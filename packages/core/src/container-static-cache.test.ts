// Covers real static builds, cache reuse and invalidation, damaged artifacts,
// failed builds, changing inputs, declared source roots and Git identity choices.
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { expect, it } from "vitest";

const exec = promisify(execFile);
const scripts = fileURLToPath(new URL("../../../container/scripts/", import.meta.url));
async function setup() {
  const root = await mkdtemp(join(tmpdir(), "sandboxer-static-"));
  const work = join(root, "work");
  const www = join(root, "www");
  const cache = join(root, "cache");
  const count = join(root, "count");
  const plan = join(root, "plan.json");
  for (const dir of [join(work, "app"), www]) await mkdir(dir, { recursive: true });
  await writeFile(join(work, "app/source"), "first");
  const service = {
    kind: "static", label: "app", package: "app", root: ".", out: "dist", cache: true,
    build: 'printf x >> "$COUNT"; mkdir -p dist; cat source > dist/index.html; printf "%s" "$VITE_API_URL" >> dist/index.html',
  };
  await writeFile(plan, JSON.stringify({ services: [service] }));
  const env = { PATH: process.env.PATH, SANDBOXER_ENV_READY: "1", WORKSPACE: work, SANDBOXER_WWW: www,
    SANDBOXER_PLAN: plan, SANDBOXER_SCRIPTS: scripts, SANDBOXER_STATIC_CACHE: cache,
    VITE_API_URL: "https://one.example", COUNT: count };
  return { root, work, www, cache, count, plan, service, env,
    build: (extra = {}) => exec("bash", [join(scripts, "build-static.sh"), "app"], { env: { ...env, ...extra } }) };
}

it("reuses verified artifacts and invalidates source, untracked files, lockfiles, environment and commands", async ({ onTestFinished }) => {
  const f = await setup();
  onTestFinished(() => rm(f.root, { recursive: true, force: true }));
  expect((await f.build()).stdout).toContain("cache miss");
  const expected = await readFile(join(f.www, "app/index.html"), "utf8");
  await rm(join(f.www, "app"), { recursive: true });
  expect((await f.build()).stdout).toContain("reused app from cache");
  expect(await readFile(join(f.www, "app/index.html"), "utf8")).toBe(expected);
  expect(await readFile(f.count, "utf8")).toBe("x");

  await writeFile(join(f.work, "app/source"), "second");
  expect((await f.build()).stdout).toContain("cache miss");
  expect(await readFile(join(f.www, "app/index.html"), "utf8")).toContain("second");
  await writeFile(join(f.work, ".env"), "TEST_SECRET=not-logged");
  const untracked = await f.build();
  expect(untracked.stdout).toContain("cache miss");
  expect(untracked.stdout + untracked.stderr).not.toContain("not-logged");
  await writeFile(join(f.work, "package-lock.json"), '{"lockfileVersion":3}');
  expect((await f.build()).stdout).toContain("cache miss");
  expect((await f.build({ VITE_API_URL: "https://two.example" })).stdout).toContain("cache miss");
  expect(await readFile(join(f.www, "app/index.html"), "utf8")).toContain("https://two.example");
  await writeFile(f.plan, JSON.stringify({ services: [{ ...f.service, build: f.service.build + '; printf changed >> dist/index.html' }] }));
  expect((await f.build()).stdout).toContain("cache miss");
  expect((await f.build({ SANDBOXER_FORCE_BUILD: "true" })).stdout).not.toContain("reused");
}, 20000);

it("rejects damaged cache artifacts and never publishes old output after a failing build", async ({ onTestFinished }) => {
  const f = await setup();
  onTestFinished(() => rm(f.root, { recursive: true, force: true }));
  await f.build();
  const entry = (await readdir(f.cache))[0]!;
  await writeFile(join(f.cache, entry, "files/index.html"), "corrupted");
  expect((await f.build()).stdout).toContain("cache miss");
  expect(await readFile(join(f.www, "app/index.html"), "utf8")).not.toContain("corrupted");
  expect((await f.build()).stdout).toContain("reused app from cache");
  await writeFile(f.plan, JSON.stringify({ services: [{ ...f.service, build: 'exit 7' }] }));
  await expect(f.build()).rejects.toMatchObject({ code: 1 });
  expect(await readFile(join(f.www, "app/index.html"), "utf8")).toContain("first");
});

it("does not cache a build that changes its inputs or a frontend without explicit opt-in", async ({ onTestFinished }) => {
  const f = await setup();
  onTestFinished(() => rm(f.root, { recursive: true, force: true }));
  await writeFile(f.plan, JSON.stringify({ services: [{ ...f.service, build: f.service.build + '; printf changed >> source' }] }));
  expect((await f.build()).stdout).toContain("inputs changed during build");
  expect(await readdir(f.cache)).toEqual([]);
  await writeFile(f.plan, JSON.stringify({ services: [{ ...f.service, cache: false }] }));
  await f.build();
  expect((await f.build()).stdout).not.toContain("reused");
  expect(await readFile(f.count, "utf8")).toBe("xxx");
});

it("scopes declared inputs, including shared libraries, while Git metadata remains an explicit choice", async ({ onTestFinished }) => {
  const f = await setup();
  onTestFinished(() => rm(f.root, { recursive: true, force: true }));
  await mkdir(join(f.work, "shared"));
  await writeFile(join(f.work, "shared/library"), "shared first");
  const scoped = { ...f.service, cache_inputs: ["app", "shared"], cache_git: false };
  await writeFile(f.plan, JSON.stringify({ services: [scoped] }));
  await exec("git", ["init", "-q", f.work]);
  const git = (...args: string[]) => exec("git", ["-C", f.work, "-c", "user.name=Test", "-c", "user.email=test@example.test", ...args]);
  await git("add", ".");
  await git("commit", "-qm", "initial");
  await f.build();
  await writeFile(join(f.work, "backend.go"), "backend edit");
  await git("add", "backend.go");
  await git("commit", "-qm", "backend only");
  expect((await f.build()).stdout).toContain("reused app from cache");
  await writeFile(join(f.work, "shared/library"), "shared changed");
  expect((await f.build()).stdout).toContain("cache miss");
  await writeFile(f.plan, JSON.stringify({ services: [{ ...scoped, cache_git: true }] }));
  await f.build();
  await git("commit", "--allow-empty", "-qm", "revision only");
  expect((await f.build()).stdout).toContain("cache miss");
}, 15000);
