/**
 * Running a project's own migration command, and the bookkeeping around it.
 *
 * The command is never reimplemented and never parsed for meaning — the exit
 * code is the truth. What is read out of its output is for display only: which
 * files it mentioned, and which one it stopped on, so a failure names something
 * a person can open.
 */

import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

import type { ResolvedConfig } from "../config/types.js";
import type { ExecResult } from "../docker.js";
import { MIGRATE_STATE, RUN_DIR } from "../sandbox/layout.js";
import type { DriverContext, MigrateResult } from "./types.js";

export interface MigrationState {
  dir: string;
  /** The last schema known to be clean. */
  baseline: string;
  /** The schema as of the last successful run. */
  after: string;
  /** Present when the last run failed, which is what protects the baseline. */
  failedMarker: string;
  log: string;
}

export function migrationState(home: string, project: string, slug: string): MigrationState {
  const dir = join(home, "logs", project, slug);
  return {
    dir,
    baseline: join(dir, "schema-before.sql"),
    after: join(dir, "schema-after.sql"),
    failedMarker: join(dir, ".failed"),
    log: join(dir, "migrate.log"),
  };
}

/**
 * Runs a command inside the sandbox.
 *
 * The command comes from the project's own config file, which is as trusted as
 * the project's code, so it is handed to a shell inside the container — a
 * project writes `cmd --flag ../dir` and means it. Nothing else is ever
 * interpolated into that string: values a caller supplies travel as environment
 * variables, so a slug or a branch name can never become shell syntax.
 */
export function execCommand(
  ctx: DriverContext,
  command: string,
  options: { workdir?: string | undefined; env?: Record<string, string> | undefined } = {},
): Promise<ExecResult> {
  return ctx.exec(["sh", "-lc", command], options);
}

/** The working directory a migration command runs in, as an absolute path. */
export function migrateWorkdir(config: ResolvedConfig, mount = "/workspace"): string {
  const workdir = config.database.migrate?.workdir;
  return workdir ? join(mount, workdir) : mount;
}

export interface ParsedMigrationOutput {
  /** Files the run mentioned in a way that reads as progress. */
  applied: string[];
  /** The file it stopped on, when the output names one on an error line. */
  failed?: string | undefined;
  /** The most useful error line, for a one-line summary. */
  error?: string | undefined;
}

const FILENAME = /[\w.\-/]+\.sql\b/g;
const PROGRESS = /\b(appl\w+|migrat\w+|running|ran|executing|executed|ok)\b/i;
const FAILURE = /\b(error|failed|failure|fatal|refus\w+)\b/i;

/**
 * Reads a migration run's output for display.
 *
 * Deliberately heuristic and deliberately generic: every project's runner
 * prints something different, and the alternative — a per-project parser — is
 * exactly the reimplementation of a project's migration logic that this tool
 * does not do. Nothing here decides success; that is the exit code's job.
 */
export function parseMigrationOutput(output: string): ParsedMigrationOutput {
  const applied: string[] = [];
  let failed: string | undefined;
  let error: string | undefined;

  for (const line of output.split("\n")) {
    const names = [...line.matchAll(FILENAME)].map((match) => match[0]);
    const isFailure = FAILURE.test(line);

    if (isFailure) {
      error ??= line.trim();
      const last = names.at(-1);
      if (last && !failed) failed = last;
      continue;
    }
    if (!PROGRESS.test(line)) continue;
    for (const name of names) if (!applied.includes(name)) applied.push(name);
  }

  // A file the run stopped on is not a file the run applied, whatever an
  // earlier "running X" line said.
  const cleaned = failed ? applied.filter((name) => name !== failed) : applied;
  return { applied: cleaned, failed, error };
}

/**
 * Lists the migration files a run would apply, in the order a runner would
 * apply them.
 *
 * Display only — the project's own program decides what actually runs. `since`
 * is passed through from the config because a project whose early migrations
 * predate its own tracking table needs a cutoff, and widening it would list
 * files that fail on columns that already exist.
 */
export function pendingMigrations(files: string[], completed: string[], since?: string): string[] {
  const done = new Set(completed);
  return files
    .filter((name) => name.endsWith(".sql"))
    .filter((name) => !done.has(name))
    .filter((name) => {
      if (!since) return true;
      // Compared as strings: the convention these names follow is a sortable
      // timestamp prefix, so a lexical comparison is the intended one.
      const prefix = name.slice(0, since.length);
      return prefix >= since;
    })
    .sort();
}

export async function recordFailure(state: MigrationState): Promise<void> {
  await mkdir(state.dir, { recursive: true });
  await writeFile(state.failedMarker, `${new Date().toISOString()}\n`);
}

export async function clearFailure(state: MigrationState): Promise<void> {
  await rm(state.failedMarker, { force: true });
}

export async function lastRunFailed(state: MigrationState): Promise<boolean> {
  try {
    await readFile(state.failedMarker, "utf8");
    return true;
  } catch {
    return false;
  }
}

export async function writeLog(state: MigrationState, output: string): Promise<string> {
  await mkdir(state.dir, { recursive: true });
  await writeFile(state.log, output);
  return state.log;
}

/**
 * Records the outcome where the sandbox's own state is read from.
 *
 * A failed migration must not stop the sandbox — inspecting one is a reason the
 * sandbox exists — so the failure is written as a marker and the services boot
 * anyway. The marker is what makes the state `degraded` rather than `running`,
 * and writing it inside the container keeps the fact where it happened instead
 * of in a second copy on the host.
 */
export async function markOutcome(ctx: DriverContext, result: MigrateResult): Promise<void> {
  // The same file, in the same shape, that `container/scripts/migrate-run.sh`
  // writes when the container migrates on its own at boot. Two writers of one
  // fact must produce one file: when this wrote a pair of touch-files instead,
  // a container-side run left `migrate.json` saying `ok` while the host went on
  // reading absent markers as `pending`, and every such sandbox was stuck
  // reporting `starting` forever.
  const state = JSON.stringify({
    state: result.ok ? "ok" : "failed",
    file: result.failed ?? "",
    error: result.ok ? "" : "See the full log for what went wrong.",
  });
  await ctx.exec([
    "sh",
    "-lc",
    `mkdir -p ${RUN_DIR} && cat > ${MIGRATE_STATE} <<'SANDBOXER_EOF'\n${state}\nSANDBOXER_EOF`,
  ]);
}

/**
 * Whether to re-take the schema baseline before a run.
 *
 * DDL is not transactional in every engine, so a migration can fail with
 * earlier statements already committed, and "what did that actually change?" is
 * the question a person asks next. For the answer to exist, the baseline has to
 * be the last schema known to be clean: re-snapshotting on every attempt would
 * overwrite it with the half-migrated state the failure left behind, and the
 * next diff would report no change exactly when it matters most.
 */
export function shouldTakeBaseline(input: { previousRunFailed: boolean; baselineExists: boolean }): boolean {
  return !input.previousRunFailed || !input.baselineExists;
}
