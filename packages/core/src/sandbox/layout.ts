/**
 * The paths shared with what runs *inside* a sandbox.
 *
 * This file is the host side of that boundary, and it must agree with
 * `container/README.md` ("Container inputs") exactly. Everything that mounts or
 * reads one of these paths goes through here, so a change to the boundary is a
 * single edit rather than a hunt through string literals.
 */

/** The worktree, bind-mounted read-write so a saved file is live inside. */
export const WORKSPACE = "/workspace";

/** The plan: the container's only view of the project, mounted read-only. */
export const PLAN_FILE = "/sandboxr/plan.json";

/** The host seed cache, mounted read-only: a sandbox restores, never writes. */
export const CACHE_DIR = "/sandboxr/cache";

/** Per-sandbox logs, on a host directory so they outlive the container. */
export const LOG_DIR = "/var/log/sandboxr";

/** The database volume: MySQL's data directory, or a file driver's state. */
export const DATA_DIR = "/var/lib/sandboxr/data";

/** Object storage inside the sandbox. */
export const BLOB_DIR = "/var/lib/sandboxr/blob";

/** Built binaries, on a volume so a rebuild survives a restart. */
export const BIN_DIR = "/var/lib/sandboxr/bin";

/** Built static sites, served by the sandbox's own file server. */
export const WWW_DIR = "/srv/www";

/** Runtime state, on a tmpfs: gone when the container stops, as it should be. */
export const RUN_DIR = "/run/sandboxr";

/**
 * Markers the container writes as it comes up.
 *
 * State is read from these rather than tracked on the host, for the same reason
 * the sandbox list is a function of `docker ps`: a fact written where it happens
 * cannot drift from what is actually true.
 */
/**
 * The migration verdict, as the container writes it.
 *
 * One JSON file and not a pair of touch-files: the container has to record
 * *which* migration failed and what it said, not merely that something did, and
 * `container/scripts/migrate-run.sh` composes exactly this — the same file
 * `status.sh` reads to build `/__sandboxr/status.json`. Reading it here rather
 * than probing for a second set of markers is what stops the host and the
 * container from holding two different opinions about the same run.
 */
export const MIGRATE_STATE = `${RUN_DIR}/migrate.json`;
export const READY = `${RUN_DIR}/ready`;

/**
 * What a sandbox has built, written as each build lands.
 *
 * The sandbox's own record rather than a guess from a directory listing, and it
 * lives on the volume, so it survives a restart.
 */
export const BUILT_MANIFEST = `${WWW_DIR}/.built.json`;

/** Where a static app's build output is served from. */
export function siteDir(label: string): string {
  return `${WWW_DIR}/${label}`;
}

/** Where a backend's binary is built to. */
export function binaryPath(name: string): string {
  return `${BIN_DIR}/${name}`;
}
