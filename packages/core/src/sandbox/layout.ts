/**
 * The paths shared with what runs *inside* a sandbox.
 *
 * This file is the host side of that boundary, and it must agree with
 * `container/README.md` ("Container inputs") exactly. Everything that mounts or
 * reads one of these paths goes through here, so a change to the boundary is a
 * single edit rather than a hunt through string literals.
 */

import { basename, resolve, sep } from "node:path";

/** The worktree, bind-mounted read-write so a saved file is live inside. */
export const WORKSPACE = "/workspace";

/**
 * Where the image installs `container/scripts/`.
 *
 * Not a mount — it is part of the image — but it belongs here for the same
 * reason the mounts do: it is a path both sides have to spell identically, and
 * the container half already spells it once, as `SANDBOXR_SCRIPTS`'s default in
 * `container/scripts/lib.sh`.
 */
export const SCRIPTS_DIR = "/opt/sandboxr/scripts";

/**
 * The prefix that gives a command the environment the sandbox computed for
 * itself (`container/scripts/with-env`).
 *
 * Needed because `docker exec` gets the container's *configured* environment and
 * never sees what the entrypoint exported — /init inherits those and
 * `S6_KEEP_ENV=1` passes them to every supervised service, but a process the host
 * reaches in and starts is not supervised. Each script under `SCRIPTS_DIR` sources
 * the library itself and so needs nothing; a command that is not one of them, and
 * `claude` above all, has no way to.
 *
 * It became necessary when the secrets file stopped being a `--env-file`: an
 * env-file *was* the container's configured environment, so it reached such a
 * process by accident. A mount does not, and without this prefix everything an
 * agent session ran would run without the project's credentials.
 */
export const WITH_ENV = `${SCRIPTS_DIR}/with-env`;

/** The plan: the container's only view of the project, mounted read-only. */
export const PLAN_FILE = "/sandboxr/plan.json";

/**
 * The project's third-party credentials, mounted read-only.
 *
 * A mount and not a `--env-file`, and the difference is the whole reason this
 * constant exists. `--env-file` is read once by `docker run` and baked into the
 * container's configuration, so an edited credential could not reach a sandbox
 * without recreating the container — which made "Restart services" a button that
 * appeared to apply a rotated key and did not. A mounted file is re-read every
 * time `env.sh` is sourced, so a restart or a rebuild picks it up.
 *
 * Read-only for the reason `PLAN_FILE` is, and one further one: the values also
 * stop appearing in `docker inspect`, which they did as an env-file.
 */
export const SECRETS_FILE = "/sandboxr/secrets.env";

/** The host seed cache, mounted read-only: a sandbox restores, never writes. */
export const CACHE_DIR = "/sandboxr/cache";

/**
 * Where a seed the project *declared* is mounted, as opposed to one sandboxr cached.
 *
 * Separate from CACHE_DIR because the two artifacts are found in different ways.
 * A cached dump is content-addressed into `~/.sandboxr/cache`, so its filename is
 * its identity and the directory is fixed at both ends. A `database.seed_from.file`
 * is a path the project wrote down and may be anywhere — outside every repo on
 * purpose, so `git clean` cannot destroy it — and its *directory* is the only thing
 * locating it.
 *
 * One code path used to serve both, and it took the basename: correct for the cache
 * and fatal for the declared file, which was then looked for in a directory it had
 * never been in. Nothing failed loudly. The sandbox reported "no seed artifact in
 * /sandboxr/cache", started empty, and the project's migrations failed one by one
 * against a database with no tables — a documented feature that had never once run.
 */
export const SEED_DIR = "/sandboxr/seed";

/** Per-sandbox logs, on a host directory so they outlive the container. */
export const LOG_DIR = "/var/log/sandboxr";

/** The database volume: MySQL's data directory, or a file driver's state. */
export const DATA_DIR = "/var/lib/sandboxr/data";

/** Object storage inside the sandbox. */
export const BLOB_DIR = "/var/lib/sandboxr/blob";

/** Built binaries, on a volume so a rebuild survives a restart. */
export const BIN_DIR = "/var/lib/sandboxr/bin";

/**
 * Go's caches, on machine-wide volumes.
 *
 * These two paths are `GOPATH=/go` and `GOCACHE=/go/cache` as the project
 * Dockerfile sets them, and they must keep agreeing with it: Go is told where
 * its caches are by the image, and mounting a volume anywhere else leaves the
 * real cache in the container's writable layer where it dies with the container.
 *
 * That is exactly what used to happen, and the symptom did not look like a
 * missing mount. `up` *replaces* the container, so every start began with an
 * empty module cache and an empty build cache: each one re-downloaded the module
 * graph the image had already downloaded at build time, then recompiled every
 * dependency from source. On a six-service Go monorepo that was three minutes of
 * a three-and-a-half minute boot, and it stayed three minutes on the second and
 * third start — which reads as "sandboxes are just slow" rather than as a cache
 * that is thrown away.
 */
export const GOCACHE_DIR = "/go/cache";
export const GOMOD_DIR = "/go/pkg/mod";

/** Built static sites, served by the sandbox's own file server. */
export const WWW_DIR = "/srv/www";

/**
 * Claude Code's state directory, on the machine-wide `sandboxr-claude` volume.
 *
 * `/root` because a sandbox runs as root, and Claude Code reads `$HOME`.
 *
 * The container is also told `CLAUDE_CONFIG_DIR=<this>`, and that second half is
 * load-bearing: Claude Code keeps the token, settings and session history under
 * `~/.claude`, but keeps the OAuth account, personal MCP servers and per-project
 * trust in `~/.claude.json` — a *file beside the directory*, not in it. Mounting
 * the directory alone persists the session history and loses the login, which
 * looks like the volume not working at all. `CLAUDE_CONFIG_DIR` moves that file
 * inside the volume so the two halves live and die together.
 */
export const CLAUDE_DIR = "/root/.claude";

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

/**
 * Where the container will read a seed artifact, and what has to be mounted for
 * it to be there (contracts §6.2).
 *
 * The one function both the plan writer and the `docker run` argument list go
 * through, because they have to agree exactly: the plan naming a path nothing
 * mounts is precisely the failure this replaces, and it is silent — the sandbox
 * reports an empty cache and starts from an empty database.
 *
 * "Is it in the cache?" is asked of the path rather than of the artifact's
 * declared `source`, because the two drivers disagree about that and both are
 * right: the file-backed drivers copy a declared `file:` into the cache (they
 * have to fingerprint it anyway, and a database file is small), while mysql
 * hands back the declared path untouched, because a logical dump is routinely
 * tens of gigabytes and copying one on every `up` is not a thing to do quietly.
 */
export interface SeedMount {
  /** The path the plan names, and the container opens. */
  inside: string;
  /** The host file to bind-mount there. Absent when the cache already covers it. */
  bind?: string;
}

export function seedMount(hostPath: string, cacheDir: string): SeedMount {
  const name = basename(hostPath);
  // Compared as a path rather than as a string prefix: `~/.sandboxr/cache-old`
  // starts with `~/.sandboxr/cache` and is not in it, and the artifact there
  // would then be named in the plan as a cache entry nothing had mounted.
  const inCache = resolve(hostPath).startsWith(resolve(cacheDir) + sep);
  return inCache ? { inside: `${CACHE_DIR}/${name}` } : { inside: `${SEED_DIR}/${name}`, bind: hostPath };
}
