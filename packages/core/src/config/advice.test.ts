// Tests for the advisory checks (contracts §5.4):
// - pointsAtSandboxState: each driver's variable, the shared directory variable, a driver with no state
// - persistenceAdvice: a migration and a serve command that would write into the worktree
// - only the owner is checked, because the container withholds the location from every other server
// - a server driver has no state directory, so it never produces advice

import { describe, expect, it } from "vitest";

import { persistenceAdvice, pointsAtSandboxState } from "./advice.js";
import { resolveConfig } from "./load.js";
import type { ResolvedConfig } from "./types.js";

function configFor(overrides: {
  driver?: "d1" | "sqlite" | "mysql";
  migrate?: string;
  owner?: string;
  apps?: Array<Record<string, unknown>>;
}): ResolvedConfig {
  const driver = overrides.driver ?? "d1";
  return resolveConfig(
    {
      project: "acme",
      sandboxer: ">=0.1.0",
      access: { apps: "private" },
      database: {
        driver,
        ...(driver === "mysql" ? { version: "8.4" } : {}),
        migrate: { command: overrides.migrate ?? "npx wrangler d1 migrations apply DB --local" },
        ...(overrides.owner ? { owner: overrides.owner } : {}),
      },
      frontends: {
        apps: overrides.apps ?? [{ label: "app", package: ".", serve: "npx wrangler dev --port 8787", port: 8787 }],
      },
    },
    "/repo/sandboxer.yaml",
  );
}

describe("pointsAtSandboxState", () => {
  it.each([
    ["d1 named directly", "npx wrangler dev --persist-to $SANDBOXER_D1_DIR", "d1", true],
    ["d1 not named at all", "npx wrangler dev", "d1", false],
    ["the shared directory variable", "npx wrangler dev --persist-to $SANDBOXER_DB_DIR", "d1", true],
    ["sqlite named directly", 'sqlite3 "$SANDBOXER_DB_FILE"', "sqlite", true],
    ["sqlite pointed at a literal path", "sqlite3 ./local.db", "sqlite", false],
    ["a driver with no state directory", "mysql -e 'select 1'", "mysql", true],
    ["no database at all", "anything", "none", true],
  ] as const)("%s", (_name, command, driver, want) => {
    expect(pointsAtSandboxState(command, driver)).toBe(want);
  });
});

describe("persistenceAdvice", () => {
  // Without the flag the runtime uses its own default, which is inside the
  // worktree — so the sandbox writes into the developer's checkout and every
  // sandbox of the project shares one file.
  it("names a migration command that would write into the worktree", () => {
    const advice = persistenceAdvice(configFor({}));
    expect(advice.map((a) => a.field)).toContain("database.migrate.command");
    expect(advice[0]?.fix).toContain("--persist-to $SANDBOXER_D1_DIR");
  });

  it("names a serve command that would write into the worktree", () => {
    expect(persistenceAdvice(configFor({})).map((a) => a.field)).toContain("frontends.app.serve");
  });

  it("says nothing when both commands point at the sandbox", () => {
    const config = configFor({
      migrate: "npx wrangler d1 migrations apply DB --local --persist-to $SANDBOXER_D1_DIR",
      apps: [
        {
          label: "app",
          package: ".",
          serve: "npx wrangler dev --port 8787 --persist-to $SANDBOXER_D1_DIR",
          port: 8787,
        },
      ],
    });
    expect(persistenceAdvice(config)).toEqual([]);
  });

  // The container withholds the database's location from every server that is
  // not the owner, so a non-owner without the flag is correct rather than wrong.
  it("checks only the service that owns the database", () => {
    const config = configFor({
      migrate: "npx wrangler d1 migrations apply DB --persist-to $SANDBOXER_D1_DIR",
      owner: "app",
      apps: [
        { label: "app", package: ".", serve: "npx wrangler dev --persist-to $SANDBOXER_D1_DIR", port: 8787 },
        { label: "other", package: "other", serve: "npx wrangler dev --port 8788", port: 8788 },
      ],
    });
    expect(persistenceAdvice(config)).toEqual([]);
  });

  it.each([["mysql"], ["none"]] as const)("says nothing for a %s project", (driver) => {
    const config =
      driver === "mysql"
        ? configFor({ driver: "mysql", migrate: "go run ./cmd/migrate" })
        : resolveConfig(
            {
              project: "acme",
              sandboxer: ">=0.1.0",
              access: { apps: "private" },
              frontends: { apps: [{ label: "app", package: ".", serve: "npm start", port: 3000 }] },
            },
            "/repo/sandboxer.yaml",
          );
    expect(persistenceAdvice(config)).toEqual([]);
  });

  it("says nothing when the project declares no migration command", () => {
    const config = resolveConfig(
      {
        project: "acme",
        sandboxer: ">=0.1.0",
        access: { apps: "private" },
        database: { driver: "d1", seed_from: { fixtures: "f.sql" }, owner: "app" },
        frontends: {
          apps: [{ label: "app", package: ".", serve: "npx wrangler dev --persist-to $SANDBOXER_D1_DIR", port: 1 }],
        },
      },
      "/repo/sandboxer.yaml",
    );
    expect(persistenceAdvice(config)).toEqual([]);
  });
});
