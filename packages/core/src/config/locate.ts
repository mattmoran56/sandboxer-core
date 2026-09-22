/**
 * Which file configures a directory, and which directory that config governs.
 *
 * These used to be one answer. A project describes itself in a `sandboxer.yaml`
 * at its own repo root, so the root was `dirname(file)` and there was nothing
 * else to decide. Contracts §5.6 adds the one exception: a project-level config
 * at `<workspace>/<project>/sandboxer.yaml`, read by every worktree of that
 * project that carries no config of its own. That file sits *beside* `repo.git`,
 * one level above every worktree, so its content applies to a worktree while its
 * directory emphatically does not.
 *
 * Both decisions live here, in one place, because the failure mode when they
 * drift apart is not a wrong config — it is a sandbox that mounts the wrong
 * directory as `/workspace` and then fails somewhere much further downstream.
 */

import { realpathSync } from "node:fs";
import { stat } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

import { WORKTREES_DIR, paths } from "../paths.js";

export const CONFIG_FILENAME = "sandboxer.yaml";

/** Alternative spellings, accepted in this order when more than one is present. */
export const CONFIG_FILENAMES = [CONFIG_FILENAME, "sandboxer.yml", ".sandboxer.yaml"] as const;

/** Where a config's content came from, relative to the tree it configures. */
export type ConfigOrigin =
  /** Inside the checkout it configures — a project describing itself. */
  | "repo"
  /** `<workspace>/<project>/sandboxer.yaml`, standing in for every worktree. */
  | "project";

export interface ConfigLocation {
  /** Absolute path to the file to read. An error names this one. */
  file: string;
  /** Absolute path to the directory the config governs — what becomes `/workspace`. */
  root: string;
  origin: ConfigOrigin;
}

export interface LocateOptions {
  /** The environment the workspace path is read from. */
  env?: NodeJS.ProcessEnv | undefined;
}

async function isFile(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isFile();
  } catch {
    return false;
  }
}

/**
 * The path the filesystem really calls this path.
 *
 * The same trap worktree.ts records: macOS puts `/tmp` and `/var/folders` behind
 * symlinks into `/private`, and git hands back the *resolved* path of a worktree
 * it created. A workspace root read out of the environment is not resolved, so
 * the two never string-match — and a worktree then looks like it is not in the
 * workspace at all, which is nothing like what the symptom suggests.
 */
function canonical(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
}

function samePath(a: string, b: string): boolean {
  return a === b || canonical(a) === canonical(b);
}

/** `target` split into segments below `base`, or undefined when it is not below it. */
function segmentsUnder(base: string, target: string): string[] | undefined {
  const rel = relative(resolve(base), resolve(target));
  if (rel === "") return [];
  if (rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) return undefined;
  return rel.split(sep);
}

/**
 * Matches a path against the workspace, literally first and then through
 * realpath.
 *
 * The literal attempt comes first so an answer keeps the spelling the caller
 * uses; the resolved one is the fallback that makes a symlinked home work at
 * all. `base` is returned alongside because the answer has to be rebuilt from
 * whichever spelling matched.
 */
function againstWorkspace(
  dir: string,
  env: NodeJS.ProcessEnv,
): { base: string; segments: string[] } | undefined {
  const configured = paths(env).workspace;

  const literal = segmentsUnder(configured, dir);
  if (literal) return { base: configured, segments: literal };

  const resolved = segmentsUnder(canonical(configured), canonical(dir));
  return resolved ? { base: canonical(configured), segments: resolved } : undefined;
}

export interface WorkspaceWorktree {
  /** The project's directory name in the workspace. */
  project: string;
  /** `<workspace>/<project>` — where a project-level config may sit. */
  projectDir: string;
  /** `<workspace>/<project>/wt/<slug>` — the top of this checkout. */
  worktree: string;
}

/**
 * The managed worktree a directory sits in, if it sits in one.
 *
 * Decided from the path rather than asked of git, because the layout *is* the
 * contract (§4) and git would happily answer for any repository anywhere,
 * including the ones outside the workspace this must not change the behaviour
 * of.
 */
