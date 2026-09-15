// Tests for the images `init` and a session build, and what each one's digest covers:
// - baseImageTag is a function of container/, so editing a base input moves it
// - baseImageTag ignores container/workstation/, container/project/ and container/examples/
// - ensureWorkstationImage builds container/workstation/Dockerfile, version-tagged and :latest
// - ensureWorkstationImage passes TARGETARCH, which the legacy builder never sets
// - ensureWorkstationImage does nothing when the tag is already here, and rebuilds when told to

import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import type { Docker } from "../docker.js";
import { TOOL_VERSION } from "../tool-version.js";
import { WORKSTATION_IMAGE_NAME, baseImageTag, ensureWorkstationImage } from "./index.js";

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
