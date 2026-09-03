// Tests for cutting worktrees out of a project's bare clone:
// - parseWorktreeList: the bare first stanza is skipped, a detached stanza, and a path containing a space
// - addWorktree: an existing local branch, a new branch off a base, a branch only on origin
// - addWorktree: the same branch a second time comes back detached, and branchOf still names it
// - addWorktree: find-or-create returns the worktree already there rather than failing
// - addWorktree: a post-checkout hook that fails after the checkout does not lose the worktree
// - addWorktree: a branch name beginning "-" or containing ".." is refused
// - addWorktree: two branches on one ticket derive one slug, so the second worktree is given a unique one and it is recorded
// - addWorktree: a worktree that collided keeps its given slug when the same branch is asked for again
// - listWorktrees: a directory deleted by hand is still listed, with exists:false
// - listWorktrees: `committed` is git's own ISO date, and "" for every way reading it can fail
// - listWorktrees: `created` is the directory's birthtime, or "" where the filesystem has none
// - listWorktrees: a worktree that is gone is asked for neither date
// - removeWorktree: the worktree and its admin entry both go
// - listBranches: local and remote are one branch, named without the origin/ prefix
//
// Everything but parseWorktreeList runs real git against a temp clone: the
// behaviour under test *is* git's, so a mock would only assert that this file
// and the fake agree with each other.

import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { promisify } from "node:util";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { ExecResult, Runner } from "./docker.js";
import { branchOf } from "./git.js";
import type { Project } from "./workspace.js";
import { addWorktree, listBranches, listWorktrees, parseWorktreeList, removeWorktree } from "./worktree.js";
import { readRecordedSlug, slugFor } from "./worktree-slug.js";

const exec = promisify(execFile);

/** Shelling out to git is slow on a cold filesystem, and CI's is always cold. */
const GIT_TIMEOUT = 30_000;

async function git(dir: string, ...args: string[]): Promise<string> {
  const { stdout } = await exec("git", ["-C", dir, ...args]);
  return stdout;
}

describe("parseWorktreeList", () => {
  // The stanza a bare repository puts first has no HEAD and no directory anybody
  // could run: reporting it as a worktree gives every project a phantom one.
  it("skips the bare repository's own stanza", () => {
    const porcelain = [
      "worktree /w/repo.git",
      "bare",
      "",
      "worktree /w/wt/main",
      "HEAD abc1234def5678",
      "branch refs/heads/main",
      "",
    ].join("\n");

    expect(parseWorktreeList(porcelain)).toEqual([
      { path: "/w/wt/main", head: "abc1234def5678", branch: "main", detached: false },
    ]);
  });

  it("reads a detached stanza as having no branch", () => {
    const porcelain = ["worktree /w/wt/feat-thing", "HEAD abc1234def5678", "detached", ""].join("\n");

    expect(parseWorktreeList(porcelain)).toEqual([
      { path: "/w/wt/feat-thing", head: "abc1234def5678", branch: "?", detached: true },
    ]);
  });

  // The reason this reads the porcelain form at all: the human listing separates
  // its columns with spaces, so this path would take the sha's place.
  it("keeps a path containing a space", () => {
    const porcelain = [
      "worktree /Users/a/My Repos/wt/main",
      "HEAD abc1234def5678",
      "branch refs/heads/main",
      "",
    ].join("\n");

    expect(parseWorktreeList(porcelain)[0]?.path).toBe("/Users/a/My Repos/wt/main");
  });

  it("strips only the refs/heads/ prefix, leaving a slashed branch whole", () => {
    const porcelain = "worktree /w/wt/x\nHEAD abc\nbranch refs/heads/feat/tkt-4821\n";
    expect(parseWorktreeList(porcelain)[0]?.branch).toBe("feat/tkt-4821");
  });

  it("is empty for empty input", () => {
    expect(parseWorktreeList("")).toEqual([]);
  });
});

