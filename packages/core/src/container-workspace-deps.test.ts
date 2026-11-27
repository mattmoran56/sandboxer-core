// Covers the dependency scan on a warm root install, nested workspaces, and an absent image install.
import { execFile } from "node:child_process";
import { chmod, mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { expect, it } from "vitest";

const exec = promisify(execFile);
const scripts = fileURLToPath(new URL("../../../container/scripts/", import.meta.url));

async function trees(root: string) {
  const { stdout } = await exec("bash", ["-c", 'source "$SANDBOXER_SCRIPTS/lib.sh"; workspace_dep_trees "$1"', "scan", root], {
    env: { PATH: process.env.PATH, SANDBOXER_SCRIPTS: scripts, SANDBOXER_ENV_READY: "1" },
  });
  return stdout.split("\0").filter(Boolean).sort();
}

it("skips installed dependencies and finds workspace trees at any depth", async (ctx) => {
  const root = await mkdtemp(join(tmpdir(), "workspace-deps-"));
  const hidden = join(root, "node_modules", "do-not-traverse");
  const workspace = join(root, "apps", "pkg", "node_modules");
  const deep = join(root, "packages", "nested", "sub\nworkspace", "node_modules");
  ctx.onTestFinished(async () => {
    await chmod(hidden, 0o700);
    await rm(root, { force: true, recursive: true });
  });
  await mkdir(join(hidden, "node_modules"), { recursive: true });
  await mkdir(join(workspace, "pkg", "node_modules"), { recursive: true });
  await mkdir(deep, { recursive: true });
  // If find enters a dependency tree, it fails here when run without root privileges.
  await chmod(hidden, 0);
  expect(await trees(root)).toEqual([workspace, deep].sort());
  expect(await trees(join(root, "absent"))).toEqual([]);
});
