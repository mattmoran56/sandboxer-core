/**
 * Bringing a worktree up to date with the remote, or refusing and saying why.
 *
 * Two entry points, one rule. `pullWorktree` brings a worktree that already
 * exists up to its branch's head; `freshenBranch` does the same job for a
 * worktree that is about to be *created*, before `addWorktree` resolves any ref.
 * Both fast-forward or leave the ref alone and say so, and neither ever merges,
 * rebases or discards.
 *
 * The worktrees under `<project>/wt/` are not places anybody edits — they are
 * places a sandbox *runs*. The commits arrive from somewhere else, and the job
 * here is one button: bring this checkout up to the branch's head so the
 * services can be restarted onto it.
 *
 * **Fast-forward or fail.** Nothing here merges, rebases, resets or discards. A
 * pull that cannot be a fast-forward is refused with the reasons, and the
 * worktree is left exactly as it was — because the whole value of the button is
 * that its failure is visible. Somebody who has half a day's work in a running
 * worktree finds out from a sentence naming their files, not from a reflog.
 *
 * **One case is not a fast-forward and still moves: a rewritten upstream.** A
 * rebase and force-push leaves origin holding an equivalent of every commit this
 * worktree has, under new shas. Comparing shas calls that a divergence and
 * refuses; comparing *patches*, with `git cherry`, shows there is nothing to
 * lose. So a divergence is measured by patch, and when no commit here is absent
 * from origin the worktree is moved onto it — by `checkout`, which still refuses
 * to overwrite an uncommitted change, and never by `reset --hard`. The rule the
 * paragraph above states is intact: nothing is discarded. What changed is that
 * "discarded" is now judged by content rather than by identity, because a
 * managed worktree is where a rewritten branch is the ordinary case rather than
 * the exception — and refusing it left no way forward that was not a terminal.
 *
 * **Every reason, not the first.** A refusal lists all of them. Fixing one and
 * pressing the button again to be told about the next is how a two-minute job
 * takes twenty.
 *
 * Two facts about a *managed* worktree shape the whole file:
 *
 *  - **It is usually on a detached HEAD.** git refuses to check one branch out
 *    twice and the branch is very often open in somebody's main checkout, so
 *    `addWorktree` creates it with `--detach` (see worktree.ts). That is the
 *    normal case, not an edge case, and it has no upstream — so `git pull` is
 *    not a thing that can be run here at all. The branch name comes back from
 *    git.ts's `branchOf`, and `refs/remotes/origin/<branch>` is what gets
 *    fast-forwarded onto.
 *  - **The remote is only ever talked to through the project's mirror.**
 *    `fetchProject` updates `refs/remotes/origin/*` in `repo.git`, and a linked
 *    worktree shares those refs, so one fetch serves every worktree of the
 *    project. A second `git fetch` run in the worktree itself would be a second
 *    way of talking to the remote with its own refspec, which is exactly what
 *    workspace.ts's clone comment exists to prevent.
 */

import { existsSync } from "node:fs";

import { nodeRunner, type ExecResult, type Runner } from "./docker.js";
import { DEFAULT_DIRTY_IGNORE, branchOf, dirtyFiles } from "./git.js";
import { fetchProject, type Project } from "./workspace.js";

/** What `branchOf` answers when it cannot name a branch. */
const UNKNOWN = "?";

/** How many characters of a sha to show, matching `git rev-parse --short`. */
const SHORT_SHA = 7;

/**
 * How many paths a refusal names before it counts the rest.
 *
 * A refusal has to be actionable without a terminal, so it names files. A
 * worktree with two hundred modified files would otherwise produce a wall of
 * text nobody reads, which is the same as naming none.
 */
const NAMED_FILES = 10;

/** How many commits a divergence names before it counts the rest. */
const NAMED_COMMITS = 5;

export interface PullInput {
  /** The project whose mirror holds the remote-tracking refs. */
  project: Project;
  /** Absolute path to the worktree to bring up to date. */
  worktree: string;
  run?: Runner | undefined;
  /** Paths whose changes do not count as dirty, as literal suffixes. */
  ignoreDirty?: string[] | undefined;
  /** Progress, one line at a time. */
  log?: ((line: string) => void) | undefined;
}

