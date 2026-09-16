// Tests for the images `init` builds, and what each one's digest covers:
// - baseImageTag is a function of container/, so editing a base input moves it
// - baseImageTag ignores container/workstation/, container/project/ and container/examples/
// - ensureWorkstationImage builds container/workstation/Dockerfile, version-tagged and :latest
// - ensureWorkstationImage passes TARGETARCH, which the legacy builder never sets
// - ensureWorkstationImage does nothing when the tag is already here, and rebuilds when told to
// - init builds the workstation image, beside the base and the dashboard, so the first
//   `New session` on a machine is not the thing that pays for it (contracts §3.3)

import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import type { Docker } from "../docker.js";
import { TOOL_VERSION } from "../tool-version.js";
import {
  DASHBOARD_IMAGE_NAME,
  WORKSTATION_IMAGE_NAME,
  baseImageTag,
  ensureWorkstationImage,
  initAccess,
} from "./index.js";

/** An installation whose `container/` holds one file in each directory that matters. */
async function installation(): Promise<NodeJS.ProcessEnv> {
  const root = await mkdtemp(join(tmpdir(), "sandboxr-install-"));
  for (const dir of ["base", "project", "examples", "workstation", "scripts"]) {
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
  it("moves when one of the base image's own inputs changes", async () => {
    const env = await installation();
    const before = await baseImageTag(env);
    await writeFile(join(env.SANDBOXR_INSTALL as string, "container", "base", "Dockerfile"), "# changed\n", "utf8");
    expect(await baseImageTag(env)).not.toBe(before);
  });

  // `workstation/` arrived under `container/` after `inputsOf` was written, and
  // silently joined the base image's digest — so editing the agent's Dockerfile
  // would have forced a base rebuild, several minutes and several gigabytes, for
  // a change that cannot affect the base at all. It shares not one layer with it.
  it.each(["workstation", "project", "examples"])("ignores container/%s/", async (dir) => {
    const env = await installation();
    const before = await baseImageTag(env);
    await writeFile(join(env.SANDBOXR_INSTALL as string, "container", dir, "Dockerfile"), "# changed\n", "utf8");
    expect(await baseImageTag(env)).toBe(before);
  });
});

describe("ensureWorkstationImage", () => {
  it("builds the workstation Dockerfile, version-tagged and latest", async () => {
    const env = await installation();
    const fake = fakeDocker();
    const tag = await ensureWorkstationImage({ docker: fake.docker, env });

    expect(tag).toBe(`${WORKSTATION_IMAGE_NAME}:${TOOL_VERSION}`);
    const build = fake.builds[0] as string[];
    expect(build[0]).toBe("build");
    expect(build).toContain(join(env.SANDBOXR_INSTALL as string, "container", "workstation", "Dockerfile"));
    expect(build).toContain(tag);
    expect(build).toContain(`${WORKSTATION_IMAGE_NAME}:latest`);
  });

  // `TARGETARCH` is a BuildKit built-in the legacy builder never sets, and this
  // Dockerfile puts the resolved architecture straight into a download URL — so
  // an unresolved one is a 404 that reads as a broken mirror.
  it("passes the architecture the legacy builder would not", async () => {
    const env = await installation();
    const fake = fakeDocker();
    await ensureWorkstationImage({ docker: fake.docker, env });
    expect((fake.builds[0] as string[]).join(" ")).toContain("TARGETARCH=");
  });

  it("builds nothing when the tag is already here, and rebuilds when told to", async () => {
    const env = await installation();
    const present = [`${WORKSTATION_IMAGE_NAME}:${TOOL_VERSION}`];

    const found = fakeDocker(present);
    await ensureWorkstationImage({ docker: found.docker, env });
    expect(found.builds).toEqual([]);

    const forced = fakeDocker(present);
    await ensureWorkstationImage({ docker: forced.docker, env, rebuild: true });
    expect(forced.builds).toHaveLength(1);
  });
});

/**
 * `init` builds the machine's images, and the workstation is one of them.
 *
 * This moved. It used to be built by the first `createSession`, on the argument
 * that a machine which never makes a session never needs several hundred
 * megabytes of `claude` — an argument that carried its own expiry date, and a
 * session is now the thing the dashboard is organised around. The cost landed in
 * the one place it must not: `POST /api/sessions` answers one JSON body and has
 * nowhere to stream a build log to, so the first **New session** on a machine was
 * several silent minutes. A build belongs in the verb that sets a machine up.
 *
 * Driven with `tls: false` and `start: false` so it is the images being asserted
 * and not mkcert or the router — the two halves of `init` that need a real
 * machine.
 */
describe("initAccess", () => {
  it("builds the workstation image beside the base and the dashboard", async () => {
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
      ok: async (args: string[]) => {
        if (args[0] === "build") {
          const tagged = args.indexOf("-t");
          built.push(args[tagged + 1] as string);
        }
        return { code: 0, stdout: "", stderr: "" };
      },
    } as unknown as Docker;

    await initAccess({ env, docker, tls: false, start: false });

    // The workstation's, and it is the assertion this test exists for.
    expect(built).toContain(`${WORKSTATION_IMAGE_NAME}:${TOOL_VERSION}`);
    // Beside the dashboard's, so a reordering that dropped one is visible as the
    // list it is rather than as a single missing tag.
    expect(built).toContain(`${DASHBOARD_IMAGE_NAME}:${TOOL_VERSION}`);
  });
});
