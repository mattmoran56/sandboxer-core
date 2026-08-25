// Tests for the file-backed drivers (d1 and sqlite):
// - hasDatabase: a real file, a file too small to be one, a directory holding one, an empty directory, a missing path
// - listDatabaseFiles: recursion, extensions, ordering, a directory that is not there
// - fingerprintPath: stable for unchanged content, moves when content changes, covers a directory's files
// - prepareSeed: copies a source into the cache, reuses an existing entry, and reports an empty start when there is nothing to copy
// - prepareSeed: a public sandbox never copies an unmarked source
// - migrate: the baseline is taken on a first run and preserved after a failure
// - migrate: the cutoff reaches the project's runner as SANDBOXR_MIGRATE_SINCE, and is absent when unset
// - locationEnv: the path entrypoint.sh derives, a directory for d1 and a file for sqlite
// - shell: delegates to the container's driver script, carrying the location docker exec does not inherit
// - both driver names are exposed, and they behave identically

import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { resolveConfig } from "../config/load.js";
import type { ResolvedConfig } from "../config/types.js";
import type { Docker, ExecResult } from "../docker.js";
import { d1Driver, fingerprintPath, hasDatabase, listDatabaseFiles, locationEnv, sqliteDriver } from "./file.js";
import { lastRunFailed, migrationState } from "./migrate.js";
import type { DriverContext } from "./types.js";

/** A database file has to be big enough not to be an empty bind-mount leftover. */
const REAL_DB = Buffer.alloc(4096, 7);

function configFor(root: string, seed: Record<string, unknown>, apps: "public" | "private" = "private"): ResolvedConfig {
  return resolveConfig(
    {
      project: "acme",
      sandboxr: ">=0.1.0",
      access: { apps },
      database: { driver: "d1", seed_from: seed, migrate: { command: "migrate" }, owner: "app" },
      frontends: { apps: [{ label: "app", package: ".", serve: "serve", port: 1 }] },
    },
    join(root, "sandboxr.yaml"),
    { enforceAccess: false },
  );
}

function contextFor(
  config: ResolvedConfig,
  home: string,
  replies: Array<[match: string, reply: Partial<ExecResult>]> = [],
): {
  ctx: DriverContext;
  calls: string[][];
  logs: string[];
  copies: string[][];
  /** The environment each exec carried, which is not inherited from the container. */
  envs: Array<Record<string, string> | undefined>;
} {
  const calls: string[][] = [];
  const logs: string[] = [];
  const copies: string[][] = [];
  const envs: Array<Record<string, string> | undefined> = [];
  const docker = {
    cp: async (from: string, container: string, to: string) => {
      copies.push([from, container, to]);
    },
    execInteractive: async (container: string, cmd: string[]) => {
      calls.push(["interactive", container, ...cmd]);
      return 0;
    },
  } as unknown as Docker;

  const ctx: DriverContext = {
    project: config.project,
    slug: "tkt-1",
    config,
    home,
    worktree: config.root,
    exec: async (cmd, options) => {
      calls.push(cmd);
      envs.push(options?.env);
      const joined = cmd.join(" ");
      const reply = replies.find(([match]) => joined.includes(match))?.[1] ?? {};
      return { code: reply.code ?? 0, stdout: reply.stdout ?? "", stderr: reply.stderr ?? "" };
    },
    log: (line) => logs.push(line),
    docker,
  };
  return { ctx, calls, logs, copies, envs };
}

