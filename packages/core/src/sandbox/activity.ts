/**
 * When each sandbox was last actually used.
 *
 * The expiry clock runs from the last time somebody used a sandbox, not from
 * how long it has been up, so something has to answer "was anyone here?". Three
 * candidate signals, and only one of them works:
 *
 * - **Container uptime** is what this used to measure. It says nothing about
 *   use: a sandbox nobody has opened for two days looks identical to one
 *   somebody is typing into.
 * - **The per-sandbox logs** under `~/.sandboxr/logs/<project>/<slug>/` are
 *   written every few seconds by the dashboard's own health probes — a `GET /`
 *   from `sandboxes/probe.ts`, which dials the container directly on the docker
 *   network. An idle timer keyed on their mtime would never fire.
 * - **The router's access log** is the one that is true. Traefik is configured
 *   with `accessLog: {}` (see `writeRouterConfig`) and writes one common-log
 *   line per request to its stdout, ending in the router's name — which for a
 *   sandbox *is* its container name. The probes never appear there, because
 *   they do not go through the router.
 *
 * So last-activity is **derived at read time** from `docker logs
 * sandboxr-router`, and nothing new is stored. That is the argument of
 * docs/architecture/state.md applied to a timer: the truth is already in a
 * place we have to read anyway, and a second copy of it would only be a thing
 * that can drift.
 *
 * The failure mode that matters is a missing or unreadable router log. It must
 * never read as "nobody has used any sandbox" — that would expire the whole
 * machine at once, which is the one outcome here that destroys work. Every
 * failure therefore returns an empty map, and an absent entry means "no
 * activity seen", which the planner falls back to the start time for.
 */

import { DASHBOARD_CONTAINER } from "../access/dashboard.js";
import { ROUTER_CONTAINER } from "../access/router.js";
import { docker as defaultDocker, type Docker } from "../docker.js";

/**
 * How far back to read when the caller does not say.
 *
 * A window rather than the whole log because the router can be up for weeks and
 * this runs on every dashboard render. A sandbox with no line inside the window
 * simply has no recorded activity, which is exactly what "idle for longer than
 * any ttl in play" means, so the window costs nothing as long as it is longer
 * than the longest lifetime being enforced.
 */
export const DEFAULT_ACTIVITY_WINDOW = "48h";

export interface ActivityOptions {
  docker?: Docker | undefined;
  /** How far back to read, in the form `docker logs --since` takes: `36h`. */
  since?: string | undefined;
  now?: Date | undefined;
}

/**
 * When each sandbox was last used, by container name.
 *
 * Containers with no request in the window are absent rather than present with
 * an old date: "not seen" and "seen long ago" are the same answer to the only
 * question the planner asks, and inventing a date for the first would be a
 * guess dressed as a fact.
 */
export async function lastActivity(options: ActivityOptions = {}): Promise<Map<string, Date>> {
  const dock = options.docker ?? defaultDocker;
  const result = await dock.logs(ROUTER_CONTAINER, { since: options.since ?? DEFAULT_ACTIVITY_WINDOW });
  // A router that is not running, or one docker will not talk about, is a fact
  // about the router. Reading it as "no sandbox has been used" would stop every
  // sandbox on the machine on the next pass.
  if (result.code !== 0) return new Map();
  // Traefik writes its own INF/WRN lines to stderr and the access log to
  // stdout, but both are read: the split is Traefik's choice, not a contract,
  // and a parse that skips anything it does not recognise costs nothing to feed.
  return parseAccessLog(`${result.stdout}\n${result.stderr}`, options.now ?? new Date());
}

const MONTHS: Record<string, number> = {
  jan: 0,
  feb: 1,
  mar: 2,
  apr: 3,
  may: 4,
  jun: 5,
  jul: 6,
  aug: 7,
  sep: 8,
  oct: 9,
  nov: 10,
  dec: 11,
};

/**
 * One Traefik common-log line, or nothing.
 *
 * Anchored at the end rather than counting fields from the front. The line is
 *
 *     IP - - [26/Aug/2026:14:14:13 +0000] "GET / HTTP/1.1" 200 1773 "-" "-" 35 "sandboxr-demo-tkt-4821@docker" "http://172.18.0.3:80" 11ms
 *
 * and the request line in the middle is attacker-controlled: a path could
 * contain quotes, brackets, or the word `@docker`. The last three fields are
 * not — they are the router name, the backend URL and the duration, written by
 * Traefik — so matching backwards from the end is the reading that cannot be
 * spoofed by a crafted request. The `.*` before it is greedy on purpose, so it
 * consumes any decoy and lands on the real field.
 */
const ACCESS_LINE =
  /\[(\d{2})\/([A-Za-z]{3})\/(\d{4}):(\d{2}):(\d{2}):(\d{2}) ([+-])(\d{2})(\d{2})\].*"([^"]*)"\s+"[^"]*"\s+[0-9.]+m?s\s*$/;

/** Container names that answer through the router but are not sandboxes. */
const NOT_A_SANDBOX = new Set([DASHBOARD_CONTAINER, ROUTER_CONTAINER]);

/**
 * Reads a router access log into "when was each container last asked for".
 *
 * Pure, and exported, so the format can be tested without a docker daemon —
 * and so the test can be checked against a line copied from a real router
 * rather than one invented to match the parser.
 *
 * Unparseable lines are skipped, never thrown on. The stream is a mix of access
 * lines and Traefik's own coloured startup chatter, and a log that had gained
 * one new kind of line must not take the expiry clock down with it.
 */
export function parseAccessLog(text: string, now: Date): Map<string, Date> {
  const seen = new Map<string, Date>();

  for (const line of text.split("\n")) {
    const match = ACCESS_LINE.exec(line.trim());
    if (!match) continue;

    const router = match[10] ?? "";
    // Traefik writes `-` when nothing matched the request — a 404 on a hostname
    // no sandbox claims. It is a request, but not to anything.
    if (!router.endsWith("@docker")) continue;
    const container = router.slice(0, -"@docker".length);
    if (container === "" || NOT_A_SANDBOX.has(container)) continue;

    const when = parseStamp(match);
    if (when === undefined) continue;

    // Clamped rather than dropped. A stamp in the future means the router's
    // clock and ours disagree, and of the two readings available — "this
    // happened just now" and "this line does not count" — only the first is
    // safe: the second shortens a sandbox's life on the strength of a clock
    // nobody here controls.
    const at = when > now ? now : when;

    const previous = seen.get(container);
    if (previous === undefined || at > previous) seen.set(container, at);
  }

  return seen;
}

/** The bracketed timestamp, built explicitly because `Date` cannot read it. */
function parseStamp(match: RegExpExecArray): Date | undefined {
  const month = MONTHS[(match[2] ?? "").toLowerCase()];
  if (month === undefined) return undefined;

  const utc = Date.UTC(
    Number(match[3]),
    month,
    Number(match[1]),
    Number(match[4]),
    Number(match[5]),
    Number(match[6]),
  );
  if (!Number.isFinite(utc)) return undefined;

  // The offset is the log's, not this machine's: a router in a container is
  // usually on UTC while the host is not, and reading `+0000` as local time
  // would shift every timestamp by the host's offset — silently expiring
  // sandboxes an hour early, or never.
  const offsetMinutes = (Number(match[8]) * 60 + Number(match[9])) * (match[7] === "-" ? -1 : 1);
  const when = new Date(utc - offsetMinutes * 60_000);
  return Number.isNaN(when.getTime()) ? undefined : when;
}
