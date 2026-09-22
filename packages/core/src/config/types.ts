/**
 * The shapes `sandboxer.yaml` parses into.
 *
 * `ProjectConfig` is the file as written, with its `defaults:` blocks still
 * separate. `ResolvedConfig` is what every other package consumes: defaults
 * merged into each entry, every optional field filled in, and the path the file
 * came from carried along so an error can name it.
 */

import type { ConfigOrigin } from "./locate.js";

export type DriverName = "mysql" | "d1" | "sqlite" | "none";

/** Where a driver gets its initial data. */
export interface SeedFrom {
  /** Fork a database out of a container the developer already runs. Read-only. */
  local?: { container: string; database?: string | undefined } | undefined;
  /** Restore a dump, or copy a database file, from this host path. */
  file?: string | undefined;
  /** A fixtures script, applied after migrations. */
  fixtures?: string | undefined;
  /**
   * Whether `file` holds an anonymised dump.
   *
   * Public apps may only be backed by fixtures or by a dump that says this,
   * because a public URL over real records is a data leak (contracts §5.3).
   */
  anonymised?: boolean | undefined;
}

export interface MigrateConfig {
  /** Directory the command runs in, relative to the repo root. */
  workdir?: string | undefined;
  /** The project's own migration command. Never reimplemented, only invoked. */
  command: string;
  /**
   * Cutoff passed to the project's runner as `SANDBOXER_MIGRATE_SINCE`.
   *
   * Exported rather than turned into a flag: the tool cannot guess a runner's
   * flag spelling, so the command in the config consumes the variable if it
   * wants it.
   */
  since?: string | undefined;
  /** Patterns the container uses to read the runner's output. Passed through. */
  failurePattern?: string | undefined;
  filePattern?: string | undefined;
  errorPattern?: string | undefined;
}

export interface DatabaseConfig {
  driver: DriverName;
  /** Driver-specific: the server version a dump is restored into. */
  version?: string | undefined;
  seedFrom?: SeedFrom | undefined;
  migrate?: MigrateConfig | undefined;
  /**
   * For file-backed drivers, the one service allowed to open the database.
   *
   * Two processes opening the same D1 file deadlock, so exactly one owner is a
   * rule of the driver rather than a convention.
   */
  owner?: string | undefined;
}

/** A long-running process with a port, built once to a binary. */
export interface BackendService {
  name: string;
  port: number;
  label: string;
  /** Build command. `{name}` and `{out}` are substituted. */
  build?: string | undefined;
  workdir?: string | undefined;
  /** Health path, probed to decide whether the service is up. */
  health?: string | undefined;
  memory?: string | undefined;
  /** Started only when asked for. */
  optional: boolean;
}

/**
 * A front-end. Two kinds share this shape: `out` makes it a static build served
 * from a directory, `serve` makes it a long-running server that is proxied.
 * Collapsing the two would lose the Workers case (contracts §5.1).
 */
export interface FrontendApp {
  label: string;
  /** Package directory, relative to `frontendRoot`. */
  package: string;
  /** Build command for a static app. `{name}` and `{out}` are substituted. */
  build?: string | undefined;
  /** Output directory for a static app, relative to the package. */
  out?: string | undefined;
  /** Command for a long-running server. Mutually exclusive with `out`. */
  serve?: string | undefined;
  /** Run once before a served app starts: a codegen step, a schema pull. */
  prepare?: string | undefined;
  /** Health path, probed to decide whether a served app is up. */
  health?: string | undefined;
  /** The port a served app listens on. Required with `serve`. */
  port?: number | undefined;
  /** How a built directory is served. Only meaningful for a static app. */
  staticMode: "spa" | "files" | "html";
  memory?: string | undefined;
  /** Included when a caller asks to build everything. */
  inBuildAll: boolean;
  /** Started only when asked for. */
  optional: boolean;
  kind: "static" | "server";
}

/** Path prefixes per app label, pointing at a backend name. */
export type RouteMap = Record<string, Record<string, string>>;

export interface SecretsConfig {
  /** Files an import reads, in order. Later files win. */
  read: string[];
  /** Names to import. Nothing outside this list is ever imported. */
  keep: string[];
  /** Source name to target name. An explicit rename outranks `never`. */
  rename: Record<string, string>;
  /** Glob patterns that are never imported, whatever `keep` says. */
  never: string[];
}

export interface StorageConfig {
  driver: "minio" | "none";
  buckets: string[];
}

/** The Node dependency tree, when the project has one. */
export interface DepsConfig {
  /** Repo-relative directory holding the lockfile. */
  root: string;
  lockfile: string;
  install: string;
}

export interface ToolchainConfig {
  go?: string | undefined;
  node?: string | undefined;
}

export interface AccessConfig {
  /** Whether app hostnames need a session. Controls always do. */
  apps: "public" | "private";
  controls: "password";
  /**
   * Whether the sandbox may carry real third-party credentials.
   *
   * Public apps get dummies unless this says otherwise: anyone who can drive a
   * public app can otherwise make it send real email and spend real LLM credit
   * (contracts §5.3).
   */
  credentials: "dummy" | "real";
}

/** The file as written, before defaults are merged. */
export interface ProjectConfig {
  project: string;
  sandboxer: string;
  database?: DatabaseConfig | undefined;
  backends?: { defaults?: Partial<BackendService>; services: Array<Partial<BackendService>> } | undefined;
  frontends?:
    | { root?: string; defaults?: Partial<FrontendApp>; apps: Array<Partial<FrontendApp>> }
    | undefined;
  routes?: RouteMap | undefined;
  secrets?: Partial<SecretsConfig> | undefined;
  storage?: StorageConfig | undefined;
  toolchain?: ToolchainConfig | undefined;
  access?: Partial<AccessConfig> | undefined;
}

/** What every other package consumes. */
export interface ResolvedConfig {
  /**
   * Absolute path to the config file this came from. Errors name this, because
   * it is the file whose author has to edit it.
   *
   * > **`dirname(file)` is not always `root`.** It was, until project-level
   * > configs existed: a managed worktree with no config of its own is governed
   * > by `<workspace>/<project>/sandboxer.yaml`, which sits one level *above*
   * > every worktree it applies to (contracts §5.6). Code that wants the
   * > directory a declared path resolves against wants `root`, or better
   * > `projectPath()` — never `dirname(file)`.
   */
  file: string;
  /**
   * The tree the config governs: the top of the checkout, and the directory
   * bind-mounted as `/workspace`. Every relative path in the config resolves
   * against this.
   */
  root: string;
  /**
   * Whether the file is inside `root` ("repo") or is the workspace's
   * project-level fallback ("project"). A project running from a config that is
   * not in its own repository is something a user has to be able to see.
   */
  origin: ConfigOrigin;
  project: string;
  /** The version constraint as written, already checked against this tool. */
  sandboxer: string;
  database: DatabaseConfig;
  backends: BackendService[];
  /** Directory the front-end packages live under, relative to the root. */
  frontendRoot: string;
  frontends: FrontendApp[];
  routes: RouteMap;
  secrets: SecretsConfig;
  storage: StorageConfig;
  deps?: DepsConfig | undefined;
  toolchain: ToolchainConfig;
  access: AccessConfig;
  /** The project's own names for what the sandbox computes. */
  env: Record<string, string>;
}
