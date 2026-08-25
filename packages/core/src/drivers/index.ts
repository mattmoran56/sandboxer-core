/**
 * Driver selection.
 *
 * One table, so adding a driver is one line and nothing else has to know the
 * set. The name comes from the config, which the schema has already limited to
 * this set — the error below exists for a caller that builds a context by hand.
 */

import type { DriverName, ResolvedConfig } from "../config/types.js";
import { paths } from "../paths.js";
import { docker as defaultDocker, nodeRunner, type Docker, type ExecResult } from "../docker.js";
import { containerName } from "../naming.js";
import { d1Driver, sqliteDriver } from "./file.js";
import { mysqlDriver } from "./mysql.js";
import { noneDriver } from "./none.js";
import type { DatabaseDriver, DriverContext } from "./types.js";

export class DriverError extends Error {
  override readonly name = "DriverError";
}

const DRIVERS: Record<DriverName, DatabaseDriver> = {
  mysql: mysqlDriver,
  d1: d1Driver,
  sqlite: sqliteDriver,
  none: noneDriver,
};

export const driverNames = Object.keys(DRIVERS) as DriverName[];

export function getDriver(name: DriverName): DatabaseDriver {
  const driver = DRIVERS[name];
  if (!driver) {
    throw new DriverError(`no driver called "${name}" — one of ${driverNames.join(", ")}`);
  }
  return driver;
}

export interface ContextOptions {
  slug: string;
  worktree: string;
  env?: NodeJS.ProcessEnv | undefined;
  docker?: Docker | undefined;
  log?: ((line: string) => void) | undefined;
  now?: (() => Date) | undefined;
}

/**
 * Builds the context a driver runs in.
 *
 * `exec` targets the sandbox's own container, so every destructive operation a
 * driver performs lands on the copy inside it rather than anywhere else.
 */
export function driverContext(config: ResolvedConfig, options: ContextOptions): DriverContext {
  const env = options.env ?? process.env;
  const docker = options.docker ?? defaultDocker;
  const container = containerName(config.project, options.slug);

  return {
    project: config.project,
    slug: options.slug,
    config,
    home: paths(env).home,
    worktree: options.worktree,
    exec: (cmd: string[], execOptions): Promise<ExecResult> => docker.exec(container, cmd, execOptions),
    log: options.log ?? ((line: string) => process.stderr.write(`${line}\n`)),
    host: nodeRunner,
    docker,
    now: options.now,
  };
}

export { mysqlDriver, d1Driver, sqliteDriver, noneDriver };
export * from "./seed.js";
export * from "./migrate.js";
