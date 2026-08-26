// Tests for the pin marker:
// - writePin then readPin: the stamp comes back, and the pins directory is created on the way
// - readPin: a sandbox that was never pinned, and a project with no pins directory at all, read as undefined
// - isPinned: true only when the stamp matches the live sandbox's created label
// - isPinned: a pin left by a previous sandbox of the same project/slug reports NOT pinned (the resurrection case)
// - isPinned: a sandbox with no created label can never match a pin
// - removePin: unpins, and removing a pin that is not there does not throw

import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { beforeEach, describe, expect, it } from "vitest";

import { paths } from "../paths.js";
import { isPinned, readPin, removePin, writePin } from "./pins.js";
import type { Sandbox } from "./types.js";

const CREATED = "2026-08-25T09:00:00.000Z";

let env: NodeJS.ProcessEnv;

// SANDBOXR_HOME is passed as an environment rather than set on the process, per
// the note on `paths()`: the whole tree moves to a temporary directory without
// the test having to mutate anything global.
beforeEach(async () => {
  env = { SANDBOXR_HOME: await mkdtemp(join(tmpdir(), "sandboxr-pins-")) };
});

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
    created: CREATED,
    ttl: "8h",
    state: "running",
    container: "sandboxr-acme-tkt-1",
    ...overrides,
  };
}

describe("writePin", () => {
  it("writes the stamp, creating the pins directory", async () => {
    await writePin("acme", "tkt-1", CREATED, env);
    expect((await readFile(paths(env).pinFile("acme", "tkt-1"), "utf8")).trim()).toBe(CREATED);
  });

  it("replaces the stamp of an existing pin", async () => {
    await writePin("acme", "tkt-1", CREATED, env);
    await writePin("acme", "tkt-1", "2026-08-26T09:00:00.000Z", env);
    expect(await readPin("acme", "tkt-1", env)).toBe("2026-08-26T09:00:00.000Z");
  });
});

describe("readPin", () => {
  it("reads back what was written", async () => {
    await writePin("acme", "tkt-1", CREATED, env);
    expect(await readPin("acme", "tkt-1", env)).toBe(CREATED);
  });

  it("reads an unpinned sandbox as undefined", async () => {
    await writePin("acme", "tkt-1", CREATED, env);
    expect(await readPin("acme", "tkt-2", env)).toBeUndefined();
  });

  // The pins directory does not exist until something is pinned for the first
  // time, so a missing directory is just "not pinned", never an error.
  it("reads as undefined when nothing has ever been pinned", async () => {
    expect(await readPin("acme", "tkt-1", env)).toBeUndefined();
  });
});

describe("isPinned", () => {
  it("is true when the stamp matches the sandbox", async () => {
    await writePin("acme", "tkt-1", CREATED, env);
    expect(await isPinned(sandbox(), env)).toBe(true);
  });

  it("is false when there is no pin", async () => {
    expect(await isPinned(sandbox(), env)).toBe(false);
  });

  // The resurrection case. Slugs come from ticket ids and branch names, so the
  // same project/slug is recreated routinely — same ticket, second attempt. A
  // bare marker would outlive its sandbox and silently pin the successor, and
  // "this one never expires" looks nothing like its cause.
  it("is false when the pin was written for an earlier sandbox of the same name", async () => {
    await writePin("acme", "tkt-1", "2026-08-20T09:00:00.000Z", env);
    expect(await isPinned(sandbox({ created: CREATED }), env)).toBe(false);
  });

  it("is false for a sandbox with no created label, whatever the pin says", async () => {
    await writePin("acme", "tkt-1", "", env);
    expect(await isPinned(sandbox({ created: "" }), env)).toBe(false);
  });

  it("does not confuse two projects that share a slug", async () => {
    await writePin("acme", "tkt-1", CREATED, env);
    expect(await isPinned(sandbox({ project: "demo" }), env)).toBe(false);
  });
});

describe("removePin", () => {
  it("unpins the sandbox", async () => {
    await writePin("acme", "tkt-1", CREATED, env);
    await removePin("acme", "tkt-1", env);
    expect(await readPin("acme", "tkt-1", env)).toBeUndefined();
    expect(await isPinned(sandbox(), env)).toBe(false);
  });

  it("does not throw when there is no pin to remove", async () => {
    await expect(removePin("acme", "never-pinned", env)).resolves.toBeUndefined();
  });
});
