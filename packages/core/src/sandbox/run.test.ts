// Tests for the docker run arguments and the build commands:
// - runArgs: the container name, the shared network, every label, and the worktree bind mount
// - runArgs: one volume per purpose, the data mount per driver, storage only when declared
// - runArgs: the seed cache is read-only, the secrets file is layered under the generated environment
// - runArgs: no argument is ever a shell string, and a value with a space survives as one argument
// - memoryFor / toBytes: the largest declared limit wins, because the cgroup total is what the kernel enforces
// - renderBuild: placeholder substitution, a missing placeholder, and a value that would become shell syntax
// - backendBuild / frontendBuild: the workdir, the output path and the served directory

import { describe, expect, it } from "vitest";

import { resolveConfig } from "../config/load.js";
import type { ResolvedConfig } from "../config/types.js";
import { labelsFor } from "./labels.js";
import { BuildError, backendBuild, frontendBuild, lockHash, memoryFor, renderBuild, runArgs, toBytes } from "./run.js";

function configOf(extra: Record<string, unknown>): ResolvedConfig {
  return resolveConfig({ project: "acme", sandboxr: ">=0.1.0", access: { apps: "private" }, ...extra }, "/repo/sandboxr.yaml");
}

const mysqlConfig = configOf({
  database: { driver: "mysql", seed_from: { fixtures: "f.sql" }, migrate: { command: "m" } },
  backends: [{ name: "api", port: 8001, label: "api", build: "go build -o {out} ./{name}", workdir: "services" }],
  frontends: {
    root: "packages",
    defaults: { build: "npx vite build", out: "dist" },
    apps: [
      { label: "app", package: "web" },
      { label: "www", package: "marketing", memory: "6g" },
    ],
  },
  storage: { driver: "minio", buckets: ["uploads"] },
});

const labels = labelsFor({
  project: "acme",
  slug: "tkt-1",
  branch: "feat/a b",
  commit: "abc",
  dirty: false,
  worktree: "/repos/tkt-1",
  driver: "mysql",
  access: "private",
});

const base = {
  config: mysqlConfig,
  slug: "tkt-1",
  worktree: "/repos/tkt-1",
  labels,
  envFile: "/home/.sandboxr/build/acme/tkt-1.env",
  planFile: "/home/.sandboxr/build/acme/tkt-1.plan.json",
  cacheDir: "/home/.sandboxr/cache",
  logDir: "/home/.sandboxr/logs/acme/tkt-1",
};

describe("runArgs", () => {
  const args = runArgs(base);

  it("names the container and joins the one shared network", () => {
    expect(args.slice(0, 6)).toEqual(["run", "-d", "--name", "sandboxr-acme-tkt-1", "--network", "sandboxr"]);
  });

  it("carries every label", () => {
    for (const [key, value] of Object.entries(labels)) {
      const index = args.indexOf(`${key}=${value}`);
      expect(index).toBeGreaterThan(-1);
      expect(args[index - 1]).toBe("--label");
    }
  });

  // A branch name can contain a space, and an argument array is what keeps it
  // one argument rather than two.
  it("keeps a value containing a space as a single argument", () => {
    expect(args).toContain("sandboxr.branch=feat/a b");
  });

  it("bind-mounts the worktree, so a saved file is immediately live inside", () => {
    expect(args).toContain("/repos/tkt-1:/workspace");
  });

  it.each([
    ["binaries", "sandboxr-bin-acme-tkt-1:/var/lib/sandboxr/bin"],
    ["built sites", "sandboxr-www-acme-tkt-1:/srv/www"],
    ["the database", "sandboxr-data-acme-tkt-1:/var/lib/sandboxr/data"],
    ["object storage", "sandboxr-blob-acme-tkt-1:/var/lib/sandboxr/blob"],
  ])("gives the sandbox its own volume for %s", (_name, mount) => {
    expect(args).toContain(mount);
  });

  // One volume either way, so `down` removes the database whichever driver it is.
  it("mounts a file-backed database on the same data volume", () => {
    const fileArgs = runArgs({
      ...base,
      config: configOf({
        database: { driver: "sqlite", seed_from: { fixtures: "f.sql" }, migrate: { command: "m" } },
      }),
    });
    expect(fileArgs).toContain("sandboxr-data-acme-tkt-1:/var/lib/sandboxr/data");
  });

  // The container reads the plan and never sandboxr.yaml, and a container that
  // could rewrite the plan could change what it claims to be running.
  it("mounts the plan read-only", () => {
    expect(args).toContain(`${base.planFile}:/sandboxr/plan.json:ro`);
  });

  it("mounts the log directory from the host, so logs outlive the container", () => {
    expect(args).toContain(`${base.logDir}:/var/log/sandboxr`);
  });

  it("mounts no database volume for a project with no database", () => {
    const bare = runArgs({ ...base, config: configOf({ database: { driver: "none" } }) });
    expect(bare.join(" ")).not.toContain("sandboxr-data-");
  });

  it("mounts no storage volume unless storage is declared", () => {
    const bare = runArgs({ ...base, config: configOf({ database: { driver: "none" } }) });
    expect(bare.join(" ")).not.toContain("sandboxr-blob-");
  });

  // A sandbox restores from the cache and never writes to it.
  it("mounts the seed cache read-only", () => {
    expect(args).toContain("/home/.sandboxr/cache:/sandboxr/cache:ro");
  });

  // The directory holding the lockfile is not always the directory holding the
  // packages, so the volume lands at the root the project declares.
  it("shares one dependency volume per lockfile hash, at the declared root", () => {
    const withDeps = runArgs({
      ...base,
      config: configOf({ database: { driver: "none" }, deps: { root: "web" } }),
      depsHash: "abc123",
    });
    expect(withDeps).toContain("sandboxr-deps-abc123:/workspace/web/node_modules");

    const atRoot = runArgs({
      ...base,
      config: configOf({ database: { driver: "none" }, deps: { root: "." } }),
      depsHash: "abc123",
    });
    expect(atRoot).toContain("sandboxr-deps-abc123:/workspace/node_modules");
  });

  it("mounts no dependency volume for a project that declares no node tree", () => {
    expect(runArgs({ ...base, depsHash: "abc123" }).join(" ")).not.toContain("sandboxr-deps-");
  });

  // A credential may come from outside; a redirection of the sandbox's database
  // or storage may not.
  it("layers the secrets file under the generated environment", () => {
    const withSecrets = runArgs({ ...base, secretsFile: "/home/.sandboxr/secrets/acme.env" });
    const secretsAt = withSecrets.indexOf("/home/.sandboxr/secrets/acme.env");
    const envAt = withSecrets.indexOf(base.envFile);
    expect(secretsAt).toBeGreaterThan(-1);
    expect(secretsAt).toBeLessThan(envAt);
  });

  it("passes optional runtimes to the entrypoint", () => {
    expect(runArgs({ ...base, with: ["cms"] })).toContain("SANDBOXR_WITH=cms");
  });

  it("ends with the entrypoint and the image", () => {
    expect(args.at(-3)).toBe("--entrypoint");
    expect(args.at(-2)).toBe("/sandboxr/scripts/entrypoint.sh");
    expect(args.at(-1)).toBe("sandboxr/base:latest");
  });

  it("takes an image override", () => {
    expect(runArgs({ ...base, image: "sandboxr/base:dev" }).at(-1)).toBe("sandboxr/base:dev");
  });

  it("never produces an argument that is a shell command line", () => {
    for (const arg of args) expect(arg).not.toMatch(/\s&&\s|\s\|\s|;/);
  });
});