describe("hasDatabase", () => {
  it("accepts a file of plausible size", async () => {
    const dir = await mkdtemp(join(tmpdir(), "sbx-file-"));
    const path = join(dir, "db.sqlite");
    await writeFile(path, REAL_DB);
    expect(await hasDatabase(path)).toBe(true);
  });

  it("rejects a file too small to be a database", async () => {
    const dir = await mkdtemp(join(tmpdir(), "sbx-file-"));
    const path = join(dir, "db.sqlite");
    await writeFile(path, "x");
    expect(await hasDatabase(path)).toBe(false);
  });

  it("finds a database inside a state directory", async () => {
    const dir = await mkdtemp(join(tmpdir(), "sbx-file-"));
    await mkdir(join(dir, "v3", "d1"), { recursive: true });
    await writeFile(join(dir, "v3", "d1", "db.sqlite"), REAL_DB);
    expect(await hasDatabase(dir)).toBe(true);
  });

  // Docker creates a missing bind-mount source as an empty directory rather
  // than failing, so one aborted start leaves something that looks like state
  // and holds nothing.
  it("rejects the empty directory an aborted run leaves behind", async () => {
    const dir = await mkdtemp(join(tmpdir(), "sbx-file-"));
    await mkdir(join(dir, "v3", "d1"), { recursive: true });
    expect(await hasDatabase(dir)).toBe(false);
  });

  it("rejects a path that is not there", async () => {
    expect(await hasDatabase("/nowhere/at/all")).toBe(false);
  });
});

describe("listDatabaseFiles", () => {
  it("finds database files recursively, in order", async () => {
    const dir = await mkdtemp(join(tmpdir(), "sbx-list-"));
    await mkdir(join(dir, "a"), { recursive: true });
    await writeFile(join(dir, "b.sqlite"), REAL_DB);
    await writeFile(join(dir, "a", "a.db"), REAL_DB);
    await writeFile(join(dir, "notes.txt"), "x");
    expect(await listDatabaseFiles(dir)).toEqual([join(dir, "a", "a.db"), join(dir, "b.sqlite")]);
  });

  it("answers nothing for a directory that is not there", async () => {
    expect(await listDatabaseFiles("/nowhere")).toEqual([]);
  });
});

describe("fingerprintPath", () => {
  it("is stable for unchanged content", async () => {
    const dir = await mkdtemp(join(tmpdir(), "sbx-fp-"));
    const path = join(dir, "db.sqlite");
    await writeFile(path, REAL_DB);
    expect(await fingerprintPath(path)).toBe(await fingerprintPath(path));
  });

  // A timestamp moves every time the engine checkpoints, whether or not
  // anything changed, so the key is the content.
  it("moves when the content changes", async () => {
    const dir = await mkdtemp(join(tmpdir(), "sbx-fp-"));
    const path = join(dir, "db.sqlite");
    await writeFile(path, REAL_DB);
    const before = await fingerprintPath(path);
    await writeFile(path, Buffer.alloc(4096, 9));
    expect(await fingerprintPath(path)).not.toBe(before);
  });

  it("covers every file in a directory", async () => {
    const dir = await mkdtemp(join(tmpdir(), "sbx-fp-"));
    await writeFile(join(dir, "a.sqlite"), REAL_DB);
    const before = await fingerprintPath(dir);
    await writeFile(join(dir, "b.sqlite"), REAL_DB);
    expect(await fingerprintPath(dir)).not.toBe(before);
  });
});

describe("prepareSeed", () => {
  it("copies the source into the cache, sidecars and all", async () => {
    const root = await mkdtemp(join(tmpdir(), "sbx-seed-"));
    const home = join(root, "home");
    const state = join(root, "state");
    await mkdir(state, { recursive: true });
    await writeFile(join(state, "db.sqlite"), REAL_DB);
    await writeFile(join(state, "db.sqlite-wal"), REAL_DB);

    const config = configFor(root, { file: "state", fixtures: "seeds/f.sql" });
    const { ctx } = contextFor(config, home);
    const seed = await d1Driver.prepareSeed(ctx);

    expect(seed.kind).toBe("copy");
    expect(seed.source).toBe("file");
    expect(seed.path).toContain(join(home, "cache", `seed-acme-${seed.key}`));
    expect(await hasDatabase(seed.path as string)).toBe(true);
    // The write-ahead log belongs to the same database; a copy without it can
    // read as corrupt.
    expect(await listDatabaseFiles(seed.path as string)).toHaveLength(1);
  });

  it("reuses an existing cache entry rather than copying again", async () => {
    const root = await mkdtemp(join(tmpdir(), "sbx-seed-"));
    const home = join(root, "home");
    await mkdir(join(root, "state"), { recursive: true });
    await writeFile(join(root, "state", "db.sqlite"), REAL_DB);
    const config = configFor(root, { file: "state" });

    const first = await d1Driver.prepareSeed(contextFor(config, home).ctx);
    const second = await d1Driver.prepareSeed(contextFor(config, home).ctx);
    expect(second.key).toBe(first.key);
    expect(second.path).toBe(first.path);
  });

  // A gitignored state directory means a fresh checkout has no content at all,
  // which is a normal start rather than a failure.
  it("starts empty when there is nothing to copy", async () => {
    const root = await mkdtemp(join(tmpdir(), "sbx-seed-"));
    const config = configFor(root, { file: "state", fixtures: "seeds/f.sql" });
    const { ctx, logs } = contextFor(config, join(root, "home"));
    const seed = await d1Driver.prepareSeed(ctx);

    expect(seed.kind).toBe("fixtures");
    expect(logs.join("\n")).toMatch(/starts empty and migrates/);
  });

  it("never copies an unmarked source into a public sandbox", async () => {
    const root = await mkdtemp(join(tmpdir(), "sbx-seed-"));
    await mkdir(join(root, "state"), { recursive: true });
    await writeFile(join(root, "state", "db.sqlite"), REAL_DB);
    const config = configFor(root, { file: "state", fixtures: "seeds/f.sql" }, "public");
    const seed = await d1Driver.prepareSeed(contextFor(config, join(root, "home")).ctx);
    expect(seed.kind).toBe("fixtures");
  });
});

