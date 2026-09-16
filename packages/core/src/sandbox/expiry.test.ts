// Tests for the expiry plan:
// - parseTtl: plain seconds, `never`, 30m/12h/7d, whitespace and case; garbage, negative and zero are undefined
// - formatTtl: never, and the largest whole unit a duration divides into
// - deadlineOf: max(startedAt, lastActive) + ttl; undefined for never, for garbage and with no start time
// - planExpiry: a stopped sandbox is never stopped again
// - planExpiry: ttl `never` and an unreadable ttl are kept as "no expiry set"
// - planExpiry: a sandbox kept alive is kept, however long it has been idle
// - planExpiry: no start time from docker keeps the sandbox — failing closed
// - planExpiry: exactly at the limit stops; one second short does not
// - planExpiry: a request resets the clock, and one older than the start does not shorten it
// - planExpiry: the clock runs from startedAt, not created (the Restart regression)
// - planExpiry: reason strings name the limit and how long the sandbox has been idle
// - the spans in a reason string: two units, so most of an hour is not rounded away
// - sessionDeadlineOf: the same max(startedAt, lastActive) + ttl, off a session's ttl
// - planSessionExpiry: a stopped workstation, `never` and a keep marker are all kept
// - planSessionExpiry: an idle workstation is stopped, and one used a moment ago is not
// - planSessionExpiry: no lastActive at all runs the clock from startedAt, not from the epoch
// - planSessionExpiry: no start time from docker keeps the workstation — failing closed
// - planSessionExpiry: a session and a sandbox in the same state get the same verdict and wording

import { describe, expect, it } from "vitest";

import type { Session } from "../session/types.js";
import {
  deadlineOf,
  formatTtl,
  parseTtl,
  planExpiry,
  planSessionExpiry,
  sessionDeadlineOf,
  type ExpiryCandidate,
  type SessionExpiryCandidate,
} from "./expiry.js";
import type { Sandbox } from "./types.js";

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
    ttl: "8h",
    env: "",
    kind: "runtime",
    session: "",
    state: "running",
    container: "sandboxr-acme-tkt-1",
    ...overrides,
  };
}

function candidate(overrides: Partial<ExpiryCandidate> = {}): ExpiryCandidate {
  return {
    sandbox: sandbox(),
    startedAt: new Date("2026-08-25T09:00:00.000Z"),
    lastActive: undefined,
    keptAlive: false,
    ...overrides,
  };
}

describe("parseTtl", () => {
  it.each([
    ["plain seconds", "3600", 3600],
    ["minutes", "30m", 1800],
    ["hours", "8h", 28800],
    ["days", "7d", 604800],
    ["an explicit second suffix", "90s", 90],
    ["a fractional amount", "1.5h", 5400],
    ["surrounding whitespace", "  8h  ", 28800],
    ["upper case", "8H", 28800],
  ])("reads %s", (_name, raw, want) => {
    expect(parseTtl(raw)).toBe(want);
  });

  it("reads never as never", () => {
    expect(parseTtl("never")).toBe("never");
    expect(parseTtl("NEVER")).toBe("never");
  });

  // Anything unreadable has to fail closed. Coercing it to a number would make
  // a typo in a label a reason to stop somebody's sandbox.
  it.each([
    ["an empty string", ""],
    ["a word", "soon"],
    ["an unknown unit", "8w"],
    ["a unit with no amount", "h"],
    ["something with a stray sign", "8h!"],
    ["a negative duration", "-30m"],
    ["a bare negative number", "-1"],
    ["zero", "0"],
    ["zero with a unit", "0h"],
  ])("refuses %s", (_name, raw) => {
    expect(parseTtl(raw)).toBeUndefined();
  });

  it("never throws, whatever it is handed", () => {
    expect(() => parseTtl("💥")).not.toThrow();
    expect(parseTtl("💥")).toBeUndefined();
  });
});

describe("formatTtl", () => {
  it.each([
    ["never", "never" as const, "never"],
    ["whole days", 604800, "7d"],
    ["whole hours", 28800, "8h"],
    ["whole minutes", 1800, "30m"],
    ["anything else in seconds", 90, "90s"],
  ])("renders %s", (_name, seconds, want) => {
    expect(formatTtl(seconds)).toBe(want);
  });
});

