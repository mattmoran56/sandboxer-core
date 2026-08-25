/**
 * The file-backed drivers: `d1` and `sqlite`.
 *
 * The easy case, and much cheaper to run. The database is a *file*, so seeding
 * is a copy, forking is a copy, there is no server to install, no version skew
 * and no advisory lock.
 *
 * One rule: **one writer per file.** Two processes opening the same database
 * file deadlock, so every sandbox gets a private copy and the config names the
 * single service that owns it. That is a rule of the driver, not a workaround,
 * which is why the config is refused without it rather than defaulted.
 */

import { createHash } from "node:crypto";
import { cp, mkdir, readdir, readFile, rm, stat } from "node:fs/promises";
import { join } from "node:path";

import { projectPath } from "../config/load.js";
import {
  clearFailure,
  execCommand,
  lastRunFailed,
  markOutcome,
  migrateWorkdir,
  migrationState,
  parseMigrationOutput,
  recordFailure,
  shouldTakeBaseline,
  writeLog,
} from "./migrate.js";
import { cacheEntry, chooseSeed, fileBytes, fileExists } from "./seed.js";
import type { ResolvedConfig } from "../config/types.js";
import type { ExecResult } from "../docker.js";
import type { DatabaseDriver, DriverContext, MigrateResult, SeedArtifact } from "./types.js";

export class FileDriverError extends Error {
  override readonly name = "FileDriverError";
}

/**
 * Where a sandbox's private copy of the database lives inside the container.
 *
 * The same rule `entrypoint.sh` uses, because the host and the container have to
 * agree on one path: the `data` volume, then a directory per driver.
 */
export function dataDir(driver: string): string {
  return `/var/lib/sandboxr/data/${driver}`;
}

/**
 * The database location, as the container's own scripts expect to read it.
 *
 * `entrypoint.sh` exports these before it execs `/init`, so every *supervised*
 * service inherits them — but `docker exec` does not: it gets the container's
 * configured environment, which never saw those exports. A command run from the
 * host therefore has to carry them itself, or `$SANDBOXR_DB_FILE` expands to
 * nothing and `sqlite3 ""` quietly operates on a temporary in-memory database
 * instead of failing.
 */
export function locationEnv(config: ResolvedConfig): Record<string, string> {
  const driver = config.database.driver;
  const dir = dataDir(driver);
  const name = config.project;
  const env: Record<string, string> = {
    SANDBOXR_DB_DRIVER: driver,
    SANDBOXR_DB_NAME: name,
    SANDBOXR_DB_DIR: dir,
  };
  if (driver === "sqlite") env.SANDBOXR_DB_FILE = `${dir}/${name}.sqlite`;
  // A directory rather than a file: miniflare owns the layout inside it, and
  // locates its own database by glob.
  if (driver === "d1") env.SANDBOXR_D1_DIR = dir;
  return env;
}

/** A file under this size is not a database — it is what an empty bind mount leaves behind. */
const MIN_DATABASE_BYTES = 1024;

/**
 * Whether a path holds an actual database rather than the debris of a previous
 * run.
 *
 * Docker creates a missing bind-mount source as an empty directory rather than
 * failing, so an aborted start leaves a directory that looks like a state
 * directory and holds nothing. Checking for a file of plausible size inside is
 * what stops that being mistaken for real content on the next run.
 */
export async function hasDatabase(path: string): Promise<boolean> {
  let info: Awaited<ReturnType<typeof stat>>;
  try {
    info = await stat(path);
  } catch {
    return false;
  }
  if (info.isFile()) return info.size >= MIN_DATABASE_BYTES;

  for (const file of await listDatabaseFiles(path)) {
    if ((await fileBytes(file) ?? 0) >= MIN_DATABASE_BYTES) return true;
  }
  return false;
}

/** Every database file under a directory, recursively. Sidecars included. */
export async function listDatabaseFiles(dir: string): Promise<string[]> {
  const found: string[] = [];
  let entries: Array<{ name: string; isDirectory: () => boolean }>;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return found;
  }
  for (const entry of entries) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      found.push(...(await listDatabaseFiles(path)));
    } else if (/\.(sqlite|sqlite3|db)$/.test(entry.name)) {
      found.push(path);
    }
  }
  return found.sort();
}