export type PullRefusalKind =
  | "missing"
  | "no-branch"
  | "no-head"
  | "no-remote-branch"
  | "diverged"
  | "local-changes"
  | "untracked"
  | "failed";

/**
 * One reason a pull did not happen.
 *
 * Two wordings, deliberately: `summary` is a phrase that fits in a one-line
 * verdict beside two others, and `message` is the sentence that names the files
 * and says what to do about it. A single wording could be one or the other and
 * was always the wrong one somewhere.
 */
export interface PullRefusal {
  kind: PullRefusalKind;
  summary: string;
  message: string;
  /** The paths or commits this is about, when it is about any. */
  files: string[];
}

export interface PullResult {
  /**
   * `replaced` is the rewritten-upstream case: not a fast-forward, but origin
   * already carries an equivalent of every commit the worktree had, so moving
   * onto it loses nothing. Callers that only ask whether a pull happened should
   * test for `refused`, not list the successes.
   */
  outcome: "up-to-date" | "fast-forwarded" | "replaced" | "refused";
  /** The branch, or `?` when it could not be named. */
  branch: string;
  /** Checked out detached, which is the ordinary state of a managed worktree. */
  detached: boolean;
  /** Short sha before the pull, or `?`. */
  from: string;
  /** Short sha after it. Equal to `from` unless it fast-forwarded. */
  to: string;
  /** How many commits arrived. Zero unless it fast-forwarded. */
  commits: number;
  /** Every reason it was refused, in the order they were found. Empty otherwise. */
  refusals: PullRefusal[];
}

async function git(run: Runner, worktree: string, args: string[]): Promise<ExecResult> {
  return run("git", ["-C", worktree, ...args]);
}

const short = (sha: string): string => (sha === "" ? UNKNOWN : sha.slice(0, SHORT_SHA));

const lines = (stdout: string): string[] =>
  stdout
    .split("\n")
    .map((line) => line.trimEnd())
    .filter((line) => line !== "");

/**
 * `a, b and c`, or `a, b, c and 4 more` past the cap.
 *
 * `total` is passed separately where the list itself was capped before it got
 * here — a divergence names five commits out of however many there are, and
 * counting the array would say "and 0 more" for a worktree fifty ahead.
 */
function nameThem(items: string[], cap: number, total = items.length): string {
  const head = items.slice(0, cap);
  const rest = total - head.length;
  const listed = head.join(", ");
  return rest > 0 ? `${listed} and ${rest} more` : listed;
}

const plural = (count: number, one: string, many = `${one}s`): string =>
  `${count} ${count === 1 ? one : many}`;

/**
 * One `git cherry -v` line as `<short sha> <subject>`.
 *
 * The line arrives as `+ <full sha> <subject>` or `- <full sha> <subject>`; the
 * sign is stripped by the caller, which is the thing it is reading. The sha is
 * shortened here rather than asking git for an abbreviated one, because `cherry`
 * has no `--abbrev` and the alternative is a second `log` over the same commits.
 */
const cherryCommit = (line: string): string => {
  const [sha = "", ...rest] = line.slice(1).trim().split(/\s+/);
  return [short(sha), ...rest].join(" ").trim();
};

/**
 * The paths one line of `git status --porcelain` is about.
 *
 * A rename is `R  old -> new` and both halves matter: the incoming commits can
 * collide with either the file that is about to disappear or the one that is
 * about to appear. Everything else is one path from column three on.
 *
 * The paths are **not** unquoted. git quotes an unusual path the same way in
 * `status --porcelain` and in `diff --name-only`, so comparing the two literal
 * strings is comparing like with like — unquoting one side and not the other is
 * how a file with a space in it stops matching itself.
 */
export function statusPaths(line: string): string[] {
  const path = line.slice(3);
  if (!line.startsWith("R") && !line.startsWith("C")) return [path];
  const arrow = path.indexOf(" -> ");
  return arrow === -1 ? [path] : [path.slice(0, arrow), path.slice(arrow + 4)];
}

/**
 * Whether an untracked entry stands in the way of an incoming path.
 *
 * `status --porcelain` collapses a directory whose contents are *all* untracked
 * into a single `?? dir/` entry, so an incoming `src/new/thing.ts` collides with
 * an untracked `src/new/` that git never listed a file inside. Comparing the
 * entries as plain strings misses exactly that case, and git would then refuse
 * the checkout itself — after the preflight had said it was fine.
 */
