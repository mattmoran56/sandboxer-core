/**
 * The MySQL driver: a real server, so install, start, wait, dump, restore, and
 * an advisory lock so two migrations cannot collide.
 *
 * The source database is only ever read. Every destructive operation here
 * targets the copy inside the sandbox.
 */

import { createWriteStream } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { spawn, type ChildProcess } from "node:child_process";
import { dirname, join } from "node:path";

import { projectPath } from "../config/load.js";
import { lockName } from "../naming.js";
import { seedMount } from "../sandbox/layout.js";
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
import {
  cacheEntry,
  chooseSeed,
  commitPartial,
  fileBytes,
  fileExists,
  formatBytes,
  isFresh,
  partialPath,
  readCacheMeta,
  writeCacheMeta,
  type SeedChoice,
} from "./seed.js";
import type { DatabaseDriver, DriverContext, MigrateResult, SeedArtifact } from "./types.js";

export class MysqlDriverError extends Error {
  override readonly name = "MysqlDriverError";
}

export interface MysqlSettings {
  /** Credentials for reading the fork source. Read-only by convention and by use. */
  sourceUser: string;
  sourcePassword: string;
  /** Credentials the sandbox's own server is created with. */
  user: string;
  password: string;
  rootPassword: string;
  /** The database inside the sandbox. */
  database: string;
  /** The image a dump is restored into. */
  image: string;
  ttlHours: number;
}

/**
 * Resolves the driver's settings from the environment and the config.
 *
 * The version comes from the config rather than the environment on purpose: a
 * migration is only meaningfully tested against the version it will really run
 * on, so the image is the one the project declares, not whatever the developer
 * happens to run locally. The skew between the two is reported when a dump is
 * taken rather than silently absorbed.
 */
export function mysqlSettings(env: NodeJS.ProcessEnv, project: string, version?: string): MysqlSettings {
  return {
    sourceUser: env.SANDBOXER_SOURCE_DB_USER ?? "root",
    sourcePassword: env.SANDBOXER_SOURCE_DB_PASSWORD ?? "",
    user: env.SANDBOXER_DB_USER ?? "sandboxer",
    password: env.SANDBOXER_DB_PASSWORD ?? "sandboxer",
    rootPassword: env.SANDBOXER_DB_ROOT_PASSWORD ?? "sandboxer",
    database: env.SANDBOXER_DB_NAME ?? identifier(project),
    image: env.SANDBOXER_MYSQL_IMAGE ?? `mysql:${version ?? "8.4"}`,
    ttlHours: Number(env.SANDBOXER_CACHE_TTL_HOURS ?? "24") || 24,
  };
}

/** Folds a name into a legal MySQL identifier. */
export function identifier(name: string): string {
  return name.replace(/[^A-Za-z0-9]/g, "_");
}

/** `-p` takes its value attached, and an empty password means the flag is omitted. */
export function credentialArgs(user: string, password: string): string[] {
  return password === "" ? [`-u${user}`] : [`-u${user}`, `-p${password}`];
}

/**
 * The SQL that fingerprints a source database.
 *
 * Server version, table count, column count, and the total byte size across
 * tables. Counts catch a schema edit; the byte total catches bulk data churn.
 *
 * It deliberately does *not* notice a single edited row: paying a full re-dump
 * every time one record changes would make the cache pointless. A time-to-live
 * bounds how stale an entry can be, and a forced refresh is the escape hatch.
 */
