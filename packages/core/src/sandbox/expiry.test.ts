// Tests for the expiry plan:
// - parseTtl: plain seconds, `never`, 30m/8h/7d, whitespace and case; garbage, negative and zero are undefined
// - formatTtl: never, and the largest whole unit a duration divides into
// - deadlineOf: startedAt + ttl; undefined for never, for garbage and when docker gave no start time
// - planExpiry: a stopped sandbox is never stopped again
// - planExpiry: ttl `never` and an unreadable ttl are kept as "no expiry set"
// - planExpiry: a pinned sandbox is kept, however long it has run
// - planExpiry: no start time from docker keeps the sandbox — failing closed
// - planExpiry: exactly at the deadline stops; one second short does not
// - planExpiry: the deadline runs from startedAt, not created (the Restart regression)
// - planExpiry: reason strings name the ttl and how long the sandbox ran or has left
// - the spans in a reason string: two units, so most of an hour is not rounded away

import { describe, expect, it } from "vitest";

import { deadlineOf, formatTtl, parseTtl, planExpiry, type ExpiryCandidate } from "./expiry.js";
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
    state: "running",
    container: "sandboxr-acme-tkt-1",
    ...overrides,
  };
}

function candidate(overrides: Partial<ExpiryCandidate> = {}): ExpiryCandidate {
  return {
    sandbox: sandbox(),
    startedAt: new Date("2026-08-25T09:00:00.000Z"),
    pinned: false,
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
  it("adds the ttl to the start time", () => {
    const at = deadlineOf(candidate());
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

  it("keeps a pinned sandbox that is long past its ttl", () => {
    const plan = planExpiry({ candidates: [candidate({ pinned: true })], now });
    expect(plan.stop).toEqual([]);
    expect(plan.keep[0]?.reason).toBe("pinned");
  });

  // Failing closed: docker not answering is a fact about docker, and the cost
  // of guessing wrong is killing a sandbox somebody is using.
  it("keeps a sandbox docker could not give a start time for", () => {
    const plan = planExpiry({ candidates: [candidate({ startedAt: undefined })], now });
    expect(plan.stop).toEqual([]);
    expect(plan.keep[0]?.reason).toContain("no start time");
  });

  it("stops a sandbox exactly at its deadline", () => {
    const plan = planExpiry({
      candidates: [candidate({ startedAt: new Date("2026-08-25T12:00:00.000Z") })],
      now: new Date("2026-08-25T20:00:00.000Z"),
    });
    expect(plan.stop).toHaveLength(1);
    expect(plan.keep).toEqual([]);
  });

  it("does not stop a sandbox one second short of its deadline", () => {
    const plan = planExpiry({
      candidates: [candidate({ startedAt: new Date("2026-08-25T12:00:01.000Z") })],
      now: new Date("2026-08-25T20:00:00.000Z"),
    });
    expect(plan.stop).toEqual([]);
    expect(plan.keep).toHaveLength(1);
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
    expect(plan.keep[0]?.reason).toContain("8h ttl");
  });

  it("says how long a stopped sandbox ran and what its ttl was", () => {
    const plan = planExpiry({
      candidates: [candidate({ startedAt: new Date("2026-08-25T09:00:00.000Z") })],
      now,
    });
    expect(plan.stop[0]?.reason).toBe("ran for 11h, past its 8h ttl");
  });

  it("says how long a surviving sandbox has left", () => {
    const plan = planExpiry({
      candidates: [candidate({ startedAt: new Date("2026-08-25T18:00:00.000Z") })],
      now,
    });
    expect(plan.keep[0]?.reason).toBe("6h left of its 8h ttl");
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
  const reasonFor = (ttl: string, ranSeconds: number): string => {
    const started = new Date("2026-08-26T00:00:00Z");
    const plan = planExpiry({
      now: new Date(started.getTime() + ranSeconds * 1000),
      candidates: [{ sandbox: sandbox({ ttl }), startedAt: started, pinned: false }],
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

  it("says how long an expired one actually ran", () => {
    expect(reasonFor("2h", 3 * 3600 + 30 * 60)).toContain("ran for 3h 30m");
  });
});