export function untrackedBlocks(entry: string, incoming: string): boolean {
  return entry.endsWith("/") ? incoming.startsWith(entry) : entry === incoming;
}

/**
 * Brings one worktree up to its branch's head on the remote, or refuses.
 *
 * Never throws for anything it can describe: a refusal is a value, because every
 * caller has to render it rather than catch it. It does throw when the *fetch*
 * fails, because that is the machine's network or credentials and git's own
 * message is the useful one.
 */
export async function pullWorktree(input: PullInput): Promise<PullResult> {
  const run = input.run ?? nodeRunner;
  const log = input.log ?? (() => {});
  const { worktree } = input;

  const refused = (branch: string, detached: boolean, head: string, refusals: PullRefusal[]): PullResult => ({
    outcome: "refused",
    branch,
    detached,
    from: short(head),
    to: short(head),
    commits: 0,
    refusals,
  });

  if (!existsSync(worktree)) {
    return refused(UNKNOWN, false, "", [
      {
        kind: "missing",
        summary: "its directory is gone",
        message: `The worktree directory ${worktree} is not on disk, so there is nothing to pull into. Remove the worktree in git, or restore the directory.`,
        files: [],
      },
    ]);
  }

  // `symbolic-ref` rather than reading `branchOf`'s answer for this: a detached
  // worktree's branch name is *recovered* from the commit it sits on, so the
  // name alone cannot say whether HEAD is attached — and the two cases end in
  // different refs being moved.
  const symbolic = await git(run, worktree, ["symbolic-ref", "-q", "--short", "HEAD"]);
  const detached = symbolic.code !== 0 || symbolic.stdout.trim() === "";
  const branch = detached ? await branchOf(worktree, run) : symbolic.stdout.trim();

  const headResult = await git(run, worktree, ["rev-parse", "HEAD"]);
  const head = headResult.code === 0 ? headResult.stdout.trim() : "";
  if (head === "") {
    return refused(branch, detached, "", [
      {
        kind: "no-head",
        summary: "it has no commits",
        message: `${worktree} has no commit checked out, so there is nothing to fast-forward.`,
        files: [],
      },
    ]);
  }

  if (branch === UNKNOWN || branch === "") {
    return refused(UNKNOWN, detached, head, [
      {
        kind: "no-branch",
        summary: "it is not on a branch",
        message: `This worktree is on ${short(head)} and no branch points at it, so there is no branch on the remote to pull from. Check it out on a branch first.`,
        files: [],
      },
    ]);
  }

  // The one place the remote is talked to, and it is the project's mirror rather
  // than this worktree: `repo.git` is where the refspec that keeps
  // `refs/remotes/origin/*` separate from `refs/heads/*` is configured, and a
  // linked worktree reads the refs it updates.
  log(`Fetching ${input.project.origin || input.project.name}…`);
  await fetchProject(input.project, { run });

  const remoteRef = `refs/remotes/origin/${branch}`;
  const targetResult = await git(run, worktree, ["rev-parse", "--verify", "--quiet", `${remoteRef}^{commit}`]);
  const target = targetResult.code === 0 ? targetResult.stdout.trim() : "";
  if (target === "") {
    return refused(branch, detached, head, [
      {
        kind: "no-remote-branch",
        summary: `origin has no branch called ${branch}`,
        message: `origin has no branch called ${branch}. It has been deleted or renamed on the remote, so there is nothing to pull.`,
        files: [],
      },
    ]);
  }

  if (target === head) {
    return {
      outcome: "up-to-date",
      branch,
      detached,
      from: short(head),
      to: short(head),
      commits: 0,
      refusals: [],
    };
  }

  const refusals: PullRefusal[] = [];

  // Ahead of the remote as well as behind it, or on an unrelated history: either
  // way `--ff-only` would refuse, and so does this — before anything is touched,
  // and with the commits named.
  //
  // **Counted by patch, not by hash, and that is the load-bearing part.** When
  // somebody rebases the branch and force-pushes it, every commit this worktree
  // holds is still on origin — under a new sha. `rev-list target..head` compares
  // shas, so it reports the whole pre-rebase history as work at risk: a branch
  // rebuilt once said "107 local commits not on origin" when ten were really
  // absent, and named five that were already there. The number and the names are
  // the only things somebody can act on, so both being wrong made a two-minute
  // job look impossible. `git cherry` compares patch ids and marks a commit `+`
  // when nothing equivalent is upstream and `-` when something is.
  let replaced = false;
  const ancestor = await git(run, worktree, ["merge-base", "--is-ancestor", head, target]);
  if (ancestor.code !== 0) {
    const cherry = await git(run, worktree, ["cherry", "-v", target, head]);
    const classified = cherry.code === 0;
    const unique = classified ? lines(cherry.stdout).filter((line) => line.startsWith("+")).map(cherryCommit) : [];

    if (classified && unique.length === 0) {
      // A pure upstream rewrite: origin carries an equivalent of every commit
      // here, so there is nothing this could lose. Not a fast-forward either —
      // the move below is a checkout rather than a merge.
      replaced = true;
    } else {
      // Named from `cherry` when it answered, so the refusal lists the commits
      // that would really be lost. When it could not, the old sha comparison
      // stands: an unreadable classification has to refuse, never assume.
      let local = unique;
      let total = unique.length;
      if (!classified) {
        // Counted with `rev-list --count` and named with `log`, because the log
        // is capped: a worktree fifty commits ahead would otherwise be reported
        // as exactly fifty ahead, which is a number somebody would act on.
        const ours = await git(run, worktree, [
          "log",
          "--format=%h %s",
          `--max-count=${NAMED_COMMITS}`,
          `${target}..${head}`,
        ]);
        const counted = await git(run, worktree, ["rev-list", "--count", `${target}..${head}`]);
        const ahead = Number.parseInt(counted.stdout.trim(), 10);
        local = lines(ours.stdout);
        total = Number.isFinite(ahead) ? ahead : local.length;
      }
      refusals.push({
        kind: "diverged",
        summary: `${plural(total, "local commit")} not on origin/${branch}`,
        message: `${branch} has ${plural(total, "commit")} that origin/${branch} does not: ${nameThem(local, NAMED_COMMITS, total)}. That is not a fast-forward, and sandboxer will not merge or rebase for you — push or drop those commits, then pull again.`,
        files: local,
      });
    }
  }

  // What the incoming commits touch. `diff --name-only` between the two commits
  // rather than a log of every path in them: a file changed and changed back is
  // not in the way of anything.
  const changed = await git(run, worktree, ["diff", "--name-only", head, target]);
  const incoming = lines(changed.stdout);

  const status = await git(run, worktree, ["status", "--porcelain"]);
  // The same dirty check the labels and every other command use, ignore list and
  // all: a sandbox's own build writes files, and counting those would mean that
  // merely running a worktree made it unpullable.
  const dirty = status.code === 0 ? dirtyFiles(status.stdout, input.ignoreDirty ?? DEFAULT_DIRTY_IGNORE) : [];

  const tracked = dirty.filter((line) => !line.startsWith("??")).flatMap(statusPaths);
  const untracked = dirty.filter((line) => line.startsWith("??")).flatMap(statusPaths);

  const collisions = tracked.filter((path) => incoming.includes(path));
  if (collisions.length > 0) {
    refusals.push({
      kind: "local-changes",
      summary: `${plural(collisions.length, "changed file")} would be overwritten`,
      message: `${plural(collisions.length, "file has", "files have")} uncommitted changes that the incoming commits also change: ${nameThem(collisions, NAMED_FILES)}. Commit, stash or discard them and pull again.`,
      files: collisions,
    });
  }

  const clobbered = incoming.filter((path) => untracked.some((entry) => untrackedBlocks(entry, path)));
  if (clobbered.length > 0) {
    refusals.push({
      kind: "untracked",
      summary: `${plural(clobbered.length, "untracked file")} would be overwritten`,
      message: `${plural(clobbered.length, "untracked file")} would be overwritten by the incoming commits: ${nameThem(clobbered, NAMED_FILES)}. Move or delete them and pull again.`,
      files: clobbered,
    });
  }

  if (refusals.length > 0) return refused(branch, detached, head, refusals);

  const commits = await git(run, worktree, ["rev-list", "--count", `${head}..${target}`]);
  const arrived = Number.parseInt(commits.stdout.trim(), 10);

  // `merge --ff-only` and never `pull`, `merge` or `reset`. It moves HEAD when
  // the target is a descendant and fails otherwise — it cannot write a merge
  // commit, and it will not overwrite an uncommitted change even if the
  // preflight above somehow missed one.
  //
  // On a detached worktree this moves HEAD alone and deliberately leaves
  // `refs/heads/<branch>` where it was: the reason the worktree is detached is
  // that some other checkout holds that branch, and git refuses to move a branch
  // that is checked out elsewhere. `branchOf` keeps naming the worktree
  // correctly regardless — with no local branch at the new commit it falls
  // through to the remote-tracking ref and strips the remote.
  //
  // When origin rewrote the branch there is no fast-forward to make, so the move
  // is a checkout onto its commit. Still never `reset --hard`: `checkout` carries
  // over an uncommitted change that does not collide and refuses outright when
  // one would be overwritten, so the promise that this button cannot silently
  // destroy work holds for a rewritten upstream too. It is only reached once
  // `git cherry` has proved origin already has an equivalent of every commit
  // here — the check above — so there is no history to lose either.
  //
  // Detached moves HEAD alone; on a branch, `-B` moves the branch with it. git
  // will not move a branch checked out in another worktree, and cannot be asked
  // to here: this worktree is the one holding it.
  const move = replaced
    ? detached
      ? ["checkout", "--detach", target]
      : ["checkout", "-B", branch, target]
    : ["merge", "--ff-only", target];
  log(replaced ? `Moving ${branch} onto ${short(target)}…` : `Fast-forwarding ${branch} to ${short(target)}…`);
  const moved = await git(run, worktree, move);
  if (moved.code !== 0) {
    const detail = (moved.stderr || moved.stdout).trim().split("\n").slice(-8);
    const verb = replaced ? "move" : "fast-forward";
    return refused(branch, detached, head, [
      {
        kind: "failed",
        summary: `git refused the ${verb}`,
        message: `git refused to ${verb} ${branch}, and said:\n${detail.join("\n")}`,
        files: [],
      },
    ]);
  }

  return {
    outcome: replaced ? "replaced" : "fast-forwarded",
    branch,
    detached,
    from: short(head),
    to: short(target),
    commits: Number.isFinite(arrived) ? arrived : 0,
    refusals: [],
  };
}

