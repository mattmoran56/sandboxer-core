// Tests for the host path set:
// - paths: SANDBOXR_HOME honoured, defaulted, and an empty value treated as absent
// - every directory in contracts §4 present and under the home
// - logsFor / secretsFile / envFile / cacheFile shapes
// - directoriesOf: the set a command creates up front
// - workspace: its own variable, defaulting under the home
// - projectDir / pinFile shapes

import { homedir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { directoriesOf, paths } from "./paths.js";

describe("paths", () => {
  const p = paths({ SANDBOXR_HOME: "/tmp/sbx" });

  it("uses SANDBOXR_HOME when it is set", () => {
    expect(p.home).toBe("/tmp/sbx");
  });

  it("defaults to ~/.sandboxr", () => {
    expect(paths({}).home).toBe(join(homedir(), ".sandboxr"));
  });

  it("treats an empty SANDBOXR_HOME as unset", () => {
    expect(paths({ SANDBOXR_HOME: "" }).home).toBe(join(homedir(), ".sandboxr"));
  });

  it.each([
    ["cache", "/tmp/sbx/cache"],
    ["logs", "/tmp/sbx/logs"],
    ["tls", "/tmp/sbx/tls"],
    ["state", "/tmp/sbx/state"],
    ["secrets", "/tmp/sbx/secrets"],
    ["build", "/tmp/sbx/build"],
    ["bin", "/tmp/sbx/bin"],
  ] as const)("puts %s at %s", (key, want) => {
    expect(p[key]).toBe(want);
  });

  it("scopes logs by project and slug, so they survive the container", () => {
    expect(p.logsFor("acme", "tkt-1")).toBe("/tmp/sbx/logs/acme/tkt-1");
  });

  it("gives each project one secrets file", () => {
    expect(p.secretsFile("acme")).toBe("/tmp/sbx/secrets/acme.env");
  });

  it("names the generated environment per sandbox", () => {
    expect(p.envFile("acme", "tkt-1")).toBe("/tmp/sbx/build/acme/tkt-1.env");
  });

  it("puts seed artifacts in the cache", () => {
    expect(p.cacheFile("seed-abc.sql.zst")).toBe("/tmp/sbx/cache/seed-abc.sql.zst");
  });

  it("never places anything outside the home", () => {
    for (const dir of directoriesOf(p)) expect(dir.startsWith(p.home)).toBe(true);
  });

  it("lists every directory a command has to create", () => {
    expect(directoriesOf(p)).toHaveLength(8);
  });

  it("includes the workspace, which a clone writes into before anything else", () => {
    expect(directoriesOf(p)).toContain(p.workspace);
  });
});

describe("workspace", () => {
  it("sits under the home by default", () => {
    expect(paths({ SANDBOXR_HOME: "/tmp/sbx" }).workspace).toBe(join("/tmp/sbx", "workspace"));
  });

  // Its own variable because the repositories are the one part of the tree
  // worth putting on a different disk from the seed cache and the logs.
  it("can be moved off the home entirely", () => {
    const moved = paths({ SANDBOXR_HOME: "/tmp/sbx", SANDBOXR_WORKSPACE: "/srv/projects" });
    expect(moved.workspace).toBe("/srv/projects");
    expect(moved.projectDir("acme")).toBe(join("/srv/projects", "acme"));
  });

  it("treats an empty override as absent, like SANDBOXR_HOME does", () => {
    expect(paths({ SANDBOXR_HOME: "/tmp/sbx", SANDBOXR_WORKSPACE: "" }).workspace).toBe(
      join("/tmp/sbx", "workspace"),
    );
  });
});

describe("pinFile", () => {
  // Under state/ rather than build/: build is regenerated on every `up`, and a
  // pin has to outlive that.
  it("is one file per sandbox, under the state directory", () => {
    const p2 = paths({ SANDBOXR_HOME: "/tmp/sbx" });
    expect(p2.pinFile("acme", "tkt-1")).toBe(join("/tmp/sbx", "state", "pins", "acme", "tkt-1"));
  });
});
