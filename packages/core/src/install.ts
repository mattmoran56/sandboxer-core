/**
 * Where this installation of sandboxr keeps the files it is not the only reader
 * of: the container image sources, and the dashboard's own build.
 *
 * `~/.sandboxr` (see paths.ts) is state. This is the *installation* — the
 * checkout or the published package the running code came out of — and the two
 * are separate because state survives an upgrade and an installation does not.
 *
 * Resolved by walking up from this module rather than from `process.cwd()`: a
 * command runs in the project being sandboxed, which is never this repository.
 */

import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export class InstallError extends Error {
  override readonly name = "InstallError";
}

/** Files that only exist together at the top of a sandboxr installation. */
const MARKERS = ["container/base/Dockerfile", "packages/server/package.json"];

/**
 * The top of the sandboxr installation.
 *
 * `SANDBOXR_INSTALL` overrides it, which is what a packaged install or a test
 * uses; otherwise the search walks up from this file.
 */
export function installRoot(env: NodeJS.ProcessEnv = process.env): string {
  const declared = env.SANDBOXR_INSTALL;
  if (declared && declared !== "") return resolve(declared);

  let dir = dirname(fileURLToPath(import.meta.url));
  for (;;) {
    if (MARKERS.every((marker) => existsSync(join(dir, marker)))) return dir;
    const parent = dirname(dir);
    if (parent === dir) {
      throw new InstallError(
        "cannot find the sandboxr installation (no container/ beside packages/) — set SANDBOXR_INSTALL",
      );
    }
    dir = parent;
  }
}

/** The container package: Dockerfiles, the s6 skeleton and the scripts. */
export function containerDir(env: NodeJS.ProcessEnv = process.env): string {
  return join(installRoot(env), "container");
}

/** The dashboard's entry point, as the dashboard container will run it. */
export function dashboardEntry(env: NodeJS.ProcessEnv = process.env): string {
  return join(installRoot(env), "packages", "server", "dist", "bin.js");
}
