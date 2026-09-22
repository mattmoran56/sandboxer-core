// Tests for the host path set:
// - paths: SANDBOXER_HOME honoured, defaulted, and an empty value treated as absent
// - every directory in contracts §4 present and under the home
// - logsFor / secretsFile / envFile / cacheFile shapes
// - directoriesOf: the set a command creates up front
// - workspace: its own variable, defaulting under the home
// - projectDir / worktreesDir / keepFile / attachFile / slugFile / configFile shapes
// - isInside: a path in a directory, the directory itself, a sibling with a shared prefix
// - samePath: identical strings, and two spellings of one place
// - legacyHomeNotice: names the old home only when it is there and the new one is
//   not, says nothing once SANDBOXER_HOME is set, and never moves anything

import { existsSync } from "node:fs";
import { mkdir, mkdtemp } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { WORKTREES_DIR, directoriesOf, isInside, legacyHomeNotice, paths, samePath } from "./paths.js";

describe("paths", () => {
  const p = paths({ SANDBOXER_HOME: "/tmp/sbx" });

  it("uses SANDBOXER_HOME when it is set", () => {
    expect(p.home).toBe("/tmp/sbx");
  });

  it("defaults to ~/.sandboxer", () => {
    expect(paths({}).home).toBe(join(homedir(), ".sandboxer"));
  });

  it("treats an empty SANDBOXER_HOME as unset", () => {
    expect(paths({ SANDBOXER_HOME: "" }).home).toBe(join(homedir(), ".sandboxer"));
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
    expect(paths({ SANDBOXER_HOME: "/tmp/sbx" }).workspace).toBe(join("/tmp/sbx", "workspace"));
  });

  // Its own variable because the repositories are the one part of the tree
  // worth putting on a different disk from the seed cache and the logs.
  it("can be moved off the home entirely", () => {
    const moved = paths({ SANDBOXER_HOME: "/tmp/sbx", SANDBOXER_WORKSPACE: "/srv/projects" });
    expect(moved.workspace).toBe("/srv/projects");
    expect(moved.projectDir("acme")).toBe(join("/srv/projects", "acme"));
    expect(moved.worktreesDir("acme")).toBe(join("/srv/projects", "acme", "wt"));
  });

  // One spelling of the layout, because config/locate.ts recognises a worktree
  // from its path alone and a second spelling is how a config gets looked for in
  // the wrong directory.
  it("puts worktrees under wt/ inside the project directory", () => {
    const p = paths({ SANDBOXER_HOME: "/tmp/sbx" });
    expect(p.worktreesDir("acme")).toBe(join(p.projectDir("acme"), WORKTREES_DIR));
    expect(WORKTREES_DIR).toBe("wt");
  });

  it("treats an empty override as absent, like SANDBOXER_HOME does", () => {
    expect(paths({ SANDBOXER_HOME: "/tmp/sbx", SANDBOXER_WORKSPACE: "" }).workspace).toBe(
      join("/tmp/sbx", "workspace"),
    );
  });
});

describe("keepFile", () => {
  // Under state/ rather than build/: build is regenerated on every `up`, and a
  // keep-alive marker has to outlive that.
  it("is one file per sandbox, under the state directory", () => {
    const p2 = paths({ SANDBOXER_HOME: "/tmp/sbx" });
    expect(p2.keepFile("acme", "tkt-1")).toBe(join("/tmp/sbx", "state", "keep", "acme", "tkt-1"));
  });
});

describe("attachFile", () => {
  // Beside the keep marker and keyed the same way, on the container's project
  // rather than the workspace directory: it is joined to a sandbox, not to a
  // worktree.
  it("is one file per sandbox, under the state directory", () => {
    const p2 = paths({ SANDBOXER_HOME: "/tmp/sbx" });
    expect(p2.attachFile("acme", "tkt-1")).toBe(join("/tmp/sbx", "state", "attach", "acme", "tkt-1"));
  });
});

describe("slugFile", () => {
  // Keyed on the worktree *directory* name and not on a slug: the slug is the
  // thing this file decides, so it cannot also be the key.
  it("is one file per worktree directory, under the state directory", () => {
    const p2 = paths({ SANDBOXER_HOME: "/tmp/sbx" });
    expect(p2.slugFile("acme", "feat-tkt-1-thing")).toBe(
      join("/tmp/sbx", "state", "slug", "acme", "feat-tkt-1-thing"),
    );
  });
});

describe("configFile", () => {
  // At the top of the home, not inside state/: everything under state/ is
  // generated and may be rewritten, and this one is written by hand.
  it("is config.yaml at the top of the home", () => {
    expect(paths({ SANDBOXER_HOME: "/tmp/sbx" }).configFile).toBe(join("/tmp/sbx", "config.yaml"));
  });
});

describe("isInside", () => {
  it.each([
    ["a path under the directory", "/srv/sandboxer/workspace", "/srv/sandboxer", true],
    ["the directory itself", "/srv/sandboxer", "/srv/sandboxer", true],
    ["several levels down", "/srv/sandboxer/a/b/c", "/srv/sandboxer", true],
    ["a parent", "/srv", "/srv/sandboxer", false],
    // The guard the whole function exists for: a plain `startsWith` says yes.
    ["a sibling sharing a prefix", "/srv/sandboxer-other", "/srv/sandboxer", false],
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

describe("legacyHomeNotice", () => {
  /** A fake home, with whichever of the two directories the case needs. */
  const homeWith = async (...dirs: string[]): Promise<string> => {
    const home = await mkdtemp(join(tmpdir(), "sandboxer-home-"));
    for (const dir of dirs) await mkdir(join(home, dir));
    return home;
  };

  it("names the old home when only the old home is there", async () => {
    const home = await homeWith(".sandboxr");
    const said = legacyHomeNotice({ HOME: home });
    expect(said).toContain(join(home, ".sandboxr"));
    expect(said).toContain(join(home, ".sandboxer"));
    expect(said).toContain("mv ");
  });

  it("says nothing once the new home exists", async () => {
    // Both present is the state after somebody has moved it, or after they have
    // decided not to. Either way the decision is made and repeating it is noise.
    expect(legacyHomeNotice({ HOME: await homeWith(".sandboxr", ".sandboxer") })).toBeUndefined();
  });

  it("says nothing on a machine that never ran the old name", async () => {
    expect(legacyHomeNotice({ HOME: await homeWith() })).toBeUndefined();
  });

  it("says nothing when SANDBOXER_HOME names the state itself", async () => {
    // The person has said where their state is, so the default home is not the
    // question and a sentence about it would be wrong rather than merely noisy.
    const home = await homeWith(".sandboxr");
    expect(legacyHomeNotice({ HOME: home, SANDBOXER_HOME: "/somewhere/else" })).toBeUndefined();
  });

  it("moves nothing", async () => {
    // Read-only is the whole design: an automatic mv of the directory holding
    // every worktree on the machine is help that is only noticed when it fails.
    const home = await homeWith(".sandboxr");
    legacyHomeNotice({ HOME: home });
    expect(existsSync(join(home, ".sandboxr"))).toBe(true);
    expect(existsSync(join(home, ".sandboxer"))).toBe(false);
  });
});
