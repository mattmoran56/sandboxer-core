// Tests for the MySQL driver's command construction and helpers:
// - mysqlSettings: defaults, environment overrides, and the image coming from the config's declared version
// - credentialArgs: an empty password omits the flag, a set one is attached
// - dumpArgs: the three load-bearing flags are present and --databases is absent
// - restoreArgs / snapshotArgs: checks disabled for the load, structure-only for the snapshot
// - createDatabaseSql / grantSql: the pinned collation, and the escaped wildcard in the grant
// - escapeLikeIdentifier: underscores and percents escaped, everything else untouched
// - fingerprintSql: the inputs it hashes, and that it does not look at row contents
// - identifier: folding a project name into a legal identifier
// - parseColumnOutput: tabular output, blanks, NULL
// - healStuckRows: skipped when the table has another shape, heals and reports when it has this one
// - migrate: no command configured, a failing command marking the failure, a successful one clearing it
// - describeSeedChoice: one line per source

import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { resolveConfig } from "../config/load.js";
import type { ResolvedConfig } from "../config/types.js";
import type { ExecResult } from "../docker.js";
import { lastRunFailed, migrationState } from "./migrate.js";
import {
  createDatabaseSql,
  credentialArgs,
  describeSeedChoice,
  dumpArgs,
  escapeLikeIdentifier,
  fingerprintSql,
  grantSql,
  healStuckRows,
  identifier,
  mysqlDriver,
  mysqlSettings,
  parseColumnOutput,
  restoreArgs,
  snapshotArgs,
} from "./mysql.js";
import type { DriverContext } from "./types.js";

const settings = mysqlSettings({}, "acme", "8.4");

function configWith(migrate?: Record<string, unknown>): ResolvedConfig {
  return resolveConfig(
    {
      project: "acme",
      sandboxr: ">=0.1.0",
      access: { apps: "private" },
      database: {
        driver: "mysql",
        version: "8.4",
        seed_from: { local: { container: "src", database: "app" } },
        ...(migrate ? { migrate } : { migrate: { command: "migrate" } }),
      },
    },
    "/repo/sandboxr.yaml",
  );
}

/** A context whose exec answers from a table keyed on the first matching text. */
function fakeContext(
  home: string,
  answers: Array<[match: string, reply: Partial<ExecResult>]>,
  config: ResolvedConfig = configWith(),
): { ctx: DriverContext; calls: string[][]; logs: string[] } {
  const calls: string[][] = [];
  const logs: string[] = [];
  const ctx: DriverContext = {
    project: config.project,
    slug: "tkt-1",
    config,
    home,
    worktree: "/repo",
    exec: async (cmd) => {
      calls.push(cmd);
      const joined = cmd.join(" ");
      const found = answers.find(([match]) => joined.includes(match));
      const reply = found?.[1] ?? {};
      return { code: reply.code ?? 0, stdout: reply.stdout ?? "", stderr: reply.stderr ?? "" };
    },
    log: (line) => logs.push(line),
  };
  return { ctx, calls, logs };
}

describe("mysqlSettings", () => {
  it("defaults the sandbox credentials and names the database after the project", () => {
    expect(mysqlSettings({}, "acme-shop")).toMatchObject({
      user: "sandboxr",
      password: "sandboxr",
      rootPassword: "sandboxr",
      database: "acme_shop",
      ttlHours: 24,
    });
  });

  // A migration is only meaningfully tested against the version it will really
  // run on, so the image follows the config rather than the machine.
  it("takes the image from the version the project declares", () => {
    expect(mysqlSettings({}, "acme", "8.4").image).toBe("mysql:8.4");
    expect(mysqlSettings({}, "acme", "9.0").image).toBe("mysql:9.0");
  });

  it("defaults to a supported version when the config names none", () => {
    expect(mysqlSettings({}, "acme").image).toBe("mysql:8.4");
  });

  it.each([
    ["SANDBOXR_DB_USER", "user", "app"],
    ["SANDBOXR_DB_PASSWORD", "password", "s3cret"],
    ["SANDBOXR_DB_NAME", "database", "other"],
    ["SANDBOXR_MYSQL_IMAGE", "image", "mysql:8.0"],
    ["SANDBOXR_SOURCE_DB_USER", "sourceUser", "reader"],
  ])("lets %s override %s", (variable, field, value) => {
    const resolved = mysqlSettings({ [variable]: value }, "acme", "8.4") as unknown as Record<string, string>;
    expect(resolved[field]).toBe(value);
  });

  it("falls back to the default ttl when the environment holds nonsense", () => {
    expect(mysqlSettings({ SANDBOXR_CACHE_TTL_HOURS: "soon" }, "acme").ttlHours).toBe(24);
  });
});