export function fingerprintSql(database: string): string {
  const quoted = database.replace(/'/g, "''");
  return [
    "SELECT SHA2(CONCAT_WS('|',",
    "  @@version,",
    `  (SELECT COUNT(*) FROM information_schema.tables  WHERE table_schema='${quoted}'),`,
    `  (SELECT COUNT(*) FROM information_schema.columns WHERE table_schema='${quoted}'),`,
    "  (SELECT COALESCE(SUM(data_length+index_length),0) FROM information_schema.tables",
    `     WHERE table_schema='${quoted}')`,
    "), 256) AS fp;",
  ].join("\n");
}

/**
 * Arguments for the logical dump.
 *
 * Three of these are load-bearing rather than stylistic:
 *
 * - **No `--databases`.** Without it the dump contains no `CREATE DATABASE` and
 *   no `USE`, so the same file restores into any schema name. With it the file
 *   pins itself to the source's name and every fork has to overwrite it.
 * - **`--hex-blob`.** Binary columns are emitted as escaped string literals
 *   otherwise, and any charset mismatch in the pipe corrupts them.
 * - **`--set-gtid-purged=OFF`.** Otherwise the dump carries a
 *   `SET @@GLOBAL.GTID_PURGED` that needs an extra privilege to replay and
 *   poisons the target's replication state.
 */
export function dumpArgs(settings: MysqlSettings, database: string): string[] {
  return [
    "mysqldump",
    ...credentialArgs(settings.sourceUser, settings.sourcePassword),
    "--single-transaction",
    "--quick",
    "--no-tablespaces",
    "--set-gtid-purged=OFF",
    "--hex-blob",
    "--no-autocommit",
    "--default-character-set=utf8mb4",
    "--routines",
    "--events",
    database,
  ];
}

/**
 * Arguments for restoring a dump.
 *
 * Foreign-key and uniqueness checks are off for the load because a dump is
 * ordered alphabetically rather than by dependency, so a child table can
 * legitimately precede its parent.
 */
export function restoreArgs(settings: MysqlSettings, database: string): string[] {
  return [
    "mysql",
    ...credentialArgs("root", settings.rootPassword),
    "--default-character-set=utf8mb4",
    "--init-command=SET FOREIGN_KEY_CHECKS=0, UNIQUE_CHECKS=0",
    database,
  ];
}

/** Structure only: cheap enough to run on every migration. */
export function snapshotArgs(settings: MysqlSettings, database: string): string[] {
  return [
    "mysqldump",
    ...credentialArgs("root", settings.rootPassword),
    "--no-data",
    "--no-tablespaces",
    "--skip-comments",
    "--set-gtid-purged=OFF",
    database,
  ];
}

/**
 * Creates the sandbox's database.
 *
 * The collation is pinned rather than left to the server default: a project's
 * connection string often names one, and a mismatch surfaces halfway through a
 * migration as "illegal mix of collations" rather than at connect time.
 */
export function createDatabaseSql(database: string, collation = "utf8mb4_0900_ai_ci"): string {
  return `CREATE DATABASE IF NOT EXISTS \`${database}\` CHARACTER SET utf8mb4 COLLATE ${collation};`;
}

export function grantSql(database: string, user: string, password: string): string {
  return [
    `CREATE USER IF NOT EXISTS '${user}'@'%' IDENTIFIED BY '${password}';`,
    `GRANT ALL PRIVILEGES ON \`${escapeLikeIdentifier(database)}\`.* TO '${user}'@'%';`,
    "FLUSH PRIVILEGES;",
  ].join("\n");
}

/**
 * Escapes `_` and `%` in the database part of a GRANT.
 *
 * MySQL treats both as wildcards there, so a name containing an underscore
 * grants far more widely than intended — and quoting it without escaping grants
 * on a database whose name literally contains the wildcard, after which every
 * connection fails with an access-denied error that names a database nobody
 * created.
 */
export function escapeLikeIdentifier(name: string): string {
  return name.replace(/([_%])/g, "\\$1");
}

/**
 * The bookkeeping rows a migration runner refuses to start over.
 *
 * A runner that records its own progress marks a row when it starts a file and
 * completes it when the file lands; a row left incomplete means an earlier run
 * died mid-file, and a careful runner will not proceed unattended until someone
 * has looked.
 *
 * Completing the row rather than deleting it is the conservative half of that
 * advice: deleting would make the runner treat the file as pending again, and
 * re-running a migration that already applied half its DDL is precisely the
 * hazard the refusal exists to prevent. This only ever runs against the copy,
 * and what it healed is always reported — a silent workaround in a migration
 * tool is how you stop believing its results.
 */
export const HEAL_STUCK_SQL = [
  "SELECT filename FROM migrations WHERE completed_at IS NULL;",
  "UPDATE migrations SET completed_at = created_at WHERE completed_at IS NULL;",
] as const;

export function parseColumnOutput(stdout: string): string[] {
  return stdout
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "" && line !== "NULL");
}

/** What a shell reports for a command that is not there. Used for the same case. */
const NOT_FOUND = 127;

