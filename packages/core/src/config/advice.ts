/**
 * Config problems worth saying out loud without refusing to start.
 *
 * A refusal has to be certain, and these are not: each one is a strong signal
 * that a project will misbehave in a way nothing else reports, but each can also
 * be a false alarm — a project can point its runtime at the sandbox's state
 * directory through a config file this cannot read. So they are findings that
 * `doctor` prints, not errors that `up` throws.
 */

import type { ResolvedConfig } from "./types.js";

export interface Advice {
  /** Dotted config path, so a message can name the field to change. */
  field: string;
  reason: string;
  /** What the author can do about it. */
  fix: string;
}

/**
 * The variable a driver's runtime has to be pointed at.
 *
 * A file-backed database lives in the sandbox's own state directory, and the
 * container exports its location under these names. A command that does not
 * mention one is a command that will use its tool's default — which is inside
 * the worktree, so the sandbox writes into the developer's checkout and every
 * sandbox of that project shares one file (contracts §5.4, §6.1).
 */
const STATE_VARIABLE: Partial<Record<ResolvedConfig["database"]["driver"], string>> = {
  d1: "SANDBOXER_D1_DIR",
  sqlite: "SANDBOXER_DB_FILE",
};

/** Whether a command directs its runtime at the sandbox rather than the worktree. */
export function pointsAtSandboxState(command: string, driver: ResolvedConfig["database"]["driver"]): boolean {
  const variable = STATE_VARIABLE[driver];
  // A driver with no state directory has nothing to be pointed at, so every
  // command trivially satisfies the rule.
  if (!variable) return true;
  return command.includes(variable) || command.includes("SANDBOXER_DB_DIR");
}

/**
 * Commands that will write their database somewhere other than the sandbox.
 *
 * Checked for the migration command and for every served front-end, because
 * those are the two that open the database: a static build does not, and a
 * backend reaches it through the environment the plan maps rather than a
 * command-line flag.
 */
export function persistenceAdvice(config: ResolvedConfig): Advice[] {
  const driver = config.database.driver;
  const variable = STATE_VARIABLE[driver];
  if (!variable) return [];

  const advice: Advice[] = [];
  const owner = config.database.owner;

  const migrate = config.database.migrate?.command;
  if (migrate && !pointsAtSandboxState(migrate, driver)) {
    advice.push({
      field: "database.migrate.command",
      reason: `a ${driver} migration that does not mention $${variable} runs against the worktree's own database, not the sandbox's`,
      fix: `add the runtime's persistence flag, e.g. --persist-to $${variable}`,
    });
  }

  for (const app of config.frontends) {
    // Only the owner opens the database; the container withholds its location
    // from every other server precisely so they fail rather than deadlock.
    if (app.kind !== "server" || !app.serve) continue;
    if (owner !== undefined && owner !== app.label) continue;
    if (pointsAtSandboxState(app.serve, driver)) continue;
    advice.push({
      field: `frontends.${app.label}.serve`,
      reason: `a ${driver} project's serve command that does not mention $${variable} opens the worktree's database, so every sandbox shares one file`,
      fix: `add the runtime's persistence flag, e.g. --persist-to $${variable}`,
    });
  }

  return advice;
}
