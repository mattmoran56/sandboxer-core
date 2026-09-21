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
 *   its apps, a dashboard route that names it, an agent running on its worktree,
 *   or a terminal or agent socket somebody is holding open on it. ./activity.ts
 *   is where all four are read, and why. Using a sandbox therefore resets its
 *   clock, which is what anyone would expect of a limit described as "unused".
 * - `startedAt` is the floor, and it is not redundant. It covers a sandbox that
 *   has never been visited, and — more importantly — the router's log window
 *   only reaches so far back, so a sandbox in constant use whose evidence has
 *   scrolled off must not read as idle since the beginning of time.
 *
 * A live agent session reaches this file as a `lastActive` of *now*, and so does
 * a socket somebody is holding open, so neither needs a case of its own here: a
 * sandbox with an agent working on it, or a terminal attached to it, is simply a
 * sandbox that was used a moment ago, and it stops being one the moment the
 * agent stops or the connection drops. That is deliberate. A boolean "an agent is
 * running" would be a second exemption beside `keptAlive`, and the two would
 * answer differently the question that actually matters — *when did the countdown
 * start* — because only the timestamp remembers when the agent stopped.
 *
 * `sandboxr.created` is deliberately not either of them. It is stamped once and
 * never moves, so a deadline derived from it stays in the past for ever: the
 * reaper would stop an expired sandbox, the developer would press Restart, and
 * the next pass would stop it again. Restarting a sandbox buys it a full ttl,
 * and so does using it.
 *
 * ## A workstation runs on this clock too, and it is the same clock
 *
 * Contracts §12.7: "the idle clock is the one in
 * `packages/core/src/sandbox/expiry.ts` and it is not redesigned". So
 * `planSessionExpiry` is `planExpiry` over a different subject and not a second
 * timer — both reach `decide` below, which is the only place a deadline is ever
 * compared against a clock. Two planners that each did the arithmetic would
 * eventually answer differently, and the one that is wrong would be whichever
 * one nobody was looking at.
 *
 * A workstation reaches it having lost exactly one of the four signals: it has
 * no hostname, so nothing about it ever appears in the router's log under a
 * router name of its own (§12.2). **That absence is carried by `startedAt`**,
 * which is already the floor for precisely this shape of gap, and nothing here
 * needed a case for it. The alternative — reading a missing signal as a
 * `lastActive` of the epoch — would stop every workstation on the machine on the
 * first pass, which is the failure the paragraph above about scrolled-off log
 * lines was written for.
 *
 * What stopping means is narrower for a workstation than the word suggests, and
 * §12.8 is where it is argued: **stopping removes nothing at all.** No volume,
 * no state directory, no time limit on either. The plan this file produces is a
 * list of containers to stop, and whoever acts on it may not widen it.
 */

import type { Session } from "../session/types.js";
import type { Sandbox } from "./types.js";

export interface ExpiryCandidate {
  sandbox: Sandbox;
  /** When the container last entered the running state, from docker inspect. */
  startedAt: Date | undefined;
  /**
   * The last time anybody used this sandbox: a request through the router, a
   * dashboard route naming it, an agent working on its worktree, or a socket
   * held open on it.
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

export interface SessionExpiryCandidate {
  session: Session;
  /** When the workstation last entered the running state, from docker inspect. */
  startedAt: Date | undefined;
  /**
   * The last time anybody used this session: a dashboard route naming it, an
   * agent running in its workstation, or a socket held open on it.
   *
   * **Three signals rather than the sandbox's four**, because a workstation has
   * no hostname for the fourth to be about (§12.2). Undefined is the same
   * absence it is for a sandbox and is read the same way — the session falls
   * back to `startedAt` — and it never means "idle since the epoch".
   * `sessionActivity` in ./activity.ts is where each signal is read.
   */
  lastActive: Date | undefined;
  /** `state/session/<session>/keep`, matched against the workstation's `created` (§12.6). */
  keptAlive: boolean;
}

export interface SessionExpiryInput {
  candidates: SessionExpiryCandidate[];
  now: Date;
}

