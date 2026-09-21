// Tests for reading last-activity out of the router's access log and the
// held-socket markers — the signals the engine reads for itself:
// - parseAccessLog against lines copied verbatim from a running sandboxr-router
// - parseAccessLog: the newest line per container wins, whatever order they arrive in
// - parseAccessLog: Traefik's own coloured startup chatter, blank lines and garbage are skipped
// - parseAccessLog: an unrouted request (`"-"`) and the router itself are not sandboxes
// - parseAccessLog: the log's own UTC offset is honoured, not the host's
// - parseAccessLog: a request line containing a decoy `"…@docker"` does not become a container
// - parseAccessLog: a timestamp in the future is clamped to now rather than dropped
// - parseAccessLog: a front end's route naming a sandbox counts, under `<project>/<slug>`
// - parseAccessLog: front-end routes that name no sandbox, or name an impossible one, count for nothing
// - parseAccessLog: an unreadable request field costs that line its route reading and nothing else
// - parseAccessLog: a container nobody named a front end is read as a sandbox, and its paths are not routes
// - parseAccessLog: every readable front-end request comes back in `requests`, for a caller with its own routes
// - lastActivity: passes the window to `docker logs --since`, and the front ends through
// - lastActivity: a router that is not running reads as empty, never as "nobody used anything"
// - attachedActivity: a fresh heartbeat holds its sandbox open — a socket or a run is live right now
// - attachedActivity: a heartbeat past the grace window counts when it was written, not now
// - attachedActivity: no marker, an empty home and a sandbox missing its names are all absences
// - attachedActivity: a heartbeat from the future is clamped to now
// - sandboxActivity: merges router traffic, front-end routes and a caller's `extra` onto one container key
// - sandboxActivity: a held-open socket outweighs the router line, which is stamped when it opened
// - sandboxActivity: a caller that passes no `extra` still sees the attach marker — the run's own heartbeat
// - sandboxActivity: a set with no readable ttl reads nothing at all
// - sandboxActivity: docker failing is an absence, never "nobody used anything"
//
// The agent index, the session join and the session's own routes are
// ../session/activity.test.ts's. They are what an embedder supplies, and the
// engine reads none of them.