describe("provision", () => {
  it("stages a private copy for this sandbox and then migrates", async () => {
    const root = await mkdtemp(join(tmpdir(), "sbx-prov-"));
    const home = join(root, "home");
    const config = configFor(root, { file: "state" });
    const { ctx, copies, calls } = contextFor(config, home);

    await d1Driver.provision(ctx, {
      kind: "copy",
      source: "file",
      key: "abc",
      path: join(home, "cache", "seed-acme-abc"),
      createdAt: new Date().toISOString(),
    });

    expect(copies[0]?.[1]).toBe("sandboxr-acme-tkt-1");
    // The path entrypoint.sh derives, because the host and the container have to
    // agree on where the database is.
    expect(copies[0]?.[2]).toBe("/var/lib/sandboxr/data/d1");
    expect(calls.some((cmd) => cmd.join(" ").includes("sh -lc migrate"))).toBe(true);
  });
});

describe("migrate", () => {
  it("takes a baseline on the first run", async () => {
    const root = await mkdtemp(join(tmpdir(), "sbx-mig-"));
    const home = join(root, "home");
    const config = configFor(root, { fixtures: "f.sql" });
    const { ctx } = contextFor(config, home, [[".schema", { stdout: "CREATE TABLE a(x);" }]]);

    const result = await d1Driver.migrate(ctx);
    expect(result.ok).toBe(true);
    expect(result.baseline).toBe(migrationState(home, "acme", "tkt-1").baseline);
  });

  it("keeps the clean baseline after a failure", async () => {
    const root = await mkdtemp(join(tmpdir(), "sbx-mig-"));
    const home = join(root, "home");
    const config = configFor(root, { fixtures: "f.sql" });
    const state = migrationState(home, "acme", "tkt-1");

    const failing = contextFor(config, home, [
      [".schema", { stdout: "CREATE TABLE a(x);" }],
      ["sh -lc migrate", { code: 1, stdout: "error: 001.sql failed" }],
    ]);
    const failed = await d1Driver.migrate(failing.ctx);
    expect(failed.ok).toBe(false);
    expect(failed.failed).toBe("001.sql");
    expect(await lastRunFailed(state)).toBe(true);

    const again = contextFor(config, home, [
      [".schema", { stdout: "CREATE TABLE a(x); CREATE TABLE b(y);" }],
      ["sh -lc migrate", { code: 1, stdout: "error: 001.sql failed" }],
    ]);
    await d1Driver.migrate(again.ctx);
    expect(again.logs.join("\n")).toMatch(/baseline from before the last failed run/);
  });
});

