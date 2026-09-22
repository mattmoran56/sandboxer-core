// Tests for the heartbeat that says a socket is being held open on a sandbox:
// - markAttached writes `state/attach/<project>/<slug>` and moves its mtime
// - markAttached on a home it cannot write into is silent, never an exception
// - attachFileFor honours an explicit home over the one in the environment
// - the heartbeat interval is far enough inside the grace window to miss several

import { mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { beforeEach, describe, expect, it } from "vitest";

import { ATTACH_LIVE_GRACE_MS } from "./activity.js";
import { ATTACH_HEARTBEAT_MS, attachFileFor, markAttached } from "./attach.js";

let home: string;

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), "sandboxer-attach-"));
});

describe("markAttached", () => {
  it("writes the marker where the paths contract says it goes", async () => {
    await markAttached("acme", "tkt-1", { home });

    const file = join(home, "state", "attach", "acme", "tkt-1");
    expect((await readFile(file, "utf8")).trim()).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  // The mtime is the signal, so re-stamping has to move it. The text inside is
  // for whoever is reading the directory by hand and nothing parses it.
  it("moves the mtime forward every time it is called", async () => {
    const file = attachFileFor("acme", "tkt-1", { home });
    await markAttached("acme", "tkt-1", { home });
    const first = (await stat(file)).mtimeMs;

    await new Promise((resolve) => setTimeout(resolve, 12));
    await markAttached("acme", "tkt-1", { home });

    expect((await stat(file)).mtimeMs).toBeGreaterThan(first);
  });

  // Failing to record a heartbeat drops one activity signal. Failing to open a
  // terminal because a disk is full loses somebody their shell, and the reaper
  // still has the router log and the start time underneath it.
  it("says nothing when the home cannot be written to", async () => {
    const blocker = join(home, "not-a-directory");
    await writeFile(blocker, "", "utf8");

    await expect(markAttached("acme", "tkt-1", { home: join(blocker, "inside") })).resolves.toBeUndefined();
  });
});

describe("attachFileFor", () => {
  it("prefers an explicit home to the one in the environment", () => {
    const file = attachFileFor("acme", "tkt-1", { env: { SANDBOXER_HOME: "/elsewhere" }, home });
    expect(file).toBe(join(home, "state", "attach", "acme", "tkt-1"));
  });

  it("falls back to the environment when no home is given", () => {
    const file = attachFileFor("acme", "tkt-1", { env: { SANDBOXER_HOME: "/elsewhere" } });
    expect(file).toBe(join("/elsewhere", "state", "attach", "acme", "tkt-1"));
  });
});

// The two constants are the whole safety margin: a heartbeat that could only be
// missed once would let a sandbox expire under somebody on a busy machine, and
// a grace window shorter than the interval would expire it every time.
it("leaves room for several missed heartbeats inside the grace window", () => {
  expect(ATTACH_HEARTBEAT_MS * 10).toBeLessThanOrEqual(ATTACH_LIVE_GRACE_MS);
});
