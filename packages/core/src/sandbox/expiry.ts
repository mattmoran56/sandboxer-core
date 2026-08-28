/**
 * Deciding what has sat unused long enough.
 *
 * A pure function of what `docker ps`, `docker inspect`, the router's access log
 * and the agent index report, plus one question per sandbox — whether somebody
 * asked to keep it alive. Separated from the stopping so the plan can be
 * printed, tested and inspected before a container somebody may be looking at
 * goes away.
 *
 * **The clock measures idleness, not uptime.** The deadline is
 * `max(startedAt, lastActive) + ttl`, and both halves of that maximum are
 * load-bearing:
 *
 * - `lastActive` is the last time anybody used the sandbox — a request to one of
 *   its apps, a dashboard route that names it, or an agent running on its
 *   worktree. ./activity.ts is where all three are read, and why. Using a
 *   sandbox therefore resets its clock, which is what anyone would expect of a
 *   limit described as "unused".
 * - `startedAt` is the floor, and it is not redundant. It covers a sandbox that
 *   has never been visited, and — more importantly — the router's log window
 *   only reaches so far back, so a sandbox in constant use whose evidence has
 *   scrolled off must not read as idle since the beginning of time.
 *
 * A live agent session reaches this file as a `lastActive` of *now*, so it needs
 * no case of its own here: a sandbox with an agent working on it is simply a
 * sandbox that was used a moment ago, and it stops being one the moment the
 * agent stops. That is deliberate. A boolean "an agent is running" would be a
 * second exemption beside `keptAlive`, and the two would answer differently the
 * question that actually matters — *when did the countdown start* — because only
 * the timestamp remembers when the agent stopped.
 *
 * `sandboxr.created` is deliberately not either of them. It is stamped once and
 * never moves, so a deadline derived from it stays in the past for ever: the
 * reaper would stop an expired sandbox, the developer would press Restart, and
 * the next pass would stop it again. Restarting a sandbox buys it a full ttl,
 * and so does using it.
 */

import type { Sandbox } from "./types.js";

export interface ExpiryCandidate {
  sandbox: Sandbox;
  /** When the container last entered the running state, from docker inspect. */
  startedAt: Date | undefined;
  /**
   * The last time anybody used this sandbox: a request through the router, a
   * dashboard route naming it, or an agent working on its worktree.
   *
   * Undefined means "no use seen in the window read", which is the same answer
   * as "not used" for every purpose here — the sandbox falls back to its start
   * time and the clock runs from there. It never means "nobody used anything":
   * every read behind it turns a failure into an absence, one sandbox at a time.
   */
  lastActive: Date | undefined;
  keptAlive: boolean;
}

export interface ExpiryInput {
  candidates: ExpiryCandidate[];
  now: Date;
}

export interface ExpiryPlan {
  /** Sandboxes to stop, with the reason each was chosen. */
  stop: Array<{ sandbox: Sandbox; reason: string }>;
  /** Sandboxes left alone, with the reason each survived. */
  keep: Array<{ sandbox: Sandbox; reason: string }>;
}

const MINUTE = 60;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

function unitSeconds(suffix: string): number | undefined {
  switch (suffix) {
    case "":
    case "s":
      return 1;
    case "m":
      return MINUTE;
    case "h":
      return HOUR;
    case "d":
      return DAY;
    default:
      return undefined;
  }
}

/**
 * Reads a ttl into seconds.
 *
 * Accepts a plain number of seconds, the word `never`, and the human forms a
 * person actually types — `30m`, `12h`, `7d`.
 *
 * Returns undefined for anything it cannot read rather than throwing, and never
 * coerces a bad value into a number. A ttl arrives from a container label,
 * which is a string anybody could have set by hand; the safe reading of "I do
 * not understand this" is "do not run the clock", because the alternative is
 * treating garbage as `0` and killing the sandbox on the next pass.
 */
export function parseTtl(raw: string): number | "never" | undefined {
  const text = raw.trim().toLowerCase();
  if (text === "") return undefined;
  if (text === "never") return "never";

  const match = /^(\d+(?:\.\d+)?)\s*([a-z]*)$/.exec(text);
  if (!match) return undefined;

  const amount = Number(match[1]);
  const unit = unitSeconds(match[2] ?? "");
  if (!Number.isFinite(amount) || unit === undefined) return undefined;

  const seconds = Math.round(amount * unit);
  // Zero and negative are rejected rather than clamped. "0h" is almost always
  // arithmetic that went wrong somewhere upstream, and honouring it literally
  // would stop the sandbox the instant it started — the one outcome nobody
  // asking for a ttl wants.
  if (seconds <= 0) return undefined;
  return seconds;
}

