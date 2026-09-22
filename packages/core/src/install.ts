/**
 * Where this installation of sandboxer keeps the files it is not the only reader
 * of: the container image sources.
 *
 * `~/.sandboxer` (see paths.ts) is state. This is the *installation* — the
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

/**
 * Files that only exist together at the top of a sandboxer installation.
 *
 * **Both are the engine's own**, and that is the rule rather than an accident.
 * This used to name `packages/server/package.json`, which is the *product's* —
 * so a clone of the engine on its own would have walked to `/` and thrown on
 * every `init`, every `up` and every image build. No test caught it, because
 * every test runs inside a tree that happens to have both.
 *
 * A marker belonging to something else keeps resolving right up until the
 * something else moves, and then stops, in a tree nobody has changed.
 */
const MARKERS = ["container/base/Dockerfile", "packages/core/package.json"];

/**
 * The top of the sandboxer installation.
 *
 * `SANDBOXER_INSTALL` overrides it, which is what a packaged install uses;
 * otherwise the search walks up from this file.
 *
 * `from` exists so the walk itself can be tested. Without it a test can only
 * assert the override, and the walk is where the whole difficulty is — the
 * marker list decides whether a cold clone resolves at all, and every test in
 * this repository runs inside a tree that satisfies any plausible list.
 */
export function installRoot(env: NodeJS.ProcessEnv = process.env, from?: string): string {
  const declared = env.SANDBOXER_INSTALL;
  if (declared && declared !== "") return resolve(declared);

  let dir = from ?? dirname(fileURLToPath(import.meta.url));
  for (;;) {
    if (MARKERS.every((marker) => existsSync(join(dir, marker)))) return dir;
    const parent = dirname(dir);
    if (parent === dir) {
      throw new InstallError(
        "cannot find the sandboxer installation (no container/base beside packages/core) — set SANDBOXER_INSTALL",
      );
    }
    dir = parent;
  }
}

/** The container package: Dockerfiles, the s6 skeleton and the scripts. */
export function containerDir(env: NodeJS.ProcessEnv = process.env): string {
  return join(installRoot(env), "container");
}