import { mkdir, mkdtemp, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { beforeEach, describe, expect, it } from "vitest";

import type { Docker, ExecResult } from "../docker.js";
import {
  ATTACH_LIVE_GRACE_MS,
  DEFAULT_ACTIVITY_WINDOW,
  attachedActivity,
  lastActivity,
  parseAccessLog,
  sandboxActivity,
} from "./activity.js";
import { attachFileFor } from "./attach.js";
import type { Sandbox } from "./types.js";

const NOW = new Date("2026-08-26T18:00:00.000Z");

// Copied out of `docker logs sandboxr-router` on a machine running two
// sandboxes and the dashboard. Not reformatted: a recorded format is worth
// nothing if it is not the one the router really writes.
const REAL_LOG = `[90m2026-08-26T14:04:42Z[0m [32mINF[0m [1mStarting provider *docker.Provider[0m
172.18.0.1 - - [26/Aug/2026:14:08:15 +0000] "GET / HTTP/1.1" 404 19 "-" "-" 10 "-" "-" 0ms
172.18.0.1 - - [26/Aug/2026:14:14:13 +0000] "GET / HTTP/1.1" 200 1772 "-" "-" 34 "sandboxr-demo-staging@docker" "http://172.18.0.6:80" 26ms
172.18.0.1 - - [26/Aug/2026:14:14:13 +0000] "GET / HTTP/1.1" 200 1773 "-" "-" 35 "sandboxr-demo-tkt-4821@docker" "http://172.18.0.3:80" 11ms
[90m2026-08-26T14:14:43Z[0m [33mWRN[0m [1mA new release of Traefik has been found: 3.7.12. Please consider updating.[0m
172.18.0.1 - - [26/Aug/2026:14:32:39 +0000] "POST /p/acme/actions/fetch HTTP/1.1" 200 529 "-" "-" 75 "sandboxr-dashboard@docker" "http://172.18.0.5:8080" 310ms
`;

const line = (stamp: string, router: string, request = "GET / HTTP/1.1"): string =>
  `172.18.0.1 - - [${stamp}] "${request}" 200 1773 "-" "-" 1 "${router}" "http://172.18.0.3:80" 11ms`;

/**
 * The front ends on this machine, as `expire` resolves them with one
 * `listFrontends`. The engine is *told* which containers these are: it starts
 * none of them and has no name for one to compare against.
 */
const FRONTENDS = ["sandboxr-dashboard"];

const frontend = (stamp: string, request: string): string => line(stamp, "sandboxr-dashboard@docker", request);

describe("parseAccessLog", () => {
  it("reads a real router log into one time per sandbox", () => {
    const seen = parseAccessLog(REAL_LOG, NOW, FRONTENDS).containers;
    expect([...seen.keys()].sort()).toEqual(["sandboxr-demo-staging", "sandboxr-demo-tkt-4821"]);
    expect(seen.get("sandboxr-demo-tkt-4821")?.toISOString()).toBe("2026-08-26T14:14:13.000Z");
  });

  // A front end is polled by every open browser tab, so it is the busiest router
  // on the machine — and it is not a sandbox. Left among the containers it would
  // be one permanent entry nothing ever looks up.
  it("does not treat a front end or the router as containers", () => {
    const seen = parseAccessLog(REAL_LOG, NOW, FRONTENDS).containers;
    expect(seen.has("sandboxr-dashboard")).toBe(false);
    expect(seen.has("sandboxr-router")).toBe(false);
  });

  // A 404 on a hostname no sandbox claims. Traefik still logs it, with `-`
  // where the router name goes: a request, but not to anything.
  it("ignores a request nothing routed", () => {
    expect(parseAccessLog(line("26/Aug/2026:14:08:15 +0000", "-"), NOW, FRONTENDS).containers.size).toBe(0);
  });

  it("keeps the newest line for a container, whatever order they arrive in", () => {
    const text = [
      line("26/Aug/2026:16:00:00 +0000", "sandboxr-acme-tkt-1@docker"),
      line("26/Aug/2026:09:00:00 +0000", "sandboxr-acme-tkt-1@docker"),
      line("26/Aug/2026:12:00:00 +0000", "sandboxr-acme-tkt-1@docker"),
    ].join("\n");
    expect(parseAccessLog(text, NOW, FRONTENDS).containers.get("sandboxr-acme-tkt-1")?.toISOString()).toBe(
      "2026-08-26T16:00:00.000Z",
    );
  });

  // The offset in the line, not the host's. A router in a container is usually
  // on UTC while the host is not, and reading `+0100` as local time would shift
  // every timestamp by the host's offset — expiring sandboxes an hour early on
  // one machine and an hour late on another.
  it("honours the log line's own UTC offset", () => {
    const seen = parseAccessLog(line("26/Aug/2026:15:00:00 +0100", "sandboxr-acme-tkt-1@docker"), NOW, FRONTENDS);
    expect(seen.containers.get("sandboxr-acme-tkt-1")?.toISOString()).toBe("2026-08-26T14:00:00.000Z");
  });

  // The request line is the one field an outsider writes. Matching the router
  // name backwards from the end of the line is what makes a crafted path unable
  // to invent a container — which would otherwise be a way to keep somebody
  // else's sandbox alive for ever from outside.
  it("is not fooled by a request path that looks like a router name", () => {
    const forged =
      '1.2.3.4 - - [26/Aug/2026:16:00:00 +0000] "GET /evil@docker" HTTP/1.1" 404 19 "-" "-" 9 "-" "-" 0ms';
    expect(parseAccessLog(forged, NOW, FRONTENDS).containers.has("evil")).toBe(false);
  });

  it("skips blank lines, Traefik's own log lines and outright garbage", () => {
    const text = `\n\nnot a log line at all\n${REAL_LOG}`;
    expect(parseAccessLog(text, NOW, FRONTENDS).containers.size).toBe(2);
  });

  // Clamped rather than dropped: of the two readings of a clock-skewed line,
  // only "this happened just now" cannot shorten a sandbox's life.
  it("clamps a timestamp from the future to now", () => {
    const seen = parseAccessLog(line("27/Aug/2026:09:00:00 +0000", "sandboxr-acme-tkt-1@docker"), NOW, FRONTENDS);
    expect(seen.containers.get("sandboxr-acme-tkt-1")).toEqual(NOW);
  });

  it("reads an empty log as no activity rather than throwing", () => {
    const seen = parseAccessLog("", NOW, FRONTENDS);
    expect(seen.containers.size).toBe(0);
    expect(seen.sandboxes.size).toBe(0);
  });

  // The whole point of reading a front end's lines: opening a worktree, its
  // terminal or its agent never touches the sandbox's own hostname, so without
  // this a sandbox somebody is working in through a browser looks idle.
  it("counts a front end's route that names a sandbox", () => {
    const text = [
      frontend("26/Aug/2026:15:00:00 +0000", "GET /api/p/demo/s/tkt-4821 HTTP/1.1"),
      frontend("26/Aug/2026:16:00:00 +0000", "GET /p/acme/w/tkt-9 HTTP/1.1"),
      frontend("26/Aug/2026:16:30:00 +0000", "GET /p/acme/s/tkt-9/terminal HTTP/1.1"),
    ].join("\n");
    const seen = parseAccessLog(text, NOW, FRONTENDS).sandboxes;
    expect(seen.get("demo/tkt-4821")?.toISOString()).toBe("2026-08-26T15:00:00.000Z");
    // The `w` and `s` forms are one view, so the later of the two wins for the
    // one sandbox they both name.
    expect(seen.get("acme/tkt-9")?.toISOString()).toBe("2026-08-26T16:30:00.000Z");
  });

  it("counts nothing for a front-end route that names no sandbox", () => {
    const text = [
      frontend("26/Aug/2026:15:00:00 +0000", "GET /api/workspace HTTP/1.1"),
      frontend("26/Aug/2026:15:00:01 +0000", "GET /api/p/demo/env HTTP/1.1"),
      frontend("26/Aug/2026:15:00:02 +0000", "GET /assets/app.js HTTP/1.1"),
    ].join("\n");
    expect(parseAccessLog(text, NOW, FRONTENDS).sandboxes.size).toBe(0);
  });

  // A project is a workspace directory and a slug is `[a-z0-9-]` (§3.1), so a
  // path with a traversal or an encoding in it does not name either. Skipping
  // it is both safe and correct.
  it("counts nothing for a path that could not be a project and slug", () => {
    const text = [
      frontend("26/Aug/2026:15:00:00 +0000", "GET /api/p/../s/../etc HTTP/1.1"),
      frontend("26/Aug/2026:15:00:01 +0000", "GET /api/p/demo/s/%2e%2e HTTP/1.1"),
    ].join("\n");
    expect(parseAccessLog(text, NOW, FRONTENDS).sandboxes.size).toBe(0);
  });

  // The request field is read separately from the rest of the line on purpose:
  // a line whose request cannot be read still has to yield its container, or one
  // crafted path could take a whole line's worth of genuine activity with it.
  it("still reads a container from a line whose request field is unreadable", () => {
    const odd = '172.18.0.1 - - [26/Aug/2026:15:00:00 +0000] GET / 200 1 "-" "-" 1 "sandboxr-acme-tkt-1@docker" "http://172.18.0.3:80" 11ms';
    expect(parseAccessLog(odd, NOW, FRONTENDS).containers.has("sandboxr-acme-tkt-1")).toBe(true);
  });

  // Which containers are front ends is the caller's to say. Told nothing, the
  // engine reads every router name as a sandbox's own container — which is the
  // honest answer, because that is what every other name in this log is.
  it("reads a container nobody named a front end as a sandbox", () => {
    const text = frontend("26/Aug/2026:15:00:00 +0000", "GET /api/p/acme/s/tkt-1 HTTP/1.1");
    const seen = parseAccessLog(text, NOW, []);
    expect(seen.containers.has("sandboxr-dashboard")).toBe(true);
    expect(seen.sandboxes.size).toBe(0);
  });

  // The seam. A front end serves addresses for things the engine has no noun
  // for, so every readable front-end request comes back as it was read and a
  // caller applies its own patterns — which is how `…/sessions/<id>/…` is
  // counted without this file knowing what a session is.
  it("hands back every readable front-end request for a caller with its own routes", () => {
    const text = [
      frontend("26/Aug/2026:15:00:00 +0000", "GET /api/sessions/eng-3941 HTTP/1.1"),
      frontend("26/Aug/2026:16:00:00 +0000", "GET /api/p/acme/s/tkt-1 HTTP/1.1"),
      line("26/Aug/2026:16:30:00 +0000", "sandboxr-acme-tkt-1@docker", "GET /sessions/eng-3941 HTTP/1.1"),
    ].join("\n");
    const seen = parseAccessLog(text, NOW, FRONTENDS);
    // The sandbox's own line is not a front end's, so its path — the one field
    // an outsider writes — never reaches a caller as a route.
    expect(seen.requests.map((request) => request.path)).toEqual([
      "/api/sessions/eng-3941",
      "/api/p/acme/s/tkt-1",
    ]);
    expect(seen.requests[0]?.container).toBe("sandboxr-dashboard");
    expect(seen.requests[0]?.at.toISOString()).toBe("2026-08-26T15:00:00.000Z");
  });
});

function fakeDocker(result: ExecResult, calls: Array<{ name: string; since?: string }> = []): Docker {
  // Typed against `Docker["logs"]` rather than left to inference: the cast below
  // only applies to the finished object, so the parameters of a bare arrow
  // inside it get no contextual type at all — `name` lands as `any` and
  // `options` as `{}`, which is how a fake drifts from the interface it stands
  // in for without anything saying so.
  const logs: Docker["logs"] = async (name, options = {}) => {
    calls.push({ name, ...(options.since === undefined ? {} : { since: options.since }) });
    return result;
  };
  return { logs } as unknown as Docker;
}

describe("lastActivity", () => {
  it("reads the router's log through the window it was given", async () => {
    const calls: Array<{ name: string; since?: string }> = [];
    const seen = await lastActivity({
      docker: fakeDocker({ code: 0, stdout: REAL_LOG, stderr: "" }, calls),
      since: "13h",
      frontends: FRONTENDS,
      now: NOW,
    });
    expect(calls).toEqual([{ name: "sandboxr-router", since: "13h" }]);
    expect(seen.containers.size).toBe(2);
  });

  // The front ends go through to the parse, or a front end's own lines read as
  // traffic to a sandbox of that name and its request paths are never read at
  // all — which is the only record of somebody opening a sandbox in a browser.
  it("passes the front ends through to the parse", async () => {
    const seen = await lastActivity({
      docker: fakeDocker({ code: 0, stdout: REAL_LOG, stderr: "" }),
      frontends: FRONTENDS,
      now: NOW,
    });
    expect(seen.containers.has("sandboxr-dashboard")).toBe(false);
    expect(seen.sandboxes.get("acme/fetch")).toBeUndefined();
    expect(seen.requests.map((request) => request.path)).toEqual(["/p/acme/actions/fetch"]);
  });

  it("uses the default window when none is given", async () => {
    const calls: Array<{ name: string; since?: string }> = [];
    await lastActivity({ docker: fakeDocker({ code: 0, stdout: "", stderr: "" }, calls), now: NOW });
    expect(calls[0]?.since).toBe(DEFAULT_ACTIVITY_WINDOW);
  });

  // The failure that must never look like an answer. A router that is not
  // running is a fact about the router; read as "no sandbox has been used" it
  // would stop every sandbox on the machine on the next pass.
  it("reads a missing router as no information, not as no activity", async () => {
    const seen = await lastActivity({
      docker: fakeDocker({ code: 1, stdout: "", stderr: "Error: No such container: sandboxr-router" }),
      now: NOW,
    });
    expect(seen.containers.size).toBe(0);
    expect(seen.sandboxes.size).toBe(0);
  });

  // Traefik writes the access log to stdout and its own lines to stderr, but
  // that split is its choice rather than a contract, so both are fed to a parse
  // that skips what it does not recognise.
  it("finds access lines whichever stream docker put them on", async () => {
    const seen = await lastActivity({
      docker: fakeDocker({ code: 0, stdout: "", stderr: REAL_LOG }),
      frontends: FRONTENDS,
      now: NOW,
    });
    expect(seen.containers.size).toBe(2);
  });
});

/* --- the held-socket signal ---------------------------------------------- */

let env: NodeJS.ProcessEnv;
let home: string;

// SANDBOXR_HOME is passed as an environment rather than set on the process, per
// the note on `paths()`: the whole tree moves to a temporary directory without
// the test having to mutate anything global.
beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), "sandboxr-activity-"));
  env = { SANDBOXR_HOME: home };
});