/**
 * How one child of `streamToFile` ended: normally, or without ever starting.
 *
 * **`close` and `error` are alternatives, not a sequence, and that is the whole
 * point of this helper.** A `spawn` whose binary does not exist emits `error`
 * and may never emit `close`, so waiting only for `close` waits for ever — and
 * an `error` with no listener on a ChildProcess is an *unhandled error event*,
 * which in Node is not an exception a caller can catch. It takes the process
 * down.
 *
 * That is not a theoretical tidy-up. `zstd` was missing from the dashboard
 * image while this file spawned it to compress a database dump, so the first
 * `up` that got as far as dumping killed the whole dashboard: every sandbox
 * action with it, and the orchestrator's conversation, which is held in memory
 * and does not survive the process. Docker restarted the container and the only
 * trace was `spawn zstd ENOENT` in a log nobody was reading. A missing optional
 * tool must cost one failed action.
 */
const ended = (child: ChildProcess, what: string): Promise<{ code: number; message?: string }> =>
  new Promise((done) => {
    child.once("error", (err: NodeJS.ErrnoException) => {
      done({
        code: NOT_FOUND,
        // Named, because "spawn zstd ENOENT" says nothing about what it was for
        // and the reader is looking at a failed database seed.
        message:
          err.code === "ENOENT"
            ? `${what} is not installed in this container, so the dump could not be written`
            : `${what} could not be started: ${err.message}`,
      });
    });
    child.once("close", (code) => done({ code: code ?? 1 }));
  });

/**
 * Streams one process into a file, optionally through a second.
 *
 * A dump is far too large to hold in memory, so this is the one place that
 * spawns rather than collecting output. Both sides are argument arrays: there is
 * no shell, so the pipe cannot be interpreted by one.
 *
 * Every failure is a returned code and a line of `stderr`, never a throw and
 * never a crash — see `ended` for the one that was a crash.
 */
export async function streamToFile(
  first: { bin: string; args: string[] },
  through: { bin: string; args: string[] } | undefined,
  outPath: string,
): Promise<{ code: number; stderr: string }> {
  await mkdir(dirname(outPath), { recursive: true });
  const out = createWriteStream(outPath);
  let stderr = "";
  // A write that fails — a full disk, a directory that went — reaches here the
  // same way a child's does: as an `error` event with nothing listening.
  out.on("error", (err: Error) => {
    stderr += `writing ${outPath}: ${err.message}\n`;
  });

  const source = spawn(first.bin, first.args, { stdio: ["ignore", "pipe", "pipe"] });
  source.stderr.on("data", (chunk: Buffer) => {
    stderr += chunk.toString();
  });

  const sink = through ? spawn(through.bin, through.args, { stdio: ["pipe", "pipe", "pipe"] }) : undefined;
  if (sink) {
    sink.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    // A pipe into a child that never started rejects with EPIPE on the stream
    // rather than on the process, so both ends are handled: without this the
    // failure moves from one unhandled event to another.
    source.stdout.pipe(sink.stdin).on("error", () => undefined);
    sink.stdout.pipe(out);
  } else {
    source.stdout.pipe(out);
  }

  const [from, thru] = await Promise.all([
    ended(source, first.bin),
    sink && through ? ended(sink, through.bin) : Promise.resolve({ code: 0 } as { code: number; message?: string }),
  ]);
  // Killed rather than left: one half failing to start leaves the other waiting
  // on a pipe that will never carry anything, and a sandbox that hangs is worse
  // than one that fails.
  if (from.code !== 0) sink?.kill();
  if (thru.code !== 0) source.kill();
  out.end();

  for (const { message } of [from, thru]) if (message) stderr += `${message}\n`;
  return { code: from.code !== 0 ? from.code : thru.code, stderr };
}

const ZSTD = { bin: "zstd", args: ["-3", "-T0", "-q", "-c"] };

