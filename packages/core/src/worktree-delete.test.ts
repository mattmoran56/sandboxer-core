// Tests for deleting a worktree, sandbox first:
// - the sandbox goes before the directory, and both are reported item by item
// - two worktrees on one slug: the sandbox is kept, named, and only the directory goes
// - a sibling that was GIVEN a slug is compared under that slug and not the one it would
//   derive: no false collision, and each delete reaches its own container
// - a slug that names two worktrees is refused rather than deleting an arbitrary one
// - a worktree with no sandbox deletes cleanly and says there was nothing to tear down
// - uncommitted changes are refused, naming the files, and --force gets past it
// - unpushed commits are refused, and the wording says the commits themselves survive
// - a worktree whose directory is already gone is deleted without a dirty check
// - the display name goes with the worktree, and is kept when a sibling shares the slug
// - a worktree nobody can find is refused, and nothing is removed
//
// git is real, against a temp clone, because the behaviour under test is git's.
// Docker is a fake: what matters here is the order and the arguments, and a real
// daemon would test the daemon.

import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { promisify } from "node:util";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { ContainerRow, Docker } from "./docker.js";
import { paths } from "./paths.js";
import { labelsFor } from "./sandbox/labels.js";
import type { Project } from "./workspace.js";
import { addWorktree, type Worktree } from "./worktree.js";
import { deleteWorktree, WorktreeDeleteError } from "./worktree-delete.js";
import { readDisplayName, writeDisplayName } from "./worktree-name.js";

const exec = promisify(execFile);

/** Shelling out to git is slow on a cold filesystem, and CI's is always cold. */
const GIT_TIMEOUT = 30_000;

async function git(dir: string, ...args: string[]): Promise<string> {
  const { stdout } = await exec("git", ["-C", dir, ...args]);
  return stdout;
}

/** A docker whose every call is recorded and which has exactly the containers it is given. */
function fakeDocker(rows: ContainerRow[] = []) {
  const calls: Array<{ method: string; args: unknown[] }> = [];
  const record = (method: string, ...args: unknown[]): number => calls.push({ method, args });
  const nothing = async (): Promise<{ code: number; stdout: string; stderr: string }> => ({
    code: 0,
    stdout: "",
    stderr: "",
  });

  const docker = {
    raw: nothing,
    ok: nothing,
    available: async () => true,
    ps: async () => rows,
    inspect: async () => ({ Mounts: [] }),
    containerExists: async (name: string) => rows.some((r) => r.name === name),
    containerRunning: async (name: string) => rows.some((r) => r.name === name && r.state === "running"),
    labels: async (name: string) => rows.find((r) => r.name === name)?.labels ?? {},
    // Every sandbox in these tests is running, so `list` asks it for its
    // migration markers; anything else makes it read as degraded.
    exec: async () => ({ code: 0, stdout: '{"state":"ok","file":"","error":""}', stderr: "" }),
    execInteractive: async () => 0,
    logs: nothing,
    logsFollow: async () => 0,
    rm: async (name: string, options?: { force?: boolean }) => {
      record("rm", name, options);
    },
    stop: async () => undefined,
    start: async () => undefined,
    startedAt: async () => undefined,
    volumes: async () => [],
    volumeRm: async (name: string) => {
      record("volumeRm", name);
      return true;
    },
    ensureNetwork: async () => undefined,
    imageExists: async () => true,
    diskUsage: async () => ({ images: [], volumes: [], buildCache: [] }),
    imageRm: async () => true,
    builderPrune: async () => 0,
    cp: async () => undefined,
  } as unknown as Docker;

  const argsOf = (method: string) => calls.filter((call) => call.method === method).map((call) => call.args);
  return { docker, calls, argsOf };
}

const sandboxRow = (slug: string, worktree: string, project = "demo"): ContainerRow => ({
  name: `sandboxer-${project}-${slug}`,
  id: `sandboxer-${project}-${slug}`,
  state: "running",
  labels: labelsFor({
    project,
    slug,
    branch: "feat/eng-3941-answers",
    commit: "abc",
    dirty: false,
    worktree,
    driver: "mysql",
    access: "private",
  }),
});

