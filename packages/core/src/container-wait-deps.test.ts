// Exercises per-boot dependency completion, pending/failed installs, timeouts,
// projects without Node dependencies, and manual static build gating.
import { execFile } from "node:child_process";
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { promisify } from "node:util";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

const exec = promisify(execFile);
const scripts = new URL("../../../container/scripts/", import.meta.url).pathname;
const hasJq = await exec("sh", ["-c", "command -v jq"]).then(() => true, () => false);

describe.skipIf(!hasJq)("frontend dependency completion", () => {
  let dir: string;
  let env: NodeJS.ProcessEnv;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "frontend-deps-"));
    env = {
      PATH: process.env.PATH,
      SANDBOXER_ENV_READY: "1",
      SANDBOXER_PLAN: join(dir, "plan.json"),
      SANDBOXER_RUN: dir,
      SANDBOXER_WWW: join(dir, "www"),
      SANDBOXER_SCRIPTS: scripts,
      WORKSPACE: dir,
    };
    await mkdir(join(dir, "www"));
    await mkdir(join(dir, "web", "app"), { recursive: true });
    await writeFile(join(dir, "web", "package-lock.json"), "{}");
  });

  afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

  const run = (script: string, ...args: string[]) =>
    exec("bash", [join(scripts, script), ...args], { env, timeout: 10_000 });

  async function plan(install?: string) {
    await writeFile(join(dir, "plan.json"), JSON.stringify({
      deps: install ? { root: "web", install } : undefined,
      services: [{
        kind: "static", label: "app", root: "web", package: "app", out: "dist",
        build: "test -f ../node_modules/proof && mkdir -p dist && echo ready > dist/index.html",
      }],
    }));
  }

  it("holds a requested static build until the boot install completes", async () => {
    await plan('mkdir -p node_modules; touch "$SANDBOXER_RUN/installing"; for i in {1..100}; do test -e "$SANDBOXER_RUN/release" && break; sleep 0.05; done; touch node_modules/proof');
    await writeFile(join(dir, "deps-finished"), "finished\n"); // A manual rerun follows a completed install.
    const install = run("deps-init.sh");
    try {
      await expect.poll(() => access(join(dir, "installing")).then(() => true, () => false)).toBe(true);
      await expect(access(join(dir, "deps-finished"))).rejects.toMatchObject({ code: "ENOENT" });
      const build = run("build-static.sh", "app");
      try {
        expect(await Promise.race([build.then(() => "built", () => "failed"), delay(150, "waiting")])).toBe("waiting");
      } finally {
        await writeFile(join(dir, "release"), "");
        await build;
      }
    } finally {
      await writeFile(join(dir, "release"), "");
      await install;
    }
    expect(await readFile(join(dir, "www", "app", "index.html"), "utf8")).toBe("ready\n");
    expect(await readFile(join(dir, "deps-finished"), "utf8")).toBe("finished\n");
  });

  it("times out an unfinished install and preserves the completed install's failure warning", async () => {
    await plan("false");
    await expect(run("wait-deps.sh", "0")).rejects.toMatchObject({ stderr: expect.stringContaining("still pending") });
    expect((await run("deps-init.sh")).stderr).toContain("front-end builds will not work");
    expect((await run("wait-deps.sh", "0")).stderr).toContain("reported a failure");
  });

  it("proceeds without a dependency root", async () => {
    await plan();
    await expect(run("wait-deps.sh", "0")).resolves.toMatchObject({ stderr: "" });
  });
});