export const mysqlDriver: DatabaseDriver = {
  name: "mysql",

  async prepareSeed(ctx: DriverContext): Promise<SeedArtifact> {
    const env = process.env;
    const settings = mysqlSettings(env, ctx.project, ctx.config.database.version);
    const now = ctx.now?.() ?? new Date();
    const docker = ctx.docker;

    const localAvailable = docker
      ? await docker.containerRunning(ctx.config.database.seedFrom?.local?.container ?? "")
      : false;
    const fileTarget = ctx.config.database.seedFrom?.file;
    const choice = chooseSeed(ctx.config, {
      localAvailable,
      fileAvailable: fileTarget ? await fileExists(projectPath(ctx.config, fileTarget)) : false,
    });

    if (choice.source === "fixtures" || choice.source === "none") {
      // Nothing to restore: the sandbox starts empty, migrates, then applies
      // fixtures. That is a first-class outcome rather than a failure — it is
      // what a public sandbox is meant to run on.
      return {
        kind: choice.source === "none" ? "none" : "fixtures",
        source: choice.source,
        key: "empty",
        createdAt: now.toISOString(),
        meta: choice.fixtures ? { fixtures: choice.fixtures } : undefined,
      };
    }

    if (choice.source === "file") {
      const path = projectPath(ctx.config, choice.file as string);
      return {
        kind: "dump",
        source: "file",
        key: "declared",
        path,
        bytes: await fileBytes(path),
        createdAt: now.toISOString(),
        meta: { file: path },
      };
    }

    if (!docker) throw new MysqlDriverError("forking a running container needs docker");
    const container = choice.container as string;
    const database = choice.database ?? settings.database;

    const fingerprint = await readFingerprint(ctx, settings, container, database);
    const entry = cacheEntry(ctx.home, ctx.project, fingerprint, ".sql.zst");
    const meta = await readCacheMeta(entry);
    const exists = await fileExists(entry.path);

    if (isFresh({ exists, createdAt: meta?.createdAt, ttlHours: settings.ttlHours, now })) {
      return {
        kind: "dump",
        source: "local",
        key: fingerprint,
        path: entry.path,
        bytes: await fileBytes(entry.path),
        createdAt: meta?.createdAt ?? now.toISOString(),
        meta,
      };
    }

    const version = await readSourceVersion(ctx, settings, container);
    ctx.log(`Dumping ${database} from ${container} (MySQL ${version})`);
    // Said once per dump rather than on every command: the sandbox runs the
    // version the project declares, and knowing that axis matters when
    // something behaves oddly.
    if (!settings.image.endsWith(version.split("-")[0] ?? "") && ctx.config.database.version) {
      ctx.log(`  source is MySQL ${version}; this sandbox restores into ${settings.image} for parity with production`);
    }

    const started = Date.now();
    const result = await streamToFile(
      { bin: "docker", args: ["exec", "-i", container, ...dumpArgs(settings, database)] },
      ZSTD,
      partialPath(entry.path),
    );
    if (result.code !== 0) {
      throw new MysqlDriverError(`dumping ${database} from ${container} failed: ${result.stderr.trim()}`);
    }
    await commitPartial(entry.path);

    const bytes = (await fileBytes(entry.path)) ?? 0;
    await writeCacheMeta(entry, {
      source: `${container}:${database}`,
      sourceVersion: version,
      restoredInto: settings.image,
      bytes,
    });
    ctx.log(`Cached ${formatBytes(bytes)} in ${Math.round((Date.now() - started) / 1000)}s (${fingerprint})`);

    return {
      kind: "dump",
      source: "local",
      key: fingerprint,
      path: entry.path,
      bytes,
      createdAt: now.toISOString(),
      meta: { source: `${container}:${database}`, sourceVersion: version },
    };
  },

  async provision(ctx: DriverContext, seed: SeedArtifact): Promise<void> {
    const settings = mysqlSettings(process.env, ctx.project, ctx.config.database.version);
    const database = settings.database;

    await sql(ctx, settings, createDatabaseSql(database));
    await sql(ctx, settings, grantSql(database, settings.user, settings.password));

    // Already-populated is a skip, not a restore, and it is the same rule
    // `container/scripts/db/mysql.sh provision` applies — because both of them
    // run. The container's oneshot provisions at boot and `up` calls this
    // afterwards, so on any start where the data volume survives, the database
    // is already seeded by the time this is reached. A dump written by
    // `mysqldump` carries `CREATE TABLE` and no `DROP TABLE IF EXISTS`, so
    // replaying it over a populated schema fails on Error 1050, and the sandbox
    // was reported as "Provisioning did not complete" while being entirely
    // healthy. `provision` means *first boot* (contracts §6); this is what makes
    // the two halves agree on when that is.
    const existing = await tableCount(ctx, settings, database);
    if (seed.kind === "dump" && seed.path && existing > 0) {
      ctx.log(`${database} already has ${existing} tables, keeping them`);
    } else if (seed.kind === "dump" && seed.path) {
      ctx.log(`Restoring ${database}`);
      // The artifact is mounted read-only into the container, so the restore
      // reads it from inside rather than pushing it through the docker socket.
      // Through `seedMount` and not a basename: a declared `file:` is mounted at
      // its own path, and only the cache is reachable under /sandboxer/cache.
      const inside = seedMount(seed.path, join(ctx.home, "cache")).inside;
      const decompress = seed.path.endsWith(".zst") ? `zstd -dc ${inside}` : `cat ${inside}`;
      const restore = restoreArgs(settings, database).join(" ");
      const result = await ctx.exec(["sh", "-lc", `${decompress} | ${restore}`]);
      if (result.code !== 0) {
        throw new MysqlDriverError(`restoring ${database} failed: ${(result.stderr || result.stdout).trim()}`);
      }
      const count = await tableCount(ctx, settings, database);
      if (count === 0) throw new MysqlDriverError(`restore produced no tables in ${database}`);
      ctx.log(`Restored ${count} tables`);
    }

    const migrated = await this.migrate(ctx);
    await markOutcome(ctx, migrated);
    if (!migrated.ok) {
      ctx.log(`Migrations FAILED${migrated.failed ? ` at ${migrated.failed}` : ""} — the sandbox is up anyway.`);
      ctx.log("  The database is left exactly as it is, for you to inspect.");
    }
    await applyFixtures(ctx, settings);
  },

  async migrate(ctx: DriverContext): Promise<MigrateResult> {
    const settings = mysqlSettings(process.env, ctx.project, ctx.config.database.version);
    const state = migrationState(ctx.home, ctx.project, ctx.slug);
    const command = ctx.config.database.migrate?.command;
    const started = Date.now();

    if (!command) {
      return { ok: true, code: 0, applied: [], durationMs: 0, output: "no migration command is configured" };
    }

    const healed = await healStuckRows(ctx, settings);
    if (healed.length > 0) {
      ctx.log(`Healed ${healed.length} incomplete migration row(s) in the COPY: ${healed.join(", ")}`);
      ctx.log("  The source database is untouched. Check the result before trusting it.");
    }

    let baseline: string | undefined;
    if (shouldTakeBaseline({ previousRunFailed: await lastRunFailed(state), baselineExists: await fileExists(state.baseline) })) {
      baseline = await writeSnapshot(ctx, settings, state.baseline);
    } else {
      baseline = state.baseline;
      ctx.log("Comparing against the baseline from before the last failed run.");
    }

    // The lock is what stops two sandboxes' migrations colliding when they
    // share a server. The slug ceiling exists to keep this name inside the
    // engine's limit.
    const lock = lockName(ctx.project, ctx.slug);
    const result = await execCommand(ctx, command, {
      workdir: migrateWorkdir(ctx.config),
      env: {
        DB_HOST: "127.0.0.1",
        DB_PORT: "3306",
        DB_NAME: settings.database,
        DB_USERNAME: settings.user,
        DB_PASSWORD: settings.password,
        SANDBOXER_MIGRATION_LOCK: lock,
        ...(ctx.config.database.migrate?.since ? { SANDBOXER_MIGRATE_SINCE: ctx.config.database.migrate.since } : {}),
      },
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
        healed,
        baseline,
        log,
        durationMs: Date.now() - started,
        output,
      };
    }

    await clearFailure(state);
    await writeSnapshot(ctx, settings, state.after);
    return {
      ok: true,
      code: 0,
      applied: parsed.applied,
      healed,
      baseline,
      log,
      durationMs: Date.now() - started,
      output,
    };
  },

  async snapshot(ctx: DriverContext): Promise<string> {
    const settings = mysqlSettings(process.env, ctx.project, ctx.config.database.version);
    const result = await ctx.exec(snapshotArgs(settings, settings.database));
    if (result.code !== 0) {
      throw new MysqlDriverError(`could not snapshot ${settings.database}: ${(result.stderr || result.stdout).trim()}`);
    }
    return result.stdout;
  },

  async shell(ctx: DriverContext): Promise<void> {
    const settings = mysqlSettings(process.env, ctx.project, ctx.config.database.version);
    const docker = ctx.docker;
    if (!docker) throw new MysqlDriverError("an interactive shell needs docker");
    const { containerName } = await import("../naming.js");
    await docker.execInteractive(containerName(ctx.project, ctx.slug), [
      "mysql",
      ...credentialArgs(settings.user, settings.password),
      settings.database,
    ]);
  },
};

