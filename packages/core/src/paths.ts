/**
 * Every host path sandboxr owns, from contracts §4.
 *
 * All of it hangs off SANDBOXR_HOME (default `~/.sandboxr`), which is
 * deliberately outside any repository so `git clean` cannot destroy a seed
 * cache or a certificate.
 */

import { realpathSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, relative } from "node:path";

/**
 * The path the filesystem will call this path.
 *
 * git records a worktree by its *resolved* path, and so does every mount table,
 * so on any machine where a parent directory is a symlink — macOS's `/tmp` and
 * `/var/folders` are both symlinks into `/private`, and plenty of people keep
 * their code under one — a path handed in never string-matches the path
 * `worktree list` reports back. That mismatch does not look like a symlink
 * problem: it looks like git having created a worktree it then denies exists.
 */
export function canonicalPath(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
}

/** Whether two paths name the same place, symlinks resolved. */
export function samePath(a: string, b: string): boolean {
  return a === b || canonicalPath(a) === canonicalPath(b);
}

/**
 * Whether one path is the same as, or under, another.
 *
 * Path arithmetic with a separator guard rather than `startsWith` alone: a
 * workspace at `/srv/sandboxr-other` would otherwise count as inside
 * `/srv/sandboxr` and silently lose its mount.
 */
export function isInside(child: string, parent: string): boolean {
  const rel = relative(parent, child);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

/**
 * The directory a project's worktrees are cut into, inside its project
 * directory: `<workspace>/<project>/wt/<slug>`.
 *
 * Here rather than in workspace.ts because config/locate.ts has to recognise a
 * worktree from its path alone — two spellings of one layout rule is exactly how
 * a config ends up being looked for in the wrong directory.
 */
export const WORKTREES_DIR = "wt";

export interface Paths {
  /** SANDBOXR_HOME itself. */
  home: string;
  /** Database seed artifacts, content-addressed. */
  cache: string;
  /** Per-sandbox logs, which outlive the container. */
  logs: string;
  /** The certificate and key the router serves. */
  tls: string;
  /** Router config and the dashboard session secret. */
  state: string;
  /** Third-party credentials, one file per project, mode 0600. */
  secrets: string;
  /**
   * The machine's own settings — how long a sandbox may sit unused.
   *
   * Beside the tree rather than inside `state/`, because everything under
   * `state/` is generated and may be rewritten, and this one is written by hand.
   */
  configFile: string;
  /** Generated per-sandbox environment files. */
  build: string;
  /** Host-built helper binaries. */
  bin: string;
  /**
   * The projects this machine can start a sandbox for, one directory each.
   *
   * Outside the rest of the tree in spirit: everything else under SANDBOXR_HOME
   * is something sandboxr generated and can regenerate, whereas this holds
   * checkouts of other people's repositories. It is still under the home so
   * there is one directory to mount into the dashboard and one to back up.
   */
  workspace: string;

  logsFor(project: string, slug: string): string;
  secretsFile(project: string): string;
  /** The generated environment for one sandbox. */
  envFile(project: string, slug: string): string;
  /** A content-addressed seed artifact. */
  cacheFile(name: string): string;
  /** Where one project's bare mirror and worktrees live. */
  projectDir(project: string): string;
  /** Where that project's worktrees are cut, one directory per branch. */
  worktreesDir(project: string): string;
  /** The marker that keeps one sandbox alive past its idle limit. */
  keepFile(project: string, slug: string): string;
}

/**
 * Resolves the path set from an environment.
 *
 * Takes the environment as an argument rather than reading `process.env`
 * directly so a test can point the whole tree at a temporary directory without
 * mutating the process.
 */
export function paths(env: NodeJS.ProcessEnv = process.env): Paths {
  const home = env.SANDBOXR_HOME && env.SANDBOXR_HOME !== "" ? env.SANDBOXR_HOME : join(homedir(), ".sandboxr");
  // Its own variable rather than always under the home, because the projects
  // are the one thing here worth putting on a different disk.
  const workspace =
    env.SANDBOXR_WORKSPACE && env.SANDBOXR_WORKSPACE !== "" ? env.SANDBOXR_WORKSPACE : join(home, "workspace");

  return {
    home,
    cache: join(home, "cache"),
    logs: join(home, "logs"),
    tls: join(home, "tls"),
    state: join(home, "state"),
    secrets: join(home, "secrets"),
    configFile: join(home, "config.yaml"),
    build: join(home, "build"),
    bin: join(home, "bin"),
    workspace,

    logsFor: (project, slug) => join(home, "logs", project, slug),
    secretsFile: (project) => join(home, "secrets", `${project}.env`),
    envFile: (project, slug) => join(home, "build", project, `${slug}.env`),
    cacheFile: (name) => join(home, "cache", name),
    projectDir: (project) => join(workspace, project),
    worktreesDir: (project) => join(workspace, project, WORKTREES_DIR),
    keepFile: (project, slug) => join(home, "state", "keep", project, slug),
  };
}

/** The directories a command creates before it writes anything. */
export function directoriesOf(p: Paths): string[] {
  return [p.cache, p.logs, p.tls, p.state, p.secrets, p.build, p.bin, p.workspace];
}
