/**
 * Keep-alive: one file that exempts one sandbox from the idle clock.
 *
 * A keep-alive marker lives at `~/.sandboxr/state/keep/<project>/<slug>`
 * (contracts §4). It is the one piece of sandboxr's state that cannot live in a
 * container label, because asking to keep a sandbox must work on one that is
 * already running and labels are fixed at creation.
 *
 * **The file is not an empty marker: it holds the `sandboxr.created` value of
 * the container it applies to, and it only counts when that stamp matches the
 * live sandbox.** Slugs come from ticket ids and branch names (contracts §3.1),
 * so the same project/slug is recreated routinely — same ticket, second
 * attempt. A bare marker would outlive the sandbox it was written for and
 * silently keep whatever next took the name alive, and the symptom ("this one
 * never expires") looks nothing like the cause. Stamping makes a stale marker
 * fail closed instead.
 *
 * That is also what keeps this file from becoming the manifest that
 * `docs/architecture/state.md` forbids. A marker file would need a
 * reconciliation pass — one whose job is to read `docker ps` and believe it —
 * and at that point the file is a cache of the thing you already have to read.
 * A stamped marker needs no pass: it is checked against `docker ps` at the
 * moment it is used, and one left behind by a sandbox that is gone answers "not
 * kept alive" on its own.
 */

import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

import { paths } from "../paths.js";
import type { Sandbox } from "./types.js";

/**
 * The stamp a keep-alive marker carries, or undefined when there is none.
 *
 * A missing file and a missing directory both just mean "not kept alive" — the
 * keep directory does not exist until something asks to be kept for the first
 * time.
 */
export async function readKeep(project: string, slug: string, env?: NodeJS.ProcessEnv): Promise<string | undefined> {
  try {
    const text = await readFile(paths(env).keepFile(project, slug), "utf8");
    const stamp = text.trim();
    return stamp === "" ? undefined : stamp;
  } catch {
    return undefined;
  }
}

/** Keeps one sandbox alive, recording the `sandboxr.created` it was asked for. */
export async function writeKeep(project: string, slug: string, stamp: string, env?: NodeJS.ProcessEnv): Promise<void> {
  const file = paths(env).keepFile(project, slug);
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, `${stamp}\n`, "utf8");
}

/** Hands one back to the clock. Doing so to a sandbox that was never kept alive is not an error. */
export async function removeKeep(project: string, slug: string, env?: NodeJS.ProcessEnv): Promise<void> {
  await rm(paths(env).keepFile(project, slug), { force: true });
}

/**
 * Whether this exact sandbox is being kept alive.
 *
 * The stamp comparison is the whole point — see the note at the top of the
 * file. A sandbox with no `created` label can never match, which is the right
 * answer: without it there is no way to tell the sandbox somebody asked to keep
 * from its successor, and the safe reading is that the marker belongs to the
 * other one.
 */
export async function isKeptAlive(sandbox: Sandbox, env?: NodeJS.ProcessEnv): Promise<boolean> {
  if (sandbox.created === "") return false;
  const stamp = await readKeep(sandbox.project, sandbox.slug, env);
  return stamp !== undefined && stamp === sandbox.created;
}