/** Renders a ttl the way somebody would have typed it. */
export function formatTtl(seconds: number | "never"): string {
  if (seconds === "never") return "never";
  if (seconds >= DAY && seconds % DAY === 0) return `${seconds / DAY}d`;
  if (seconds >= HOUR && seconds % HOUR === 0) return `${seconds / HOUR}h`;
  if (seconds >= MINUTE && seconds % MINUTE === 0) return `${seconds / MINUTE}m`;
  return `${seconds}s`;
}

/**
 * The most recent thing that counts as use: the later of starting and being
 * asked for. Undefined only when docker could not say when it started.
 */
function activeSince(candidate: ExpiryCandidate): Date | undefined {
  if (candidate.startedAt === undefined) return undefined;
  if (candidate.lastActive === undefined) return candidate.startedAt;
  return candidate.lastActive > candidate.startedAt ? candidate.lastActive : candidate.startedAt;
}

/**
 * When a candidate runs out, or undefined when it has no deadline at all.
 *
 * Undefined covers three situations that mean the same thing to the planner: no
 * ttl, an unreadable ttl, and a container docker could not give a start time
 * for.
 */
export function deadlineOf(candidate: ExpiryCandidate): Date | undefined {
  const ttl = parseTtl(candidate.sandbox.ttl);
  if (ttl === undefined || ttl === "never") return undefined;
  const since = activeSince(candidate);
  if (since === undefined) return undefined;
  return new Date(since.getTime() + ttl * 1000);
}

export function planExpiry(input: ExpiryInput): ExpiryPlan {
  const stop: ExpiryPlan["stop"] = [];
  const keep: ExpiryPlan["keep"] = [];

  for (const candidate of input.candidates) {
    const { sandbox } = candidate;

    // Stopping a stopped sandbox is not harmless: it would appear in every
    // pass's plan for ever, so a report of what the reaper did could no longer
    // be read as a list of things that changed.
    if (sandbox.state === "stopped") {
      keep.push({ sandbox, reason: "already stopped" });
      continue;
    }

    const ttl = parseTtl(sandbox.ttl);
    if (ttl === undefined || ttl === "never") {
      keep.push({ sandbox, reason: "no expiry set" });
      continue;
    }

    // Checked after the ttl so a keep-alive on a sandbox that was never going
    // to expire does not report a reason implying the keep-alive is what saved
    // it.
    if (candidate.keptAlive) {
      keep.push({ sandbox, reason: "kept alive" });
      continue;
    }

    // Failing closed. Docker not answering is a fact about docker, not about
    // the sandbox, and the failure mode of guessing wrong here is killing a
    // sandbox somebody is using. A sandbox that outlives its ttl because one
    // inspect failed costs nobody anything.
    if (candidate.startedAt === undefined) {
      keep.push({ sandbox, reason: "no start time from docker, so not expired" });
      continue;
    }

    // Never negative. A clock that has gone backwards between the container
    // starting and this pass would otherwise produce a negative idle time,
    // which `describe` renders as nonsense in the one string somebody reads to
    // find out why their sandbox went away.
    const since = activeSince(candidate) ?? candidate.startedAt;
    const idle = Math.max(0, Math.floor((input.now.getTime() - since.getTime()) / 1000));
    if (idle >= ttl) {
      stop.push({ sandbox, reason: `idle ${describe(idle)}, past its ${formatTtl(ttl)} limit` });
      continue;
    }

    keep.push({ sandbox, reason: `${describe(ttl - idle)} left, idle ${describe(idle)}` });
  }

  return { stop, keep };
}

/**
 * A span, to two units. Readable, not round-trippable — `formatTtl` is for that.
 *
 * Two rather than one because these strings are what the dashboard shows and
 * what `expire --dry-run` prints, and flooring to a single unit reads as a lie:
 * a sandbox with 1h59m left was reported as having "1h left", which sounds like
 * it is nearly out of time when it has almost its whole lifetime ahead of it.
 */
function describe(seconds: number): string {
  const units: Array<[number, string]> = [
    [DAY, "d"],
    [HOUR, "h"],
    [MINUTE, "m"],
    [1, "s"],
  ];
  const index = units.findIndex(([size]) => seconds >= size);
  if (index === -1) return "0s";

  const [size, suffix] = units[index] as [number, string];
  const whole = Math.floor(seconds / size);
  const rest = seconds - whole * size;

  const next = units[index + 1];
  if (!next) return `${whole}${suffix}`;
  const [nextSize, nextSuffix] = next;
  const part = Math.floor(rest / nextSize);
  return part === 0 ? `${whole}${suffix}` : `${whole}${suffix} ${part}${nextSuffix}`;
}
