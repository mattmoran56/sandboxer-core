// Tests for pulling a worktree up to its branch's head on the remote:
// - statusPaths: an ordinary entry, an untracked one, a rename's two halves, a copy
// - untrackedBlocks: an exact path, an untracked directory standing over an incoming file, a near miss
// - pullWorktree, attached: already up to date, and a clean fast-forward that moves the branch
// - pullWorktree, detached: the branch recovered from the commit, and the same fast-forward
// - pullWorktree: the fetch goes to the project's mirror and never to the worktree
// - pullWorktree refusals: a missing directory, no branch, no branch on origin, divergence
// - pullWorktree, rewritten upstream: moved onto by checkout when no local commit is absent from it,
//   detached moving HEAD alone, and never by reset --hard
// - pullWorktree divergence: counted and named by patch, so only the commits origin has no
//   equivalent of are reported — and a git cherry that cannot answer falls back to the sha count
// - pullWorktree refusals: tracked files the incoming commits also touch, untracked files clobbered
// - pullWorktree: every reason is reported at once, and nothing is merged when any is present
// - pullWorktree: a merge that fails anyway is a refusal carrying git's own words
// - pullReport: the wording of all four outcomes, and the headline a refusal leads with
// - freshenBranch: it fetches the mirror before it resolves anything, and never the worktree
// - freshenBranch: a given base wins, and needs nothing reconciled
// - freshenBranch: a local branch behind origin is fast-forwarded, with the old sha as the guard
// - freshenBranch: a branch held by another worktree is never moved — the start ref is origin's
// - freshenBranch: a diverged local branch is left alone, and both distances are reported
// - freshenBranch: a branch only on origin, a branch origin does not have, and an unreachable remote

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import type { Runner } from "./docker.js";
import {
  freshenBranch,
  pullReport,
  pullWorktree,
  statusPaths,
  untrackedBlocks,
  type PullResult,
} from "./pull.js";
import type { Project } from "./workspace.js";

const HEAD = "1111111111111111111111111111111111111111";
const TARGET = "2222222222222222222222222222222222222222";

const dirs: string[] = [];

/** A directory that really exists, because `pullWorktree` stats the worktree. */
function realDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "sandboxr-pull-"));
  dirs.push(dir);
  return dir;
}

afterEach(() => {
  while (dirs.length) rmSync(dirs.pop() as string, { recursive: true, force: true });
});

const project = (repo: string): Project => ({
  name: "acme",
  repo,
  worktrees: join(repo, "..", "wt"),
  base: "main",
  origin: "git@github.com:acme/acme.git",
});

interface Reply {
  code?: number;
  stdout?: string;
  stderr?: string;
}

/**
 * Answers git by the sub-command it was asked, recording every call.
 *
 * Keyed on the arguments after `-C <dir>`, like git.test.ts's fake, with the
 * directory kept beside it so a test can assert *where* the fetch ran — which is
 * the whole point of routing it through the project's mirror.
 */
function fakeGit(answers: Record<string, Reply>) {
  const calls: { dir: string; args: string[] }[] = [];
  const run: Runner = async (_bin, args) => {
    const dir = args[0] === "-C" ? args[1] ?? "" : "";
    const rest = args[0] === "-C" ? args.slice(2) : args;
    calls.push({ dir, args: rest });
    const key = rest.join(" ");
    const match = Object.entries(answers)
      .filter(([prefix]) => key.startsWith(prefix))
      // The longest matching prefix wins, so "rev-parse HEAD" and
      // "rev-parse --verify" can be answered differently.
      .sort((a, b) => b[0].length - a[0].length)[0];
    const reply = match?.[1] ?? { code: 1 };
    return { code: reply.code ?? 0, stdout: reply.stdout ?? "", stderr: reply.stderr ?? "" };
  };
  return { run, calls };
}

