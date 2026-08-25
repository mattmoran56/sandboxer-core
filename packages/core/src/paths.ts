/**
 * Every host path sandboxr owns, from contracts §4.
 *
 * All of it hangs off SANDBOXR_HOME (default `~/.sandboxr`), which is
 * deliberately outside any repository so `git clean` cannot destroy a seed
 * cache or a certificate.
 */

import { homedir } from "node:os";
import { join } from "node:path";

export interface Paths {
  /** SANDBOXR_HOME itself. */
  home: string;
  /** Database seed artifacts, content-addressed. */
  cache: string;
  /** Per-sandbox logs, which outlive the container. */
  logs: string;
  /** The certificate and key the router serves. */
  tls: string;
  /** Router config and the dashboard session secret. */
  state: string;
  /** Third-party credentials, one file per project, mode 0600. */
  secrets: string;
  /** Generated per-sandbox environment files. */
  build: string;
  /** Host-built helper binaries. */
  bin: string;

  logsFor(project: string, slug: string): string;
  secretsFile(project: string): string;
  /** The generated environment for one sandbox. */
  envFile(project: string, slug: string): string;
  /** A content-addressed seed artifact. */
  cacheFile(name: string): string;
}

/**
 * Resolves the path set from an environment.
 *
 * Takes the environment as an argument rather than reading `process.env`
 * directly so a test can point the whole tree at a temporary directory without
 * mutating the process.
 */
export function paths(env: NodeJS.ProcessEnv = process.env): Paths {
  const home = env.SANDBOXR_HOME && env.SANDBOXR_HOME !== "" ? env.SANDBOXR_HOME : join(homedir(), ".sandboxr");

  return {
    home,
    cache: join(home, "cache"),
    logs: join(home, "logs"),
    tls: join(home, "tls"),
    state: join(home, "state"),
    secrets: join(home, "secrets"),
    build: join(home, "build"),
    bin: join(home, "bin"),

    logsFor: (project, slug) => join(home, "logs", project, slug),
    secretsFile: (project) => join(home, "secrets", `${project}.env`),
    envFile: (project, slug) => join(home, "build", project, `${slug}.env`),
    cacheFile: (name) => join(home, "cache", name),
  };
}

/** The directories a command creates before it writes anything. */
export function directoriesOf(p: Paths): string[] {
  return [p.cache, p.logs, p.tls, p.state, p.secrets, p.build, p.bin];
}