/** Runs one statement inside the sandbox as root. */
async function sql(ctx: DriverContext, settings: MysqlSettings, statement: string) {
  return ctx.exec(["mysql", ...credentialArgs("root", settings.rootPassword), "-N", "-B", "-e", statement]);
}

/**
 * How many tables the sandbox's database has.
 *
 * Both "is this a first boot?" and "did the restore land?" are this one
 * question, and asking it in one place is what keeps the two answers consistent.
 * A failure to ask reads as zero: an unreachable server has nothing in it, and
 * the caller either restores (and finds out) or reports an empty restore.
 */
async function tableCount(ctx: DriverContext, settings: MysqlSettings, database: string): Promise<number> {
  const result = await sql(
    ctx,
    settings,
    `SELECT COUNT(*) FROM information_schema.tables WHERE table_schema='${database}';`,
  );
  return Number(parseColumnOutput(result.stdout)[0] ?? "0");
}

async function readFingerprint(
  ctx: DriverContext,
  settings: MysqlSettings,
  container: string,
  database: string,
): Promise<string> {
  const run = ctx.host;
  if (!run) throw new MysqlDriverError("fingerprinting the source needs host access");
  const result = await run("docker", [
    "exec",
    "-i",
    container,
    "mysql",
    ...credentialArgs(settings.sourceUser, settings.sourcePassword),
    "-N",
    "-B",
    "-e",
    fingerprintSql(database),
  ]);
  const value = parseColumnOutput(result.stdout)[0];
  if (result.code !== 0 || !value) {
    throw new MysqlDriverError(
      `could not fingerprint ${database} in ${container} — are the source credentials right? ` +
        "Set SANDBOXER_SOURCE_DB_USER and SANDBOXER_SOURCE_DB_PASSWORD.",
    );
  }
  return value.slice(0, 12);
}

