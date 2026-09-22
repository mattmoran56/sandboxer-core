/**
 * The `none` driver: a project with no database.
 *
 * Valid, and it stays cheap. Nothing here touches the container, reads the
 * cache or creates a directory, so a project without a database pays nothing
 * for the driver layer existing — a sandbox for it comes up as fast as the
 * container starts.
 */

import type { DatabaseDriver, DriverContext, MigrateResult, SeedArtifact } from "./types.js";

export class NoDatabaseError extends Error {
  override readonly name = "NoDatabaseError";
}

export const noneDriver: DatabaseDriver = {
  name: "none",

  async prepareSeed(ctx: DriverContext): Promise<SeedArtifact> {
    return { kind: "none", source: "none", key: "none", createdAt: (ctx.now?.() ?? new Date()).toISOString() };
  },

  async provision(ctx: DriverContext): Promise<void> {
    // The state marker is still written, so a project with no database reports
    // `running` rather than sitting at `starting` for ever. Nothing else is
    // done, and nothing is logged: a sandbox with no database should not print
    // about the database it does not have.
    await ctx.exec(["sh", "-lc", "mkdir -p /run/sandboxer && echo ok > /run/sandboxer/migrate.ok"]);
  },

  async migrate(): Promise<MigrateResult> {
    return { ok: true, code: 0, applied: [], durationMs: 0, output: "this project has no database" };
  },

  async snapshot(): Promise<string> {
    return "";
  },

  async shell(ctx: DriverContext): Promise<void> {
    throw new NoDatabaseError(`${ctx.config.project} has no database, so there is no shell to open`);
  },
};