export function workspaceWorktree(dir: string, env: NodeJS.ProcessEnv = process.env): WorkspaceWorktree | undefined {
  const match = againstWorkspace(dir, env);
  if (!match) return undefined;

  // `<project>/wt/<slug>` and then anything at all: a command may legitimately
  // be run from deep inside a worktree, which is what the walk-up is for.
  const [project, wt, slug] = match.segments;
  if (project === undefined || wt !== WORKTREES_DIR || slug === undefined) return undefined;

  const projectDir = join(match.base, project);
  return { project, projectDir, worktree: join(projectDir, WORKTREES_DIR, slug) };
}

/**
 * Whether a directory is a workspace project directory itself.
 *
 * That directory holds `repo.git` and every worktree of the project, so it is
 * the one directory in the workspace that must never become a config's `root`.
 * loadConfig refuses it; see the comment there for what happens if it does not.
 */
export function isWorkspaceProjectDir(dir: string, env: NodeJS.ProcessEnv = process.env): boolean {
  return againstWorkspace(dir, env)?.segments.length === 1;
}

/**
 * Walks up from a directory looking for a config file.
 *
 * The file lives at the root of the project being sandboxed, so any directory
 * inside that project is a legal place to run a command from — which is what
 * makes `sandboxer up` work from wherever you happen to be.
 *
 * `stopAt` is the last directory searched. It exists because the walk is
 * otherwise unbounded to the filesystem root, and inside a managed worktree that
 * takes it straight out of the checkout — see `locateConfig`.
 */
export async function findConfig(
  from: string = process.cwd(),
  options: { stopAt?: string | undefined } = {},
): Promise<string | undefined> {
  const stop = options.stopAt === undefined ? undefined : resolve(options.stopAt);
  let dir = resolve(from);
  for (;;) {
    for (const name of CONFIG_FILENAMES) {
      const candidate = join(dir, name);
      if (await isFile(candidate)) return candidate;
    }
    if (stop !== undefined && samePath(dir, stop)) return undefined;
    const parent = dirname(dir);
    if (parent === dir) return undefined;
    dir = parent;
  }
}

/** The project-level config for a managed project, if it has one. */
async function projectLevelConfig(projectDir: string): Promise<string | undefined> {
  for (const name of CONFIG_FILENAMES) {
    const candidate = join(projectDir, name);
    if (await isFile(candidate)) return candidate;
  }
  return undefined;
}

/**
 * Decides which file configures `from`, and what that config's root is.
 *
 * Three cases, in this order:
 *
 * | `from` | file | root |
 * |---|---|---|
 * | names a file | that file | its own directory |
 * | inside a managed worktree | the worktree's own, else the project-level one | the worktree |
 * | anywhere else | found by walking up, unbounded | the file's own directory |
 *
 * **A worktree's own config always wins.** The project-level file is a fallback
 * and never an override: a repository that has said how it should be run must
 * not be quietly overruled by a file outside it that its authors cannot see.
 *
 * Returns undefined when there is no config to be found; the caller owns the
 * error, because it knows what the user was trying to do.
 */
export async function locateConfig(
  from: string = process.cwd(),
  options: LocateOptions = {},
): Promise<ConfigLocation | undefined> {
  const env = options.env ?? process.env;
  const target = resolve(from);

  // A path naming a file is an explicit choice of document, so nothing is
  // searched for. Its root is still checked by the caller.
  if (await isFile(target)) return { file: target, root: dirname(target), origin: "repo" };

  const here = workspaceWorktree(target, env);
  if (!here) {
    const found = await findConfig(target);
    return found ? { file: found, root: dirname(found), origin: "repo" } : undefined;
  }

  // **Bounded at the top of the worktree, and that bound is the bug fix.**
  // Unbounded, the walk-up leaves the checkout on its own and lands on
  // `<workspace>/<project>/sandboxer.yaml` — at which point `root` is
  // `dirname(file)`, so `/workspace` becomes the project directory, with
  // `repo.git` and every sibling worktree mounted into the sandbox and every
  // declared path resolving one directory too high. None of those failures looks
  // anything like a wrong root. The fallback below is the sanctioned version of
  // the same lookup, and it keeps the worktree as the root.
  const own = await findConfig(target, { stopAt: here.worktree });
  if (own) return { file: own, root: dirname(own), origin: "repo" };

  const shared = await projectLevelConfig(here.projectDir);
  // Read for its content only. The worktree stays the root because every path
  // the config declares has to resolve inside this branch's own checkout.
  return shared ? { file: shared, root: here.worktree, origin: "project" } : undefined;
}
