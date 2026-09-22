// Tests for the migration bookkeeping shared by every driver:
// - migrationState: paths under the per-sandbox log directory, which outlives the container
// - migrateWorkdir: the configured workdir, and the mount root when there is none
// - execCommand: the command reaches a shell inside the container and nothing else is interpolated
// - parseMigrationOutput: applied files, the file a failure stopped on, an error line, output that says nothing
// - parseMigrationOutput: a file named on a progress line and then on an error line counts as failed, not applied
// - pendingMigrations: completed files excluded, the `since` cutoff, non-sql files, ordering
// - shouldTakeBaseline: the rule that keeps the last-known-clean schema after a failure
// - recordFailure / lastRunFailed / clearFailure: the marker round-trip

import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { resolveConfig } from "../config/load.js";
import type { ResolvedConfig } from "../config/types.js";
import type { ExecResult } from "../docker.js";
import {
  clearFailure,
  execCommand,
  lastRunFailed,
  migrateWorkdir,
  migrationState,
  parseMigrationOutput,
  pendingMigrations,
  recordFailure,
  shouldTakeBaseline,
} from "./migrate.js";
import type { DriverContext } from "./types.js";

function configWith(migrate: Record<string, unknown>): ResolvedConfig {
  return resolveConfig(
    {
      project: "acme",
      sandboxer: ">=0.1.0",
      access: { apps: "private" },
      database: { driver: "mysql", seed_from: { fixtures: "f.sql" }, migrate },
    },
    "/repo/sandboxer.yaml",
  );
}

describe("migrationState", () => {
  it("puts everything under the per-sandbox log directory", () => {
    const state = migrationState("/home/.sandboxer", "acme", "tkt-1");
    expect(state.dir).toBe("/home/.sandboxer/logs/acme/tkt-1");
    expect(state.baseline).toBe("/home/.sandboxer/logs/acme/tkt-1/schema-before.sql");
    expect(state.after).toBe("/home/.sandboxer/logs/acme/tkt-1/schema-after.sql");
    expect(state.failedMarker).toBe("/home/.sandboxer/logs/acme/tkt-1/.failed");
  });
});

describe("migrateWorkdir", () => {
  it("resolves the configured workdir against the mount", () => {
    expect(migrateWorkdir(configWith({ command: "m", workdir: "services" }))).toBe("/workspace/services");
  });

  it("uses the mount root when the config names no workdir", () => {
    expect(migrateWorkdir(configWith({ command: "m" }))).toBe("/workspace");
  });
});

describe("execCommand", () => {
  it("hands the project's own command to a shell inside the container", async () => {
    const seen: Array<{ cmd: string[]; options: unknown }> = [];
    const ctx = {
      exec: async (cmd: string[], options?: unknown): Promise<ExecResult> => {
        seen.push({ cmd, options });
        return { code: 0, stdout: "", stderr: "" };
      },
    } as unknown as DriverContext;

    await execCommand(ctx, "migrate --dir ../migrations", { workdir: "/workspace/services", env: { DB_NAME: "acme" } });

    expect(seen[0]?.cmd).toEqual(["sh", "-lc", "migrate --dir ../migrations"]);
    expect(seen[0]?.options).toEqual({ workdir: "/workspace/services", env: { DB_NAME: "acme" } });
  });
});