export interface SessionExpiryPlan {
  /** Workstations to stop, with the reason each was chosen. Stopping removes nothing (§12.8). */
  stop: Array<{ session: Session; reason: string }>;
  /** Sessions left alone, with the reason each survived. */
  keep: Array<{ session: Session; reason: string }>;
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
 * What the clock reads off a candidate, whatever kind of container it names.
 *
 * A sandbox and a workstation differ in every label but these, so the arithmetic
 * below takes them rather than either noun — which is how there comes to be one
 * clock and not two that agree for now.
 */
interface Clocked {
  /** Seconds the container may sit unused for, or the word `never`. */
  ttl: string;
  /** Whether the container is already stopped, however that was read. */
  stopped: boolean;
  startedAt: Date | undefined;
  lastActive: Date | undefined;
  keptAlive: boolean;
}

/**
 * The most recent thing that counts as use: the later of starting and being
 * asked for. Undefined only when docker could not say when it started.
 */
function activeSince(candidate: Pick<Clocked, "startedAt" | "lastActive">): Date | undefined {
  if (candidate.startedAt === undefined) return undefined;
  if (candidate.lastActive === undefined) return candidate.startedAt;
  return candidate.lastActive > candidate.startedAt ? candidate.lastActive : candidate.startedAt;
}

/**
 * When something runs out, or undefined when it has no deadline at all.
 *
 * Undefined covers three situations that mean the same thing to the planner: no
 * ttl, an unreadable ttl, and a container docker could not give a start time
 * for.
 */
function deadlineFrom(ttlRaw: string, candidate: Pick<Clocked, "startedAt" | "lastActive">): Date | undefined {
  const ttl = parseTtl(ttlRaw);
  if (ttl === undefined || ttl === "never") return undefined;
  const since = activeSince(candidate);
  if (since === undefined) return undefined;
  return new Date(since.getTime() + ttl * 1000);
}

/** When this sandbox runs out, or undefined when it has no deadline at all. */
export function deadlineOf(candidate: ExpiryCandidate): Date | undefined {
  return deadlineFrom(candidate.sandbox.ttl, candidate);
}

/** When this session's workstation runs out, on the same arithmetic (§12.7). */
export function sessionDeadlineOf(candidate: SessionExpiryCandidate): Date | undefined {
  return deadlineFrom(candidate.session.ttl, candidate);
}

/** Stop it, or keep it — and in either case the sentence somebody will read. */
interface Verdict {
  stop: boolean;
  reason: string;
}

/**
 * The whole of the decision, for a sandbox and for a workstation alike.
 *
 * Every branch here was argued for a sandbox and none of them changes for a
 * workstation, so "sandbox" in these comments means "the container this
 * candidate names".
 */
function decide(candidate: Clocked, now: Date): Verdict {
  // Stopping a stopped sandbox is not harmless: it would appear in every
  // pass's plan for ever, so a report of what the reaper did could no longer
  // be read as a list of things that changed.
  if (candidate.stopped) return { stop: false, reason: "already stopped" };

  const ttl = parseTtl(candidate.ttl);
  if (ttl === undefined || ttl === "never") return { stop: false, reason: "no expiry set" };

  // Checked after the ttl so a keep-alive on a sandbox that was never going
  // to expire does not report a reason implying the keep-alive is what saved
  // it.
  if (candidate.keptAlive) return { stop: false, reason: "kept alive" };

  // Failing closed. Docker not answering is a fact about docker, not about
  // the sandbox, and the failure mode of guessing wrong here is killing a
  // sandbox somebody is using. A sandbox that outlives its ttl because one
  // inspect failed costs nobody anything.
  if (candidate.startedAt === undefined) return { stop: false, reason: "no start time from docker, so not expired" };

  // Never negative. A clock that has gone backwards between the container
  // starting and this pass would otherwise produce a negative idle time,
  // which `describe` renders as nonsense in the one string somebody reads to
  // find out why their sandbox went away.
  const since = activeSince(candidate) ?? candidate.startedAt;
  const idle = Math.max(0, Math.floor((now.getTime() - since.getTime()) / 1000));
  if (idle >= ttl) return { stop: true, reason: `idle ${describe(idle)}, past its ${formatTtl(ttl)} limit` };

  return { stop: false, reason: `${describe(ttl - idle)} left, idle ${describe(idle)}` };
}

export function planExpiry(input: ExpiryInput): ExpiryPlan {
  const stop: ExpiryPlan["stop"] = [];
  const keep: ExpiryPlan["keep"] = [];

  for (const candidate of input.candidates) {
    const { sandbox } = candidate;
    const verdict = decide({ ...candidate, ttl: sandbox.ttl, stopped: sandbox.state === "stopped" }, input.now);
    (verdict.stop ? stop : keep).push({ sandbox, reason: verdict.reason });
  }

  return { stop, keep };
}

/**
 * The same plan, for the workstations of these sessions (contracts §12.7).
 *
 * **What `stop` means here is narrower than the word, and §12.8 is why.**
 * Stopping a workstation removes nothing at all — not the work volume, not
 * `state/session/<session>/`, not after any length of time. Code and data are
 * retained until an explicit delete, so a session that comes back three weeks
 * later comes back to its clones, its branches and its uncommitted changes.
 * Anything acting on this plan that removed something would be answering a
 * question this function was not asked.
 *
 * **A session's runtimes are not in it.** They are sandboxes with their own
 * clocks, read by `planExpiry` on their own evidence (§12.7): traffic to a
 * runtime's apps holds that runtime up, the agent working holds the workstation
 * up, and a session whose workstation has been stopped may still be serving a
 * preview somebody is reading. Coupling them would take that preview down the
 * moment the agent went quiet.
 */
export function planSessionExpiry(input: SessionExpiryInput): SessionExpiryPlan {
  const stop: SessionExpiryPlan["stop"] = [];
  const keep: SessionExpiryPlan["keep"] = [];

  for (const candidate of input.candidates) {
    const { session } = candidate;
    const verdict = decide({ ...candidate, ttl: session.ttl, stopped: session.state === "stopped" }, input.now);
    (verdict.stop ? stop : keep).push({ session, reason: verdict.reason });
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
