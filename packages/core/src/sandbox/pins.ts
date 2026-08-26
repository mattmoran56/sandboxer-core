/**
 * The pin: one file that exempts one sandbox from the expiry clock.
 *
 * A pin lives at `~/.sandboxr/state/pins/<project>/<slug>` (contracts §4). It is
 * the one piece of sandboxr's state that cannot live in a container label,
 * because pinning must work on a sandbox that is already running and labels are
 * fixed at creation.
 *
 * **The file is not an empty marker: it holds the `sandboxr.created` value of
 * the container it pins, and a pin only counts when that stamp matches the live
 * sandbox.** Slugs come from ticket ids and branch names (contracts §3.1), so
 * the same project/slug is recreated routinely — same ticket, second attempt.
 * A bare marker would outlive the sandbox it was written for and silently pin
 * whatever next took the name, and the symptom ("this one never expires") looks
 * nothing like the cause. Stamping makes a stale pin fail closed instead.
 *
 * That is also what keeps this file from becoming the manifest that
 * `docs/architecture/state.md` forbids. A marker file would need a
 * reconciliation pass — one whose job is to read `docker ps` and believe it —
 * and at that point the file is a cache of the thing you already have to read.
 * A stamped pin needs no pass: it is checked against `docker ps` at the moment
 * it is used, and a pin left behind by a sandbox that is gone answers "not
 * pinned" on its own.
 */

import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

import { paths } from "../paths.js";
import type { Sandbox } from "./types.js";

/**
 * The stamp a pin carries, or undefined when there is no pin.
 *
 * A missing file and a missing directory are both just "not pinned" — the pins
 * directory does not exist until something is pinned for the first time.
 */
export async function readPin(project: string, slug: string, env?: NodeJS.ProcessEnv): Promise<string | undefined> {
  try {
    const text = await readFile(paths(env).pinFile(project, slug), "utf8");
    const stamp = text.trim();
    return stamp === "" ? undefined : stamp;
  } catch {
    return undefined;
  }
}

/** Pins one sandbox, recording the `sandboxr.created` value it was pinned for. */
export async function writePin(project: string, slug: string, stamp: string, env?: NodeJS.ProcessEnv): Promise<void> {
  const file = paths(env).pinFile(project, slug);
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, `${stamp}\n`, "utf8");
}

/** Removes a pin. Unpinning something that was never pinned is not an error. */
export async function removePin(project: string, slug: string, env?: NodeJS.ProcessEnv): Promise<void> {
  await rm(paths(env).pinFile(project, slug), { force: true });
}

/**
 * Whether this exact sandbox is pinned.
 *
 * The stamp comparison is the whole point — see the note at the top of the
 * file. A sandbox with no `created` label can never match, which is the right
 * answer: without it there is no way to tell the pinned container from its
 * successor, and the safe reading is that the pin belongs to the other one.
 */
export async function isPinned(sandbox: Sandbox, env?: NodeJS.ProcessEnv): Promise<boolean> {
  if (sandbox.created === "") return false;
  const stamp = await readPin(sandbox.project, sandbox.slug, env);
  return stamp !== undefined && stamp === sandbox.created;
}
