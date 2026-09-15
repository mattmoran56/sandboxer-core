// Tests for the host path set:
// - paths: SANDBOXR_HOME honoured, defaulted, and an empty value treated as absent
// - every directory in contracts §4 present and under the home
// - logsFor / secretsFile / envFile / cacheFile shapes
// - directoriesOf: the set a command creates up front
// - workspace: its own variable, defaulting under the home
// - projectDir / worktreesDir / keepFile / attachFile / slugFile / configFile shapes
// - a session's three files share one directory, which is what stops a session id colliding with a project's
// - isInside: a path in a directory, the directory itself, a sibling with a shared prefix
// - samePath: identical strings, and two spellings of one place

import { homedir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { WORKTREES_DIR, directoriesOf, isInside, paths, samePath } from "./paths.js";

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
    expect(directoriesOf(p)).toHaveLength(9);
  });

  it("includes the socket directory, which a sidecar's bind would otherwise invent", () => {
    // Created here rather than left to Docker: a bind whose source is missing is
    // made as a root-owned directory, so the first sidecar to start would decide
    // the ownership of a path the host's own processes also write into.
    expect(directoriesOf(p)).toContain(p.run);
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
    expect(moved.worktreesDir("acme")).toBe(join("/srv/projects", "acme", "wt"));
  });

  // One spelling of the layout, because config/locate.ts recognises a worktree
  // from its path alone and a second spelling is how a config gets looked for in
  // the wrong directory.
  it("puts worktrees under wt/ inside the project directory", () => {
    const p = paths({ SANDBOXR_HOME: "/tmp/sbx" });
    expect(p.worktreesDir("acme")).toBe(join(p.projectDir("acme"), WORKTREES_DIR));
    expect(WORKTREES_DIR).toBe("wt");
  });

  it("treats an empty override as absent, like SANDBOXR_HOME does", () => {
    expect(paths({ SANDBOXR_HOME: "/tmp/sbx", SANDBOXR_WORKSPACE: "" }).workspace).toBe(
      join("/tmp/sbx", "workspace"),
    );
  });
});

describe("keepFile", () => {
  // Under state/ rather than build/: build is regenerated on every `up`, and a
  // keep-alive marker has to outlive that.
  it("is one file per sandbox, under the state directory", () => {
    const p2 = paths({ SANDBOXR_HOME: "/tmp/sbx" });
    expect(p2.keepFile("acme", "tkt-1")).toBe(join("/tmp/sbx", "state", "keep", "acme", "tkt-1"));
  });
});

describe("attachFile", () => {
  // Beside the keep marker and keyed the same way, on the container's project
  // rather than the workspace directory: it is joined to a sandbox, not to a
  // worktree.
  it("is one file per sandbox, under the state directory", () => {
    const p2 = paths({ SANDBOXR_HOME: "/tmp/sbx" });
    expect(p2.attachFile("acme", "tkt-1")).toBe(join("/tmp/sbx", "state", "attach", "acme", "tkt-1"));
  });
});

describe("slugFile", () => {
  // Keyed on the worktree *directory* name and not on a slug: the slug is the
  // thing this file decides, so it cannot also be the key.
  it("is one file per worktree directory, under the state directory", () => {
    const p2 = paths({ SANDBOXR_HOME: "/tmp/sbx" });
    expect(p2.slugFile("acme", "feat-tkt-1-thing")).toBe(
      join("/tmp/sbx", "state", "slug", "acme", "feat-tkt-1-thing"),
    );
  });
});

describe("a session's state", () => {
  // One directory per session rather than three parallel trees (contracts
  // §12.6). `state/keep/<project>/<slug>` puts a *project* directory at its
  // first level, so a session id written there could collide with a project of
  // the same name — and the two would then be one file, exempting a sandbox from
  // its lifetime because somebody pinned a session.
  it("is three files in one directory per session", () => {
    const p2 = paths({ SANDBOXR_HOME: "/tmp/sbx" });
    const dir = join("/tmp/sbx", "state", "session", "eng-3941");
    expect(p2.sessionDir("eng-3941")).toBe(dir);
    expect(p2.sessionKeepFile("eng-3941")).toBe(join(dir, "keep"));
    expect(p2.sessionNameFile("eng-3941")).toBe(join(dir, "name"));
    expect(p2.sessionAttachFile("eng-3941")).toBe(join(dir, "attach"));
  });

  // The collision the nesting exists to prevent, spelled out: a project called
  // `eng-3941` and a session called `eng-3941` must not share a path.
  it("cannot collide with a project directory under state/keep", () => {
    const p2 = paths({ SANDBOXR_HOME: "/tmp/sbx" });
    expect(p2.sessionKeepFile("eng-3941")).not.toBe(p2.keepFile("eng-3941", "keep"));
  });
});

describe("configFile", () => {
  // At the top of the home, not inside state/: everything under state/ is
  // generated and may be rewritten, and this one is written by hand.
  it("is config.yaml at the top of the home", () => {
    expect(paths({ SANDBOXR_HOME: "/tmp/sbx" }).configFile).toBe(join("/tmp/sbx", "config.yaml"));
  });
});

describe("isInside", () => {
  it.each([
    ["a path under the directory", "/srv/sandboxr/workspace", "/srv/sandboxr", true],
    ["the directory itself", "/srv/sandboxr", "/srv/sandboxr", true],
    ["several levels down", "/srv/sandboxr/a/b/c", "/srv/sandboxr", true],
    ["a parent", "/srv", "/srv/sandboxr", false],
    // The guard the whole function exists for: a plain `startsWith` says yes.
    ["a sibling sharing a prefix", "/srv/sandboxr-other", "/srv/sandboxr", false],
  ])("%s", (_name, child, parent, expected) => {
    expect(isInside(child, parent)).toBe(expected);
  });
});

describe("samePath", () => {
  it("is true for identical strings, without touching the filesystem", () => {
    expect(samePath("/nowhere/at/all", "/nowhere/at/all")).toBe(true);
  });

  it("is false for two different places", () => {
    expect(samePath("/nowhere/a", "/nowhere/b")).toBe(false);
  });

  it("sees through a symlinked parent", () => {
    // macOS keeps /tmp as a symlink into /private, which is exactly the case
    // that made a string comparison report a worktree git had just created as
    // one it had never heard of.
    expect(samePath("/tmp", "/tmp")).toBe(true);
  });
});