describe("deadlineOf", () => {
  it("adds the ttl to the start time when nothing has used the sandbox", () => {
    const at = deadlineOf(candidate());
    expect(at?.toISOString()).toBe("2026-08-25T17:00:00.000Z");
  });

  it("adds the ttl to the last request instead, once there is one", () => {
    const at = deadlineOf(candidate({ lastActive: new Date("2026-08-25T14:00:00.000Z") }));
    expect(at?.toISOString()).toBe("2026-08-25T22:00:00.000Z");
  });

  // The start time is a floor, not a fallback. The router's log is only read
  // back so far, so a sandbox in constant use whose evidence has scrolled off
  // must not read as idle since the beginning of time.
  it("never moves the deadline earlier than the start time", () => {
    const at = deadlineOf(candidate({ lastActive: new Date("2026-08-24T09:00:00.000Z") }));
    expect(at?.toISOString()).toBe("2026-08-25T17:00:00.000Z");
  });

  it.each([
    ["the ttl is never", { sandbox: sandbox({ ttl: "never" }) }],
    ["the ttl is unreadable", { sandbox: sandbox({ ttl: "whenever" }) }],
    ["docker gave no start time", { startedAt: undefined }],
  ])("has no deadline when %s", (_name, overrides) => {
    expect(deadlineOf(candidate(overrides))).toBeUndefined();
  });
});

describe("planExpiry", () => {
  const now = new Date("2026-08-25T20:00:00.000Z");

  it("never stops a sandbox that is already stopped", () => {
    const plan = planExpiry({
      candidates: [candidate({ sandbox: sandbox({ state: "stopped" }) })],
      now,
    });
    expect(plan.stop).toEqual([]);
    expect(plan.keep[0]?.reason).toBe("already stopped");
  });

  it.each([
    ["never", "never"],
    ["unreadable", "sometime"],
    ["zero", "0"],
  ])("keeps a sandbox whose ttl is %s", (_name, ttl) => {
    const plan = planExpiry({ candidates: [candidate({ sandbox: sandbox({ ttl }) })], now });
    expect(plan.stop).toEqual([]);
    expect(plan.keep[0]?.reason).toBe("no expiry set");
  });

  it("keeps a sandbox somebody asked to keep alive, however long it has been idle", () => {
    const plan = planExpiry({ candidates: [candidate({ keptAlive: true })], now });
    expect(plan.stop).toEqual([]);
    expect(plan.keep[0]?.reason).toBe("kept alive");
  });

  // Failing closed: docker not answering is a fact about docker, and the cost
  // of guessing wrong is killing a sandbox somebody is using.
  it("keeps a sandbox docker could not give a start time for", () => {
    const plan = planExpiry({ candidates: [candidate({ startedAt: undefined })], now });
    expect(plan.stop).toEqual([]);
    expect(plan.keep[0]?.reason).toContain("no start time");
  });

  it("stops a sandbox exactly at its limit", () => {
    const plan = planExpiry({
      candidates: [candidate({ startedAt: new Date("2026-08-25T12:00:00.000Z") })],
      now: new Date("2026-08-25T20:00:00.000Z"),
    });
    expect(plan.stop).toHaveLength(1);
    expect(plan.keep).toEqual([]);
  });

  it("does not stop a sandbox one second short of its limit", () => {
    const plan = planExpiry({
      candidates: [candidate({ startedAt: new Date("2026-08-25T12:00:01.000Z") })],
      now: new Date("2026-08-25T20:00:00.000Z"),
    });
    expect(plan.stop).toEqual([]);
    expect(plan.keep).toHaveLength(1);
  });

  // The point of the whole change. Measured on uptime this sandbox has run for
  // eleven hours and would be stopped; measured on use, somebody was looking at
  // it ten minutes ago.
  it("keeps a long-running sandbox that somebody used a moment ago", () => {
    const plan = planExpiry({
      candidates: [
        candidate({
          startedAt: new Date("2026-08-25T09:00:00.000Z"),
          lastActive: new Date("2026-08-25T19:50:00.000Z"),
        }),
      ],
      now,
    });
    expect(plan.stop).toEqual([]);
    expect(plan.keep[0]?.reason).toBe("7h 50m left, idle 10m");
  });

  // The converse, and the reason a request is a *floor* rather than the whole
  // answer: a line older than the container's own start belongs to a previous
  // instance of the same sandbox, and honouring it would stop a sandbox that
  // has only just come back.
  it("ignores a request older than the container's current start", () => {
    const plan = planExpiry({
      candidates: [
        candidate({
          startedAt: new Date("2026-08-25T19:00:00.000Z"),
          lastActive: new Date("2026-08-25T10:00:00.000Z"),
        }),
      ],
      now,
    });
    expect(plan.stop).toEqual([]);
    expect(plan.keep[0]?.reason).toBe("7h left, idle 1h");
  });

  // The regression test for the Restart bug. The deadline is derived from the
  // container's current start time, not from `sandboxr.created` — which is
  // stamped once and never moves. Measured from `created` this sandbox is three
  // days past an 8h ttl, so the reaper would stop it, the developer would press
  // Restart, and the next pass would stop it again: the button would look
  // broken. Measured from startedAt it has 7h59m left, which is correct.
  it("keeps a sandbox created days ago but restarted a minute ago", () => {
    const plan = planExpiry({
      candidates: [
        candidate({
          sandbox: sandbox({ created: "2026-08-22T09:00:00.000Z", ttl: "8h" }),
          startedAt: new Date("2026-08-25T19:59:00.000Z"),
        }),
      ],
      now,
    });
    expect(plan.stop).toEqual([]);
    expect(plan.keep[0]?.reason).toBe("7h 59m left, idle 1m");
  });

  it("says how long a stopped sandbox sat unused and what its limit was", () => {
    const plan = planExpiry({
      candidates: [candidate({ startedAt: new Date("2026-08-25T09:00:00.000Z") })],
      now,
    });
    expect(plan.stop[0]?.reason).toBe("idle 11h, past its 8h limit");
  });

  it("says how long a surviving sandbox has left, and how long it has been idle", () => {
    const plan = planExpiry({
      candidates: [candidate({ startedAt: new Date("2026-08-25T18:00:00.000Z") })],
      now,
    });
    expect(plan.keep[0]?.reason).toBe("6h left, idle 2h");
  });

  it("sorts each sandbox into exactly one list", () => {
    const plan = planExpiry({
      candidates: [
        candidate({ sandbox: sandbox({ slug: "a" }), startedAt: new Date("2026-08-25T09:00:00.000Z") }),
        candidate({ sandbox: sandbox({ slug: "b" }), startedAt: new Date("2026-08-25T19:00:00.000Z") }),
        candidate({ sandbox: sandbox({ slug: "c", ttl: "never" }) }),
      ],
      now,
    });
    expect(plan.stop.map((entry) => entry.sandbox.slug)).toEqual(["a"]);
    expect(plan.keep.map((entry) => entry.sandbox.slug)).toEqual(["b", "c"]);
  });
});

