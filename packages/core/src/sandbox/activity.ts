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
 *
 * ## The three kinds of use a request to an app does not cover
 *
 * Traffic to a sandbox's own hostnames is only one of the ways somebody uses
 * one, and it is not the way that bites. Three more signals are read here. Two
 * follow the same rule as the first — derived at read time from something that
 * is written anyway, never a timestamp of our own — and the third is the one
 * place that rule genuinely cannot hold, which is argued out in ./attach.ts
 * rather than here.
 *
 * **A running agent.** Somebody opens a worktree, sets Claude Code going and
 * walks away. Nothing goes through the router for an hour, the sandbox looks
 * idle, and the reaper stops it mid-run — the one failure that loses work
 * nobody can get back. The truthful signal is the run's own **transcript**:
 * contracts §7.2 says every line Claude Code emits is appended to
 * `$SANDBOXR_HOME/agent/log/<sessionId>.jsonl` *before* it is interpreted, so
 * that file's mtime is the last moment the agent produced anything, maintained
 * by the filesystem for free and visible to the CLI as well as to the server.
 * `runs.json` joins a session to its `project/slug`.
 *
 * A run the index calls live (`running`, `idle`, `needs-input`) counts as
 * activity *now*, so the sandbox cannot expire under it; a run that has ended
 * counts at `endedAt`, so **the countdown starts from when the agent stopped**
 * rather than from when it started.
 *
 * The index is believed only so far. `agent-sessions.ts` owns a `docker exec`
 * that dies with the server, and a dashboard killed mid-run leaves rows saying
 * `running` for ever. A rule that took those at face value would produce
 * sandboxes nothing on the machine will ever reap, so a live row holds a
 * sandbox open only while the transcript it names has been written to inside
 * `AGENT_LIVE_GRACE_MS`. Past that the run is credited with what it actually
 * did — its last transcript line — and nothing more.
 *
 * **Dashboard interaction.** Opening a worktree, opening its terminal, driving
 * its agent: all of those are somebody using the sandbox, and none of them
 * reaches the sandbox's own hostname. They do reach the *dashboard*, which is
 * behind the same router — so they are already in the log being read, under
 * `sandboxr-dashboard@docker`, with the sandbox named in the request path
 * (§7.1: every route that names one is `…/p/<project>/[sw]/<slug>/…`). One
 * extra read of a string we already have, and no route has to remember to call
 * anything.
 *
 * Two things about that are deliberate. The health probes still never appear,
 * because they dial containers directly on the docker network rather than
 * through the router — which is the whole reason they were rejected above, and
 * would stop being true the day somebody "tidied" the probe into using a
 * hostname. And the request path is the one field an outsider writes, so a
 * crafted path could name somebody else's sandbox: the harm that does is
 * keeping a sandbox alive, which is the direction this file already errs in
 * everywhere else, and only paths that name a sandbox the caller already has
 * are looked up at all.
 *
 * **A socket held open.** The paragraph above is true of *opening* a terminal
 * and false of *keeping* one open, and the difference is a property of the log
 * rather than of the route. Traefik writes a request's access line when the
 * request finishes, and the timestamp on that line is when the request
 * **started** — so a websocket held open for six hours contributes nothing for
 * six hours and then contributes a line dated six hours ago. Opening registers,
 * because the view fetches `/api/p/:project/s/:slug` first; a session held open
 * longer than the ttl with no other interaction did not, and the sandbox was
 * reaped out from under a live connection.
 *
 * That one cannot be derived: the only process that knows a socket is open is
 * the dashboard holding it, and `sandboxr expire` runs somewhere else. So the
 * dashboard re-stamps `state/attach/<project>/<slug>` while it holds one, and
 * ./attach.ts is where the whole argument for writing anything at all lives.
 * What is read here is only the mtime, on the same terms as a live agent run: a
 * heartbeat inside `ATTACH_LIVE_GRACE_MS` reads as activity *now*, and an older
 * one reads as activity *then* — which is the last moment a socket is known to
 * have been held, and is exactly where the countdown should start.
 */

