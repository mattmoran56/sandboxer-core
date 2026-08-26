/**
 * The workspace: one directory holding every project this machine can start a
 * sandbox for.
 *
 *     <workspace>/<name>/repo.git      a bare clone of the project
 *     <workspace>/<name>/wt/<branch>   the worktrees cut from it
 *
 * There is deliberately **no registry file**. A project *is* a directory
 * containing `repo.git`, so listing projects is a readdir — the same doctrine as
 * docs/architecture/state.md, where `sandboxr ls` is a pure function of
 * `docker ps`. A manifest would go stale the first time somebody deleted a
 * directory by hand, and there is nothing in a manifest that the directory does
 * not already say.
 *
 * Every process here runs through the injectable `Runner` from ./docker.js, and
 * arguments are always arrays: a project name or a clone URL can reach this code
 * from a browser by way of the dashboard, so there is no path where one becomes
 * shell syntax.
 */

import { mkdir, readdir, rm, stat } from "node:fs/promises";
import { join } from "node:path";

import { nodeRunner, type ExecResult, type Runner } from "./docker.js";
import { sanitizeSlug } from "./naming.js";
import { WORKTREES_DIR, paths } from "./paths.js";

export interface Project {
  /** Directory name in the workspace — the key everything else is looked up by. */
  name: string;
  /** Absolute path to the bare mirror. */
  repo: string;
  /** Absolute path to `<project>/wt`, the parent of every worktree. */
  worktrees: string;
  /** The remote's default branch, as the bare clone recorded it. */
  base: string;
  /** The URL it was cloned from, or "" when the remote is gone. */
  origin: string;
}

export class WorkspaceError extends Error {
  override readonly name = "WorkspaceError";
}

export interface WorkspaceOptions {
  env?: NodeJS.ProcessEnv | undefined;
  run?: Runner | undefined;
}

export interface CloneOptions extends WorkspaceOptions {
  /** Overrides the name derived from the URL. */
  name?: string | undefined;
  /** Progress, one line at a time. */
  log?: ((line: string) => void) | undefined;
}

/** The directory name of the bare mirror inside a project directory. */
const REPO_DIR = "repo.git";

/**
 * What `base` falls back to.
 *
 * A project whose HEAD cannot be resolved is still a project worth listing, so
 * nothing here throws over it — same posture as git.ts, which answers "?" rather
 * than failing a listing.
 */
const DEFAULT_BASE = "main";

async function git(run: Runner, dir: string, args: string[]): Promise<ExecResult> {
  return run("git", ["-C", dir, ...args]);
}

/**
 * Rejects an argument git would read as an option.
 *
 * Passing arguments as an array prevents quoting bugs but does **not** prevent
 * an argument being read as a flag: `git clone --upload-pack=<cmd> …` runs
 * `<cmd>`, so a URL beginning with a dash is arbitrary command execution by any
 * caller who can name a repository — which, via the dashboard, is anyone who can
 * reach it. There is no legitimate URL starting with `-`.
 */
function assertSafeUrl(url: string): void {
  const trimmed = url.trim();
  if (trimmed === "") throw new WorkspaceError("a clone url is required");
  if (trimmed.startsWith("-")) {
    throw new WorkspaceError(`clone url "${trimmed}" starts with "-", which git would read as an option`);
  }
}

/**
 * Rejects a name that would resolve outside the workspace.
 *
 * The name is joined onto the workspace path and then handed to `rm` on a failed
 * clone, so a `..` segment is not merely a wrong lookup — it is a delete
 * somewhere else on the disk.
 */
function assertSafeName(name: string): void {
  if (name === "") throw new WorkspaceError("a project name is required");
  if (name === "." || name.includes("/") || name.includes("\\") || name.includes("..")) {
    throw new WorkspaceError(`project name "${name}" would escape the workspace`);
  }
}

/**
 * Derives a project name from a clone URL.
 *
 * Handles the four shapes in use — `https://host/owner/repo.git`,
 * `https://host/owner/repo`, `git@host:owner/repo.git`, and any of them with a
 * trailing slash — by taking the last segment of either separator, since the scp
 * form puts a colon where https puts a slash.
 */
export function projectNameFromUrl(url: string): string {
  assertSafeUrl(url);

  const trimmed = url.trim().replace(/[/]+$/, "");
  const segment = trimmed.split(/[/:]/).pop() ?? "";
  const bare = segment.replace(/\.git$/i, "");
  if (bare === "") throw new WorkspaceError(`cannot derive a project name from "${url}"`);

  // The same sanitiser the slugs use, because a project name becomes a hostname
  // label and a docker name component exactly as a slug does.
  const name = sanitizeSlug(bare);
  assertSafeName(name);
  return name;
}

async function isDirectory(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory();
  } catch {
    return false;
  }
}

/** Reads the facts a project directory carries, without ever failing over them. */
async function describe(name: string, dir: string, run: Runner): Promise<Project> {
  const repo = join(dir, REPO_DIR);

  // A bare clone records the remote's default branch as its own HEAD, so this is
  // the remote's answer, not a guess made locally.
  const head = await git(run, repo, ["symbolic-ref", "--short", "HEAD"]);
  const base = head.code === 0 && head.stdout.trim() !== "" ? head.stdout.trim() : DEFAULT_BASE;

  const origin = await git(run, repo, ["remote", "get-url", "origin"]);

  return {
    name,
    repo,
    worktrees: join(dir, WORKTREES_DIR),
    base,
    origin: origin.code === 0 ? origin.stdout.trim() : "",
  };
}

