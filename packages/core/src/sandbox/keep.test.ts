// Tests for the keep-alive marker:
// - writeKeep then readKeep: the stamp comes back, and the keep directory is created on the way
// - readKeep: a sandbox nobody asked to keep, and a home with no keep directory at all, read as undefined
// - isKeptAlive: true only when the stamp matches the live sandbox's created label
// - isKeptAlive: a marker left by a previous sandbox of the same project/slug reports NOT kept (the resurrection case)
// - isKeptAlive: a sandbox with no created label can never match a marker
// - removeKeep: hands it back to the clock, and removing one that is not there does not throw

import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { beforeEach, describe, expect, it } from "vitest";

import { paths } from "../paths.js";
import { isKeptAlive, readKeep, removeKeep, writeKeep } from "./keep.js";
import type { Sandbox } from "./types.js";

const CREATED = "2026-08-25T09:00:00.000Z";

let env: NodeJS.ProcessEnv;

// SANDBOXR_HOME is passed as an environment rather than set on the process, per
// the note on `paths()`: the whole tree moves to a temporary directory without
// the test having to mutate anything global.
beforeEach(async () => {
  env = { SANDBOXR_HOME: await mkdtemp(join(tmpdir(), "sandboxr-keep-")) };
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
    ttl: "12h",
    env: "",
    kind: "runtime",
    session: "",
    state: "running",
    container: "sandboxr-acme-tkt-1",
    ...overrides,
  };
}

describe("writeKeep", () => {
  it("writes the stamp, creating the keep directory", async () => {
    await writeKeep("acme", "tkt-1", CREATED, env);
    expect((await readFile(paths(env).keepFile("acme", "tkt-1"), "utf8")).trim()).toBe(CREATED);
  });

  it("replaces the stamp of an existing marker", async () => {
    await writeKeep("acme", "tkt-1", CREATED, env);
    await writeKeep("acme", "tkt-1", "2026-08-26T09:00:00.000Z", env);
    expect(await readKeep("acme", "tkt-1", env)).toBe("2026-08-26T09:00:00.000Z");
  });
});

describe("readKeep", () => {
  it("reads back what was written", async () => {
    await writeKeep("acme", "tkt-1", CREATED, env);
    expect(await readKeep("acme", "tkt-1", env)).toBe(CREATED);
  });

  it("reads a sandbox nobody asked to keep as undefined", async () => {
    await writeKeep("acme", "tkt-1", CREATED, env);
    expect(await readKeep("acme", "tkt-2", env)).toBeUndefined();
  });

  // The keep directory does not exist until something is kept alive for the
  // first time, so a missing directory is just "not kept", never an error.
  it("reads as undefined when nothing has ever been kept alive", async () => {
    expect(await readKeep("acme", "tkt-1", env)).toBeUndefined();
  });
});

describe("isKeptAlive", () => {
  it("is true when the stamp matches the sandbox", async () => {
    await writeKeep("acme", "tkt-1", CREATED, env);
    expect(await isKeptAlive(sandbox(), env)).toBe(true);
  });

  it("is false when there is no marker", async () => {
    expect(await isKeptAlive(sandbox(), env)).toBe(false);
  });

  // The resurrection case. Slugs come from ticket ids and branch names, so the
  // same project/slug is recreated routinely — same ticket, second attempt. A
  // bare marker would outlive its sandbox and silently keep the successor, and
  // "this one never expires" looks nothing like its cause.
  it("is false when the marker was written for an earlier sandbox of the same name", async () => {
    await writeKeep("acme", "tkt-1", "2026-08-20T09:00:00.000Z", env);
    expect(await isKeptAlive(sandbox({ created: CREATED }), env)).toBe(false);
  });

  it("is false for a sandbox with no created label, whatever the marker says", async () => {
    await writeKeep("acme", "tkt-1", "", env);
    expect(await isKeptAlive(sandbox({ created: "" }), env)).toBe(false);
  });

  it("does not confuse two projects that share a slug", async () => {
    await writeKeep("acme", "tkt-1", CREATED, env);
    expect(await isKeptAlive(sandbox({ project: "demo" }), env)).toBe(false);
  });
});

describe("removeKeep", () => {
  it("hands the sandbox back to the clock", async () => {
    await writeKeep("acme", "tkt-1", CREATED, env);
    await removeKeep("acme", "tkt-1", env);
    expect(await readKeep("acme", "tkt-1", env)).toBeUndefined();
    expect(await isKeptAlive(sandbox(), env)).toBe(false);
  });

  it("does not throw when there is no marker to remove", async () => {
    await expect(removeKeep("acme", "never-kept", env)).resolves.toBeUndefined();
  });
});