import { readFile, stat } from "node:fs/promises";

import { DASHBOARD_CONTAINER } from "../access/dashboard.js";
import { ROUTER_CONTAINER } from "../access/router.js";
import { agentPaths } from "../agent/store.js";
import type { AgentRun, RunState } from "../agent/types.js";
import { docker as defaultDocker, type Docker } from "../docker.js";
import { paths } from "../paths.js";
import { attachFileFor } from "./attach.js";
import { parseTtl } from "./expiry.js";
import type { Sandbox } from "./types.js";

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

/**
 * Run states in which a session is still somebody's business.
 *
 * `needs-input` is on the list and is the one worth explaining: a run blocked on
 * a permission question is not making progress, but it is a question waiting for
 * a person, and stopping the container out from under it destroys the answer
 * they were coming back to give.
 */
export const AGENT_LIVE_STATES: ReadonlySet<RunState> = new Set<RunState>(["running", "idle", "needs-input"]);

/**
 * How long a live-looking run is believed without fresh evidence.
 *
 * Longer than any single quiet stretch inside a working turn — a build or a test
 * suite between one tool call and its result — and far shorter than any ttl
 * worth setting, so a `running` row left behind by a killed dashboard stops
 * pinning its sandbox within the quarter hour rather than for ever.
 */
export const AGENT_LIVE_GRACE_MS = 15 * 60_000;

/**
 * How long a held-open socket is believed after its last heartbeat.
 *
 * Deliberately `AGENT_LIVE_GRACE_MS` itself and not a second number beside it.
 * Both answer one question — how long a claim of liveness is believed without
 * fresh evidence — and two constants meaning one thing are two things to tune
 * and one of them to forget. It bounds the same failure too: a dashboard killed
 * while somebody had a terminal open leaves the last heartbeat behind, and past
 * this window the sandbox is credited with the moment that heartbeat was
 * written and nothing more, rather than becoming immortal.
 */
export const ATTACH_LIVE_GRACE_MS = AGENT_LIVE_GRACE_MS;

export interface ActivityOptions {
  docker?: Docker | undefined;
  /** How far back to read, in the form `docker logs --since` takes: `36h`. */
  since?: string | undefined;
  now?: Date | undefined;
}

/**
 * What the router's log says was used, split by *what the line is evidence of*.
 *
 * Two maps rather than one because they are keyed differently and cannot be
 * merged without a list of sandboxes to join them on: a request to a sandbox's
 * own hostname names a container, and a request to the dashboard names a
 * `project/slug`. `sandboxActivity` is where the join happens.
 */
export interface RouterActivity {
  /** By container name: requests that reached a sandbox's own hostnames. */
  containers: Map<string, Date>;
  /** By `<project>/<slug>`: dashboard routes that name a sandbox. */
  sandboxes: Map<string, Date>;
}

/**
 * What the router has seen, by container and by sandbox.
 *
 * Containers with no request in the window are absent rather than present with
 * an old date: "not seen" and "seen long ago" are the same answer to the only
 * question the planner asks, and inventing a date for the first would be a
 * guess dressed as a fact.
 */
export async function lastActivity(options: ActivityOptions = {}): Promise<RouterActivity> {
  const dock = options.docker ?? defaultDocker;
  const result = await dock.logs(ROUTER_CONTAINER, { since: options.since ?? DEFAULT_ACTIVITY_WINDOW });
  // A router that is not running, or one docker will not talk about, is a fact
  // about the router. Reading it as "no sandbox has been used" would stop every
  // sandbox on the machine on the next pass.
  if (result.code !== 0) return { containers: new Map(), sandboxes: new Map() };
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

/**
 * The request field, read separately and only for the dashboard's own lines.
 *
 * Separate rather than another group on `ACCESS_LINE`, so that a line whose
 * request field cannot be read still yields its container. Folding it in would
 * let one crafted path take a whole line's worth of genuine activity down with
 * it — which is the failure direction this file spends every other comment
 * avoiding.
 */
const REQUEST_FIELD = /\]\s+"([^"]*)"/;

