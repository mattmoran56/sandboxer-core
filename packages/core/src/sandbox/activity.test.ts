// Tests for reading last-activity out of the router's access log:
// - parseAccessLog against lines copied verbatim from a running sandboxr-router
// - parseAccessLog: the newest line per container wins, whatever order they arrive in
// - parseAccessLog: Traefik's own coloured startup chatter, blank lines and garbage are skipped
// - parseAccessLog: an unrouted request (`"-"`), the dashboard and the router itself are not sandboxes
// - parseAccessLog: the log's own UTC offset is honoured, not the host's
// - parseAccessLog: a request line containing a decoy `"…@docker"` does not become a container
// - parseAccessLog: a timestamp in the future is clamped to now rather than dropped
// - lastActivity: passes the window to `docker logs --since`
// - lastActivity: a router that is not running reads as an empty map, never as "nobody used anything"

import { describe, expect, it } from "vitest";

import type { Docker, ExecResult } from "../docker.js";
import { DEFAULT_ACTIVITY_WINDOW, lastActivity, parseAccessLog } from "./activity.js";

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

const line = (stamp: string, router: string): string =>
  `172.18.0.1 - - [${stamp}] "GET / HTTP/1.1" 200 1773 "-" "-" 1 "${router}" "http://172.18.0.3:80" 11ms`;

describe("parseAccessLog", () => {
  it("reads a real router log into one time per sandbox", () => {
    const seen = parseAccessLog(REAL_LOG, NOW);
    expect([...seen.keys()].sort()).toEqual(["sandboxr-demo-staging", "sandboxr-demo-tkt-4821"]);
    expect(seen.get("sandboxr-demo-tkt-4821")?.toISOString()).toBe("2026-08-26T14:14:13.000Z");
  });

  // The dashboard is polled by every open browser tab, so it is the busiest
  // router on the machine — and it is not a sandbox. Left in, it would be one
  // permanent entry nothing ever looks up.
  it("does not treat the dashboard or the router as sandboxes", () => {
    const seen = parseAccessLog(REAL_LOG, NOW);
    expect(seen.has("sandboxr-dashboard")).toBe(false);
    expect(seen.has("sandboxr-router")).toBe(false);
  });

  // A 404 on a hostname no sandbox claims. Traefik still logs it, with `-`
  // where the router name goes: a request, but not to anything.
  it("ignores a request nothing routed", () => {
    expect(parseAccessLog(line("26/Aug/2026:14:08:15 +0000", "-"), NOW).size).toBe(0);
  });

  it("keeps the newest line for a container, whatever order they arrive in", () => {
    const text = [
      line("26/Aug/2026:16:00:00 +0000", "sandboxr-acme-tkt-1@docker"),
      line("26/Aug/2026:09:00:00 +0000", "sandboxr-acme-tkt-1@docker"),
      line("26/Aug/2026:12:00:00 +0000", "sandboxr-acme-tkt-1@docker"),
    ].join("\n");
    expect(parseAccessLog(text, NOW).get("sandboxr-acme-tkt-1")?.toISOString()).toBe("2026-08-26T16:00:00.000Z");
  });

  // The offset in the line, not the host's. A router in a container is usually
  // on UTC while the host is not, and reading `+0100` as local time would shift
  // every timestamp by the host's offset — expiring sandboxes an hour early on
  // one machine and an hour late on another.
  it("honours the log line's own UTC offset", () => {
    const seen = parseAccessLog(line("26/Aug/2026:15:00:00 +0100", "sandboxr-acme-tkt-1@docker"), NOW);
    expect(seen.get("sandboxr-acme-tkt-1")?.toISOString()).toBe("2026-08-26T14:00:00.000Z");
  });

  // The request line is the one field an outsider writes. Matching the router
  // name backwards from the end of the line is what makes a crafted path unable
  // to invent a container — which would otherwise be a way to keep somebody
  // else's sandbox alive for ever from outside.
  it("is not fooled by a request path that looks like a router name", () => {
    const forged =
      '1.2.3.4 - - [26/Aug/2026:16:00:00 +0000] "GET /evil@docker" HTTP/1.1" 404 19 "-" "-" 9 "-" "-" 0ms';
    expect(parseAccessLog(forged, NOW).has("evil")).toBe(false);
  });

  it("skips blank lines, Traefik's own log lines and outright garbage", () => {
    const text = `\n\nnot a log line at all\n${REAL_LOG}`;
    expect(parseAccessLog(text, NOW).size).toBe(2);
  });

  // Clamped rather than dropped: of the two readings of a clock-skewed line,
  // only "this happened just now" cannot shorten a sandbox's life.
  it("clamps a timestamp from the future to now", () => {
    const seen = parseAccessLog(line("27/Aug/2026:09:00:00 +0000", "sandboxr-acme-tkt-1@docker"), NOW);
    expect(seen.get("sandboxr-acme-tkt-1")).toEqual(NOW);
  });

  it("reads an empty log as no activity rather than throwing", () => {
    expect(parseAccessLog("", NOW).size).toBe(0);
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
    const seen = await lastActivity({ docker: fakeDocker({ code: 0, stdout: REAL_LOG, stderr: "" }, calls), since: "13h", now: NOW });
    expect(calls).toEqual([{ name: "sandboxr-router", since: "13h" }]);
    expect(seen.size).toBe(2);
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
    expect(seen.size).toBe(0);
  });

  // Traefik writes the access log to stdout and its own lines to stderr, but
  // that split is its choice rather than a contract, so both are fed to a parse
  // that skips what it does not recognise.
  it("finds access lines whichever stream docker put them on", async () => {
    const seen = await lastActivity({
      docker: fakeDocker({ code: 0, stdout: "", stderr: REAL_LOG }),
      now: NOW,
    });
    expect(seen.size).toBe(2);
  });
});