async function readSourceVersion(ctx: DriverContext, settings: MysqlSettings, container: string): Promise<string> {
  const run = ctx.host;
  if (!run) return "unknown";
  const result = await run("docker", [
    "exec",
    "-i",
    container,
    "mysql",
    ...credentialArgs(settings.sourceUser, settings.sourcePassword),
    "-N",
    "-B",
    "-e",
    "SELECT VERSION();",
  ]);
  return parseColumnOutput(result.stdout)[0] ?? "unknown";
}

/**
 * Completes any incomplete migration bookkeeping row, in the copy only.
 *
 * Skipped entirely unless the copy actually has that shape of tracking table:
 * every project records its migrations differently, and guessing wrong would
 * mean writing to a table this tool does not understand.
 */
export async function healStuckRows(ctx: DriverContext, settings: MysqlSettings): Promise<string[]> {
  const shape = await sql(
    ctx,
    settings,
    "SELECT COUNT(*) FROM information_schema.columns " +
      `WHERE table_schema='${settings.database}' AND table_name='migrations' ` +
      "AND column_name IN ('filename','completed_at');",
  );
  if (Number(parseColumnOutput(shape.stdout)[0] ?? "0") < 2) return [];

  const stuck = await sql(ctx, settings, `USE \`${settings.database}\`; ${HEAL_STUCK_SQL[0]}`);
  const names = parseColumnOutput(stuck.stdout);
  if (names.length === 0) return [];

  await sql(ctx, settings, `USE \`${settings.database}\`; ${HEAL_STUCK_SQL[1]}`);
  return names;
}

async function writeSnapshot(ctx: DriverContext, settings: MysqlSettings, path: string): Promise<string> {
  const result = await ctx.exec(snapshotArgs(settings, settings.database));
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, result.stdout);
  return path;
}

/**
 * Applies the fixtures script, if there is one.
 *
 * Non-fatal on purpose: a fixture that no longer matches the schema is a useful
 * signal, not a reason to refuse to start a sandbox.
 */
async function applyFixtures(ctx: DriverContext, settings: MysqlSettings): Promise<void> {
  const fixtures = ctx.config.database.seedFrom?.fixtures;
  if (!fixtures) return;
  const inside = `/workspace/${fixtures}`;
  const result = await ctx.exec([
    "sh",
    "-lc",
    `test -f ${inside} && mysql ${credentialArgs("root", settings.rootPassword).join(" ")} ${settings.database} < ${inside}`,
  ]);
  if (result.code === 0) {
    ctx.log(`Applied fixtures from ${fixtures}`);
  } else {
    ctx.log(`Fixtures did not apply cleanly (${fixtures}) — the sandbox is up anyway`);
  }
}

/** Exposed for the lifecycle, which reports the seed choice before starting. */
export function describeSeedChoice(choice: SeedChoice): string {
  switch (choice.source) {
    case "local":
      return `forking ${choice.container}${choice.database ? `:${choice.database}` : ""} (read-only)`;
    case "file":
      return `restoring ${choice.file}`;
    case "fixtures":
      return `empty, then migrations and ${choice.fixtures}`;
    case "none":
      return "no database";
  }
}
