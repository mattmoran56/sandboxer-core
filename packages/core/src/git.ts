/**
 * What a worktree can tell us about itself.
 *
 * A sandbox's labels record the branch, the commit and whether the tree was
 * dirty when it started, so the dashboard can say what is running without
 * asking git again. Everything here degrades to a usable answer rather than
 * throwing: a worktree with no commits, a detached HEAD or no git at all is
 * still a worktree worth running.
 *
 * It also answers the two questions a *container* has to ask of the host before
 * git works inside it — which directories to mount, and who a commit is by. Both
 * live here rather than beside the mounts they end up in, because both are facts
 * about a checkout on this machine, and `sandbox/run.ts` is deliberately a pure
 * function that touches no disk.
 */

import { basename, resolve } from "node:path";

import { nodeRunner, type ExecResult, type Runner } from "./docker.js";
import { isInside, samePath } from "./paths.js";

export interface GitFacts {
  /** The branch name, or `?` when it cannot be resolved. */
  branch: string;
  /** Short commit sha, or `?`. */
  commit: string;
  dirty: boolean;
  /** Absolute path to the top of the worktree. */
  worktree: string;
  /** The worktree's directory name, which a slug can be derived from. */
  directory: string;
}

export interface GitOptions {
  run?: Runner | undefined;
  /** Paths whose changes do not count as dirty, as literal suffixes. */
  ignoreDirty?: string[] | undefined;
}

const UNKNOWN = "?";

async function git(run: Runner, worktree: string, args: string[]): Promise<ExecResult> {
  return run("git", ["-C", worktree, ...args]);
}

/**
 * Names the branch a worktree is on.
 *
 * A detached worktree — which is how you run a branch that is already checked
 * out somewhere else, since git refuses the same branch twice — has no branch
 * name, and `rev-parse --abbrev-ref HEAD` answers with the literal "HEAD".
 * Labelling a sandbox that way loses the one piece of information anything
 * asking about it wants, so any local branch pointing at the same commit
 * recovers the name, and a remote-tracking name has its remote stripped so it
 * matches what a forge reports as the head ref.
 */