/**
 * What a pull is told to a person, as lines.
 *
 * Pure, and the only wording there is: the dashboard streams these lines and the
 * CLI prints them, so the two cannot describe the same outcome differently. The
 * **first line is always a self-contained headline** — the dashboard hands it to
 * the verdict at the top of the action sheet, where a refusal has one line to
 * say what happened.
 */
export function pullReport(result: PullResult): string[] {
  const subject = result.branch === UNKNOWN || result.branch === "" ? "this worktree" : result.branch;

  if (result.outcome === "up-to-date") {
    return [`${subject} is already up to date with origin/${subject}, at ${result.to}.`];
  }

  if (result.outcome === "fast-forwarded") {
    return [
      `Fast-forwarded ${subject} from ${result.from} to ${result.to}, ${plural(result.commits, "new commit")} from origin/${subject}.`,
      // The reason the button exists: the files on disk have moved and the
      // processes reading them have not.
      "Restart the sandbox's services to run the new code.",
      ...(result.detached
        ? [
            `This worktree is detached, so its HEAD moved and the local branch ${subject} did not — which is what keeps the branch usable in the checkout that holds it.`,
          ]
        : []),
    ];
  }

  if (result.outcome === "replaced") {
    return [
      `Moved ${subject} from ${result.from} to ${result.to}, ${plural(result.commits, "commit")} from origin/${subject}.`,
      // Said plainly, because "moved" rather than "fast-forwarded" is the one
      // difference somebody would want explained, and the reason it was safe is
      // the whole justification for doing it at all.
      `origin/${subject} was rebuilt — rebased or force-pushed — so this was not a fast-forward. Every commit this worktree had is already on origin under a new hash, so nothing was lost.`,
      "Restart the sandbox's services to run the new code.",
      ...(result.detached
        ? [`This worktree is detached, so its HEAD moved and the local branch ${subject} did not.`]
        : []),
    ];
  }

  return [
    `Cannot pull ${subject}: ${result.refusals.map((refusal) => refusal.summary).join("; ")}. Nothing in the worktree was changed.`,
    ...result.refusals.map((refusal) => refusal.message),
  ];
}

