/**
 * The database driver interface (contracts §6).
 *
 * Four rules apply to every driver, and they are the reason this is an
 * interface rather than four unrelated files:
 *
 * - **The source database is only ever read.** Every destructive operation
 *   targets a copy. That is the property that makes it safe to point a
 *   half-written migration at real data.
 * - **A failed migration does not stop the sandbox.** Record the failure, mark
 *   the sandbox degraded, and let the services boot — inspecting a failed
 *   migration is a reason the sandbox exists.
 * - **The schema baseline survives a failed run.** Snapshot before migrating and
 *   re-take the baseline only after a success, so the diff still answers "what
 *   did that actually change?" the second time it is asked.
 * - **Never reimplement the project's migration logic.** Shell out to the
 *   command in the config. A driver may *read* migration state to show
 *   progress; what runs is always the project's own program.
 */

import type { ResolvedConfig } from "../config/types.js";
import type { Docker, ExecResult, Runner } from "../docker.js";

export interface DriverContext {
  project: string;
  slug: string;
  config: ResolvedConfig;
  /** SANDBOXER_HOME. */
  home: string;
  worktree: string;
  /** Runs a command inside the sandbox container. */
  exec(cmd: string[], options?: { workdir?: string; env?: Record<string, string> }): Promise<ExecResult>;
  log(line: string): void;

  /**
   * Runs a command on the host.
   *
   * Seeding is host-side work — the source database is a container the
   * developer already runs, and the artifact lands in the host cache — so a
   * driver needs both sides. Injectable so a test can record what would run.
   */
  host?: Runner | undefined;
  docker?: Docker | undefined;
  /** Injectable clock, so cache expiry is testable. */
  now?: (() => Date) | undefined;
}

/** Where a seed came from, which decides whether a public sandbox may use it. */
export type SeedSource = "local" | "file" | "fixtures" | "none";

export interface SeedArtifact {
  /**
   * `dump` is a compressed logical dump, `copy` is a database file or
   * directory, `fixtures` means there is nothing to restore and the sandbox
   * starts empty, `none` means the project has no database.
   */
  kind: "dump" | "copy" | "fixtures" | "none";
  source: SeedSource;
  /** Content fingerprint. The cache key, so an unchanged source is not re-dumped. */
  key: string;
  /** Host path to the artifact, when there is one. */
  path?: string | undefined;
  bytes?: number | undefined;
  createdAt: string;
  /** Facts worth printing: server version, table count, where it came from. */
  meta?: Record<string, string | number> | undefined;
}

export interface MigrateResult {
  ok: boolean;
  /** Exit code of the project's own migration command. */
  code: number;
  /** Migrations the run reported applying, when its output says. */
  applied: string[];
  /** The migration it stopped on, when the output names one. */
  failed?: string | undefined;
  /** Bookkeeping rows healed in the copy before the run. */
  healed?: string[] | undefined;
  /** Host path to the pre-run schema baseline, for a diff. */
  baseline?: string | undefined;
  /** Host path to the full log. */
  log?: string | undefined;
  durationMs: number;
  /** Everything the command printed, so a caller can show it without re-reading the log. */
  output: string;
}

export interface DatabaseDriver {
  readonly name: "mysql" | "d1" | "sqlite" | "none";

  /** Host-side: produce a reusable seed artifact in ~/.sandboxer/cache. Idempotent. */
  prepareSeed(ctx: DriverContext): Promise<SeedArtifact>;

  /** Inside the container, first boot: get from empty to seeded-and-migrated. */
  provision(ctx: DriverContext, seed: SeedArtifact): Promise<void>;

  /** Run the project's own migration command. Never reimplement the project's logic. */
  migrate(ctx: DriverContext): Promise<MigrateResult>;

  /** Structure-only snapshot, for diffing before/after a migration. */
  snapshot(ctx: DriverContext): Promise<string>;

  /** An interactive shell against this sandbox's database. */
  shell(ctx: DriverContext): Promise<void>;
}