/** A heartbeat for one sandbox, with its mtime set to when it was last written. */
async function writeAttach(project: string, slug: string, at: Date): Promise<void> {
  const file = attachFileFor(project, slug, { home });
  await mkdir(join(home, "state", "attach", project), { recursive: true });
  await writeFile(file, `${at.toISOString()}\n`, "utf8");
  await utimes(file, at, at);
}

describe("attachedActivity", () => {
  // The failure this signal exists for. Traefik logs a websocket only when it
  // closes and stamps the line with when it *opened*, so a terminal held open
  // for longer than the ttl left no evidence of use at all and the reaper
  // stopped the container under a live connection.
  it("holds a sandbox open while a socket or a run is being held on it", async () => {
    await writeAttach("acme", "tkt-1", new Date(NOW.getTime() - 60_000));

    const seen = await attachedActivity([{ project: "acme", slug: "tkt-1" }], { home, now: NOW });
    expect(seen.get("acme/tkt-1")).toEqual(NOW);
  });

  // The bound on it: a dashboard killed
  // while somebody had a terminal open leaves a marker nothing will ever move
  // again, and crediting that with `now` for ever produces a sandbox nothing on
  // the machine will reap.
  it("credits a heartbeat past the grace window with when it was written", async () => {
    const stale = new Date(NOW.getTime() - ATTACH_LIVE_GRACE_MS - 60_000);
    await writeAttach("acme", "tkt-1", stale);

    const seen = await attachedActivity([{ project: "acme", slug: "tkt-1" }], { home, now: NOW });
    expect(seen.get("acme/tkt-1")?.toISOString()).toBe(stale.toISOString());
  });

  it("reads a sandbox nobody has ever attached to as an absence", async () => {
    const seen = await attachedActivity([{ project: "acme", slug: "tkt-1" }], { home, now: NOW });
    expect(seen.size).toBe(0);
  });

  // A home that is not there at all is the ordinary state of a machine whose
  // dashboard has never run. It must read as "no socket seen", never as an
  // answer about whether anybody is using anything.
  it("reads a home that does not exist as an absence", async () => {
    const seen = await attachedActivity([{ project: "acme", slug: "tkt-1" }], {
      home: join(home, "gone"),
      now: NOW,
    });
    expect(seen.size).toBe(0);
  });

  it("skips a sandbox missing its project or slug", async () => {
    const seen = await attachedActivity([{ project: "", slug: "tkt-1" }, { project: "acme", slug: "" }], {
      home,
      now: NOW,
    });
    expect(seen.size).toBe(0);
  });

  it("clamps a heartbeat from the future to now", async () => {
    await writeAttach("acme", "tkt-1", new Date(NOW.getTime() + 3_600_000));

    const seen = await attachedActivity([{ project: "acme", slug: "tkt-1" }], { home, now: NOW });
    expect(seen.get("acme/tkt-1")).toEqual(NOW);
  });

  it("reads the home out of the environment when it is not handed one", async () => {
    await writeAttach("acme", "tkt-1", new Date(NOW.getTime() - 60_000));

    const seen = await attachedActivity([{ project: "acme", slug: "tkt-1" }], { env, now: NOW });
    expect(seen.get("acme/tkt-1")).toEqual(NOW);
  });
});