describe("the spans in a reason", () => {
  const reasonFor = (ttl: string, idleSeconds: number): string => {
    const started = new Date("2026-08-26T00:00:00Z");
    const plan = planExpiry({
      now: new Date(started.getTime() + idleSeconds * 1000),
      candidates: [{ sandbox: sandbox({ ttl }), startedAt: started, lastActive: undefined, keptAlive: false }],
    });
    return (plan.keep[0] ?? plan.stop[0])?.reason ?? "";
  };

  // A sandbox with 1h59m left used to report "1h left", which reads as almost
  // out of time when it has almost all of its lifetime ahead of it.
  it("does not round most of an hour away", () => {
    expect(reasonFor("2h", 60)).toContain("1h 59m left");
  });

  it("drops the second unit when it is zero", () => {
    expect(reasonFor("2h", 0)).toContain("2h left");
  });

  it("reads in days and hours for a long one", () => {
    expect(reasonFor("7d", 3600)).toContain("6d 23h left");
  });

  it("says how long an expired one actually sat unused", () => {
    expect(reasonFor("2h", 3 * 3600 + 30 * 60)).toContain("idle 3h 30m");
  });
});

function session(overrides: Partial<Session> = {}): Session {
  return {
    id: "eng-3941",
    name: null,
    adopted: null,
    created: "2026-08-25T09:00:00.000Z",
    ttl: "8h",
    state: "running",
    runtimes: [],
    ...overrides,
  };
}

function sessionCandidate(overrides: Partial<SessionExpiryCandidate> = {}): SessionExpiryCandidate {
  return {
    session: session(),
    startedAt: new Date("2026-08-25T09:00:00.000Z"),
    lastActive: undefined,
    keptAlive: false,
    ...overrides,
  };
}

describe("sessionDeadlineOf", () => {
  it("is max(startedAt, lastActive) + ttl, off the session's own ttl", () => {
    expect(
      sessionDeadlineOf(
        sessionCandidate({
          startedAt: new Date("2026-08-25T09:00:00.000Z"),
          lastActive: new Date("2026-08-25T11:00:00.000Z"),
        }),
      ),
    ).toEqual(new Date("2026-08-25T19:00:00.000Z"));
  });

  it("has no deadline for `never`, for garbage, and with no start time", () => {
    expect(sessionDeadlineOf(sessionCandidate({ session: session({ ttl: "never" }) }))).toBeUndefined();
    expect(sessionDeadlineOf(sessionCandidate({ session: session({ ttl: "soon" }) }))).toBeUndefined();
    expect(sessionDeadlineOf(sessionCandidate({ startedAt: undefined }))).toBeUndefined();
  });
});