/* --- the same job, for a worktree that does not exist yet ----------------- */

export interface FreshenInput {
  /** The project whose mirror holds every ref a worktree is cut from. */
  project: Project;
  branch: string;
  /** An explicit start point, when the caller gave one. */
  base?: string | undefined;
  /**
   * Whether another worktree of this mirror already has the branch checked out.
   *
   * It decides whether the local ref may be moved at all, so it is passed in by
   * the caller that already knows rather than worked out a second time here.
   */
  heldElsewhere?: boolean | undefined;
  run?: Runner | undefined;
  log?: ((line: string) => void) | undefined;
}

export type FreshenOutcome =
  /** A base was given, so the base decides the start point. */
  | "based"
  /** origin has no branch of this name. Whatever is local stands. */
  | "no-remote"
  /** The branch exists only on origin, and the new worktree is cut from it. */
  | "remote-only"
  /** The local branch is already at origin's tip. */
  | "current"
  /** The local branch was fast-forwarded onto origin's tip. */
  | "moved"
  /** origin is ahead, and the local ref was left alone because it is checked out elsewhere. */
  | "held"
  /** The local branch has commits origin does not. Nothing was moved. */
  | "diverged";

export interface FreshenResult {
  outcome: FreshenOutcome;
  branch: string;
  /**
   * The ref a **detached** checkout should start from — the freshest one that is
   * safe to use. The attached path checks out the branch itself, which this has
   * already moved where it could.
   */
  startRef: string;
  /** Short sha the local branch is at once this has run, or `?`. */
  local: string;
  /** Short sha origin has it at, or `?`. */
  remote: string;
  /** Local commits origin does not have. */
  ahead: number;
  /** Commits origin has that the local branch did not. */
  behind: number;
  /** True when the fetch itself failed, so every answer here is as stale as the mirror. */
  offline: boolean;
  /** What was said about it, in order. The caller streams these. */
  report: string[];
}