describe("credentialArgs", () => {
  it("attaches a password to the flag, as the client requires", () => {
    expect(credentialArgs("root", "pw")).toEqual(["-uroot", "-ppw"]);
  });

  // An empty `-p` prompts interactively, which in a container means hanging.
  it("omits the flag entirely when there is no password", () => {
    expect(credentialArgs("root", "")).toEqual(["-uroot"]);
  });
});

describe("dumpArgs", () => {
  const args = dumpArgs(settings, "app");

  // Without it the dump carries no CREATE DATABASE and no USE, so the same file
  // restores into any schema name.
  it("does not pass --databases", () => {
    expect(args).not.toContain("--databases");
    expect(args.at(-1)).toBe("app");
  });

  it.each(["--hex-blob", "--set-gtid-purged=OFF", "--single-transaction", "--routines", "--events"])(
    "passes %s",
    (flag) => {
      expect(args).toContain(flag);
    },
  );

  it("starts with the client and its credentials", () => {
    expect(args[0]).toBe("mysqldump");
    expect(args[1]).toBe("-uroot");
  });
});

describe("restoreArgs", () => {
  const args = restoreArgs(settings, "app");

  // A dump is ordered alphabetically rather than by dependency, so a child
  // table can legitimately precede its parent.
  it("disables the checks that a dependency-ordered load would need", () => {
    expect(args).toContain("--init-command=SET FOREIGN_KEY_CHECKS=0, UNIQUE_CHECKS=0");
  });

  it("restores as root into the named database", () => {
    expect(args[0]).toBe("mysql");
    expect(args.at(-1)).toBe("app");
  });
});

describe("snapshotArgs", () => {
  it("takes structure only", () => {
    const args = snapshotArgs(settings, "app");
    expect(args).toContain("--no-data");
    expect(args).toContain("--skip-comments");
  });
});

describe("createDatabaseSql", () => {
  // A project's connection string usually names a collation, and a mismatch
  // surfaces halfway through a migration rather than at connect time.
  it("pins the character set and collation", () => {
    expect(createDatabaseSql("app")).toContain("CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci");
  });

  it("is safe to run twice", () => {
    expect(createDatabaseSql("app")).toContain("IF NOT EXISTS");
  });
});

describe("grantSql", () => {
  // MySQL treats `_` as a wildcard in the database part of a GRANT, so an
  // unescaped name grants far more widely than intended.
  it("escapes the wildcard characters in the database name", () => {
    expect(grantSql("acme_shop", "app", "pw")).toContain("`acme\\_shop`.*");
  });

  it("creates the user idempotently", () => {
    expect(grantSql("app", "u", "pw")).toContain("CREATE USER IF NOT EXISTS 'u'@'%'");
  });
});

describe("escapeLikeIdentifier", () => {
  it.each([
    ["acme_shop", "acme\\_shop"],
    ["a%b", "a\\%b"],
    ["plain", "plain"],
    ["a_b%c", "a\\_b\\%c"],
  ])("escapes %s", (input, want) => {
    expect(escapeLikeIdentifier(input)).toBe(want);
  });
});

describe("fingerprintSql", () => {
  const sql = fingerprintSql("app");

  it.each(["@@version", "information_schema.tables", "information_schema.columns", "data_length+index_length"])(
    "hashes %s",
    (part) => {
      expect(sql).toContain(part);
    },
  );

  // Paying a full re-dump every time one record changes would make the cache
  // pointless; the time-to-live bounds how stale an entry can get instead.
  it("does not read row contents", () => {
    expect(sql).not.toMatch(/SELECT \*/);
  });

  it("escapes a quote in the database name", () => {
    expect(fingerprintSql("we're")).toContain("we''re");
  });
});

describe("identifier", () => {
  it.each([
    ["acme-shop", "acme_shop"],
    ["a.b", "a_b"],
    ["already_legal", "already_legal"],
  ])("folds %s", (input, want) => {
    expect(identifier(input)).toBe(want);
  });
});

describe("parseColumnOutput", () => {
  it.each([
    ["one value", "abc\n", ["abc"]],
    ["several", "a\nb\n", ["a", "b"]],
    ["blank lines", "\n\na\n", ["a"]],
    ["a NULL", "NULL\n", []],
    ["nothing", "", []],
  ])("reads %s", (_name, stdout, want) => {
    expect(parseColumnOutput(stdout)).toEqual(want);
  });
});

