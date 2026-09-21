// Tests for the images `init` builds, and what each one's digest covers:
// - baseImageTag is a function of container/base/ and container/scripts/, the two
//   directories the base build reads, so editing either of them moves it
// - baseImageTag ignores every other directory under container/ — the project
//   template, the fixtures, and any image a product adds beside them (a
//   workstation, a dashboard, an orchestrator, an agent layer)
// - the engine's base image carries no agent: container/base/Dockerfile matches
//   neither agent vendor's name, anywhere
// - initAccess builds the base image and no product's: it prepares the bare domain
//   and does not fill it (contracts §7.2)
// - initAccess reports where a front end must listen, and says that nothing is
//   serving the bare domain

import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import type { Docker } from "../docker.js";
import { containerDir } from "../install.js";
import { TOOL_VERSION } from "../tool-version.js";
import { BASE_IMAGE, DEFAULT_FRONTEND_PORT, baseImageTag, initAccess } from "./index.js";
/**
 * The product's image names, spelled here rather than imported.
 *
 * They belong to the product, in another repository, and these are names the
 * engine must *not* build — so a literal is the honest form of the assertion,
 * and there is nothing here to import them from. `PROTECTED_IMAGES` in
 * ../naming.ts is where the same strings are reserved against reclamation.
 */
const DASHBOARD_IMAGE_NAME = "sandboxr/dashboard";
const WORKSTATION_IMAGE_NAME = "sandboxr/workstation";

/** An installation whose `container/` holds one file in each directory that matters. */
async function installation(): Promise<NodeJS.ProcessEnv> {
  const root = await mkdtemp(join(tmpdir(), "sandboxr-install-"));
  for (const dir of ["base", "project", "examples", "workstation", "dashboard", "orchestrator", "agent-layer", "scripts"]) {
    await mkdir(join(root, "container", dir), { recursive: true });
    await writeFile(join(root, "container", dir, "Dockerfile"), `# ${dir}\n`, "utf8");
  }
  return { SANDBOXR_INSTALL: root };
}

/** A docker that records its builds and answers a declared set of existing images. */
function fakeDocker(present: string[] = []) {
  const builds: string[][] = [];
  const docker = {
    ok: async (args: string[]) => {
      builds.push(args);
      return { code: 0, stdout: "", stderr: "" };
    },
    imageExists: async (reference: string) => present.includes(reference),
  } as unknown as Docker;
  return { docker, builds };
}

describe("baseImageTag", () => {
  it.each(["base", "scripts"])("moves when container/%s/ changes, because the build reads it", async (dir) => {
    const env = await installation();
    const before = await baseImageTag(env);
    await writeFile(join(env.SANDBOXR_INSTALL as string, "container", dir, "Dockerfile"), "# changed\n", "utf8");
    expect(await baseImageTag(env)).not.toBe(before);
  });

  // `workstation/` arrived under `container/` after `inputsOf` was written, and
  // silently joined the base image's digest — so editing the agent's Dockerfile
  // would have forced a base rebuild, several minutes and several gigabytes, for
  // a change that cannot affect the base at all. It shares not one layer with it.
  //
  // An agent layer is the case that turned the deny-list into an allowlist. It
  // is the *product's*, built `FROM` the base, so its Dockerfile cannot be an
  // input to the image it is built on top of — and after the repository split it
  // is not in the engine's tree at all, which a deny-list naming it would have
  // had to pretend otherwise about.
  it.each(["workstation", "project", "examples", "dashboard", "orchestrator", "agent-layer"])(
    "ignores container/%s/",
    async (dir) => {
      const env = await installation();
      const before = await baseImageTag(env);
      await writeFile(join(env.SANDBOXR_INSTALL as string, "container", dir, "Dockerfile"), "# changed\n", "utf8");
      expect(await baseImageTag(env)).toBe(before);
    },
  );
});

/**
 * The engine's base image has no agent in it, and that is a boundary rather than
 * a detail of what it happens to install.
 *
 * sandboxr runs a project and has no opinion about who edits the worktree
 * (contracts §7.2); an agent lives one layer above, in an image a product
 * builds `FROM` this one. Asserted as "the file mentions neither name" rather
 * than by building the image, because a build takes minutes and the thing that
 * would reintroduce an agent here is somebody adding a line to this file.
 *
 * The other half of this pair — that the product's agent layer *does* name it —
 * is a test in the product's repository. The two are deliberately apart: the two
 * Dockerfiles are in different repositories, and a single test asserting both
 * could live in neither.
 */
