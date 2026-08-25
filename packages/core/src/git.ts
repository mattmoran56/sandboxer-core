/**
 * What a worktree can tell us about itself.
 *
 * A sandbox's labels record the branch, the commit and whether the tree was
 * dirty when it started, so the dashboard can say what is running without
 * asking git again. Everything here degrades to a usable answer rather than
 * throwing: a worktree with no commits, a detached HEAD or no git at all is
 * still a worktree worth running.
 */

import { basename } from "node:path";

import { nodeRunner, type ExecResult, type Runner } from "./docker.js";

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