describe("parseMigrationOutput", () => {
  it("lists the files a run reported applying", () => {
    const output = [
      "Config: environment variables",
      "applying 20260209-1200-add-a-column.sql",
      "applied  20260209-1200-add-a-column.sql",
      "applying 20260301-0900-add-an-index.sql",
      "2 migrations applied",
    ].join("\n");
    expect(parseMigrationOutput(output).applied).toEqual([
      "20260209-1200-add-a-column.sql",
      "20260301-0900-add-an-index.sql",
    ]);
  });

  it("names the file a failure stopped on", () => {
    const output = [
      "applying 20260209-1200-add-a-column.sql",
      "applying 20260301-0900-add-an-index.sql",
      "Error 1061 (42000): Duplicate key name 'idx_a' in 20260301-0900-add-an-index.sql",
    ].join("\n");
    const parsed = parseMigrationOutput(output);
    expect(parsed.failed).toBe("20260301-0900-add-an-index.sql");
    expect(parsed.error).toContain("Duplicate key name");
  });

  // A file the run stopped on is not a file the run applied, whatever the
  // earlier progress line said.
  it("does not count the failed file as applied", () => {
    const parsed = parseMigrationOutput("applying a.sql\napplied a.sql\nerror: a.sql blew up");
    expect(parsed.applied).toEqual([]);
    expect(parsed.failed).toBe("a.sql");
  });

  it.each([
    ["nothing at all", ""],
    ["a line with no filename", "everything is fine"],
    ["a filename on a line that is not progress", "considering b.sql"],
  ])("finds nothing in %s", (_name, output) => {
    expect(parseMigrationOutput(output).applied).toEqual([]);
  });

  it("does not repeat a file mentioned twice", () => {
    expect(parseMigrationOutput("applying a.sql\napplied a.sql").applied).toEqual(["a.sql"]);
  });
});

describe("pendingMigrations", () => {
  const files = [
    "20260101-1000-first.sql",
    "20260209-1200-second.sql",
    "20260301-0900-third.sql",
    "README.md",
    "20260401-0000-fourth.sql",
  ];

  it("excludes what is already recorded as complete", () => {
    expect(pendingMigrations(files, ["20260209-1200-second.sql"])).toEqual([
      "20260101-1000-first.sql",
      "20260301-0900-third.sql",
      "20260401-0000-fourth.sql",
    ]);
  });

  // A project whose early migrations predate its own tracking table needs a
  // cutoff: without one they are all "pending" and every one fails on a column
  // that already exists.
  it("honours the cutoff from the config", () => {
    expect(pendingMigrations(files, [], "20260209")).toEqual([
      "20260209-1200-second.sql",
      "20260301-0900-third.sql",
      "20260401-0000-fourth.sql",
    ]);
  });

  it("includes a file exactly at the cutoff", () => {
    expect(pendingMigrations(["20260209-1200-x.sql"], [], "20260209")).toHaveLength(1);
  });

  it("ignores anything that is not a migration", () => {
    expect(pendingMigrations(files, [])).not.toContain("README.md");
  });

  it("returns them in the order a runner would apply them", () => {
    expect(pendingMigrations(["b.sql", "a.sql"], [])).toEqual(["a.sql", "b.sql"]);
  });

  it.each([
    ["no files", [] as string[], [] as string[]],
    ["everything already applied", ["a.sql"], ["a.sql"]],
  ])("finds nothing pending for %s", (_name, files_, completed) => {
    expect(pendingMigrations(files_, completed)).toEqual([]);
  });
});

describe("shouldTakeBaseline", () => {
  it.each([
    ["a clean previous run", { previousRunFailed: false, baselineExists: true }, true],
    ["a first run", { previousRunFailed: false, baselineExists: false }, true],
    // Re-snapshotting after a failure would overwrite the last-known-clean
    // schema with the half-migrated state, and the next diff would report no
    // change exactly when the question matters most.
    ["after a failure, with a baseline to protect", { previousRunFailed: true, baselineExists: true }, false],
    ["after a failure, with no baseline at all", { previousRunFailed: true, baselineExists: false }, true],
  ])("%s", (_name, input, want) => {
    expect(shouldTakeBaseline(input)).toBe(want);
  });
});

describe("the failure marker", () => {
  it("round-trips", async () => {
    const home = await mkdtemp(join(tmpdir(), "sbx-migrate-"));
    const state = migrationState(home, "acme", "tkt-1");

    expect(await lastRunFailed(state)).toBe(false);
    await recordFailure(state);
    expect(await lastRunFailed(state)).toBe(true);
    await clearFailure(state);
    expect(await lastRunFailed(state)).toBe(false);
  });

  it("is safe to clear when it was never set", async () => {
    const home = await mkdtemp(join(tmpdir(), "sbx-migrate-"));
    await expect(clearFailure(migrationState(home, "acme", "tkt-1"))).resolves.toBeUndefined();
  });
});