/* --- the merge ----------------------------------------------------------- */

function sandbox(overrides: Partial<Sandbox> = {}): Sandbox {
  return {
    project: "acme",
    slug: "tkt-1",
    branch: "feat/thing",
    commit: "abc1234",
    dirty: false,
    worktree: "/repos/tkt-1",
    driver: "mysql",
    access: "public",
    created: "2026-08-25T09:00:00.000Z",
    ttl: "12h",
    env: "",
    state: "running",
    container: "sandboxr-acme-tkt-1",
    ...overrides,
  } as Sandbox;
}

describe("sandboxActivity", () => {
  it("merges router traffic, front-end routes and a caller's extra onto the container key", async () => {
    const text = [
      line("26/Aug/2026:10:00:00 +0000", "sandboxr-acme-tkt-1@docker"),
      frontend("26/Aug/2026:15:00:00 +0000", "GET /api/p/acme/s/tkt-1 HTTP/1.1"),
    ].join("\n");

    const seen = await sandboxActivity([sandbox()], {
      docker: fakeDocker({ code: 0, stdout: text, stderr: "" }),
      frontends: FRONTENDS,
      extra: [new Map([["acme/tkt-1", new Date("2026-08-26T12:00:00.000Z")]])],
      env,
      now: NOW,
    });
    // The front-end line is the newest of the three, so it is the answer — which
    // is the point: opening a worktree resets the clock.
    expect(seen.get("sandboxr-acme-tkt-1")?.toISOString()).toBe("2026-08-26T15:00:00.000Z");
  });

  // What the embedder's half of the evidence buys. The engine cannot see a
  // running agent (contracts §3.4), so a caller that can hands the map in.
  it("lets a caller's extra win over older router traffic", async () => {
    const seen = await sandboxActivity([sandbox()], {
      docker: fakeDocker({ code: 0, stdout: line("26/Aug/2026:10:00:00 +0000", "sandboxr-acme-tkt-1@docker"), stderr: "" }),
      extra: [new Map([["acme/tkt-1", NOW]])],
      env,
      now: NOW,
    });
    expect(seen.get("sandboxr-acme-tkt-1")).toEqual(NOW);
  });

  // The hole `extra` leaves, and what closes it. `sandboxr expire` from a cron
  // job has nobody to hand it the agent map — so whoever holds a live run
  // re-stamps the attach marker, and the engine's own signal covers it. Removing
  // that heartbeat on the strength of `extra` existing re-opens this.
  it("still sees a live run through the attach marker when nothing passes extra", async () => {
    await writeAttach("acme", "tkt-1", new Date(NOW.getTime() - 30_000));

    const seen = await sandboxActivity([sandbox()], {
      docker: fakeDocker({ code: 0, stdout: line("26/Aug/2026:09:00:00 +0000", "sandboxr-acme-tkt-1@docker"), stderr: "" }),
      env,
      now: NOW,
    });
    expect(seen.get("sandboxr-acme-tkt-1")).toEqual(NOW);
  });

  // The whole point of the fourth signal, at the level the reaper sees it. The
  // router's line for a websocket is written when it closes and dated when it
  // opened, so a session held open all day looks like traffic from this morning;
  // the heartbeat is what makes it read as somebody being there now.
  it("lets a held-open socket win over a router line stamped when it opened", async () => {
    await writeAttach("acme", "tkt-1", new Date(NOW.getTime() - 30_000));

    const seen = await sandboxActivity([sandbox()], {
      docker: fakeDocker({ code: 0, stdout: line("26/Aug/2026:09:00:00 +0000", "sandboxr-acme-tkt-1@docker"), stderr: "" }),
      env,
      now: NOW,
    });
    expect(seen.get("sandboxr-acme-tkt-1")).toEqual(NOW);
  });

  // The window is the longest lifetime in play plus an hour; a set with no
  // readable lifetime skips both reads, because nothing in it can expire.
  it("reads the window from the longest ttl in the set", async () => {
    const calls: Array<{ name: string; since?: string }> = [];
    await sandboxActivity([sandbox({ ttl: "12h" }), sandbox({ slug: "tkt-2", ttl: "3d" })], {
      docker: fakeDocker({ code: 0, stdout: "", stderr: "" }, calls),
      env,
      now: NOW,
    });
    expect(calls[0]?.since).toBe("73h");
  });

  it("reads nothing at all when no sandbox in the set can expire", async () => {
    const calls: Array<{ name: string; since?: string }> = [];
    const seen = await sandboxActivity([sandbox({ ttl: "never" }), sandbox({ slug: "tkt-2", ttl: "rubbish" })], {
      docker: fakeDocker({ code: 0, stdout: REAL_LOG, stderr: "" }, calls),
      env,
      now: NOW,
    });
    expect(calls).toEqual([]);
    expect(seen.size).toBe(0);
  });

  // The case that would expire the machine if it were ever read as "nobody used
  // anything". It has to be an empty map, and the planner then falls every
  // sandbox back to its own start time.
  it("reads docker failing as an absence", async () => {
    const seen = await sandboxActivity([sandbox()], {
      docker: fakeDocker({ code: 1, stdout: "", stderr: "Error: No such container: sandboxr-router" }),
      env,
      now: NOW,
    });
    expect(seen.size).toBe(0);
  });
});