/**
 * Every project in the workspace, sorted by name.
 *
 * A missing workspace directory is an empty workspace, not an error — it is the
 * state of a machine that has never cloned anything. A directory without a
 * `repo.git` is skipped silently: it is not a half-project, it is not a project
 * at all, and a warning about it would fire on every listing forever.
 */
export async function listProjects(options: WorkspaceOptions = {}): Promise<Project[]> {
  const run = options.run ?? nodeRunner;
  const workspace = paths(options.env).workspace;

  let entries;
  try {
    entries = await readdir(workspace, { withFileTypes: true });
  } catch {
    return [];
  }

  const names: string[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    if (!(await isDirectory(join(workspace, entry.name, REPO_DIR)))) continue;
    names.push(entry.name);
  }
  names.sort((a, b) => a.localeCompare(b));

  return Promise.all(names.map((name) => describe(name, join(workspace, name), run)));
}

/** One project by name, or undefined when the workspace has no such directory. */
export async function findProject(name: string, options: WorkspaceOptions = {}): Promise<Project | undefined> {
  assertSafeName(name);

  const run = options.run ?? nodeRunner;
  const dir = paths(options.env).projectDir(name);
  if (!(await isDirectory(join(dir, REPO_DIR)))) return undefined;

  return describe(name, dir, run);
}

/**
 * Clones a repository into the workspace as a bare mirror.
 *
 * **`--bare`, not `--mirror`, and the refspec is then set by hand.** A mirror
 * clone fetches `+refs/*:refs/*`, so every subsequent fetch force-updates
 * `refs/heads/*` to match the remote. Worktree branches live in `refs/heads/*`,
 * which means a routine background fetch would reset a branch a sandbox has
 * checked out and discard commits made in it — data loss from an operation
 * nobody thinks of as destructive. Fetching into `refs/remotes/origin/*` instead
 * leaves local branches alone, which is the whole point of this directory.
 *
 * The refspec has to be configured explicitly because a plain `--bare` clone
 * configures *none at all*: without it `git fetch` exits 0 having updated
 * nothing, and every branch listing stays frozen at the moment of the clone,
 * silently and forever.
 */
export async function cloneProject(url: string, options: CloneOptions = {}): Promise<Project> {
  assertSafeUrl(url);
  const run = options.run ?? nodeRunner;
  const log = options.log ?? (() => {});

  const name = options.name ?? projectNameFromUrl(url);
  assertSafeName(name);

  const dir = paths(options.env).projectDir(name);
  const repo = join(dir, REPO_DIR);

  // Refused rather than reused: an existing directory may hold worktrees with
  // uncommitted work in them, and cloning over it would be the one mistake this
  // module cannot undo.
  if (await isDirectory(dir)) {
    throw new WorkspaceError(`project "${name}" already exists at ${dir}`);
  }

  await mkdir(dir, { recursive: true });

  try {
    log(`cloning ${url}`);
    const cloned = await run("git", ["clone", "--bare", url, repo]);
    if (cloned.code !== 0) throw failure(["clone", "--bare", url, repo], cloned);

    const refspec = await git(run, repo, ["config", "remote.origin.fetch", "+refs/heads/*:refs/remotes/origin/*"]);
    if (refspec.code !== 0) throw failure(["config", "remote.origin.fetch"], refspec);

    // Fetched once immediately, because the clone populated `refs/heads/*` and
    // nothing else — until this runs there are no remote-tracking refs, and the
    // refspec just set is what everything downstream reads branches from.
    const fetched = await git(run, repo, ["fetch", "origin"]);
    if (fetched.code !== 0) throw failure(["fetch", "origin"], fetched);

    await mkdir(join(dir, WORKTREES_DIR), { recursive: true });

    const project = await describe(name, dir, run);
    log(`cloned ${name} (${project.base})`);
    return project;
  } catch (error) {
    // A half-cloned `repo.git` is worse than no project: listProjects would
    // report it as a real one, and every command after that would fail somewhere
    // deeper, with an error that does not resemble its cause.
    await rm(dir, { recursive: true, force: true });
    throw error;
  }
}

/**
 * Brings a project's remote-tracking refs up to date.
 *
 * Safe to run at any time precisely because of the refspec set at clone time:
 * it touches `refs/remotes/origin/*` only, so a worktree with work in it is
 * never disturbed.
 */
export async function fetchProject(project: Project, options: { run?: Runner | undefined } = {}): Promise<void> {
  const run = options.run ?? nodeRunner;
  const result = await git(run, project.repo, ["fetch", "origin"]);
  if (result.code !== 0) throw failure(["fetch", "origin"], result);
}

function failure(args: string[], result: ExecResult): WorkspaceError {
  const detail = (result.stderr || result.stdout).trim().split("\n").slice(-8).join("\n");
  return new WorkspaceError(`git ${args.join(" ")} exited ${result.code}${detail ? `:\n${detail}` : ""}`);
}
