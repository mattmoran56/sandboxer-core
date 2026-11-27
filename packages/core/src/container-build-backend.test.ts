// Exercises the container's rebuild check against real file timestamps. The
// find wrapper records each visited path so descending into an ignored tree
// fails the test even when the eventual decision to reuse the binary is right.
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { expect, it } from "vitest";

const exec = promisify(execFile);
const scripts = fileURLToPath(new URL("../../../container/scripts/", import.meta.url));

it("prunes dependency and Git directories, while shared sources and Git pointer files can still trigger a build", async ({ onTestFinished }) => {
  const root = await mkdtemp(join(tmpdir(), "sandboxer-build-"));
  onTestFinished(() => rm(root, { recursive: true, force: true }));
  const work = join(root, "work");
  const bin = join(root, "bin");
  const trace = join(root, "visited");
  await mkdir(bin);
  const plan = join(root, "plan.json");
  await writeFile(plan, JSON.stringify({ services: [{
    name: "api", kind: "backend", workdir: ".",
    build: 'touch "{out}" && chmod +x "{out}"',
  }] }));
  await writeFile(join(bin, "find"), `#!/bin/sh
dir=$1
shift
exec /usr/bin/find "$dir" -exec sh -c 'printf "%s\\n" "$1" >> "$TRACE"' record {} \\; \\( "$@" \\)
`, { mode: 0o755 });
  for (const rel of ["pkg/node_modules", ".git/objects", "shared", "linked"]) {
    await mkdir(join(work, rel), { recursive: true });
  }
  const env = {
    PATH: bin + ":" + process.env.PATH, WORKSPACE: work, SANDBOXER_STATE: root,
    SANDBOXER_SCRIPTS: scripts, SANDBOXER_PLAN: plan, SANDBOXER_ENV_READY: "1", TRACE: trace,
  };
  const build = () => exec("bash", [join(scripts, "build-backend.sh"), "api"], { env });
  await build();
  await writeFile(join(work, "pkg/node_modules/unvisited"), "dependency");
  await writeFile(join(work, ".git/objects/unvisited"), "object");
  expect((await build()).stdout).toContain("api is up to date");
  const visited = await readFile(trace, "utf8");
  expect(visited).toContain("node_modules");
  expect(visited).toContain(".git");
  expect(visited).not.toContain("unvisited");

  const binary = join(bin, "api");
  for (const path of ["shared/source", "linked/.git"]) {
    await writeFile(join(work, path), "changed");
    await utimes(binary, 1, 1);
    expect((await build()).stdout).toContain("building api");
    // Give the next path sole responsibility for invalidating the binary.
    await utimes(join(work, path), 0, 0);
  }
});