describe("planSessionExpiry", () => {
  const now = new Date("2026-08-25T20:00:00.000Z");

  it("never stops a workstation that is already stopped", () => {
    const plan = planSessionExpiry({
      candidates: [sessionCandidate({ session: session({ state: "stopped" }), startedAt: undefined })],
      now,
    });
    expect(plan.stop).toEqual([]);
    expect(plan.keep[0]?.reason).toBe("already stopped");
  });

  it("keeps a session whose ttl is `never` or unreadable", () => {
    const plan = planSessionExpiry({
      candidates: [
        sessionCandidate({ session: session({ id: "a", ttl: "never" }) }),
        sessionCandidate({ session: session({ id: "b", ttl: "whenever" }) }),
      ],
      now,
    });
    expect(plan.stop).toEqual([]);
    expect(plan.keep.map((entry) => entry.reason)).toEqual(["no expiry set", "no expiry set"]);
  });

  // The keep marker is the "keep it up forever" toggle and the only exemption
  // (§12.7). A live agent and a held socket reach this file as a `lastActive`,
  // never as a second exemption beside it.
  it("keeps a session that is kept alive, however long it has been idle", () => {
    const plan = planSessionExpiry({
      candidates: [sessionCandidate({ keptAlive: true, startedAt: new Date("2026-08-01T00:00:00.000Z") })],
      now,
    });
    expect(plan.stop).toEqual([]);
    expect(plan.keep[0]?.reason).toBe("kept alive");
  });

  it("stops one past its limit and keeps one that was used a moment ago", () => {
    const plan = planSessionExpiry({
      candidates: [
        sessionCandidate({ session: session({ id: "quiet" }), startedAt: new Date("2026-08-25T09:00:00.000Z") }),
        sessionCandidate({
          session: session({ id: "busy" }),
          startedAt: new Date("2026-08-25T09:00:00.000Z"),
          lastActive: new Date("2026-08-25T19:59:00.000Z"),
        }),
      ],
      now,
    });
    expect(plan.stop.map((entry) => entry.session.id)).toEqual(["quiet"]);
    expect(plan.stop[0]?.reason).toBe("idle 11h, past its 8h limit");
    expect(plan.keep.map((entry) => entry.session.id)).toEqual(["busy"]);
    expect(plan.keep[0]?.reason).toBe("7h 59m left, idle 1m");
  });

  // §12.7's missing signal. A workstation has no hostname, so the router's log
  // says nothing about one and `lastActive` is routinely undefined — which must
  // read as "run the clock from the start time", never as "idle since the epoch".
  // Read the other way this candidate would be 56 years past an 8h limit.
  it("runs the clock from startedAt when no signal reached it at all", () => {
    const plan = planSessionExpiry({
      candidates: [sessionCandidate({ startedAt: new Date("2026-08-25T19:00:00.000Z"), lastActive: undefined })],
      now,
    });
    expect(plan.stop).toEqual([]);
    expect(plan.keep[0]?.reason).toBe("7h left, idle 1h");
  });

  // Docker not answering is a fact about docker, not about the session, and the
  // cost of guessing wrong is stopping a workstation somebody is working in.
  it("keeps a workstation docker gave no start time for", () => {
    const plan = planSessionExpiry({
      candidates: [sessionCandidate({ startedAt: undefined, lastActive: new Date("2026-08-01T00:00:00.000Z") })],
      now,
    });
    expect(plan.stop).toEqual([]);
    expect(plan.keep[0]?.reason).toBe("no start time from docker, so not expired");
  });

  // One clock, not two that agree today (§12.7). Both planners reach `decide`,
  // so a sandbox and a session in the same state produce the same sentence — and
  // if one of them were ever re-implemented, this is the test that would fail.
  it("gives a session and a sandbox in the same state the same verdict and wording", () => {
    const started = new Date("2026-08-25T09:00:00.000Z");
    const used = new Date("2026-08-25T18:30:00.000Z");

    const sandboxPlan = planExpiry({
      candidates: [candidate({ sandbox: sandbox({ ttl: "8h" }), startedAt: started, lastActive: used })],
      now,
    });
    const sessionPlan = planSessionExpiry({
      candidates: [sessionCandidate({ session: session({ ttl: "8h" }), startedAt: started, lastActive: used })],
      now,
    });

    expect(sessionPlan.keep[0]?.reason).toBe(sandboxPlan.keep[0]?.reason);
    expect(sessionPlan.stop).toEqual([]);
  });
});
