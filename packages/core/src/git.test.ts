// Tests for reading a worktree's git facts:
// - pickBranch: a plain branch, the parenthesised detached pseudo-entry, HEAD, a remote HEAD, empty input
// - dirtyFiles: staged and unstaged shapes, the generated-file ignore list, renames, empty input
// - branchOf: a checked-out branch, a detached tree recovered from a local branch, then from a remote one, then unknown
// - gitFacts: the happy path, a tree with no commits, and a directory git knows nothing about
// - gitMounts: a linked worktree gets itself and its repository, a plain checkout gets nothing
// - gitMounts: nothing at all for a non-repository, or a repository whose top is above the tree
// - hostGitIdentity: the environment wins, git config is the fallback, and neither is not an error

import { describe, expect, it } from "vitest";

import type { Runner } from "./docker.js";
import { DEFAULT_DIRTY_IGNORE, branchOf, dirtyFiles, gitFacts, gitMounts, hostGitIdentity, pickBranch } from "./git.js";

/** Answers git by the sub-command it was asked, so order does not matter. */
function fakeGit(answers: Record<string, { code?: number; stdout?: string }>): Runner {
  return async (_bin, args) => {
    // args are ["-C", worktree, <sub>, ...]
    const key = args.slice(2).join(" ");
    const match = Object.entries(answers).find(([prefix]) => key.startsWith(prefix));
    const reply = match?.[1] ?? { code: 1, stdout: "" };
    return { code: reply.code ?? 0, stdout: reply.stdout ?? "", stderr: "" };
  };
}

describe("pickBranch", () => {
  it.each([
    ["a plain branch", "feat/thing\n", "feat/thing"],
    ["the detached pseudo-entry is skipped", "(HEAD detached at abc1234)\nfeat/thing\n", "feat/thing"],
    ["a bare HEAD is skipped", "HEAD\nmain\n", "main"],
    ["a remote HEAD is skipped", "origin/HEAD\norigin/main\n", "origin/main"],
    ["nothing usable", "(HEAD detached at abc1234)\n", undefined],
    ["empty", "", undefined],
  ])("%s", (_name, stdout, want) => {
    expect(pickBranch(stdout)).toBe(want);
  });
});

describe("dirtyFiles", () => {
  it.each([
    ["an unstaged edit", " M src/a.ts", 1],
    ["a staged add", "A  src/a.ts", 1],
    ["an untracked file", "?? src/a.ts", 1],
    ["two changes", " M a\n?? b", 2],
    ["empty input", "", 0],
    ["blank lines only", "\n\n", 0],
  ])("counts %s", (_name, porcelain, want) => {
    expect(dirtyFiles(porcelain)).toHaveLength(want);
  });

  // Merely running a sandbox must not make its worktree dirty, or the commands
  // that refuse to touch a dirty tree would block themselves.
  it("ignores files a sandbox's own build generates", () => {
    const porcelain = "?? packages/web/.env.local\n M src/a.ts";
    expect(dirtyFiles(porcelain, DEFAULT_DIRTY_IGNORE)).toEqual([" M src/a.ts"]);
  });

  it("counts a change the ignore list does not cover", () => {
    expect(dirtyFiles("?? packages/web/.env.production", DEFAULT_DIRTY_IGNORE)).toHaveLength(1);
  });
});

describe("branchOf", () => {
  it("uses the checked-out branch", async () => {
    const run = fakeGit({ "rev-parse --abbrev-ref HEAD": { stdout: "feat/thing\n" } });
    expect(await branchOf("/w", run)).toBe("feat/thing");
  });

  it("recovers a detached tree's branch from a local ref", async () => {
    const run = fakeGit({
      "rev-parse --abbrev-ref HEAD": { stdout: "HEAD\n" },
      "branch --points-at HEAD": { stdout: "(HEAD detached at abc)\nfeat/thing\n" },
    });
    expect(await branchOf("/w", run)).toBe("feat/thing");
  });

  it("falls back to a remote ref, with the remote stripped", async () => {
    const run = fakeGit({
      "rev-parse --abbrev-ref HEAD": { stdout: "HEAD\n" },
      "branch --points-at HEAD": { stdout: "(HEAD detached at abc)\n" },
      "branch -r --points-at HEAD": { stdout: "origin/HEAD\norigin/feat/thing\n" },
    });
    expect(await branchOf("/w", run)).toBe("feat/thing");
  });

  it("answers ? rather than guessing", async () => {
    const run = fakeGit({});
    expect(await branchOf("/w", run)).toBe("?");
  });
});