/** The answers a clean, attached, one-commit-behind worktree gives. */
const behind = (overrides: Record<string, Reply> = {}): Record<string, Reply> => ({
  "symbolic-ref": { code: 0, stdout: "feat/thing\n" },
  "rev-parse HEAD": { code: 0, stdout: `${HEAD}\n` },
  "rev-parse --verify": { code: 0, stdout: `${TARGET}\n` },
  "merge-base --is-ancestor": { code: 0 },
  "diff --name-only": { code: 0, stdout: "src/a.ts\n" },
  "status --porcelain": { code: 0, stdout: "" },
  "rev-list --count": { code: 0, stdout: "3\n" },
  merge: { code: 0 },
  fetch: { code: 0 },
  ...overrides,
});

describe("statusPaths", () => {
  it.each([
    ["an unstaged edit", " M src/a.ts", ["src/a.ts"]],
    ["an untracked file", "?? src/a.ts", ["src/a.ts"]],
    ["an untracked directory", "?? src/new/", ["src/new/"]],
    ["a rename names both halves", "R  src/old.ts -> src/new.ts", ["src/old.ts", "src/new.ts"]],
    ["a copy names both halves", "C  src/a.ts -> src/b.ts", ["src/a.ts", "src/b.ts"]],
  ])("%s", (_name, line, want) => {
    expect(statusPaths(line)).toEqual(want);
  });
});

describe("untrackedBlocks", () => {
  it.each([
    ["the same file", "src/a.ts", "src/a.ts", true],
    ["a different file", "src/a.ts", "src/b.ts", false],
    // git collapses a wholly untracked directory into one entry, so this is the
    // only shape that catches an incoming file inside it.
    ["a directory over an incoming file", "src/new/", "src/new/thing.ts", true],
    ["a directory that does not contain it", "src/new/", "src/old/thing.ts", false],
  ])("%s", (_name, entry, incoming, want) => {
    expect(untrackedBlocks(entry, incoming)).toBe(want);
  });
});