describe("memoryFor", () => {
  // The cgroup total is what the kernel enforces, so the largest thing the
  // project says it needs is what the sandbox has to be given.
  it("takes the largest declared limit", () => {
    expect(memoryFor(mysqlConfig)).toBe("6g");
  });

  it("falls back to the floor when nothing declares a limit", () => {
    expect(memoryFor(configOf({ database: { driver: "none" } }))).toBe("4g");
  });

  it("keeps the floor when every declared limit is smaller", () => {
    const small = configOf({
      database: { driver: "none" },
      frontends: { apps: [{ label: "a", package: "a", build: "b", out: "dist", memory: "512m" }] },
    });
    expect(memoryFor(small)).toBe("4g");
  });
});

describe("toBytes", () => {
  it.each([
    ["6g", 6 * 1_073_741_824],
    ["512m", 512 * 1_048_576],
    ["1024k", 1_048_576],
    ["1024", 1024],
    ["nonsense", 0],
  ])("reads %s", (limit, want) => {
    expect(toBytes(limit)).toBe(want);
  });
});

describe("renderBuild", () => {
  it("substitutes both placeholders", () => {
    expect(renderBuild("go build -o {out} ./{name}", { name: "api", out: "/var/lib/sandboxr/bin/api" })).toBe(
      "go build -o /var/lib/sandboxr/bin/api ./api",
    );
  });

  it("leaves a command with no placeholders alone", () => {
    expect(renderBuild("npx vite build", { name: "web" })).toBe("npx vite build");
  });

  it("refuses a placeholder it has no value for", () => {
    expect(() => renderBuild("build {out}", { name: "api" })).toThrow(BuildError);
  });

  // The command goes to a shell, so a value with a space or a semicolon would
  // be two commands rather than one argument.
  it.each(["a b", "a;rm -rf /", "$(id)", "a`b`"])("refuses %s as a substitution", (value) => {
    expect(() => renderBuild("build ./{name}", { name: value })).toThrow(BuildError);
  });
});

describe("backendBuild", () => {
  it("builds to the sandbox's binary directory, in the declared workdir", () => {
    const backend = mysqlConfig.backends[0];
    expect(backend).toBeDefined();
    expect(backendBuild(backend as NonNullable<typeof backend>)).toEqual({
      command: "go build -o /var/lib/sandboxr/bin/api ./api",
      workdir: "/workspace/services",
      output: "/var/lib/sandboxr/bin/api",
    });
  });
});

describe("frontendBuild", () => {
  it("runs in the package directory and copies the output to where it is served", () => {
    const app = mysqlConfig.frontends[0];
    expect(app).toBeDefined();
    expect(frontendBuild(mysqlConfig, app as NonNullable<typeof app>)).toEqual({
      command: "npx vite build",
      workdir: "/workspace/packages/web",
      output: "/workspace/packages/web/dist",
      served: "/srv/www/app",
    });
  });

  it("handles a package at the repo root", () => {
    const rootConfig = configOf({
      database: { driver: "none" },
      frontends: { apps: [{ label: "app", package: ".", build: "b", out: "dist" }] },
    });
    const app = rootConfig.frontends[0];
    expect(frontendBuild(rootConfig, app as NonNullable<typeof app>).workdir).toBe("/workspace");
  });
});

describe("lockHash", () => {
  it("is stable and short", () => {
    expect(lockHash("contents")).toBe(lockHash("contents"));
    expect(lockHash("contents")).toHaveLength(16);
  });

  // A branch that changes its dependencies has to get its own volume, or a
  // build there compiles against the wrong tree.
  it("moves when the lockfile moves", () => {
    expect(lockHash("a")).not.toBe(lockHash("b"));
  });
});