export async function branchOf(worktree: string, run: Runner = nodeRunner): Promise<string> {
  const head = await git(run, worktree, ["rev-parse", "--abbrev-ref", "HEAD"]);
  const name = head.code === 0 ? head.stdout.trim() : "";
  if (name !== "" && name !== "HEAD") return name;

  const local = await git(run, worktree, ["branch", "--points-at", "HEAD", "--format=%(refname:short)"]);
  const localName = pickBranch(local.stdout);
  if (localName) return localName;

  const remote = await git(run, worktree, ["branch", "-r", "--points-at", "HEAD", "--format=%(refname:short)"]);
  const remoteName = pickBranch(remote.stdout);
  if (remoteName) return remoteName.replace(/^[^/]+\//, "");

  return UNKNOWN;
}

/**
 * Picks a usable branch name out of `git branch --points-at`.
 *
 * The detached HEAD itself is listed as a parenthesised pseudo-entry alongside
 * any real branches, so taking the first line blindly labels every detached
 * sandbox "(no branch)".
 */
export function pickBranch(stdout: string): string | undefined {
  return stdout
    .split("\n")
    .map((line) => line.trim())
    .find((line) => line !== "" && !line.startsWith("(") && line !== "HEAD" && !line.endsWith("/HEAD"));
}

/**
 * Lists a worktree's uncommitted changes, minus the ones sandboxr itself makes.
 *
 * A build inside a sandbox can write files the branch's .gitignore does not
 * cover — a generated environment file beside a package is the usual one — and
 * counting those would mean that merely running a sandbox made its worktree
 * dirty, which then blocks the commands that refuse to touch a dirty tree.
 */
export function dirtyFiles(porcelain: string, ignore: string[] = []): string[] {
  return porcelain
    .split("\n")
    .map((line) => line.trimEnd())
    .filter((line) => line !== "")
    .filter((line) => {
      const path = line.slice(3);
      return !ignore.some((suffix) => path.endsWith(suffix));
    });
}

/** The default ignore list: files a sandbox's own builds generate. */
export const DEFAULT_DIRTY_IGNORE = [".env.local"];

export async function gitFacts(worktree: string, options: GitOptions = {}): Promise<GitFacts> {
  const run = options.run ?? nodeRunner;

  const top = await git(run, worktree, ["rev-parse", "--show-toplevel"]);
  const root = top.code === 0 && top.stdout.trim() !== "" ? top.stdout.trim() : worktree;

  const commitResult = await git(run, root, ["rev-parse", "--short", "HEAD"]);
  const status = await git(run, root, ["status", "--porcelain"]);

  return {
    branch: await branchOf(root, run),
    commit: commitResult.code === 0 && commitResult.stdout.trim() !== "" ? commitResult.stdout.trim() : UNKNOWN,
    dirty: status.code === 0 && dirtyFiles(status.stdout, options.ignoreDirty ?? DEFAULT_DIRTY_IGNORE).length > 0,
    worktree: root,
    directory: basename(root),
  };
}

/**
 * The host directories a sandbox needs mounted at their own paths before git
 * works inside it.
 *
 * **A linked worktree is a directory full of absolute paths.** Its `.git` is not
 * a directory but a one-line file — `gitdir: <repo>/worktrees/<name>` — and the
 * repository it names is on the host, not in the container. Bind-mounting the
 * worktree alone therefore produces a `/workspace` where *every* git command
 * fails identically:
 *
 *     fatal: not a git repository: /Users/…/repo.git/worktrees/staging
 *
 * which reads as a broken checkout rather than a missing mount, and which is
 * what a sandbox did for as long as `git` was in the base image — including for
 * the `git status`/`git diff`/`git commit` an agent session is allowed to run.
 *
 * The fix is the one every workspace mount here already applies:
 * mount the directory at the **identical path inside and out**, so the absolute
 * path git wrote down resolves to the thing it names. Two paths need it:
 *
 * - the repository, because that is what the worktree's `.git` points at, and
 *   `git commit` writes objects and refs into it;
 * - the worktree itself, a second time alongside `/workspace`, because the
 *   repository points *back* — `<repo>/worktrees/<name>/gitdir` holds the
 *   worktree's host path, and when that path does not exist git marks the
 *   worktree `prunable`. That is not cosmetic: `git gc`, which `git commit`
 *   triggers on its own, prunes prunable worktrees, and pruning this one would
 *   delete the host's admin entry for a worktree that is very much alive.
 *   (The base image also pins `gc.worktreePruneExpire` to `never`, because one
 *   sandbox can only ever see its own worktree and would judge every *sibling*
 *   worktree of the same project missing.)
 *
 * The second mount is for git's benefit and nothing else's: the dependency
 * volume is mounted under `/workspace`, so the identical-path copy is the same
 * files without `node_modules`, and it is not a second place to work.
 *
 * Nothing is returned for a plain (non-worktree) checkout, whose `.git` is a
 * directory inside the tree already being mounted and which records no absolute
 * path at all — and nothing for a repository whose top is *above* the tree being
 * mounted, because making that work would mean mounting the enclosing
 * repository, and a git that finds its `.git` above `/workspace` reports every
 * file in the project as deleted. A clean failure beats that.
 */
export async function gitMounts(root: string, options: { run?: Runner | undefined } = {}): Promise<string[]> {
  const run = options.run ?? nodeRunner;

  const top = await git(run, root, ["rev-parse", "--show-toplevel"]);
  if (top.code !== 0 || top.stdout.trim() === "") return [];
  // Not a repository, or a repository whose top is somewhere else: either way
  // there is no absolute path of ours to make resolvable.
  if (!samePath(top.stdout.trim(), root)) return [];

  const common = await git(run, root, ["rev-parse", "--git-common-dir"]);
  if (common.code !== 0 || common.stdout.trim() === "") return [];
  // `--git-common-dir` answers a path relative to the working directory for an
  // ordinary repository and an absolute one for a linked worktree, and asking
  // for `--path-format=absolute` instead would need git 2.31 on the host.
  const commonDir = resolve(root, common.stdout.trim());
  if (isInside(commonDir, root)) return [];

  return [root, commonDir];
}

/** Who a commit made inside a sandbox is by. */
export interface GitIdentity {
  name?: string | undefined;
  email?: string | undefined;
}

/**
 * The identity this machine commits under.
 *
 * A sandbox has no `~/.gitconfig`, and git will not commit without a name and an
 * address: it tries to invent one from the passwd entry and the hostname, and in
 * a container the hostname has no domain, so it gives up with "unable to
 * auto-detect email address" — a sentence about DNS in the middle of a commit.
 *
 * Read from the environment first so a front end, which has no gitconfig of
 * its own either, can be handed the answer at `init` (see access/host-env.ts)
 * rather than resolving one from inside its container. The host's `~/.gitconfig`
 * is deliberately **not** mounted into either: it carries a credential helper
 * naming a macOS keychain that is not there, and `commit.gpgsign` pointing at a
 * key that is not there, so the whole file breaks the two operations it was
 * supposed to enable. Two values crossing the boundary is the whole of it.
 *
 * Never throws: a machine that has never configured git has no identity, and the
 * sandbox still starts. `git commit` then fails inside it with git's own message,
 * which names exactly what to set.
 */
export async function hostGitIdentity(
  env: NodeJS.ProcessEnv = process.env,
  run: Runner = nodeRunner,
): Promise<GitIdentity> {
  const held = (value: string | undefined): string | undefined =>
    value !== undefined && value.trim() !== "" ? value.trim() : undefined;

  const identity: GitIdentity = {
    name: held(env.GIT_AUTHOR_NAME),
    email: held(env.GIT_AUTHOR_EMAIL),
  };
  if (identity.name && identity.email) return identity;

  try {
    if (!identity.name) {
      const name = await run("git", ["config", "--get", "user.name"]);
      identity.name = name.code === 0 ? held(name.stdout) : undefined;
    }
    if (!identity.email) {
      const email = await run("git", ["config", "--get", "user.email"]);
      identity.email = email.code === 0 ? held(email.stdout) : undefined;
    }
  } catch {
    // No git on this machine at all. Nothing to say about who it commits as.
  }
  return identity;
}