describe("pullWorktree", () => {
  it("says nothing arrived when the remote is where HEAD already is", async () => {
    const worktree = realDir();
    const { run } = fakeGit(behind({ "rev-parse --verify": { code: 0, stdout: `${HEAD}\n` } }));

    const result = await pullWorktree({ project: project(realDir()), worktree, run });

    expect(result.outcome).toBe("up-to-date");
    expect(result.branch).toBe("feat/thing");
    expect(result.commits).toBe(0);
  });

  it("fast-forwards an attached worktree and reports the range", async () => {
    const worktree = realDir();
    const { run, calls } = fakeGit(behind());

    const result = await pullWorktree({ project: project(realDir()), worktree, run });

    expect(result).toMatchObject({
      outcome: "fast-forwarded",
      branch: "feat/thing",
      detached: false,
      from: HEAD.slice(0, 7),
      to: TARGET.slice(0, 7),
      commits: 3,
    });
    // Fast-forward or nothing: no merge strategy, no rebase, no reset.
    const merge = calls.find((call) => call.args[0] === "merge");
    expect(merge?.args).toEqual(["merge", "--ff-only", TARGET]);
    expect(calls.some((call) => call.args[0] === "rebase" || call.args[0] === "reset")).toBe(false);
  });

  // The normal case for a managed worktree: git will not check one branch out
  // twice, so the branch is recovered from the commit rather than read off HEAD.
  it("fast-forwards a detached worktree, naming the branch it recovered", async () => {
    const worktree = realDir();
    const { run } = fakeGit(
      behind({
        "symbolic-ref": { code: 1 },
        "rev-parse --abbrev-ref HEAD": { code: 0, stdout: "HEAD\n" },
        "branch --points-at": { code: 0, stdout: "(HEAD detached at 1111111)\nfeat/thing\n" },
      }),
    );

    const result = await pullWorktree({ project: project(realDir()), worktree, run });

    expect(result).toMatchObject({ outcome: "fast-forwarded", branch: "feat/thing", detached: true });
  });

  // One fetch, into the mirror the refspec is configured on. A fetch run in the
  // worktree would be a second way of talking to the remote.
  it("fetches the project's mirror and never the worktree", async () => {
    const worktree = realDir();
    const repo = realDir();
    const { run, calls } = fakeGit(behind());

    await pullWorktree({ project: project(repo), worktree, run });

    const fetches = calls.filter((call) => call.args[0] === "fetch");
    expect(fetches).toEqual([{ dir: repo, args: ["fetch", "origin"] }]);
  });

  it("refuses a worktree whose directory has been deleted, without running git", async () => {
    const gone = join(realDir(), "not-here");
    const { run, calls } = fakeGit(behind());

    const result = await pullWorktree({ project: project(realDir()), worktree: gone, run });

    expect(result.outcome).toBe("refused");
    expect(result.refusals.map((refusal) => refusal.kind)).toEqual(["missing"]);
    expect(calls).toEqual([]);
  });

  it("refuses a worktree no branch points at, and does not fetch for it", async () => {
    const worktree = realDir();
    const { run, calls } = fakeGit(
      behind({
        "symbolic-ref": { code: 1 },
        "rev-parse --abbrev-ref HEAD": { code: 0, stdout: "HEAD\n" },
        "branch --points-at": { code: 0, stdout: "(HEAD detached at 1111111)\n" },
        "branch -r --points-at": { code: 0, stdout: "" },
      }),
    );

    const result = await pullWorktree({ project: project(realDir()), worktree, run });

    expect(result.refusals.map((refusal) => refusal.kind)).toEqual(["no-branch"]);
    expect(calls.some((call) => call.args[0] === "fetch")).toBe(false);
  });

  it("refuses when origin has no branch of that name, and says so by name", async () => {
    const worktree = realDir();
    const { run } = fakeGit(behind({ "rev-parse --verify": { code: 1 } }));

    const result = await pullWorktree({ project: project(realDir()), worktree, run });

    expect(result.refusals[0]?.kind).toBe("no-remote-branch");
    expect(result.refusals[0]?.message).toContain("origin has no branch called feat/thing");
  });

  it("refuses a divergence, counting the local commits rather than the ones it names", async () => {
    const worktree = realDir();
    const { run, calls } = fakeGit(
      behind({
        "merge-base --is-ancestor": { code: 1 },
        "log --format=%h %s": { code: 0, stdout: "aaa1111 one\nbbb2222 two\n" },
        "rev-list --count 2222": { code: 0, stdout: "9\n" },
      }),
    );

    const result = await pullWorktree({ project: project(realDir()), worktree, run });

    expect(result.outcome).toBe("refused");
    const diverged = result.refusals.find((refusal) => refusal.kind === "diverged");
    expect(diverged?.message).toContain("9 commits");
    expect(diverged?.message).toContain("aaa1111 one");
    expect(calls.some((call) => call.args[0] === "merge")).toBe(false);
  });

  // A rebase and force-push upstream. Every commit here is on origin under a new
  // sha, so a sha comparison calls it a divergence and a patch comparison shows
  // there is nothing to lose. This is the case that made the button useless on a
  // managed worktree, where a rewritten branch is ordinary rather than rare.
  it("moves onto a rewritten upstream when no local commit is absent from it", async () => {
    const worktree = realDir();
    const { run, calls } = fakeGit(
      behind({
        "merge-base --is-ancestor": { code: 1 },
        "cherry -v": { code: 0, stdout: `- ${HEAD} one\n- ${TARGET} two\n` },
        checkout: { code: 0 },
      }),
    );

    const result = await pullWorktree({ project: project(realDir()), worktree, run });

    expect(result).toMatchObject({ outcome: "replaced", branch: "feat/thing", refusals: [] });
    // Attached, so the branch moves with HEAD — and by `checkout`, which refuses
    // to overwrite an uncommitted change. Never `reset --hard`, which would not.
    expect(calls.some((call) => call.args.join(" ").startsWith("checkout -B feat/thing"))).toBe(true);
    expect(calls.some((call) => call.args[0] === "merge")).toBe(false);
    expect(calls.some((call) => call.args.includes("--hard"))).toBe(false);
  });

  it("moves a detached worktree's HEAD alone onto a rewritten upstream", async () => {
    const worktree = realDir();
    const { run, calls } = fakeGit(
      behind({
        "symbolic-ref": { code: 1 },
        "rev-parse --abbrev-ref HEAD": { code: 0, stdout: "HEAD\n" },
        "branch --points-at": { code: 0, stdout: "(HEAD detached at 1111111)\nfeat/thing\n" },
        "merge-base --is-ancestor": { code: 1 },
        "cherry -v": { code: 0, stdout: `- ${HEAD} one\n` },
        checkout: { code: 0 },
      }),
    );

    const result = await pullWorktree({ project: project(realDir()), worktree, run });

    expect(result).toMatchObject({ outcome: "replaced", detached: true });
    expect(calls.some((call) => call.args.join(" ").startsWith("checkout --detach"))).toBe(true);
  });

  // The number and the names are the only things somebody can act on, so a
  // divergence reports the commits that would really be lost — not the whole
  // pre-rebase history, which is what counting shas gives.
  it("counts and names only the commits origin has no equivalent of", async () => {
    const worktree = realDir();
    const { run, calls } = fakeGit(
      behind({
        "merge-base --is-ancestor": { code: 1 },
        "cherry -v": {
          code: 0,
          stdout: `- ${HEAD} already there\n+ aaa1111aaa1111 mine one\n- ${TARGET} also there\n+ bbb2222bbb2222 mine two\n`,
        },
        "rev-list --count 2222": { code: 0, stdout: "107\n" },
      }),
    );

    const result = await pullWorktree({ project: project(realDir()), worktree, run });

    expect(result.outcome).toBe("refused");
    const diverged = result.refusals.find((refusal) => refusal.kind === "diverged");
    expect(diverged?.summary).toBe("2 local commits not on origin/feat/thing");
    expect(diverged?.files).toEqual(["aaa1111 mine one", "bbb2222 mine two"]);
    expect(diverged?.message).not.toContain("already there");
    expect(calls.some((call) => call.args[0] === "checkout")).toBe(false);
  });

  // An unreadable classification has to refuse, never assume. Falling through to
  // the sha comparison is what keeps a broken `cherry` from moving a worktree.
  it("falls back to the sha comparison when git cherry cannot answer", async () => {
    const worktree = realDir();
    const { run, calls } = fakeGit(
      behind({
        "merge-base --is-ancestor": { code: 1 },
        "cherry -v": { code: 128, stderr: "fatal: bad revision\n" },
        "log --format=%h %s": { code: 0, stdout: "aaa1111 one\n" },
        "rev-list --count 2222": { code: 0, stdout: "9\n" },
      }),
    );

    const result = await pullWorktree({ project: project(realDir()), worktree, run });

    expect(result.outcome).toBe("refused");
    expect(result.refusals.find((refusal) => refusal.kind === "diverged")?.message).toContain("9 commits");
    expect(calls.some((call) => call.args[0] === "checkout")).toBe(false);
  });

  it("refuses when an uncommitted change is to a file the incoming commits also touch", async () => {
    const worktree = realDir();
    const { run, calls } = fakeGit(
      behind({
        "diff --name-only": { code: 0, stdout: "src/a.ts\nsrc/b.ts\n" },
        "status --porcelain": { code: 0, stdout: " M src/a.ts\n M src/untouched.ts\n" },
      }),
    );

    const result = await pullWorktree({ project: project(realDir()), worktree, run });

    const refusal = result.refusals.find((entry) => entry.kind === "local-changes");
    expect(refusal?.files).toEqual(["src/a.ts"]);
    expect(refusal?.message).toContain("src/a.ts");
    // A dirty file the incoming commits do not touch is not in the way of anything.
    expect(refusal?.message).not.toContain("src/untouched.ts");
    expect(calls.some((call) => call.args[0] === "merge")).toBe(false);
  });

  it("refuses when an untracked directory stands over an incoming file", async () => {
    const worktree = realDir();
    const { run } = fakeGit(
      behind({
        "diff --name-only": { code: 0, stdout: "src/new/thing.ts\n" },
        "status --porcelain": { code: 0, stdout: "?? src/new/\n" },
      }),
    );

    const result = await pullWorktree({ project: project(realDir()), worktree, run });

    expect(result.refusals.map((entry) => entry.kind)).toEqual(["untracked"]);
    expect(result.refusals[0]?.files).toEqual(["src/new/thing.ts"]);
  });

  // A build inside a sandbox writes files the branch's .gitignore does not
  // cover, and counting those would mean running a worktree made it unpullable.
  it("ignores the files a sandbox's own build generates", async () => {
    const worktree = realDir();
    const { run } = fakeGit(
      behind({
        "diff --name-only": { code: 0, stdout: "packages/web/.env.local\n" },
        "status --porcelain": { code: 0, stdout: "?? packages/web/.env.local\n" },
      }),
    );

    const result = await pullWorktree({ project: project(realDir()), worktree, run });

    expect(result.outcome).toBe("fast-forwarded");
  });

  it("reports every reason at once rather than the first", async () => {
    const worktree = realDir();
    const { run } = fakeGit(
      behind({
        "merge-base --is-ancestor": { code: 1 },
        "log --format=%h %s": { code: 0, stdout: "aaa1111 one\n" },
        "rev-list --count 2222": { code: 0, stdout: "1\n" },
        "diff --name-only": { code: 0, stdout: "src/a.ts\nsrc/new/thing.ts\n" },
        "status --porcelain": { code: 0, stdout: " M src/a.ts\n?? src/new/\n" },
      }),
    );

    const result = await pullWorktree({ project: project(realDir()), worktree, run });

    expect(result.refusals.map((entry) => entry.kind)).toEqual(["diverged", "local-changes", "untracked"]);
  });

  it("turns a merge that fails anyway into a refusal carrying git's own words", async () => {
    const worktree = realDir();
    const { run } = fakeGit(behind({ merge: { code: 128, stderr: "fatal: Not possible to fast-forward\n" } }));

    const result = await pullWorktree({ project: project(realDir()), worktree, run });

    expect(result.outcome).toBe("refused");
    expect(result.refusals[0]?.message).toContain("Not possible to fast-forward");
  });
});