/**
 * Fingerprints the source.
 *
 * A database file is small enough to hash outright, and hashing the content is
 * the only honest key: a file's timestamp moves every time the engine
 * checkpoints, whether or not anything changed.
 */
export async function fingerprintPath(path: string): Promise<string> {
  const hash = createHash("sha256");
  const info = await stat(path);
  if (info.isFile()) {
    hash.update(await readFile(path));
  } else {
    for (const file of await listDatabaseFiles(path)) {
      hash.update(file.slice(path.length));
      hash.update(await readFile(file));
    }
  }
  return hash.digest("hex").slice(0, 12);
}

function makeDriver(name: "d1" | "sqlite"): DatabaseDriver {
  return {
    name,

    async prepareSeed(ctx: DriverContext): Promise<SeedArtifact> {
      const now = ctx.now?.() ?? new Date();
      const declared = ctx.config.database.seedFrom?.file;
      const source = declared ? projectPath(ctx.config, declared) : undefined;

      const choice = chooseSeed(ctx.config, {
        localAvailable: false,
        fileAvailable: source ? await hasDatabase(source) : false,
      });

      if (choice.source !== "file" || !source) {
        // No content to copy. The sandbox starts from an empty database, runs
        // the project's migrations and applies fixtures — which is exactly what
        // a fresh checkout of a project whose state directory is gitignored
        // has to do anyway.
        ctx.log("No database to seed from, so this sandbox starts empty and migrates.");
        return {
          kind: "fixtures",
          source: choice.source === "none" ? "none" : "fixtures",
          key: "empty",
          createdAt: now.toISOString(),
          meta: choice.fixtures ? { fixtures: choice.fixtures } : undefined,
        };
      }

      const key = await fingerprintPath(source);
      const entry = cacheEntry(ctx.home, ctx.project, key, "");
      if (!(await fileExists(entry.path))) {
        await mkdir(entry.path, { recursive: true });
        // Copied whole rather than file by file: the write-ahead log and shared
        // memory sidecars belong to the same database, and a copy missing them
        // reads as corrupt.
        await cp(source, entry.path, { recursive: true });
      }

      return {
        kind: "copy",
        source: "file",
        key,
        path: entry.path,
        bytes: await fileBytes(entry.path),
        createdAt: now.toISOString(),
        meta: { source },
      };
    },

    async provision(ctx: DriverContext, seed: SeedArtifact): Promise<void> {
      // Every sandbox gets its own copy, never a share. Two processes opening
      // one file deadlock, and a shared copy would also let one sandbox's
      // migration rewrite another's data.
      if (seed.kind === "copy" && seed.path) {
        const docker = ctx.docker;
        if (!docker) throw new FileDriverError("staging a database file needs docker");
        const { containerName } = await import("../naming.js");
        const dir = dataDir(ctx.config.database.driver);
        await ctx.exec(["mkdir", "-p", dir]);
        await docker.cp(seed.path, containerName(ctx.project, ctx.slug), dir);
        ctx.log(`Staged a private copy of the database (${seed.key})`);
      }

      const migrated = await this.migrate(ctx);
      await markOutcome(ctx, migrated);
      if (!migrated.ok) {
        ctx.log(`Migrations FAILED${migrated.failed ? ` at ${migrated.failed}` : ""} — the sandbox is up anyway.`);
      }

      const fixtures = ctx.config.database.seedFrom?.fixtures;
      if (fixtures) {
        // Non-fatal: a fixture that no longer matches the schema is a useful
        // signal, not a reason to refuse to start.
        const result = await containerDb(ctx, "fixtures");
        ctx.log(
          result.code === 0
            ? `Applied fixtures from ${fixtures}`
            : `Fixtures did not apply cleanly (${fixtures}) — the sandbox is up anyway`,
        );
      }
    },

    async migrate(ctx: DriverContext): Promise<MigrateResult> {
      const state = migrationState(ctx.home, ctx.project, ctx.slug);
      const command = ctx.config.database.migrate?.command;
      const started = Date.now();
      if (!command) {
        return { ok: true, code: 0, applied: [], durationMs: 0, output: "no migration command is configured" };
      }

      let baseline: string | undefined;
      const previousRunFailed = await lastRunFailed(state);
      if (shouldTakeBaseline({ previousRunFailed, baselineExists: await fileExists(state.baseline) })) {
        baseline = await snapshotTo(ctx, state.baseline);
      } else {
        baseline = state.baseline;
        ctx.log("Comparing against the baseline from before the last failed run.");
      }

      const since = ctx.config.database.migrate?.since;
      const result = await execCommand(ctx, command, {
        workdir: migrateWorkdir(ctx.config),
        // The cutoff is exported rather than turned into a flag: the tool cannot
        // guess a runner's flag spelling, so the command consumes it if it wants
        // it (contracts §5.4).
        env: { ...locationEnv(ctx.config), ...(since ? { SANDBOXR_MIGRATE_SINCE: since } : {}) },
      });
      const output = `${result.stdout}${result.stderr}`;
      const parsed = parseMigrationOutput(output);
      const log = await writeLog(state, output);

      if (result.code !== 0) {
        await recordFailure(state);
        return {
          ok: false,
          code: result.code,
          applied: parsed.applied,
          failed: parsed.failed,
          baseline,
          log,
          durationMs: Date.now() - started,
          output,
        };
      }

      await clearFailure(state);
      await snapshotTo(ctx, state.after);
      return { ok: true, code: 0, applied: parsed.applied, baseline, log, durationMs: Date.now() - started, output };
    },

    async snapshot(ctx: DriverContext): Promise<string> {
      const result = await containerDb(ctx, "snapshot");
      if (result.code !== 0) {
        throw new FileDriverError(`could not read the schema: ${(result.stderr || result.stdout).trim()}`);
      }
      return result.stdout;
    },

    async shell(ctx: DriverContext): Promise<void> {
      const docker = ctx.docker;
      if (!docker) throw new FileDriverError("an interactive shell needs docker");
      const { containerName } = await import("../naming.js");
      // The driver script opens it read-only: the owning service holds the file
      // while it runs, and a writable shell would be the second writer that
      // deadlocks this driver.
      await docker.execInteractive(containerName(ctx.project, ctx.slug), [
        "env",
        ...Object.entries(locationEnv(ctx.config)).map(([key, value]) => `${key}=${value}`),
        DB_SCRIPT,
        "shell",
      ]);
    },
  };
}