describe("worktrees on a real repository", () => {
  let root: string;
  let source: string;
  let project: Project;

  beforeAll(async () => {
    // Resolved, because git records a worktree by its real path and the system
    // temp directory is a symlink on macOS — comparing the two as strings
    // otherwise fails in a way that looks nothing like a symlink.
    root = await realpath(await mkdtemp(join(tmpdir(), "sandboxr-worktree-")));
    source = join(root, "source");

    // A source repo with two branches, then a bare clone of it — the same shape
    // workspace.ts's cloneProject leaves behind, including the refspec, without
    // depending on that module's workspace directory.
    await exec("git", ["init", "-b", "main", source]);
    await git(source, "config", "user.email", "test@example.com");
    await git(source, "config", "user.name", "Test");
    await writeFile(join(source, "README.md"), "one\n");
    await git(source, "add", ".");
    await git(source, "commit", "-m", "one");
    await git(source, "checkout", "-b", "feat/tkt-4821");
    await writeFile(join(source, "README.md"), "two\n");
    await git(source, "commit", "-am", "two");
    await git(source, "checkout", "main");

    const repo = join(root, "repo.git");
    await exec("git", ["clone", "--bare", source, repo]);
    await git(repo, "config", "remote.origin.fetch", "+refs/heads/*:refs/remotes/origin/*");
    await git(repo, "fetch", "origin");

    project = { name: "demo", repo, worktrees: join(root, "wt"), base: "main", origin: source };
  }, GIT_TIMEOUT);

  afterAll(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it(
    "adds a worktree for an existing local branch",
    async () => {
      const worktree = await addWorktree({ project, branch: "feat/tkt-4821" });

      // The directory is the slug, so a slashed branch stays one path segment.
      expect(worktree.path).toBe(join(project.worktrees, "feat-tkt-4821"));
      expect(worktree.branch).toBe("feat/tkt-4821");
      expect(worktree.detached).toBe(false);
      expect(worktree.exists).toBe(true);
      expect(worktree.head).not.toBe("?");
      expect(existsSync(join(worktree.path, "README.md"))).toBe(true);
    },
    GIT_TIMEOUT,
  );

  it(
    "returns the worktree already there rather than failing",
    async () => {
      const again = await addWorktree({ project, branch: "feat/tkt-4821" });

      expect(again.path).toBe(join(project.worktrees, "feat-tkt-4821"));
      expect(again.detached).toBe(false);
      expect(await listWorktrees(project)).toHaveLength(1);
    },
    GIT_TIMEOUT,
  );

  it(
    "creates a new branch off a base",
    async () => {
      const worktree = await addWorktree({ project, branch: "feat/new-thing", base: "origin/main" });

      expect(worktree.branch).toBe("feat/new-thing");
      expect(worktree.detached).toBe(false);
      expect((await git(project.repo, "branch", "--list", "feat/new-thing")).trim()).not.toBe("");
    },
    GIT_TIMEOUT,
  );

  // The property the whole scheme rests on: git will not check out one branch in
  // two places, so the second worktree is detached — and a detached worktree is
  // still nameable, or the sandbox it runs would be labelled "?" for ever.
  it(
    "detaches when the branch is already checked out, and branchOf still names it",
    async () => {
      const second: Project = { ...project, worktrees: join(root, "wt2") };
      const worktree = await addWorktree({ project: second, branch: "feat/tkt-4821" });

      expect(worktree.detached).toBe(true);
      expect(worktree.path).toBe(join(second.worktrees, "feat-tkt-4821"));
      expect(worktree.branch).toBe("feat/tkt-4821");
      expect(await branchOf(worktree.path)).toBe("feat/tkt-4821");
    },
    GIT_TIMEOUT,
  );

  it(
    "creates a local branch for one that only exists on origin",
    async () => {
      await git(source, "checkout", "-b", "feat/pushed-later");
      await writeFile(join(source, "README.md"), "three\n");
      await git(source, "commit", "-am", "three");
      await git(source, "checkout", "main");
      await git(project.repo, "fetch", "origin");

      // Only the remote-tracking ref exists at this point.
      expect((await git(project.repo, "branch", "--list", "feat/pushed-later")).trim()).toBe("");

      const worktree = await addWorktree({ project, branch: "feat/pushed-later" });
      expect(worktree.branch).toBe("feat/pushed-later");
      expect(worktree.detached).toBe(false);
    },
    GIT_TIMEOUT,
  );

  it(
    "refuses a branch git would read as an option or a range",
    async () => {
      await expect(addWorktree({ project, branch: "--upload-pack=touch" })).rejects.toThrow(/reads? as an option/);
      await expect(addWorktree({ project, branch: "main..other" })).rejects.toThrow(/commit range/);
      await expect(addWorktree({ project, branch: "  " })).rejects.toThrow(/branch name is required/);
    },
    GIT_TIMEOUT,
  );

  it(
    "refuses a branch that exists nowhere",
    async () => {
      await expect(addWorktree({ project, branch: "feat/never-existed" })).rejects.toThrow(/does not exist/);
    },
    GIT_TIMEOUT,
  );

  it(
    "reports a worktree deleted by hand as not existing",
    async () => {
      const worktree = await addWorktree({ project, branch: "feat/deleted-by-hand", base: "origin/main" });
      await rm(worktree.path, { recursive: true, force: true });

      const listed = (await listWorktrees(project)).find((entry) => entry.path === worktree.path);
      expect(listed).toBeDefined();
      expect(listed?.exists).toBe(false);
    },
    GIT_TIMEOUT,
  );

  it(
    "removes a worktree and its admin entry",
    async () => {
      const worktree = await addWorktree({ project, branch: "feat/short-lived", base: "origin/main" });
      await removeWorktree(project, worktree.path);

      expect(existsSync(worktree.path)).toBe(false);
      expect((await listWorktrees(project)).map((entry) => entry.path)).not.toContain(worktree.path);
    },
    GIT_TIMEOUT,
  );

  it(
    "lists a branch once, without its origin/ prefix",
    async () => {
      const branches = await listBranches(project);
      const names = branches.map((branch) => branch.name);

      expect(names).not.toContain("HEAD");
      expect(names.some((name) => name.startsWith("origin/"))).toBe(false);
      expect(names.filter((name) => name === "main")).toHaveLength(1);
      expect(branches.find((branch) => branch.name === "main")?.remote).toBe(false);
      expect(branches.find((branch) => branch.name === "main")?.updated).not.toBe("");
    },
    GIT_TIMEOUT,
  );
});

// A repository hook runs after the checkout is already written, so git can exit
// non-zero for a worktree that is on disk and perfectly fine.
describe("a post-checkout hook that fails", () => {
  let root: string;
  let project: Project;

  beforeAll(async () => {
    root = await realpath(await mkdtemp(join(tmpdir(), "sandboxr-worktree-hook-")));
    const source = join(root, "source");

    await exec("git", ["init", "-b", "main", source]);
    await git(source, "config", "user.email", "test@example.com");
    await git(source, "config", "user.name", "Test");
    await writeFile(join(source, "README.md"), "one\n");
    await git(source, "add", ".");
    await git(source, "commit", "-m", "one");

    const repo = join(root, "repo.git");
    await exec("git", ["clone", "--bare", source, repo]);
    await git(repo, "config", "remote.origin.fetch", "+refs/heads/*:refs/remotes/origin/*");
    await git(repo, "fetch", "origin");

    const hooks = join(root, "hooks");
    await exec("mkdir", ["-p", hooks]);
    await writeFile(join(hooks, "post-checkout"), "#!/bin/sh\nexit 1\n", { mode: 0o755 });
    await git(repo, "config", "core.hooksPath", hooks);

    project = { name: "hooky", repo, worktrees: join(root, "wt"), base: "main", origin: source };
  }, GIT_TIMEOUT);

  afterAll(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it(
    "keeps the worktree and says a hook failed",
    async () => {
      const lines: string[] = [];
      const worktree = await addWorktree({ project, branch: "main", log: (line) => lines.push(line) });

      expect(worktree.exists).toBe(true);
      expect(worktree.branch).toBe("main");
      expect(lines.join("\n")).toMatch(/hook failed/);
    },
    GIT_TIMEOUT,
  );
});

/**
 * Two branches on one ticket, which §3.1's readable-slug rule guarantees will
 * happen.
 *
 * The worktrees have to be cut inside a real workspace, because that layout is
 * what a slug record is keyed on — this is the one test where
 * `SANDBOXR_WORKSPACE` is load-bearing rather than incidental.
 */
describe("two worktrees on one ticket", () => {
  let root: string;
  let env: NodeJS.ProcessEnv;
  let project: Project;

  const first = "feat/eng-3941-labs-answers-page";
  const second = "feat/eng-3941-labs-run-selector";

  beforeAll(async () => {
    root = await realpath(await mkdtemp(join(tmpdir(), "sandboxr-worktree-slug-")));
    const source = join(root, "source");
    const workspace = join(root, "workspace");
    env = { SANDBOXR_HOME: join(root, "home"), SANDBOXR_WORKSPACE: workspace };

    await exec("git", ["init", "-b", "main", source]);
    await git(source, "config", "user.email", "test@example.com");
    await git(source, "config", "user.name", "Test");
    await writeFile(join(source, "README.md"), "one\n");
    await git(source, "add", ".");
    await git(source, "commit", "-m", "one");
    for (const branch of [first, second]) {
      await git(source, "checkout", "-b", branch, "main");
      await writeFile(join(source, "README.md"), `${branch}\n`);
      await git(source, "commit", "-am", branch);
    }
    await git(source, "checkout", "main");

    const repo = join(workspace, "acme", "repo.git");
    await exec("git", ["clone", "--bare", source, repo]);
    await git(repo, "config", "remote.origin.fetch", "+refs/heads/*:refs/remotes/origin/*");
    await git(repo, "fetch", "origin");

    project = {
      name: "acme",
      repo,
      worktrees: join(workspace, "acme", "wt"),
      base: "main",
      origin: source,
    };
  }, GIT_TIMEOUT);

  afterAll(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it(
    "gives the second worktree a slug of its own, and writes it down",
    async () => {
      const lines: string[] = [];
      const one = await addWorktree({ project, branch: first, env });
      const two = await addWorktree({ project, branch: second, env, log: (line) => lines.push(line) });

      // The whole point: without the guard both of these are `eng-3941`, so the
      // second `up` would replace the first one's container and mount its data
      // volume — one sandbox for two unrelated branches.
      const slugOne = await slugFor({ worktree: one.path, project: project.name, branch: one.branch, env });
      const slugTwo = await slugFor({ worktree: two.path, project: project.name, branch: two.branch, env });

      expect(slugOne).toBe("eng-3941");
      expect(slugTwo).not.toBe(slugOne);
      expect(slugTwo).toMatch(/^eng-3941-[a-z0-9]{4}$/);
      expect(lines.join("\n")).toMatch(/already answers to "eng-3941"/);

      // Recorded, because a random token cannot be derived again.
      expect(await readRecordedSlug(project.name, basename(two.path), env)).toBe(slugTwo);
      expect(await readRecordedSlug(project.name, basename(one.path), env)).toBeNull();
    },
    GIT_TIMEOUT,
  );

  it(
    "keeps the slug it was given when the same branch is asked for again",
    async () => {
      const before = await readRecordedSlug(project.name, "feat-eng-3941-labs-run-selector", env);
      const again = await addWorktree({ project, branch: second, env });

      expect(again.path).toBe(join(project.worktrees, "feat-eng-3941-labs-run-selector"));
      expect(await readRecordedSlug(project.name, basename(again.path), env)).toBe(before);
    },
    GIT_TIMEOUT,
  );

  it(
    "forgets the record when the worktree goes",
    async () => {
      const path = join(project.worktrees, "feat-eng-3941-labs-run-selector");
      expect(await readRecordedSlug(project.name, "feat-eng-3941-labs-run-selector", env)).not.toBeNull();

      await removeWorktree(project, path, { force: true, env });
      expect(await readRecordedSlug(project.name, "feat-eng-3941-labs-run-selector", env)).toBeNull();
    },
    GIT_TIMEOUT,
  );
});

/**
 * The two dates, against a stubbed git and real directories.
 *
 * Real directories because `exists` is checked on the filesystem and both dates
 * hang off it; a stubbed git because the interesting cases are the failures — an
 * unreadable repository, a branch with no commits, a runner that throws — and
 * none of them is arrangeable on a repository that works.
 */
describe("the dates a worktree carries", () => {
  let root: string;
  let project: Project;
  let tree: string;

  const porcelain = (path: string): string =>
    [`worktree ${path}`, "HEAD abc1234def5678", "branch refs/heads/main", ""].join("\n");

  const ok = (stdout: string): ExecResult => ({ code: 0, stdout, stderr: "" });

  /** A runner that answers the listing, and whatever it is given for `git log`. */
  const runner =
    (log: ExecResult | Error): Runner =>
    async (_bin, args) => {
      if (args.includes("--porcelain")) return ok(porcelain(tree));
      if (log instanceof Error) throw log;
      return log;
    };

  beforeAll(async () => {
    root = await realpath(await mkdtemp(join(tmpdir(), "sandboxr-worktree-dates-")));
    tree = join(root, "wt", "main");
    await exec("mkdir", ["-p", tree]);
    project = { name: "demo", repo: join(root, "repo.git"), worktrees: join(root, "wt"), base: "main", origin: "" };
  });

  afterAll(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it.each([
    // `%cI` keeps the offset the commit was made with, which is the reason to ask
    // for it rather than for a rendered date: `%cd` follows the machine's own
    // `log.date` setting, so a gitconfig saying `relative` would have this
    // answering "3 days ago".
    ["git's own strict ISO date", ok("2026-08-24T09:00:00+01:00\n"), "2026-08-24T09:00:00+01:00"],
    ["a UTC one", ok("2026-08-24T09:00:00Z\n"), "2026-08-24T09:00:00Z"],
    ["a repository git will not read", { code: 128, stdout: "", stderr: "fatal: not a git repository" }, ""],
    // A branch created and never committed to. git exits zero and prints
    // nothing, which is neither an error nor a date.
    ["a branch with no commits", ok("\n"), ""],
    ["a runner that throws outright", new Error("git is not installed"), ""],
  ])("reads %s as %j", async (_name, log, expected) => {
    const [worktree] = await listWorktrees(project, { run: runner(log) });
    expect(worktree?.committed).toBe(expected);
  });

  it("still answers a listing when reading the date threw", async () => {
    await expect(listWorktrees(project, { run: runner(new Error("boom")) })).resolves.toHaveLength(1);
  });

  // Not asserted as an exact instant: the value comes from the filesystem, and
  // the filesystems with no birthtime at all are exactly the case the guard
  // exists for. Either answer is right; a date from 1970 or from next year is
  // not, and both are what an unguarded `birthtime` hands back.
  it("stamps the directory's own creation time, or says nothing", async () => {
    const [worktree] = await listWorktrees(project, { run: runner(ok("2026-08-24T09:00:00Z\n")) });
    const created = worktree?.created ?? "";
    if (created === "") return;

    const at = Date.parse(created);
    expect(Number.isFinite(at)).toBe(true);
    expect(at).toBeGreaterThan(Date.now() - 600_000);
    expect(at).toBeLessThanOrEqual(Date.now() + 1000);
  });

  it("asks for neither date about a worktree that is no longer on disk", async () => {
    const asked: string[][] = [];
    const gone = join(root, "wt", "vanished");
    const run: Runner = async (_bin, args) => {
      asked.push(args);
      return args.includes("--porcelain") ? ok(porcelain(gone)) : ok("2026-08-24T09:00:00Z");
    };

    const [worktree] = await listWorktrees(project, { run });
    expect(worktree?.exists).toBe(false);
    expect(worktree?.committed).toBe("");
    expect(worktree?.created).toBe("");
    expect(asked.some((args) => args.includes("log"))).toBe(false);
  });
});