/**
 * A dashboard route that names one sandbox (§7.1).
 *
 * `s` and `w` are one view — the sandbox is something that comes and goes on
 * top of the worktree — and both the JSON routes and the HTML shell use the same
 * shape, so one pattern covers the sandbox page, its actions, its logs, its
 * terminal socket and its agent socket without listing them.
 *
 * The character class is deliberately narrow. A project is a workspace directory
 * and a slug is `[a-z0-9-]` by §3.1, so anything percent-encoded, dotted or
 * otherwise clever is not a name either of them can have, and skipping it is
 * both safe and correct.
 */
const DASHBOARD_ROUTE = /(?:^|\/)p\/([A-Za-z0-9][A-Za-z0-9_-]*)\/[sw]\/([A-Za-z0-9][A-Za-z0-9_-]*)(?:[/?#]|$)/;

/** Container names that answer through the router but are not sandboxes. */
const NOT_A_SANDBOX = new Set([DASHBOARD_CONTAINER, ROUTER_CONTAINER]);

/** Keeps the newest time per key, clamping a stamp from the future to now. */
function note(into: Map<string, Date>, key: string, when: Date | undefined, now: Date): void {
  if (when === undefined) return;
  // Clamped rather than dropped. A stamp in the future means some other clock
  // and ours disagree, and of the two readings available — "this happened just
  // now" and "this does not count" — only the first is safe: the second shortens
  // a sandbox's life on the strength of a clock nobody here controls.
  const at = when > now ? now : when;
  const previous = into.get(key);
  if (previous === undefined || at > previous) into.set(key, at);
}

/**
 * Reads a router access log into "when was each sandbox last asked for".
 *
 * Pure, and exported, so the format can be tested without a docker daemon —
 * and so the test can be checked against a line copied from a real router
 * rather than one invented to match the parser.
 *
 * Unparseable lines are skipped, never thrown on. The stream is a mix of access
 * lines and Traefik's own coloured startup chatter, and a log that had gained
 * one new kind of line must not take the expiry clock down with it.
 */
export function parseAccessLog(text: string, now: Date): RouterActivity {
  const containers = new Map<string, Date>();
  const sandboxes = new Map<string, Date>();

  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    const match = ACCESS_LINE.exec(trimmed);
    if (!match) continue;

    const router = match[10] ?? "";
    // Traefik writes `-` when nothing matched the request — a 404 on a hostname
    // no sandbox claims. It is a request, but not to anything.
    if (!router.endsWith("@docker")) continue;
    const container = router.slice(0, -"@docker".length);
    if (container === "") continue;

    const when = parseStamp(match);
    if (when === undefined) continue;

    // The dashboard is not a sandbox, but a request to it may be *about* one.
    if (container === DASHBOARD_CONTAINER) {
      const named = sandboxNamedBy(trimmed);
      if (named !== undefined) note(sandboxes, named, when, now);
      continue;
    }
    if (NOT_A_SANDBOX.has(container)) continue;

    note(containers, container, when, now);
  }

  return { containers, sandboxes };
}

/** The `<project>/<slug>` one dashboard request was about, if it was about one. */
function sandboxNamedBy(line: string): string | undefined {
  const request = REQUEST_FIELD.exec(line)?.[1];
  if (request === undefined) return undefined;
  // `GET /api/p/demo/s/tkt-4821 HTTP/1.1`. The target is the second word; a
  // request line that is not three words is not one this can read.
  const target = request.split(" ")[1];
  if (target === undefined) return undefined;
  const route = DASHBOARD_ROUTE.exec(target);
  return route ? `${route[1]}/${route[2]}` : undefined;
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

/** An ISO stamp from the agent index, or undefined for anything unreadable. */
function stampOf(raw: string | null | undefined): Date | undefined {
  if (typeof raw !== "string" || raw === "") return undefined;
  const at = new Date(raw);
  return Number.isNaN(at.getTime()) ? undefined : at;
}

/** When a file was last written, or undefined when it cannot be asked about. */
async function mtimeOf(file: string): Promise<Date | undefined> {
  try {
    const info = await stat(file);
    return Number.isNaN(info.mtime.getTime()) ? undefined : info.mtime;
  } catch {
    return undefined;
  }
}

export interface AgentActivityOptions {
  env?: NodeJS.ProcessEnv | undefined;
  now?: Date | undefined;
  /** `$SANDBOXR_HOME`, for a caller that already has it. Derived from `env` otherwise. */
  home?: string | undefined;
}

/**
 * When an agent last did something in each sandbox, by `<project>/<slug>`.
 *
 * See the note at the top of the file for why this is read from the transcripts
 * and the index rather than asked of the server: the server's session map is
 * true and in the wrong process — `sandboxr expire` on the command line would
 * see none of it — while the files are written by the run itself and are the
 * same answer to both readers.
 *
 * Every failure is an absence. An unreadable index, a row missing its fields, a
 * transcript that cannot be stat'd: each one drops that run's contribution and
 * nothing else's. "No agent activity seen" is a safe answer because the router
 * log and the container's start time are still underneath it; "nobody used
 * anything" is the answer that must never be produced, and no path here does.
 */
export async function agentActivity(options: AgentActivityOptions = {}): Promise<Map<string, Date>> {
  const now = options.now ?? new Date();
  const store = agentPaths(options.home ?? paths(options.env).home);

  let runs: AgentRun[];
  try {
    const parsed = JSON.parse(await readFile(store.indexFile, "utf8")) as { runs?: unknown };
    if (!parsed || !Array.isArray(parsed.runs)) return new Map();
    runs = parsed.runs as AgentRun[];
    // A missing index is the ordinary state of a machine nobody has run an agent
    // on. A corrupt one is a cache that can be rebuilt from the transcripts, and
    // neither is a reason to tell the reaper that every sandbox is idle.
  } catch {
    return new Map();
  }

  const seen = new Map<string, Date>();

  await Promise.all(
    runs.map(async (run) => {
      if (!run || typeof run.project !== "string" || typeof run.slug !== "string") return;
      if (run.project === "" || run.slug === "") return;
      const key = `${run.project}/${run.slug}`;

      // What the run did, whether or not it is still going. `endedAt` is the
      // moment the agent stopped, which is where the countdown is meant to
      // start from; `updatedAt` covers a row that never got one.
      note(seen, key, stampOf(run.endedAt) ?? stampOf(run.updatedAt), now);

      if (!AGENT_LIVE_STATES.has(run.state)) return;
      if (typeof run.sessionId !== "string" || run.sessionId === "") return;

      // Only live rows are stat'd. An ended run's `endedAt` already says when it
      // stopped, and one syscall per finished session on every dashboard render
      // would buy nothing — the index is append-only and outlives the sandboxes
      // it names.
      const wrote = await mtimeOf(store.logFile(run.sessionId));
      note(seen, key, wrote, now);
      // The row says live and the transcript agrees, so the sandbox is in use
      // right now and must not expire under it. Checked against the file rather
      // than taken on trust: see AGENT_LIVE_GRACE_MS.
      if (wrote !== undefined && now.getTime() - wrote.getTime() <= AGENT_LIVE_GRACE_MS) note(seen, key, now, now);
    }),
  );

  return seen;
}

export interface AttachedActivityOptions {
  env?: NodeJS.ProcessEnv | undefined;
  /** `$SANDBOXR_HOME`, for a caller that already has it. Derived from `env` otherwise. */
  home?: string | undefined;
  now?: Date | undefined;
}

/**
 * When a socket was last held open on each of these sandboxes.
 *
 * One `stat` per sandbox rather than a walk of `state/attach/`, so a directory
 * full of markers for worktrees nobody has cut costs nothing to have: the
 * question is only ever asked about sandboxes that already exist, and a marker
 * naming anything else is never opened.
 *
 * A heartbeat inside `ATTACH_LIVE_GRACE_MS` yields *now* — somebody is on the
 * other end of a connection and the sandbox must not go away under them. An
 * older one yields its own mtime, which is the last moment a socket is known to
 * have been held: the process holding it may have been killed, and crediting a
 * dead dashboard's last heartbeat with `now` for ever is how a machine fills up
 * with sandboxes nothing will reap.
 *
 * Every failure is an absence, one sandbox at a time. A marker that cannot be
 * stat'd — no such file, no such directory, a home on a disk that has gone away
 * — drops this signal for that sandbox and leaves the router log and the start
 * time underneath it.
 */
export async function attachedActivity(
  sandboxes: readonly Pick<Sandbox, "project" | "slug">[],
  options: AttachedActivityOptions = {},
): Promise<Map<string, Date>> {
  const now = options.now ?? new Date();
  const seen = new Map<string, Date>();

  await Promise.all(
    sandboxes.map(async (sandbox) => {
      if (sandbox.project === "" || sandbox.slug === "") return;
      const held = await mtimeOf(
        attachFileFor(sandbox.project, sandbox.slug, {
          env: options.env,
          home: options.home,
        }),
      );
      if (held === undefined) return;
      const key = `${sandbox.project}/${sandbox.slug}`;
      note(seen, key, held, now);
      if (now.getTime() - held.getTime() <= ATTACH_LIVE_GRACE_MS) note(seen, key, now, now);
    }),
  );

  return seen;
}

export interface SandboxActivityOptions {
  docker?: Docker | undefined;
  env?: NodeJS.ProcessEnv | undefined;
  now?: Date | undefined;
}

/**
 * When each of these sandboxes was last used, by container name.
 *
 * One read of the router log and one read of the agent index for the whole set,
 * because both are per-machine files and a page of a dozen cards asking
 * separately would run them a dozen times.
 *
 * The window is the longest lifetime in play plus an hour: a sandbox whose last
 * request predates its own ttl is idle by definition, so reading further back
 * could not change the answer, and the margin covers the gap between the log
 * line and this pass. A set with no readable lifetime at all skips both reads —
 * nothing in it can expire, so the answer would be thrown away.
 */
export async function sandboxActivity(
  sandboxes: readonly Sandbox[],
  options: SandboxActivityOptions = {},
): Promise<Map<string, Date>> {
  let longest = 0;
  for (const sandbox of sandboxes) {
    const ttl = parseTtl(sandbox.ttl);
    if (typeof ttl === "number" && ttl > longest) longest = ttl;
  }
  if (longest === 0) return new Map();

  const now = options.now ?? new Date();
  // Together rather than in sequence: they are a `docker logs` and a file read,
  // both on the path of every dashboard render, and neither needs the other.
  const [router, agents, attached] = await Promise.all([
    lastActivity({ docker: options.docker, since: `${Math.ceil(longest / 3600) + 1}h`, now }),
    agentActivity({ env: options.env, now }),
    attachedActivity(sandboxes, { env: options.env, now }),
  ]);

  const seen = new Map<string, Date>(router.containers);
  for (const sandbox of sandboxes) {
    if (sandbox.container === "") continue;
    const key = `${sandbox.project}/${sandbox.slug}`;
    note(seen, sandbox.container, router.sandboxes.get(key), now);
    note(seen, sandbox.container, agents.get(key), now);
    note(seen, sandbox.container, attached.get(key), now);
  }
  return seen;
}