describe("pullReport", () => {
  const result = (overrides: Partial<PullResult>): PullResult => ({
    outcome: "up-to-date",
    branch: "feat/thing",
    detached: false,
    from: "1111111",
    to: "1111111",
    commits: 0,
    refusals: [],
    ...overrides,
  });

  it("says a worktree is already up to date, and where", () => {
    expect(pullReport(result({}))).toEqual([
      "feat/thing is already up to date with origin/feat/thing, at 1111111.",
    ]);
  });

  // The whole reason the button exists: the files moved and the processes
  // reading them did not.
  it("names the range, the count and the restart that has to follow", () => {
    const lines = pullReport(
      result({ outcome: "fast-forwarded", to: "2222222", commits: 3 }),
    );
    expect(lines[0]).toBe(
      "Fast-forwarded feat/thing from 1111111 to 2222222, 3 new commits from origin/feat/thing.",
    );
    expect(lines[1]).toContain("Restart the sandbox's services");
  });

  // "Moved" rather than "fast-forwarded" is the one difference somebody would
  // want explained, so the reason it was safe is said in the same breath.
  it("says a rewritten upstream was moved onto, and why nothing was lost", () => {
    const lines = pullReport(result({ outcome: "replaced", to: "2222222", commits: 213 }));
    expect(lines[0]).toBe("Moved feat/thing from 1111111 to 2222222, 213 commits from origin/feat/thing.");
    expect(lines[1]).toContain("rebased or force-pushed");
    expect(lines[1]).toContain("nothing was lost");
    expect(lines[2]).toContain("Restart the sandbox's services");
  });

  it("explains that a detached worktree's branch ref stayed where it was", () => {
    const lines = pullReport(
      result({ outcome: "fast-forwarded", detached: true, to: "2222222", commits: 1 }),
    );
    expect(lines.join(" ")).toContain("the local branch feat/thing did not");
  });

  // The headline is what the dashboard puts in the verdict, so it has to stand
  // on its own — and it has to say that nothing was touched.
  it("leads a refusal with one line naming every reason", () => {
    const lines = pullReport(
      result({
        outcome: "refused",
        refusals: [
          { kind: "diverged", summary: "2 local commits not on origin/feat/thing", message: "long one", files: [] },
          { kind: "untracked", summary: "1 untracked file would be overwritten", message: "long two", files: [] },
        ],
      }),
    );
    expect(lines[0]).toBe(
      "Cannot pull feat/thing: 2 local commits not on origin/feat/thing; 1 untracked file would be overwritten. Nothing in the worktree was changed.",
    );
    expect(lines.slice(1)).toEqual(["long one", "long two"]);
  });

  it("calls a worktree with no branch by something other than its name", () => {
    const lines = pullReport(
      result({
        outcome: "refused",
        branch: "?",
        refusals: [{ kind: "no-branch", summary: "it is not on a branch", message: "long", files: [] }],
      }),
    );
    expect(lines[0]).toContain("Cannot pull this worktree:");
  });
});

