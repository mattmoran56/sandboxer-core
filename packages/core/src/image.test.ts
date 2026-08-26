// Tests for the per-project image layer:
// - applyBlocks / applyValues: which blocks survive, and a missing value refused rather than emptied
// - blocksFor / valuesFor: what a config turns on, and the versions it pins
// - staging a build context: the manifests found, the go.mod rule, the content-addressed tag
// - the real container Dockerfiles: every architecture switch survives a builder that sets no TARGETARCH
// - ensureProjectImage: the build arguments, base image and architecture included

import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { readFile } from "node:fs/promises";

import {
  applyBlocks,
  applyValues,
  blocksFor,
  ensureProjectImage,
  findGoModule,
  findManifests,
  imageTag,
  renderDockerfile,
  valuesFor,
} from "./image.js";
import { containerDir } from "./install.js";
import type { Docker } from "./docker.js";
import type { ResolvedConfig } from "./config/types.js";

const config = (overrides: Partial<ResolvedConfig> = {}): ResolvedConfig => ({
  file: "/p/sandboxr.yaml",
  root: "/p",
  origin: "repo",
  project: "acme",
  sandboxr: ">=0.1.0",
  database: { driver: "none" },
  backends: [],
  frontendRoot: "",
  frontends: [],
  routes: {},
  secrets: { read: [], keep: [], rename: {}, never: [] },
  storage: { driver: "none", buckets: [] },
  toolchain: {},
  access: { apps: "public", controls: "password", credentials: "dummy" },
  env: {},
  ...overrides,
});

const TEMPLATE = [
  "FROM base",
  "# >>> sandboxr:block go",
  "RUN install go {{GO_VERSION}}",
  "# <<< sandboxr:block go",
  "# >>> sandboxr:block node",
  "RUN install node {{NODE_VERSION}}",
  "# <<< sandboxr:block node",
  "WORKDIR /workspace",
].join("\n");

describe("applyBlocks", () => {
  it("keeps an enabled block and deletes a disabled one, guards included", () => {
    const kept = applyBlocks(TEMPLATE, new Set(["go"]));
    expect(kept).toContain("RUN install go {{GO_VERSION}}");
    expect(kept).not.toContain("RUN install node");
    expect(kept).not.toContain("sandboxr:block");
  });

  it("keeps everything outside every block", () => {
    const none = applyBlocks(TEMPLATE, new Set());
    expect(none).toContain("FROM base");
    expect(none).toContain("WORKDIR /workspace");
    expect(none).not.toContain("RUN install");
  });

  it("refuses a block that is never closed", () => {
    expect(() => applyBlocks("# >>> sandboxr:block go\nRUN x\n", new Set())).toThrow(/never closed/);
  });
});

describe("applyValues", () => {
  it("substitutes every hole", () => {
    expect(applyValues("a {{X}} b {{Y}}", { X: "1", Y: "2" })).toBe("a 1 b 2");
  });

  it.each([
    ["a missing value", "a {{X}}", {}],
    ["an empty value", "a {{X}}", { X: "" }],
  ])("refuses %s, rather than rendering an image that cannot run", (_name, template, values) => {
    expect(() => applyValues(template, values)).toThrow(/\{\{X\}\}/);
  });
});

describe("blocksFor", () => {
  it("turns on sqlite for d1, because a D1 database is SQLite underneath", () => {
    const enabled = blocksFor({ config: config({ database: { driver: "d1", owner: "app" } }), gomod: false, deps: false });
    expect([...enabled]).toEqual(["sqlite"]);
  });

  it.each([
    ["mysql", "mysql"],
    ["sqlite", "sqlite"],
  ] as const)("turns on %s for driver %s", (driver, block) => {
    expect(blocksFor({ config: config({ database: { driver } }), gomod: false, deps: false }).has(block)).toBe(true);
  });

  it("adds nothing for driver none", () => {
    expect([...blocksFor({ config: config(), gomod: false, deps: false })]).toEqual([]);
  });

  it("only stages gomod and deps when something was actually found to stage", () => {
    const withToolchains = config({ toolchain: { go: "1.26", node: "22" } });
    expect([...blocksFor({ config: withToolchains, gomod: false, deps: false })].sort()).toEqual(["go", "node"]);
    expect([...blocksFor({ config: withToolchains, gomod: true, deps: true })].sort()).toEqual([
      "deps",
      "go",
      "gomod",
      "node",
    ]);
  });
});

describe("valuesFor", () => {
  it("defaults the MySQL series rather than leaving the pin empty", () => {
    expect(valuesFor({ config: config({ database: { driver: "mysql" } }), gomod: false, deps: false })).toEqual({
      MYSQL_VERSION: "8.4",
    });
  });

  it("passes an explicit version through", () => {
    expect(
      valuesFor({ config: config({ database: { driver: "mysql", version: "9.0" } }), gomod: false, deps: false })
        .MYSQL_VERSION,
    ).toBe("9.0");
  });

  it("carries the dependency install and lockfile the deps block needs", () => {
    const values = valuesFor({
      config: config({
        toolchain: { node: "22" },
        deps: { root: "web", lockfile: "package-lock.json", install: "npm ci" },
      }),
      gomod: false,
      deps: true,
    });
    expect(values).toMatchObject({ NODE_VERSION: "22", DEPS_INSTALL: "npm ci", DEPS_LOCKFILE: "package-lock.json" });
  });
});