/**
 * Brings a project's idea of one branch up to the remote's, before a worktree is
 * cut from it.
 *
 * **Every creation path in `addWorktree` resolves a ref, and a ref is only as
 * fresh as the last fetch.** A worktree cut for a branch — or for a pull
 * request's head branch, which arrives there as an ordinary branch name — landed
 * on whatever the mirror happened to hold, which on a machine that had not
 * fetched for a week was a week-old checkout with nothing on screen saying so.
 * The fetch therefore happens here, into the mirror and through `fetchProject`,
 * for the reason at the top of this file: one refspec, one way of talking to the
 * remote.
 *
 * **A fetch alone is not enough, and that is the subtle half.** Two of the four
 * creation paths start from a *local* ref, which a fetch does not move. So where
 * origin is strictly ahead this fast-forwards `refs/heads/<branch>` itself — and
 * where it is not, it moves nothing and says, in as many words, which commit the
 * worktree is about to land on and how far that is from the remote.
 *
 * **A branch checked out somewhere else is never moved.** `update-ref` will
 * happily move a ref another worktree has checked out, and git does not stop it
 * the way `git branch -f` would: that worktree then shows every incoming change
 * as an uncommitted *reversal*, which looks exactly like an editor having eaten
 * somebody's work. The new worktree starts detached at `origin/<branch>`
 * instead, which reaches the same commit and touches nothing.
 *
 * Never throws. A remote that cannot be reached costs freshness, and refusing to
 * create a worktree over it would be worse than the staleness it prevents.
 */