describe("deleteWorktree", () => {
  let root: string;
  let source: string;
  let home: string;
  let projectDir: string;
  let project: Project;
  let env: NodeJS.ProcessEnv;

  beforeEach(async () => {
    // Resolved, because git records a worktree by its real path and the system
    // temp directory is a symlink on macOS — comparing the two as strings
    // otherwise fails in a way that looks nothing like a symlink.
    root = await realpath(await mkdtemp(join(tmpdir(), "sandboxer-delete-")));
    source = join(root, "source");
    home = join(root, "home");
    // The project lives **inside the workspace**, which is what makes the slug
    // store reachable at all: only a worktree under `<workspace>/<project>/wt`
    // can hold a record (§4.2.3), so a fixture outside it would silently test a
    // world where no worktree has ever been given a slug.
    projectDir = join(home, "workspace", "demo");

    await exec("git", ["init", "-b", "main", source]);
    await git(source, "config", "user.email", "test@example.com");
    await git(source, "config", "user.name", "Test");
    await writeFile(join(source, "README.md"), "one\n");
    await git(source, "add", ".");
    await git(source, "commit", "-m", "one");
    for (const branch of ["feat/eng-3941-answers", "feat/eng-3941-selector"]) {
      await git(source, "checkout", "-b", branch);
      await git(source, "checkout", "main");
    }

    const repo = join(projectDir, "repo.git");
    await mkdir(projectDir, { recursive: true });
    await exec("git", ["clone", "--bare", source, repo]);
    await git(repo, "config", "remote.origin.fetch", "+refs/heads/*:refs/remotes/origin/*");
    await git(repo, "fetch", "origin");

    project = { name: "demo", repo, worktrees: join(projectDir, "wt"), base: "main", origin: source };
    // No `SANDBOXER_WORKSPACE`: it defaults to `<home>/workspace`, which is where
    // `projectDir` is, so `workspaceWorktree` recognises these worktrees exactly
    // as it does on a real machine.
    env = { SANDBOXER_HOME: home };
  }, GIT_TIMEOUT);

  /**
   * Cuts a worktree the way the tool now does, slug record and all.
   *
   * `env` is not optional: without it `addWorktree` looks for the workspace
   * under the real `~/.sandboxer`, decides these worktrees are not in one, and
   * never records a collision — which would make every test below quietly
   * describe the world as it was before slugs could be given.
   */
  const cut = (branch: string) => addWorktree({ project, branch, env });

  /**
   * Throws away a worktree's recorded slug, leaving the collision behind.
   *
   * This is what a machine upgraded across the collision fix looks like: two
   * worktrees on one ticket, cut before anything guarded against it, sharing a
   * slug that neither of them has written down. Collisions already on disk are
   * deliberately not migrated — renaming a worktree whose sandbox is running
   * would orphan that container — so this state is reachable and is the state
   * the sibling check exists for.
   */
  const forgetGivenSlug = async (worktree: Worktree): Promise<void> => {
    await rm(paths(env).slugFile("demo", basename(worktree.path)), { force: true });
  };

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it(
    "removes the sandbox before the worktree, and reports both",
    async () => {
      const worktree = await cut("feat/eng-3941-answers");
      const { docker, calls, argsOf } = fakeDocker([sandboxRow("eng-3941", worktree.path)]);

      const done = await deleteWorktree({ project, branch: "feat/eng-3941-answers", docker, env });

      expect(done.sandbox).toBe("removed");
      expect(argsOf("rm")[0]?.[0]).toBe("sandboxer-demo-eng-3941");
      expect(argsOf("volumeRm").map((args) => args[0])).toEqual([
        "sandboxer-data-demo-eng-3941",
        "sandboxer-blob-demo-eng-3941",
        "sandboxer-bin-demo-eng-3941",
        "sandboxer-www-demo-eng-3941",
      ]);
      // The order is the whole point: a volume cannot be removed while the
      // container holds it, and the slug cannot be derived once the worktree is
      // gone. The container's removal is therefore the first thing recorded.
      expect(calls[0]?.method).toBe("rm");
      expect(existsSync(worktree.path)).toBe(false);

      // Item by item, container and directory both.
      expect(done.removed).toContain("sandboxer-demo-eng-3941");
      expect(done.removed).toContain(worktree.path);
    },
    GIT_TIMEOUT,
  );

  it(
    "keeps a sandbox two worktrees resolve to, and says which one is still using it",
    async () => {
      // The hazard in one test: a ticket id in both directory names derives one
      // slug, so both branches share a container. `addWorktree` gives the second
      // one a slug of its own now, and forgetting that record is what leaves the
      // machine in the state an upgrade leaves it in.
      const first = await cut("feat/eng-3941-answers");
      await forgetGivenSlug(await cut("feat/eng-3941-selector"));
      const { docker, argsOf } = fakeDocker([sandboxRow("eng-3941", first.path)]);

      const lines: string[] = [];
      const done = await deleteWorktree({
        project,
        branch: "feat/eng-3941-answers",
        docker,
        env,
        log: (line) => lines.push(line),
      });

      expect(done.sandbox).toBe("shared");
      expect(argsOf("rm")).toHaveLength(0);
      expect(argsOf("volumeRm")).toHaveLength(0);
      expect(done.sharedWith).toEqual([join(project.worktrees, "feat-eng-3941-selector")]);
      expect(lines.join("\n")).toMatch(/feat\/eng-3941-selector resolves to the same slug/);
      // The worktree itself still goes: it is the sandbox that is shared.
      expect(existsSync(first.path)).toBe(false);
    },
    GIT_TIMEOUT,
  );

  it(
    "refuses a slug that names two worktrees rather than guessing",
    async () => {
      await cut("feat/eng-3941-answers");
      await forgetGivenSlug(await cut("feat/eng-3941-selector"));
      const { docker, argsOf } = fakeDocker();

      await expect(deleteWorktree({ project, slug: "eng-3941", docker, env })).rejects.toThrow(
        /is the slug of 2 worktrees/,
      );
      expect(argsOf("rm")).toHaveLength(0);
      expect(existsSync(join(project.worktrees, "feat-eng-3941-answers"))).toBe(true);
    },
    GIT_TIMEOUT,
  );

  it(
    "deletes a worktree that never had a sandbox, and says so",
    async () => {
      const worktree = await cut("feat/eng-3941-answers");
      const { docker, argsOf } = fakeDocker();

      const lines: string[] = [];
      const done = await deleteWorktree({
        project,
        branch: "feat/eng-3941-answers",
        docker,
        env,
        log: (line) => lines.push(line),
      });

      expect(done.sandbox).toBe("none");
      expect(argsOf("rm")).toHaveLength(0);
      expect(lines.join("\n")).toMatch(/nothing to tear down/);
      expect(existsSync(worktree.path)).toBe(false);
    },
    GIT_TIMEOUT,
  );

  it(
    "refuses a worktree with uncommitted changes, names them, and yields to --force",
    async () => {
      const worktree = await cut("feat/eng-3941-answers");
      await writeFile(join(worktree.path, "README.md"), "work in progress\n");
      const { docker } = fakeDocker([sandboxRow("eng-3941", worktree.path)]);

      const refusal = await deleteWorktree({ project, branch: "feat/eng-3941-answers", docker, env }).catch(
        (error: unknown) => error,
      );
      expect(refusal).toBeInstanceOf(WorktreeDeleteError);
      expect((refusal as WorktreeDeleteError).forceable).toBe(true);
      expect((refusal as Error).message).toMatch(/README\.md/);
      // Nothing was touched: a refusal that had already removed the container
      // would be the worst of both answers.
      expect(existsSync(worktree.path)).toBe(true);

      const done = await deleteWorktree({ project, branch: "feat/eng-3941-answers", docker, env, force: true });
      expect(done.sandbox).toBe("removed");
      expect(existsSync(worktree.path)).toBe(false);
    },
    GIT_TIMEOUT,
  );

  it(
    "ignores the files a sandbox's own build writes",
    async () => {
      const worktree = await cut("feat/eng-3941-answers");
      // `.env.local` is `DEFAULT_DIRTY_IGNORE`: counting it would mean that
      // merely having run a sandbox blocked deleting its worktree.
      await writeFile(join(worktree.path, ".env.local"), "TOKEN=1\n");
      const { docker } = fakeDocker();

      await expect(deleteWorktree({ project, branch: "feat/eng-3941-answers", docker, env })).resolves.toMatchObject({
        sandbox: "none",
      });
    },
    GIT_TIMEOUT,
  );

  it(
    "refuses unpushed commits, and says the commits themselves survive",
    async () => {
      const worktree = await cut("feat/eng-3941-answers");
      await writeFile(join(worktree.path, "README.md"), "landed\n");
      await git(worktree.path, "config", "user.email", "test@example.com");
      await git(worktree.path, "config", "user.name", "Test");
      await git(worktree.path, "commit", "-am", "landed");
      const { docker } = fakeDocker();

      const refusal = await deleteWorktree({ project, branch: "feat/eng-3941-answers", docker, env }).catch(
        (error: unknown) => error,
      );
      expect(refusal).toBeInstanceOf(WorktreeDeleteError);
      expect((refusal as Error).message).toMatch(/1 commit that is on no remote/);
      // The distinction the wording exists for: a refusal that claimed the
      // commits were about to be lost would be one people learn to force past.
      expect((refusal as Error).message).toMatch(/stay in the project's clone/);
      expect(existsSync(worktree.path)).toBe(true);
    },
    GIT_TIMEOUT,
  );

  it(
    "deletes a worktree whose directory is already gone",
    async () => {
      const worktree = await cut("feat/eng-3941-answers");
      // A worktree deleted with `rm -rf` leaves git's admin entry behind, and
      // clearing that entry is exactly what somebody pressing Delete wants.
      await rm(worktree.path, { recursive: true, force: true });
      const { docker } = fakeDocker();

      const done = await deleteWorktree({ project, branch: "feat/eng-3941-answers", docker, env });
      expect(done.removed).toContain(worktree.path);
      expect(await git(project.repo, "worktree", "list", "--porcelain")).not.toContain(worktree.path);
    },
    GIT_TIMEOUT,
  );

  it(
    "takes the display name with the worktree, and leaves it when a sibling shares the slug",
    async () => {
      const first = await cut("feat/eng-3941-answers");
      await writeDisplayName("demo", "eng-3941", "the answers page", env);
      const { docker } = fakeDocker();

      // Shared: the name is filed under the slug, so taking it would blank the
      // label on the worktree that is staying.
      await forgetGivenSlug(await cut("feat/eng-3941-selector"));
      await deleteWorktree({ project, branch: "feat/eng-3941-answers", docker, env });
      expect(await readDisplayName("demo", "eng-3941", env)).toBe("the answers page");

      // …and once nothing else resolves to it, the name goes too.
      await deleteWorktree({ project, branch: "feat/eng-3941-selector", docker, env });
      expect(await readDisplayName("demo", "eng-3941", env)).toBeNull();
      expect(existsSync(first.path)).toBe(false);
    },
    GIT_TIMEOUT,
  );

  // The state the collision fix creates, and the one every check here has to be
  // right about: the sibling's slug is *recorded* and carries a random token, so
  // nothing can re-derive it. A check that derived would compare the sibling
  // under `eng-3941` — the name this worktree holds — find a collision that is
  // not there, and keep a container nothing else is using.
  it(
    "sees a sibling under the slug it was given, not the one it would derive",
    async () => {
      const first = await cut("feat/eng-3941-answers");
      const sibling = await cut("feat/eng-3941-selector");

      const given = (await readFile(paths(env).slugFile("demo", basename(sibling.path)), "utf8")).trim();
      expect(given).toMatch(/^eng-3941-[a-z0-9]{4}$/);

      const { docker, argsOf } = fakeDocker([
        sandboxRow("eng-3941", first.path),
        sandboxRow(given, sibling.path),
      ]);
      const done = await deleteWorktree({ project, branch: "feat/eng-3941-answers", docker, env });

      // No false collision: the two answer to different names, so the sandbox
      // goes with the worktree.
      expect(done.sandbox).toBe("removed");
      expect(done.sharedWith).toEqual([]);
      // …and the right container. Deleting `eng-3941` must not reach the one
      // named for the token.
      expect(argsOf("rm").map((args) => args[0])).toEqual(["sandboxer-demo-eng-3941"]);
      expect(argsOf("volumeRm").map((args) => args[0])).not.toContain(`sandboxer-data-demo-${given}`);
      expect(existsSync(sibling.path)).toBe(true);

      // The sibling is still addressable by the name it actually has, and its
      // own delete finds its own container.
      const second = await deleteWorktree({ project, branch: "feat/eng-3941-selector", docker, env });
      expect(second.slug).toBe(given);
      expect(argsOf("rm").map((args) => args[0])).toEqual([
        "sandboxer-demo-eng-3941",
        `sandboxer-demo-${given}`,
      ]);
    },
    GIT_TIMEOUT,
  );

  it(
    "refuses a worktree it cannot find, without touching anything",
    async () => {
      const { docker, calls } = fakeDocker();
      await expect(deleteWorktree({ project, branch: "feat/nope", docker, env })).rejects.toThrow(
        /no worktree called feat\/nope in demo/,
      );
      expect(calls).toHaveLength(0);
    },
    GIT_TIMEOUT,
  );

  it(
    "removes the generated files a sandbox is named after",
    async () => {
      const worktree = await cut("feat/eng-3941-answers");
      const build = join(home, "build", "demo");
      const logs = join(home, "logs", "demo", "eng-3941");
      await mkdir(build, { recursive: true });
      await mkdir(logs, { recursive: true });
      await mkdir(join(home, "state", "attach", "demo"), { recursive: true });
      await writeFile(join(build, "eng-3941.plan.json"), "{}\n");
      await writeFile(join(build, "eng-3941.env"), "A=1\n");
      await writeFile(join(home, "state", "attach", "demo", "eng-3941"), "now\n");
      const { docker } = fakeDocker([sandboxRow("eng-3941", worktree.path)]);

      await deleteWorktree({ project, branch: "feat/eng-3941-answers", docker, env });

      expect(existsSync(join(build, "eng-3941.plan.json"))).toBe(false);
      expect(existsSync(join(build, "eng-3941.env"))).toBe(false);
      expect(existsSync(join(home, "state", "attach", "demo", "eng-3941"))).toBe(false);
      expect(existsSync(logs)).toBe(false);
    },
    GIT_TIMEOUT,
  );
});