/** The container's own database entry point, which owns every driver detail. */
const DB_SCRIPT = "/opt/sandboxr/scripts/db.sh";

/**
 * Runs one of the container's database verbs.
 *
 * Delegated rather than reimplemented: `container/scripts/db/<driver>.sh` already
 * knows where a D1 database hides inside miniflare's state directory and that a
 * shell against it has to be read-only, and a second copy of that here is a
 * second thing to keep in step with the first.
 */
function containerDb(ctx: DriverContext, verb: "fixtures" | "snapshot"): Promise<ExecResult> {
  return ctx.exec([DB_SCRIPT, verb], { env: locationEnv(ctx.config) });
}

async function snapshotTo(ctx: DriverContext, path: string): Promise<string> {
  const result = await containerDb(ctx, "snapshot");
  const { mkdir: makeDir, writeFile } = await import("node:fs/promises");
  const { dirname } = await import("node:path");
  await makeDir(dirname(path), { recursive: true });
  await writeFile(path, result.stdout);
  return path;
}

export const d1Driver = makeDriver("d1");
export const sqliteDriver = makeDriver("sqlite");

/** Removes a sandbox's staged copy from the host cache staging area. */
export async function discardStaged(home: string, project: string, slug: string): Promise<void> {
  await rm(join(home, "cache", "staged", project, slug), { recursive: true, force: true });
}
