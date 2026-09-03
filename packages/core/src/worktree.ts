/**
 * The writing half of git: cutting worktrees out of a project's bare clone.
 *
 * ./git.js reads a worktree that already exists — this creates, lists and
 * removes them. Same posture as that file: the injectable `Runner` from
 * ./docker.js is the only seam onto the OS, arguments are arrays rather than
 * shell strings, and a listing degrades to a usable answer rather than throwing.
 * Creating and removing *do* throw, because a caller that asked for a worktree
 * needs to know it did not get one.
 *
 * The layout is workspace.ts's: `<project>/wt/<slug>`, one directory per branch.
 */

import { existsSync, statSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";

import { nodeRunner, type ExecResult, type Runner } from "./docker.js";
import { branchOf } from "./git.js";
import { sanitizeSlug } from "./naming.js";
import { samePath } from "./paths.js";
import type { Project } from "./workspace.js";
import {
  readRecordedSlug,
  removeRecordedSlug,
  slugFor,
  uniqueSlug,
  worktreeKey,
  writeRecordedSlug,
} from "./worktree-slug.js";

export interface Worktree {
  /** Absolute path to the top of the worktree. */
  path: string;
  /** The branch name, or `?` when it cannot be resolved — never git's literal "HEAD". */
  branch: string;
  /** Short commit sha, or `?`. */
  head: string;
  /** Checked out detached, which is how a branch open elsewhere is run. */
  detached: boolean;
  /** Whether the directory is really on disk. */
  exists: boolean;
  /**
   * ISO 8601 of the HEAD commit, or `""` when it cannot be read.
   *
   * "When did anybody last work on this" is the question a list of worktrees is
   * really sorted by, and a branch name does not answer it. Empty rather than a
   * guess: a worktree whose directory has gone has no commit to read, and a
   * fabricated date would sort it somewhere it does not belong.
   */
  committed: string;
  /**
   * ISO 8601 of the directory's creation time, or `""` where the filesystem has
   * no answer. See `createdAt` for why that is a real possibility.
   */
  created: string;
}

export interface Branch {
  /** The name a forge would report: `feat/thing`, with no `origin/` on the front. */
  name: string;
  /** True when the only ref for it is the remote-tracking one. */
  remote: boolean;
  /** Last commit date, ISO 8601, as git formatted it. */
  updated: string;
}

export class WorktreeError extends Error {
  override readonly name = "WorktreeError";
}

export interface AddInput {
  project: Project;
  branch: string;
  /** Create the branch off this ref — `origin/main`, a tag, a sha. */
  base?: string | undefined;
  run?: Runner | undefined;
  /** Progress and warnings, one line at a time. */
  log?: ((line: string) => void) | undefined;
  /**
   * The environment `SANDBOXR_HOME` is read from, for the slug record.
   *
   * Taken as an argument rather than read off `process.env` for paths.ts's
   * reason: a test has to be able to point the whole tree at a temporary
   * directory without mutating the process.
   */
  env?: NodeJS.ProcessEnv | undefined;
}

const UNKNOWN = "?";

/** How many characters of a sha to keep, matching `git rev-parse --short`. */
const SHORT_SHA = 7;

async function git(run: Runner, dir: string, args: string[]): Promise<ExecResult> {
  return run("git", ["-C", dir, ...args]);
}

function failure(args: string[], result: ExecResult): WorktreeError {
  const detail = (result.stderr || result.stdout).trim().split("\n").slice(-8).join("\n");
  return new WorktreeError(`git ${args.join(" ")} exited ${result.code}${detail ? `:\n${detail}` : ""}`);
}

/**
 * Rejects a branch name git would read as something other than a branch name.
 *
 * Passing arguments as an array stops a name becoming shell syntax, but not a
 * name becoming an *option*: `git worktree add -b --foo …` is still git parsing
 * a flag. `..` is worse than wrong — in the base position it is a revision
 * *range*, so `a..b` names no commit at all and the failure arrives from deep
 * inside git looking nothing like "that is not a branch".
 */
function assertBranchName(raw: string): string {
  const branch = raw.trim();
  if (branch === "") throw new WorktreeError("a branch name is required");
  if (branch.startsWith("-")) {
    throw new WorktreeError(`branch "${branch}" starts with "-", which git would read as an option`);
  }
  if (branch.includes("..")) {
    throw new WorktreeError(`branch "${branch}" contains "..", which git reads as a commit range`);
  }
  return branch;
}

interface RawWorktree {
  path: string;
  head: string;
  branch: string;
  detached: boolean;
}

/**
 * Parses `git worktree list --porcelain`.
 *
 * The porcelain form and not the human one, which prints path, sha and branch
 * separated by runs of spaces: a worktree whose path contains a space is then
 * ambiguous, and the first such path silently turns into a wrong sha and a
 * missing branch. Porcelain gives one key per line, so the path is whatever
 * follows the first space and nothing has to be guessed.
 *
 * Pure and exported so the parsing can be tested without a repository — the
 * shapes that matter (bare, detached, a space in the path) are all awkward to
 * arrange on disk and trivial to write down.
 */
export function parseWorktreeList(porcelain: string): RawWorktree[] {
  const entries: RawWorktree[] = [];

  // Stanzas are separated by a blank line, and the last one may or may not have
  // a trailing newline depending on git's version.
  for (const stanza of porcelain.split(/\r?\n\r?\n/)) {
    let path = "";
    let head = UNKNOWN;
    let branch = UNKNOWN;
    let detached = false;
    let bare = false;

    for (const rawLine of stanza.split(/\r?\n/)) {
      const line = rawLine.replace(/\r$/, "").trimEnd();
      if (line === "") continue;

      const space = line.indexOf(" ");
      const key = space === -1 ? line : line.slice(0, space);
      const value = space === -1 ? "" : line.slice(space + 1);

      if (key === "worktree") path = value;
      else if (key === "HEAD") head = value;
      else if (key === "branch") branch = value.replace(/^refs\/heads\//, "");
      else if (key === "detached") detached = true;
      else if (key === "bare") bare = true;
    }

    // The first stanza of a bare repository is the repository itself: no HEAD,
    // no branch, and no directory anybody could run a sandbox from.
    if (path === "" || bare) continue;

    // git never writes `branch HEAD`, but a ref named HEAD would parse to it and
    // "HEAD" names nothing a caller can use — naming.ts refuses to slug it.
    entries.push({ path, head, branch: branch === "HEAD" ? UNKNOWN : branch, detached });
  }

  return entries;
}

function shortSha(head: string): string {
  return head === UNKNOWN || head === "" ? UNKNOWN : head.slice(0, SHORT_SHA);
}

async function rawList(run: Runner, project: Project): Promise<RawWorktree[]> {
  const result = await git(run, project.repo, ["worktree", "list", "--porcelain"]);
  // A listing never throws: a project whose repo has gone has no worktrees, and
  // that is a fact the dashboard can render.
  if (result.code !== 0) return [];
  return parseWorktreeList(result.stdout);
}

/**
 * Every worktree git knows about for this project, and whether it is real.
 *
 * `exists` is checked on the filesystem rather than trusted from git, for the
 * reason sandbox/gc.ts already records at its `worktreeExists` input: a worktree
 * deleted with a plain `rm -rf` leaves its entry in git's admin files, so git
 * goes on reporting it and everything downstream goes on believing it is alive.
 * The entry is reported rather than dropped, because "registered but gone" is
 * precisely what the caller wants to see before it prunes anything.
 */
export async function listWorktrees(
  project: Project,
  options: { run?: Runner | undefined } = {},
): Promise<Worktree[]> {
  const run = options.run ?? nodeRunner;
  return hydrate(run, await rawList(run, project));
}

/**
 * Turns parsed stanzas into answers: the sha shortened, the branch of a detached
 * tree recovered.
 *
 * A detached worktree has no branch of its own, and git.ts's `branchOf` gets the
 * name back from any local branch pointing at the same commit — the property the
 * detached form depends on to be usable at all. It needs the tree, so a worktree
 * that is no longer on disk keeps whatever git's admin files still say.
 */
async function hydrate(run: Runner, entries: RawWorktree[]): Promise<Worktree[]> {
  const out: Worktree[] = [];
  for (const entry of entries) {
    const exists = existsSync(entry.path);
    const branch = entry.branch === UNKNOWN && exists ? await branchOf(entry.path, run) : entry.branch;
    out.push({
      path: entry.path,
      branch,
      head: shortSha(entry.head),
      detached: entry.detached,
      exists,
      // Both dates are asked only of a worktree that is really there. A
      // directory git still lists but nobody can open has no commit to log and
      // nothing to stat, and asking would spend a process to learn that.
      committed: exists ? await committedAt(run, entry.path) : "",
      created: exists ? createdAt(entry.path) : "",
    });
  }
  return out;
}

/**
 * When HEAD was committed, as git formats it.
 *
 * `%cI` is git's strict ISO 8601, which is the one format that survives being
 * parsed by anything else — `%cd` follows the machine's `log.date` setting, so a
 * developer with `log.date = relative` in their gitconfig would have this
 * answering "3 days ago". Anything that goes wrong is `""`: `listWorktrees` is
 * documented never to throw, and a worktree on a commit nobody can read is
 * still a worktree somebody may want to delete.
 */
async function committedAt(run: Runner, dir: string): Promise<string> {
  try {
    const result = await git(run, dir, ["log", "-1", "--format=%cI"]);
    if (result.code !== 0) return "";
    return result.stdout.trim();
  } catch {
    return "";
  }
}

/**
 * How far ahead of now a birthtime may be before it is treated as no answer.
 *
 * Not zero, because a worktree on a network mount is stamped by the server's
 * clock and a few minutes of skew is ordinary. A day is well past skew and well
 * short of the values a filesystem invents when it has no birthtime at all.
 */
const BIRTHTIME_SLACK_MS = 24 * 3600_000;

/**
 * When the directory was created, as the filesystem reports it.
 *
 * Guarded, because plenty of filesystems do not record a birthtime and Node has
 * to answer something anyway: ext4 without `crtime`, and several network and
 * container filesystems, report the epoch — and a few report a value from the
 * future. Either would be rendered as a date, so this answers `""` and lets the
 * caller say nothing rather than say something wrong.
 */
function createdAt(path: string): string {
  try {
    const at = statSync(path).birthtime;
    const ms = at.getTime();
    if (!Number.isFinite(ms) || ms <= 0) return "";
    if (ms > Date.now() + BIRTHTIME_SLACK_MS) return "";
    return at.toISOString();
  } catch {
    return "";
  }
}

async function localBranchExists(run: Runner, project: Project, branch: string): Promise<boolean> {
  const result = await git(run, project.repo, ["show-ref", "--verify", "--quiet", `refs/heads/${branch}`]);
  return result.code === 0;
}

async function remoteBranchExists(run: Runner, project: Project, branch: string): Promise<boolean> {
  const result = await git(run, project.repo, ["show-ref", "--verify", "--quiet", `refs/remotes/origin/${branch}`]);
  return result.code === 0;
}

/**
 * Creates the worktree for a branch, or hands back the one already there.
 *
 * The three cases are the ones docs/troubleshooting.md has always told people to
 * run by hand, in the same order:
 *
 * | Where the branch is | What runs |
 * |---|---|
 * | a base was given | `worktree add -b <branch> <path> <base>` |
 * | local, checked out nowhere | `worktree add <path> <branch>` |
 * | local, checked out somewhere else | `worktree add --detach <path> refs/heads/<branch>` |
 * | only on the remote | `worktree add -b <branch> <path> origin/<branch>` |
 *
 * git refuses to check out one branch in two places, and a branch is very often
 * already open in somebody's main checkout, so the detached form is not an edge
 * case — it is the normal way to run a branch somebody is working on. It costs
 * nothing, because git.ts's `branchOf` recovers the branch name from a detached
 * tree via `git branch --points-at HEAD`.
 */
export async function addWorktree(input: AddInput): Promise<Worktree> {
  const run = input.run ?? nodeRunner;
  const log = input.log ?? (() => {});
  const branch = assertBranchName(input.branch);
  const { project } = input;

  // The directory name is the slug, not the branch: `feat/tkt-4821` has a slash
  // in it and would otherwise become a nested directory, and the same sanitiser
  // is what names the container and the hostname, so one branch has one name
  // everywhere.
  const path = join(project.worktrees, sanitizeSlug(branch));

  const before = await rawList(run, project);
  const atPath = before.find((entry) => samePath(entry.path, path));
  if (atPath && existsSync(path)) {
    // Find-or-create: asking twice for the same branch is what a dashboard does
    // on a double click, and the second answer should be the first worktree.
    const [existing] = await hydrate(run, [atPath]);
    if (existing) return existing;
  }
  if (atPath) {
    // Registered but gone — see listWorktrees. Without this, `worktree add`
    // refuses with "already registered" for a directory that is not there.
    await git(run, project.repo, ["worktree", "prune"]);
  }

  // Asked of the *raw* entries: branchOf gives a detached worktree the name of
  // the branch it sits on, and a detached worktree does not hold that branch, so
  // the recovered name would detach every later worktree for no reason.
  const heldElsewhere = before.some((entry) => !entry.detached && entry.branch === branch);

  let args: string[];
  if (input.base !== undefined && input.base.trim() !== "") {
    args = ["worktree", "add", "-b", branch, path, input.base.trim()];
  } else if (await localBranchExists(run, project, branch)) {
    args = heldElsewhere
      ? ["worktree", "add", "--detach", path, `refs/heads/${branch}`]
      : ["worktree", "add", path, branch];
  } else if (await remoteBranchExists(run, project, branch)) {
    args = ["worktree", "add", "-b", branch, path, `origin/${branch}`];
  } else {
    throw new WorktreeError(
      `branch "${branch}" does not exist locally or on origin — pass a base to create it`,
    );
  }

  await mkdir(project.worktrees, { recursive: true });
  const added = await git(run, project.repo, args);

  // **The tree on disk decides whether it worked, not the exit code.** A
  // repository's `post-checkout` hook runs *after* the checkout is already
  // written — one depending on a tool this machine does not have fails exactly
  // here — and git then exits non-zero for a worktree that exists and is
  // perfectly fine. Trusting the exit code deletes somebody's working setup and
  // tells them the worktree was never created, which is both wrong and the
  // hardest kind of wrong to debug.
  if (!existsSync(path)) throw failure(args, added);
  if (added.code !== 0) {
    log(
      `worktree created at ${path}, but git exited ${added.code} — a repository hook failed after the checkout:\n` +
        (added.stderr || added.stdout).trim().split("\n").slice(-8).join("\n"),
    );
  }

  const after = await rawList(run, project);
  const entry = after.find((candidate) => samePath(candidate.path, path));
  if (!entry) throw new WorktreeError(`git created ${path} but does not list it as a worktree`);

  const [created] = await hydrate(run, [entry]);
  if (!created) throw new WorktreeError(`git created ${path} but does not list it as a worktree`);

  await claimSlug(project, created, before, log, input.env);
  return created;
}

/**
 * Gives this worktree a slug of its own when the one it would derive is already
 * another worktree's.
 *
 * **This is the only place a collision can be seen.** §3.1 prefers a ticket id
 * found anywhere in the directory name over the branch, so two branches on one
 * ticket derive one slug — and every name is built from `<project>-<slug>`, so
 * that is one container, one set of volumes, one host rule and one migration
 * lock shared by two unrelated branches. `up` replaces a container it finds
 * rather than refusing, so the second worktree to start would tear the first
 * one's sandbox down and inherit its database. Nothing downstream can catch
 * that: from `up`'s side it is indistinguishable from restarting a sandbox after
 * a config change, which is a thing people do constantly.
 *
 * Here, the sibling worktrees are already in hand — `before` is the listing this
 * function took to decide how to create the worktree — so the check costs
 * nothing beyond the small reads that resolve each sibling's slug.
 *
 * Existing collisions on disk are deliberately **not** migrated. Renaming a
 * worktree that already has a running sandbox would orphan its container and its
 * volumes under the old name, which is a worse failure than the one being
 * prevented; this guards worktrees cut from now on.
 */
async function claimSlug(
  project: Project,
  created: Worktree,
  before: RawWorktree[],
  log: (line: string) => void,
  env?: NodeJS.ProcessEnv,
): Promise<void> {
  // Only a worktree under `<workspace>/<project>/wt` can hold a record, which is
  // every worktree this function creates — but a caller may hand it a `Project`
  // pointing somewhere else, and inventing a record for a directory outside the
  // workspace would put a value into a hostname that nothing else would read.
  const key = worktreeKey(created.path, project.name, env);
  if (!key) return;

  // Find-or-create reaches here for a worktree git had pruned and re-added, and
  // a worktree that has already been given a slug keeps it: rolling a second
  // token would move a live sandbox's name out from under it.
  if (await readRecordedSlug(key.project, key.worktreeDir, env)) return;

  const want = await slugFor({ worktree: created.path, project: project.name, branch: created.branch, env });

  const taken = new Set<string>();
  for (const sibling of before) {
    if (samePath(sibling.path, created.path)) continue;
    try {
      taken.add(
        await slugFor({
          worktree: sibling.path,
          project: project.name,
          branch: sibling.branch === UNKNOWN ? undefined : sibling.branch,
          env,
        }),
      );
    } catch {
      // A sibling whose name derives to nothing has no slug to collide with,
      // and refusing to cut *this* worktree because of it would be absurd.
    }
  }

  if (!taken.has(want)) return;

  const given = uniqueSlug(want, taken);
  await writeRecordedSlug(key.project, key.worktreeDir, given, env);
  log(
    `another worktree of ${project.name} already answers to "${want}", so this one is "${given}" — ` +
      "a slug names a container, four volumes and a migration lock, and two worktrees cannot share them",
  );
}

/**
 * Removes a worktree and the entry that outlives it.
 *
 * The prune is not tidiness: `worktree remove` refuses a directory somebody has
 * already deleted by hand, and without the prune that stale entry keeps the
 * worktree looking alive to `list` and blocks the next `add` at the same path.
 * So the disk decides here too — if the directory is gone afterwards, the job is
 * done, whatever `remove` thought of it.
 */
export async function removeWorktree(
  project: Project,
  path: string,
  options: { run?: Runner | undefined; force?: boolean | undefined; env?: NodeJS.ProcessEnv | undefined } = {},
): Promise<void> {
  const run = options.run ?? nodeRunner;

  const args = ["worktree", "remove", ...(options.force ? ["--force"] : []), path];
  const removed = await git(run, project.repo, args);
  await git(run, project.repo, ["worktree", "prune"]);

  if (existsSync(path)) throw failure(args, removed);

  // Tidiness, not correctness — the same posture `down` takes with a keep-alive
  // marker. A record left behind names a directory that no longer exists, and
  // the next worktree cut at that name would simply be handed a slug it had no
  // collision to justify.
  const key = worktreeKey(path, project.name, options.env);
  if (key) await removeRecordedSlug(key.project, key.worktreeDir, options.env);
}

/**
 * Every branch the project has, local and remote, most recent commit first.
 *
 * Named the way a forge names them — `origin/` is stripped — because the branch
 * a caller types is the one a pull request shows, and a listing that answers
 * `origin/feat/thing` would make `addWorktree("origin/feat/thing")` look right
 * when it is not a branch name at all.
 */
export async function listBranches(
  project: Project,
  options: { run?: Runner | undefined } = {},
): Promise<Branch[]> {
  const run = options.run ?? nodeRunner;

  // A tab separator rather than a space: a committer date has spaces in some
  // formats, and a ref name may not contain a tab, so the split is unambiguous.
  const result = await git(run, project.repo, [
    "for-each-ref",
    "--format=%(refname:short)%09%(committerdate:iso8601)",
    "refs/heads",
    "refs/remotes/origin",
  ]);
  if (result.code !== 0) return [];

  // Local wins over remote: they are the same branch, and the local ref is the
  // one a worktree can be checked out from without creating anything.
  const branches = new Map<string, Branch>();

  for (const line of result.stdout.split("\n")) {
    if (line.trim() === "") continue;
    const [rawName = "", updated = ""] = line.split("\t");

    const remote = rawName.startsWith("origin/");
    const name = remote ? rawName.slice("origin/".length) : rawName;

    // `origin/HEAD` is a symbolic ref onto the default branch, not a branch of
    // its own; listing it puts a phantom branch called HEAD in every dropdown.
    if (name === "" || name === "HEAD") continue;

    const seen = branches.get(name);
    if (seen && (!seen.remote || remote)) continue;
    branches.set(name, { name, remote, updated: updated.trim() });
  }

  return [...branches.values()].sort((a, b) => b.updated.localeCompare(a.updated) || a.name.localeCompare(b.name));
}