describe("staging a build context", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "sandboxr-image-test-"));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("finds every package.json and the lockfile, keeping the workspace layout", async () => {
    await writeFile(join(dir, "package.json"), "{}");
    await writeFile(join(dir, "package-lock.json"), "{}");
    await mkdir(join(dir, "packages", "app"), { recursive: true });
    await writeFile(join(dir, "packages", "app", "package.json"), "{}");
    // Anything under node_modules is what the install produces, not what
    // describes it; staging it would make the context enormous and the layer
    // rebuild on every change.
    await mkdir(join(dir, "node_modules", "left"), { recursive: true });
    await writeFile(join(dir, "node_modules", "left", "package.json"), "{}");

    const staged = await findManifests(dir, "package-lock.json");
    expect(staged.map((file) => file.target)).toEqual([
      "package-lock.json",
      "package.json",
      "packages/app/package.json",
    ]);
  });

  it("stages nothing at all without a lockfile or a manifest", async () => {
    expect(await findManifests(dir, "package-lock.json")).toEqual([]);
  });

  it("treats a go.sum with no go.mod as no module", async () => {
    await writeFile(join(dir, "go.sum"), "");
    expect(await findGoModule(dir)).toEqual([]);
    await writeFile(join(dir, "go.mod"), "module x\n");
    expect((await findGoModule(dir)).map((file) => file.target)).toEqual(["go.mod", "go.sum"]);
  });

  it("keys the tag on the Dockerfile and on every staged file's contents", async () => {
    const manifest = join(dir, "package.json");
    await writeFile(manifest, "{}");
    const staged = [{ source: manifest, target: "manifests/package.json" }];

    const first = await imageTag("acme", "FROM a", staged);
    expect(first).toMatch(/^sandboxr\/acme:[0-9a-f]{12}$/);
    expect(await imageTag("acme", "FROM a", staged)).toBe(first);
    expect(await imageTag("acme", "FROM b", staged)).not.toBe(first);

    await writeFile(manifest, '{"a":1}');
    expect(await imageTag("acme", "FROM a", staged)).not.toBe(first);
  });
});

// A build arg is only half the fix. These read the files that are actually
// shipped, because the failure they guard against — an empty TARGETARCH under
// the legacy builder — is invisible to any test that renders a fake template.
describe("the architecture switches in the shipped Dockerfiles", () => {
  const sources = ["base/Dockerfile", "dashboard/Dockerfile", "project/Dockerfile.template"];

  it.each(sources)("resolves the architecture for itself in %s", async (name) => {
    const text = await readFile(join(containerDir(), name), "utf8");

    // A bare expansion is two bugs at once: empty under the legacy builder, and
    // an exit 2 "parameter not set" under `set -u`.
    expect(text).not.toMatch(/case "\$\{TARGETARCH\}"/);
    expect(text).toContain('ARCH="${TARGETARCH:-}"');
    expect(text).toContain('ARCH="$(uname -m)"');
    // uname's spelling and docker's, because the fallback produces the first.
    expect(text).toMatch(/arm64\|aarch64/);
    expect(text).toMatch(/amd64\|x86_64/);
  });

  it("keeps the fallback in the rendered project layer", async () => {
    const template = await readFile(join(containerDir(), "project", "Dockerfile.template"), "utf8");
    const rendered = renderDockerfile(template, {
      config: config({ toolchain: { go: "1.25", node: "24" }, database: { driver: "mysql" } }),
      gomod: false,
      deps: false,
    });
    // Go, Node and MySQL each switch on it, and the Go one is where this failed.
    expect(rendered.match(/ARCH="\$\{TARGETARCH:-\}"/g)).toHaveLength(3);
    expect(rendered).toContain("GO_ARCH=amd64");
    expect(rendered).not.toContain("${TARGETARCH}");
  });
});

describe("ensureProjectImage", () => {
  let worktree: string;

  beforeEach(async () => {
    worktree = await mkdtemp(join(tmpdir(), "sandboxr-image-build-"));
  });

  afterEach(async () => {
    await rm(worktree, { recursive: true, force: true });
  });

  /** Records the arguments a build was asked to run with, and builds nothing. */
  const spy = () => {
    const calls: string[][] = [];
    const docker = {
      imageExists: async () => false,
      ok: async (args: string[]) => {
        calls.push(args);
        return { code: 0, stdout: "", stderr: "" };
      },
    } as unknown as Docker;
    return { calls, docker };
  };

  it("passes the base image and this host's architecture", async () => {
    const { calls, docker } = spy();
    const built = await ensureProjectImage({
      config: config({ toolchain: { node: "24" } }),
      worktree,
      docker,
      baseImage: "sandboxr/base:9.9.9",
    });

    expect(built.built).toBe(true);
    const args = calls[0] ?? [];
    expect(args.slice(0, 2)).toEqual(["build", "-f"]);
    expect(args.join(" ")).toContain("--build-arg BASE_IMAGE=sandboxr/base:9.9.9");

    // Mapped here rather than taken from archBuildArgs, so the test would catch
    // the mapping changing under it.
    const expected = process.arch === "x64" ? "amd64" : process.arch === "arm64" ? "arm64" : undefined;
    if (expected) expect(args.join(" ")).toContain(`--build-arg TARGETARCH=${expected}`);
    else expect(args.join(" ")).not.toContain("TARGETARCH");
  });

  it("builds nothing when the tag is already here", async () => {
    const calls: string[][] = [];
    const docker = {
      imageExists: async () => true,
      ok: async (args: string[]) => {
        calls.push(args);
        return { code: 0, stdout: "", stderr: "" };
      },
    } as unknown as Docker;
    const built = await ensureProjectImage({ config: config({ toolchain: { node: "24" } }), worktree, docker });
    expect(built.built).toBe(false);
    expect(calls).toEqual([]);
  });
});