describe("gitFacts", () => {
  it("reads the branch, the commit, the dirty flag and the directory name", async () => {
    const run = fakeGit({
      "rev-parse --show-toplevel": { stdout: "/repos/tkt-4821\n" },
      "rev-parse --short HEAD": { stdout: "abc1234\n" },
      "rev-parse --abbrev-ref HEAD": { stdout: "feat/tkt-4821\n" },
      "status --porcelain": { stdout: " M src/a.ts\n" },
    });
    expect(await gitFacts("/repos/tkt-4821/deep", { run })).toEqual({
      branch: "feat/tkt-4821",
      commit: "abc1234",
      dirty: true,
      worktree: "/repos/tkt-4821",
      directory: "tkt-4821",
    });
  });

  it("reports a clean tree as clean", async () => {
    const run = fakeGit({
      "rev-parse --show-toplevel": { stdout: "/w\n" },
      "rev-parse --short HEAD": { stdout: "abc\n" },
      "rev-parse --abbrev-ref HEAD": { stdout: "main\n" },
      "status --porcelain": { stdout: "" },
    });
    expect((await gitFacts("/w", { run })).dirty).toBe(false);
  });

  // A tree with no commit yet is still a tree worth running a sandbox from.
  it("degrades to ? for a repository with no commits", async () => {
    const run = fakeGit({
      "rev-parse --show-toplevel": { stdout: "/w\n" },
      "status --porcelain": { stdout: "" },
    });
    const facts = await gitFacts("/w", { run });
    expect(facts.commit).toBe("?");
    expect(facts.branch).toBe("?");
  });

  it("falls back to the path it was given when git knows nothing", async () => {
    const run = fakeGit({});
    expect(await gitFacts("/not/a/repo", { run })).toMatchObject({
      worktree: "/not/a/repo",
      directory: "repo",
      commit: "?",
      branch: "?",
      dirty: false,
    });
  });
});

describe("gitMounts", () => {
  const worktree = "/home/me/.sandboxr/workspace/acme/wt/staging";
  const repo = "/home/me/.sandboxr/workspace/acme/repo.git";

  it("mounts a linked worktree and the repository it points at", async () => {
    const run = fakeGit({
      "rev-parse --show-toplevel": { stdout: `${worktree}\n` },
      // What git answers for a linked worktree: absolute, and nowhere near the
      // tree being mounted.
      "rev-parse --git-common-dir": { stdout: `${repo}\n` },
    });
    expect(await gitMounts(worktree, { run })).toEqual([worktree, repo]);
  });

  it("mounts nothing for a plain checkout, whose .git is already in the tree", async () => {
    const run = fakeGit({
      "rev-parse --show-toplevel": { stdout: "/repos/acme\n" },
      // The relative answer an ordinary repository gives.
      "rev-parse --git-common-dir": { stdout: ".git\n" },
    });
    expect(await gitMounts("/repos/acme", { run })).toEqual([]);
  });

  it("mounts nothing when the tree is not a repository", async () => {
    const run = fakeGit({ "rev-parse --show-toplevel": { code: 128, stdout: "" } });
    expect(await gitMounts("/repos/acme", { run })).toEqual([]);
  });

  it("mounts nothing when the repository's top is above the tree being mounted", async () => {
    // A project kept in a subdirectory of a larger repository. Making git work
    // here would mean mounting the enclosing repository, and a git that finds
    // its .git above /workspace calls every file in the project deleted.
    const run = fakeGit({
      "rev-parse --show-toplevel": { stdout: "/repos/monorepo\n" },
      "rev-parse --git-common-dir": { stdout: "/repos/monorepo/.git\n" },
    });
    expect(await gitMounts("/repos/monorepo/services/acme", { run })).toEqual([]);
  });
});

describe("hostGitIdentity", () => {
  const refuse: Runner = async () => ({ code: 1, stdout: "", stderr: "" });

  it("takes the environment without asking git", async () => {
    const identity = await hostGitIdentity(
      { GIT_AUTHOR_NAME: "Ada", GIT_AUTHOR_EMAIL: "ada@example.com" },
      refuse,
    );
    expect(identity).toEqual({ name: "Ada", email: "ada@example.com" });
  });

  it("falls back to this machine's git config", async () => {
    const run: Runner = async (_bin, args) => ({
      code: 0,
      stdout: args.includes("user.name") ? "Ada\n" : "ada@example.com\n",
      stderr: "",
    });
    expect(await hostGitIdentity({}, run)).toEqual({ name: "Ada", email: "ada@example.com" });
  });

  it("treats a blank value as no value, so a shell profile exporting an empty name is not one", async () => {
    expect(await hostGitIdentity({ GIT_AUTHOR_NAME: "   " }, refuse)).toEqual({
      name: undefined,
      email: undefined,
    });
  });

  it("answers with nothing rather than throwing when the machine has no git", async () => {
    const explode: Runner = async () => {
      throw new Error("git: not found");
    };
    expect(await hostGitIdentity({}, explode)).toEqual({ name: undefined, email: undefined });
  });
});