describe("freshenBranch", () => {
  /** A mirror whose local branch is two commits behind origin. */
  const stale = (overrides: Record<string, Reply> = {}): Record<string, Reply> => ({
    fetch: { code: 0 },
    "rev-parse --verify --quiet refs/heads": { code: 0, stdout: `${HEAD}\n` },
    "rev-parse --verify --quiet refs/remotes": { code: 0, stdout: `${TARGET}\n` },
    "merge-base --is-ancestor": { code: 0 },
    "rev-list --count": { code: 0, stdout: "2\n" },
    "update-ref": { code: 0 },
    ...overrides,
  });

  // The whole point of the addition: a ref is only as fresh as the last fetch,
  // and the fetch belongs in the mirror where the refspec is configured.
  it("fetches the mirror before it resolves any ref", async () => {
    const repo = realDir();
    const { run, calls } = fakeGit(stale());

    await freshenBranch({ project: project(repo), branch: "feat/thing", run });

    expect(calls[0]).toEqual({ dir: repo, args: ["fetch", "origin"] });
    expect(calls.filter((call) => call.args[0] === "fetch")).toHaveLength(1);
  });

  it("takes a given base as the start point and reconciles nothing", async () => {
    const { run, calls } = fakeGit(stale());

    const result = await freshenBranch({
      project: project(realDir()),
      branch: "feat/new",
      base: "origin/main",
      run,
    });

    expect(result).toMatchObject({ outcome: "based", startRef: "origin/main" });
    // The fetch still ran, because that is what makes `origin/main` current.
    expect(calls[0]?.args[0]).toBe("fetch");
    expect(calls.some((call) => call.args[0] === "update-ref")).toBe(false);
  });

  it("fast-forwards a local branch that is behind, guarding on the sha it had", async () => {
    const { run, calls } = fakeGit(stale());

    const result = await freshenBranch({ project: project(realDir()), branch: "feat/thing", run });

    expect(result).toMatchObject({ outcome: "moved", behind: 2, startRef: "refs/heads/feat/thing" });
    // Compare-and-swap: the old value is the third argument, so a ref that moved
    // under us fails rather than being overwritten.
    expect(calls.find((call) => call.args[0] === "update-ref")?.args).toEqual([
      "update-ref",
      "refs/heads/feat/thing",
      TARGET,
      HEAD,
    ]);
    expect(result.report[0]).toBe(
      "Fast-forwarded feat/thing from 1111111 to 2222222, 2 new commits from origin/feat/thing.",
    );
  });

  // Moving a ref another worktree has checked out makes that worktree show every
  // incoming change as an uncommitted reversal, and git does not stop
  // `update-ref` doing it. So the ref stays and the new checkout detaches.
  it("never moves a branch another worktree holds, and starts from origin instead", async () => {
    const { run, calls } = fakeGit(stale());

    const result = await freshenBranch({
      project: project(realDir()),
      branch: "feat/thing",
      heldElsewhere: true,
      run,
    });

    expect(result).toMatchObject({ outcome: "held", startRef: "refs/remotes/origin/feat/thing" });
    expect(calls.some((call) => call.args[0] === "update-ref")).toBe(false);
    expect(result.report.join(" ")).toContain("checked out in another worktree");
  });

  // The case a reader will not predict: the mirror's branch has work origin does
  // not. Nothing is moved, nothing is thrown away, and the worktree is still cut
  // — but the commit it lands on is said out loud.
  it("leaves a diverged local branch where it is, and says how far from origin that is", async () => {
    const { run, calls } = fakeGit(
      stale({
        "merge-base --is-ancestor": { code: 1 },
        [`rev-list --count ${TARGET.slice(0, 4)}`]: { code: 0, stdout: "3\n" },
        [`rev-list --count ${HEAD.slice(0, 4)}`]: { code: 0, stdout: "7\n" },
      }),
    );

    const result = await freshenBranch({ project: project(realDir()), branch: "feat/thing", run });

    expect(result).toMatchObject({ outcome: "diverged", ahead: 3, behind: 7, startRef: "refs/heads/feat/thing" });
    expect(calls.some((call) => call.args[0] === "update-ref")).toBe(false);
    expect(result.report[0]).toBe(
      "feat/thing has 3 commits that origin/feat/thing does not, so it was not moved.",
    );
    expect(result.report[1]).toContain("This worktree starts at 1111111, which is not origin's tip 2222222 — 7 commits behind it");
  });

  it("says nothing to reconcile when the local branch is already at the tip", async () => {
    const { run } = fakeGit(stale({ "rev-parse --verify --quiet refs/remotes": { code: 0, stdout: `${HEAD}\n` } }));

    const result = await freshenBranch({ project: project(realDir()), branch: "feat/thing", run });

    expect(result.outcome).toBe("current");
    expect(result.report[0]).toBe("feat/thing is already at origin's tip, 1111111.");
  });

  it("starts from origin for a branch that exists only there", async () => {
    const { run } = fakeGit(stale({ "rev-parse --verify --quiet refs/heads": { code: 1 } }));

    const result = await freshenBranch({ project: project(realDir()), branch: "feat/thing", run });

    expect(result).toMatchObject({ outcome: "remote-only", startRef: "refs/remotes/origin/feat/thing" });
  });

  it("keeps the local ref when origin has no branch of that name", async () => {
    const { run } = fakeGit(stale({ "rev-parse --verify --quiet refs/remotes": { code: 1 } }));

    const result = await freshenBranch({ project: project(realDir()), branch: "feat/thing", run });

    expect(result).toMatchObject({ outcome: "no-remote", startRef: "refs/heads/feat/thing" });
    expect(result.report[0]).toContain("origin has no branch called feat/thing");
  });

  // Refusing to create a worktree because the network is down would be worse
  // than the staleness it prevents, so this costs freshness and a sentence.
  it("carries on with the refs it has when the remote cannot be reached", async () => {
    const { run } = fakeGit(stale({ fetch: { code: 128, stderr: "fatal: could not read from remote\n" } }));

    const result = await freshenBranch({ project: project(realDir()), branch: "feat/thing", run });

    expect(result.offline).toBe(true);
    expect(result.outcome).toBe("moved");
    expect(result.report[0]).toContain("Could not fetch");
  });
});