describe("container/base/Dockerfile", () => {
  it("names no agent", async () => {
    const source = await readFile(join(containerDir(), "base", "Dockerfile"), "utf8");
    expect(source).not.toMatch(/claude|anthropic/i);
  });
});

/**
 * `init` builds the machine's base image and nothing else.
 *
 * **It prepares the bare domain and does not fill it** (contracts §7.2). The
 * base is the prerequisite of the next thing anybody does — the first `up`
 * fails without it — which is the test for belonging in the engine's `init`. A
 * dashboard's image, a workstation's and an orchestrator's are a *product's*,
 * and `jef init` builds them.
 *
 * The workstation's build has to stay in a verb that sets a machine up, and the
 * reason has not changed: it used to be built by the first `createSession`, on
 * the argument that a machine which never makes a session never needs several
 * hundred megabytes of agent — an argument that carried its own expiry date.
 * The cost landed in the one place it must not: `POST /api/sessions` answers one
 * JSON body and has nowhere to stream a build log to, so the first **New
 * session** on a machine was several silent minutes. That assertion now lives
 * with the product's own `init`; what is asserted here is that the engine does
 * *not* build it.
 *
 * Driven with `tls: false` and `start: false` so it is the images being asserted
 * and not mkcert or the router — the two halves of `init` that need a real
 * machine.
 */
describe("initAccess", () => {
  const run = async (): Promise<{ built: string[]; report: Awaited<ReturnType<typeof initAccess>> }> => {
    const root = await mkdtemp(join(tmpdir(), "sandboxr-init-"));
    for (const dir of ["base", "project", "examples", "workstation", "dashboard", "scripts"]) {
      await mkdir(join(root, "container", dir), { recursive: true });
      await writeFile(join(root, "container", dir, "Dockerfile"), `# ${dir}\n`, "utf8");
    }
    const env: NodeJS.ProcessEnv = {
      SANDBOXR_INSTALL: root,
      SANDBOXR_HOME: join(root, "home"),
      HOME: join(root, "home"),
      // Set so the host lookups answer from the environment rather than shelling
      // out to `git` and `gh`: what this asserts must not depend on which account
      // is logged in on the machine running it.
      GIT_AUTHOR_NAME: "Ada",
      GIT_AUTHOR_EMAIL: "ada@example.com",
      GH_TOKEN: "gho_test",
    };

    const built: string[] = [];
    const docker = {
      available: async () => true,
      ensureNetwork: async () => undefined,
      imageExists: async () => false,
      ps: async () => [],
      ok: async (args: string[]) => {
        if (args[0] === "build") {
          const tagged = args.indexOf("-t");
          built.push(args[tagged + 1] as string);
        }
        return { code: 0, stdout: "", stderr: "" };
      },
    } as unknown as Docker;

    const report = await initAccess({ env, docker, tls: false, start: false });
    return { built, report };
  };

  it("builds the base image and no product's", async () => {
    const { built } = await run();
    // Content-addressed, so the tag carries a digest of `container/` after the
    // version — matched by prefix rather than spelled, which would pin this test
    // to a fixture's hash.
    expect(built.some((tag) => tag.startsWith(`${BASE_IMAGE}:${TOOL_VERSION}`))).toBe(true);
    expect(built).not.toContain(`${DASHBOARD_IMAGE_NAME}:${TOOL_VERSION}`);
    expect(built).not.toContain(`${WORKSTATION_IMAGE_NAME}:${TOOL_VERSION}`);
  });

  // Where a front end must listen, and what the router will send it. Without
  // this the engine would prepare a domain and leave whoever wants to serve it
  // guessing at a port number.
  it("reports where a front end must listen", async () => {
    const { report } = await run();
    expect(report.frontend).toEqual({ port: DEFAULT_FRONTEND_PORT, domain: report.domain, tls: false });
  });

  // A bare domain nobody is serving looks like a broken install rather than a
  // finished one, so it is said out loud exactly once.
  it("says that nothing is serving the bare domain", async () => {
    const { report } = await run();
    expect(report.notes.join("\n")).toContain("command-line tool");
  });
});