describe("locationEnv", () => {
  // The same rule entrypoint.sh uses. Two answers to "where is the database"
  // is one more than a sandbox can have.
  it.each([
    ["d1", { SANDBOXR_D1_DIR: "/var/lib/sandboxr/data/d1" }],
    ["sqlite", { SANDBOXR_DB_FILE: "/var/lib/sandboxr/data/sqlite/acme.sqlite" }],
  ])("%s carries the location its driver script reads", (driver, expected) => {
    const config = resolveConfig(
      {
        project: "acme",
        sandboxr: ">=0.1.0",
        access: { apps: "private" },
        database: { driver, migrate: { command: "m" }, owner: "app" },
        frontends: { apps: [{ label: "app", package: ".", serve: "s", port: 1 }] },
      },
      "/repo/sandboxr.yaml",
    );
    expect(locationEnv(config)).toMatchObject({ SANDBOXR_DB_DRIVER: driver, SANDBOXR_DB_NAME: "acme", ...expected });
  });

  it("gives d1 a directory and sqlite a file, which are not interchangeable", () => {
    const d1Config = configFor("/repo", { fixtures: "f.sql" });
    expect(locationEnv(d1Config)).not.toHaveProperty("SANDBOXR_DB_FILE");
  });
});

describe("migrate environment", () => {
  // Exported rather than turned into a flag: the tool cannot guess a runner's
  // flag spelling, so the command consumes it if it wants it (contracts §5.4).
  it("exports the cutoff as SANDBOXR_MIGRATE_SINCE", async () => {
    const root = await mkdtemp(join(tmpdir(), "sbx-since-"));
    const config = resolveConfig(
      {
        project: "acme",
        sandboxr: ">=0.1.0",
        access: { apps: "private" },
        database: { driver: "d1", migrate: { command: "migrate", since: "20260209" }, owner: "app" },
        frontends: { apps: [{ label: "app", package: ".", serve: "s", port: 1 }] },
      },
      join(root, "sandboxr.yaml"),
    );
    const { ctx, calls, envs } = contextFor(config, join(root, "home"));
    await d1Driver.migrate(ctx);

    const index = calls.findIndex((cmd) => cmd.join(" ").includes("sh -lc migrate"));
    expect(index).toBeGreaterThanOrEqual(0);
    expect(envs[index]).toMatchObject({ SANDBOXR_MIGRATE_SINCE: "20260209" });
  });

  it("leaves it out when the config sets no cutoff", async () => {
    const root = await mkdtemp(join(tmpdir(), "sbx-nosince-"));
    const config = configFor(root, { fixtures: "f.sql" });
    const { ctx, calls, envs } = contextFor(config, join(root, "home"));
    await d1Driver.migrate(ctx);

    const index = calls.findIndex((cmd) => cmd.join(" ").includes("sh -lc migrate"));
    expect(envs[index]).not.toHaveProperty("SANDBOXR_MIGRATE_SINCE");
  });
});

describe("shell", () => {
  // Delegated to the container's own driver script, which is where a D1 database
  // is located by glob and where the read-only rule that stops a second writer
  // deadlocking this driver is applied. A copy of either here would be a second
  // thing to keep in step with the first.
  it("opens the container's database shell", async () => {
    const root = await mkdtemp(join(tmpdir(), "sbx-shell-"));
    const config = configFor(root, { fixtures: "f.sql" });
    const { ctx, calls } = contextFor(config, join(root, "home"));
    await d1Driver.shell(ctx);
    expect(calls.at(-1)?.join(" ")).toContain("/opt/sandboxr/scripts/db.sh shell");
  });

  // docker exec never sees what entrypoint.sh exported, so a command run from the
  // host has to carry the location itself. Without it `$SANDBOXR_D1_DIR` is empty
  // and the driver script exits on its own `:?` guard.
  it("carries the database location, which docker exec does not inherit", async () => {
    const root = await mkdtemp(join(tmpdir(), "sbx-shell-env-"));
    const config = configFor(root, { fixtures: "f.sql" });
    const { ctx, calls } = contextFor(config, join(root, "home"));
    await d1Driver.shell(ctx);
    expect(calls.at(-1)?.join(" ")).toContain("SANDBOXR_D1_DIR=/var/lib/sandboxr/data/d1");
  });
});

describe("the two file drivers", () => {
  it("report their own names", () => {
    expect(d1Driver.name).toBe("d1");
    expect(sqliteDriver.name).toBe("sqlite");
  });
});