describe("healStuckRows", () => {
  it("does nothing when the project's tracking table has another shape", async () => {
    const home = await mkdtemp(join(tmpdir(), "sbx-heal-"));
    const { ctx, calls } = fakeContext(home, [["information_schema.columns", { stdout: "0\n" }]]);
    expect(await healStuckRows(ctx, settings)).toEqual([]);
    expect(calls).toHaveLength(1);
  });

  it("reports nothing when the table is there but every row is complete", async () => {
    const home = await mkdtemp(join(tmpdir(), "sbx-heal-"));
    const { ctx } = fakeContext(home, [
      ["information_schema.columns", { stdout: "2\n" }],
      ["completed_at IS NULL;", { stdout: "" }],
    ]);
    expect(await healStuckRows(ctx, settings)).toEqual([]);
  });

  // Completing the row rather than deleting it is the conservative choice:
  // deleting would make the runner treat the file as pending again and re-apply
  // DDL that already landed.
  it("completes an incomplete row and names what it healed", async () => {
    const home = await mkdtemp(join(tmpdir(), "sbx-heal-"));
    const { ctx, calls } = fakeContext(home, [
      ["information_schema.columns", { stdout: "2\n" }],
      ["SELECT filename", { stdout: "20260101-1000-first.sql\n" }],
      ["UPDATE migrations", { stdout: "" }],
    ]);
    expect(await healStuckRows(ctx, settings)).toEqual(["20260101-1000-first.sql"]);
    expect(calls.at(-1)?.join(" ")).toContain("UPDATE migrations SET completed_at");
    expect(calls.at(-1)?.join(" ")).not.toContain("DELETE");
  });
});

describe("migrate", () => {
  it("does nothing when the project configures no migration command", async () => {
    const home = await mkdtemp(join(tmpdir(), "sbx-mig-"));
    const config = resolveConfig(
      {
        project: "acme",
        sandboxr: ">=0.1.0",
        access: { apps: "private" },
        database: { driver: "mysql", seed_from: { fixtures: "f.sql" } },
      },
      "/repo/sandboxr.yaml",
    );
    const { ctx } = fakeContext(home, [], config);
    const result = await mysqlDriver.migrate(ctx);
    expect(result).toMatchObject({ ok: true, code: 0, applied: [] });
  });

  it("records a failure so the next run keeps the clean baseline", async () => {
    const home = await mkdtemp(join(tmpdir(), "sbx-mig-"));
    const { ctx } = fakeContext(home, [
      ["information_schema.columns", { stdout: "0\n" }],
      ["sh -lc migrate", { code: 1, stdout: "applying a.sql\nerror: a.sql failed" }],
    ]);

    const result = await mysqlDriver.migrate(ctx);
    expect(result.ok).toBe(false);
    expect(result.code).toBe(1);
    expect(result.failed).toBe("a.sql");
    expect(await lastRunFailed(migrationState(home, "acme", "tkt-1"))).toBe(true);
  });

  it("clears the failure marker after a successful run", async () => {
    const home = await mkdtemp(join(tmpdir(), "sbx-mig-"));
    const state = migrationState(home, "acme", "tkt-1");
    const failing = fakeContext(home, [
      ["information_schema.columns", { stdout: "0\n" }],
      ["sh -lc migrate", { code: 1, stdout: "error: a.sql failed" }],
    ]);
    await mysqlDriver.migrate(failing.ctx);
    expect(await lastRunFailed(state)).toBe(true);

    const passing = fakeContext(home, [
      ["information_schema.columns", { stdout: "0\n" }],
      ["sh -lc migrate", { code: 0, stdout: "applied a.sql" }],
    ]);
    const result = await mysqlDriver.migrate(passing.ctx);
    expect(result.ok).toBe(true);
    expect(result.applied).toEqual(["a.sql"]);
    expect(await lastRunFailed(state)).toBe(false);
  });

  it("passes the database connection as environment rather than in the command", async () => {
    const home = await mkdtemp(join(tmpdir(), "sbx-mig-"));
    const seen: Array<{ cmd: string[]; options?: { env?: Record<string, string> } }> = [];
    const config = configWith();
    const ctx: DriverContext = {
      project: "acme",
      slug: "tkt-1",
      config,
      home,
      worktree: "/repo",
      exec: async (cmd, options) => {
        seen.push({ cmd, options });
        return { code: 0, stdout: cmd.join(" ").includes("information_schema") ? "0\n" : "", stderr: "" };
      },
      log: () => {},
    };
    await mysqlDriver.migrate(ctx);

    const run = seen.find((call) => call.cmd[0] === "sh");
    expect(run?.cmd).toEqual(["sh", "-lc", "migrate"]);
    expect(run?.options?.env).toMatchObject({ DB_NAME: "acme", DB_HOST: "127.0.0.1", DB_PORT: "3306" });
    expect(run?.options?.env?.SANDBOXR_MIGRATION_LOCK).toBe("sandboxr_migrate_acme_tkt_1");
  });
});

describe("describeSeedChoice", () => {
  it.each([
    [{ source: "local" as const, container: "src", database: "app" }, /forking src:app \(read-only\)/],
    [{ source: "file" as const, file: "/seeds/d.sql" }, /restoring \/seeds\/d\.sql/],
    [{ source: "fixtures" as const, fixtures: "f.sql" }, /empty, then migrations and f\.sql/],
    [{ source: "none" as const }, /no database/],
  ])("describes %s", (choice, want) => {
    expect(describeSeedChoice(choice)).toMatch(want);
  });
});
