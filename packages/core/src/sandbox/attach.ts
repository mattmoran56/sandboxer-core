/**
 * The heartbeat that says "somebody is on the other end of a socket right now".
 *
 * Every other activity signal in ./activity.ts is *derived* — the router already
 * logs each request, the agent already appends each line to its transcript, and
 * reading them is the whole of the work. This one is written, and it is the only
 * one that is, so the reason has to be exact.
 *
 * **A websocket is invisible to the router's log until it ends.** Traefik writes
 * its access line when the request *completes*, and the timestamp on that line is
 * the moment the request **started**. So a terminal or an agent socket held open
 * for six hours produces no line at all for six hours, and then produces one
 * dated six hours ago. Opening the socket is not the gap — the browser fetches
 * `/api/p/:project/s/:slug` first and that line is written immediately — the gap
 * is a session *held* open for longer than the sandbox's lifetime with nothing
 * else touching it. The reaper would then stop the container out from under a
 * live connection, which is the exact failure the activity mechanism exists to
 * prevent, and the cause looks nothing like the symptom: the log appears to
 * contain the request, dated to the wrong end of it.
 *
 * There is nothing to derive it from. The container's exec is not something
 * `docker inspect` will describe reliably, the per-sandbox logs were rejected as
 * a signal for reasons that have not changed, and the only process that knows a
 * socket is open is the dashboard — while `sandboxr expire` runs in a *different*
 * process and would see none of it. A set of open sockets held in memory would
 * give the CLI and the dashboard two different answers to "is this in use", which
 * is precisely the drift docs/architecture/state.md exists to forbid.
 *
 * So the file is an original, not a copy, and it passes §4.2's test — *does its
 * correctness depend on a container?* — the same way `state/name/` does, and for
 * the same reason it needs no `sandboxr.created` stamp:
 *
 * **What it records is a timestamp, and an old timestamp cannot keep anything
 * alive.** The keep marker is a permission, so a stale one left behind for a
 * recreated slug would silently exempt the next sandbox to take that name. This
 * says only "at time T a live process held a connection to this name", and the
 * planner takes `max(startedAt, lastActive)` — so a marker older than the
 * container it now names contributes nothing at all. Nothing has to reconcile it,
 * nothing has to delete it, and `down` is not hooked because there is nothing for
 * a stale one to get wrong.
 *
 * **The mtime is the signal.** The file's text is a stamp for whoever is reading
 * the directory by hand, and nothing parses it: the filesystem maintains an mtime
 * for free, it is the same thing the transcripts are read by, and a second
 * spelling of the same moment inside the file would be a thing that can disagree
 * with the file.
 */

import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

import { paths } from "../paths.js";

/**
 * How often the holder of a socket re-stamps the file.
 *
 * Far shorter than `ATTACH_LIVE_GRACE_MS`, which is what the reader believes it
 * for: at this interval a dozen heartbeats can be missed — a busy machine, a
 * paused process, a slow disk — before a sandbox somebody is looking at stops
 * counting as in use. It is here rather than beside the writer so that the
 * interval and the window it has to fit inside are one file apart, and a test
 * asserts the relationship rather than trusting it.
 */
export const ATTACH_HEARTBEAT_MS = 30_000;

export interface AttachOptions {
  env?: NodeJS.ProcessEnv | undefined;
  /** `$SANDBOXR_HOME`, for a caller that already has it resolved. */
  home?: string | undefined;
}

function pathsFor(options: AttachOptions) {
  const env = options.env ?? process.env;
  return options.home === undefined ? paths(env) : paths({ ...env, SANDBOXR_HOME: options.home });
}

/** `state/attach/<project>/<slug>` — keyed like the keep marker, on the container's project. */
export function attachFileFor(project: string, slug: string, options: AttachOptions = {}): string {
  return pathsFor(options).attachFile(project, slug);
}

/**
 * Records that a live process is attached to this sandbox, now.
 *
 * Called on every heartbeat and once more when the last socket closes, so the
 * file's final mtime is the moment the connection ended rather than the moment
 * it began — the half of the fix the router's log cannot supply.
 *
 * Failures are swallowed. A read-only home or a full disk is a reason the
 * sandbox falls back to the signals underneath this one, and never a reason for
 * a terminal to fail to open.
 */
export async function markAttached(project: string, slug: string, options: AttachOptions = {}): Promise<void> {
  const file = attachFileFor(project, slug, options);
  try {
    await mkdir(dirname(file), { recursive: true });
    await writeFile(file, `${new Date().toISOString()}\n`, "utf8");
  } catch {
    return;
  }
}