export async function freshenBranch(input: FreshenInput): Promise<FreshenResult> {
  const run = input.run ?? nodeRunner;
  const log = input.log ?? (() => {});
  const { project, branch } = input;
  const report: string[] = [];
  const say = (line: string): void => {
    report.push(line);
    log(line);
  };

  const result: FreshenResult = {
    outcome: "no-remote",
    branch,
    startRef: `refs/heads/${branch}`,
    local: UNKNOWN,
    remote: UNKNOWN,
    ahead: 0,
    behind: 0,
    offline: false,
    report,
  };

  try {
    await fetchProject(project, { run });
  } catch (error) {
    result.offline = true;
    const reason = error instanceof Error ? error.message : String(error);
    say(
      `Could not fetch ${project.origin || project.name}, so this worktree is cut from the refs this machine already has: ${reason}`,
    );
  }

  // A base is the caller saying where to start, and after the fetch above it
  // resolves against refs that are current. There is nothing else to reconcile:
  // the branch does not exist yet.
  if (input.base !== undefined && input.base.trim() !== "") {
    result.outcome = "based";
    result.startRef = input.base.trim();
    say(`Cutting ${branch} from ${result.startRef}, as origin now has it.`);
    return result;
  }

  const localSha = await revParse(run, project.repo, `refs/heads/${branch}`);
  const remoteSha = await revParse(run, project.repo, `refs/remotes/origin/${branch}`);
  result.local = short(localSha);
  result.remote = short(remoteSha);

  if (remoteSha === "") {
    result.outcome = "no-remote";
    // Only worth saying when there is a local branch to be stale *against*. With
    // neither, `addWorktree` raises its own error, which says more than this
    // would.
    if (localSha !== "") {
      say(`origin has no branch called ${branch}, so this worktree is cut from the local ref at ${short(localSha)}.`);
    }
    return result;
  }

  if (localSha === "") {
    result.outcome = "remote-only";
    result.startRef = `refs/remotes/origin/${branch}`;
    say(`${branch} is only on origin, and it is at ${short(remoteSha)}.`);
    return result;
  }

  if (localSha === remoteSha) {
    result.outcome = "current";
    say(`${branch} is already at origin's tip, ${short(remoteSha)}.`);
    return result;
  }

  const ancestor = await git(run, project.repo, ["merge-base", "--is-ancestor", localSha, remoteSha]);
  if (ancestor.code !== 0) {
    // Ahead of origin, or on an unrelated history. The worktree is still created
    // — refusing would be worse than the staleness — but nothing is moved and
    // nothing is thrown away, and the commit it lands on is said out loud.
    result.outcome = "diverged";
    result.ahead = await countRange(run, project.repo, remoteSha, localSha);
    result.behind = await countRange(run, project.repo, localSha, remoteSha);
    say(`${branch} has ${plural(result.ahead, "commit")} that origin/${branch} does not, so it was not moved.`);
    say(
      `This worktree starts at ${short(localSha)}, which is not origin's tip ${short(remoteSha)} — ${plural(result.behind, "commit")} behind it. Push or drop those commits, then pull the worktree.`,
    );
    return result;
  }

  result.behind = await countRange(run, project.repo, localSha, remoteSha);

  if (input.heldElsewhere) {
    result.outcome = "held";
    result.startRef = `refs/remotes/origin/${branch}`;
    say(
      `${branch} is checked out in another worktree, so its local ref stays where it is; this one starts detached at origin/${branch}, ${short(remoteSha)} — ${plural(result.behind, "commit")} ahead of that ref.`,
    );
    return result;
  }

  // Compare-and-swap: the old value is passed so a ref that moved under us fails
  // the update rather than being overwritten on the strength of a decision made
  // about a commit that is no longer there.
  const moved = await git(run, project.repo, ["update-ref", `refs/heads/${branch}`, remoteSha, localSha]);
  if (moved.code !== 0) {
    result.outcome = "held";
    result.startRef = `refs/remotes/origin/${branch}`;
    say(
      `${branch} could not be moved to origin's tip, so this worktree starts detached at origin/${branch}, ${short(remoteSha)}.`,
    );
    return result;
  }

  result.outcome = "moved";
  result.local = short(remoteSha);
  say(
    `Fast-forwarded ${branch} from ${short(localSha)} to ${short(remoteSha)}, ${plural(result.behind, "new commit")} from origin/${branch}.`,
  );
  return result;
}

/** One ref's full sha, or `""` when it names nothing. */
async function revParse(run: Runner, dir: string, ref: string): Promise<string> {
  const result = await git(run, dir, ["rev-parse", "--verify", "--quiet", `${ref}^{commit}`]);
  return result.code === 0 ? result.stdout.trim() : "";
}

/** How many commits `to` has that `from` does not. */
async function countRange(run: Runner, dir: string, from: string, to: string): Promise<number> {
  const result = await git(run, dir, ["rev-list", "--count", `${from}..${to}`]);
  const count = Number.parseInt(result.stdout.trim(), 10);
  return Number.isFinite(count) ? count : 0;
}
