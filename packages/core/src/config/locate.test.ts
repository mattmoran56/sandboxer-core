// Tests for deciding which config file governs a directory, and what its root is.
// Every case is a real tree under mkdtemp, because the whole subject is what is on disk.
// - findConfig: found in place, found by walking up, absent, and bounded by stopAt
// - workspaceWorktree: recognises `<workspace>/<project>/wt/<slug>` and a subdirectory of it,
//   and declines the project directory, the bare mirror, and anything outside the workspace
// - a managed worktree with its own config uses it, and root is the worktree
// - a managed worktree with none uses the project-level file, and root is *still* the worktree
// - both present: the worktree's own wins, because a repo that describes itself is never overruled
// - neither present: the existing error, unchanged
// - the regression test for the walk-up: a project-level config must never make root the project directory
// - a repository outside the workspace is unaffected, including a config in a parent directory
// - a malformed project-level config errors naming that file, not the worktree
// - a config named directly inside the project directory is refused rather than mounted

import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { beforeEach, describe, expect, it } from "vitest";

import { loadConfig } from "./load.js";
import { findConfig, isWorkspaceProjectDir, locateConfig, workspaceWorktree } from "./locate.js";

const CONFIG = (project: string) => `project: ${project}\nsandboxer: '>=0.1.0'\naccess:\n  apps: private\n`;

interface Tree {
  /** The workspace root, and the environment that points at it. */
  workspace: string;
  env: NodeJS.ProcessEnv;
  /** `<workspace>/acme`, holding repo.git and wt/. */
  projectDir: string;
  /** `<workspace>/acme/wt/main`. */
  worktree: string;
  /** A directory deep inside the worktree, to run commands from. */
  deep: string;
}

/**
 * A workspace laid out exactly as contracts §4 says, on disk.
 *
 * `repo.git` is created because the layout is what everything here reads: a
 * project directory without it is not a project, and a test that skipped it
 * would be testing a shape that never occurs.
 */
async function workspaceTree(): Promise<Tree> {
  const home = await mkdtemp(join(tmpdir(), "sbx-locate-"));
  const workspace = join(home, "workspace");
  const projectDir = join(workspace, "acme");
  const worktree = join(projectDir, "wt", "main");
  const deep = join(worktree, "services", "api");

  await mkdir(join(projectDir, "repo.git"), { recursive: true });
  await mkdir(deep, { recursive: true });

  return { workspace, env: { SANDBOXER_HOME: home }, projectDir, worktree, deep };
}

describe("findConfig", () => {
  it("finds a config in the directory it starts in", async () => {
    const dir = await mkdtemp(join(tmpdir(), "sbx-find-"));
    await writeFile(join(dir, "sandboxer.yaml"), CONFIG("x"));
    expect(await findConfig(dir)).toBe(join(dir, "sandboxer.yaml"));
  });

  it("walks up to the project root", async () => {
    const dir = await mkdtemp(join(tmpdir(), "sbx-find-"));
    await writeFile(join(dir, "sandboxer.yaml"), CONFIG("x"));
    const deep = join(dir, "a", "b", "c");
    await mkdir(deep, { recursive: true });
    expect(await findConfig(deep)).toBe(join(dir, "sandboxer.yaml"));
  });

  it("returns nothing when there is no config anywhere above", async () => {
    // A temp directory has no project above it, and the walk stops at the root
    // rather than looping.
    const dir = await mkdtemp(join(tmpdir(), "sbx-none-"));
    const found = await findConfig(dir);
    expect(found === undefined || found.startsWith(dir) === false).toBe(true);
  });

  it("searches stopAt and then gives up", async () => {
    const dir = await mkdtemp(join(tmpdir(), "sbx-stop-"));
    const top = join(dir, "top");
    const deep = join(top, "a", "b");
    await mkdir(deep, { recursive: true });
    await writeFile(join(dir, "sandboxer.yaml"), CONFIG("above"));
    await writeFile(join(top, "sandboxer.yaml"), CONFIG("top"));

    expect(await findConfig(deep, { stopAt: top })).toBe(join(top, "sandboxer.yaml"));
  });

  it("does not look above stopAt", async () => {
    const dir = await mkdtemp(join(tmpdir(), "sbx-stop-"));
    const top = join(dir, "top");
    await mkdir(top, { recursive: true });
    await writeFile(join(dir, "sandboxer.yaml"), CONFIG("above"));

    expect(await findConfig(top, { stopAt: top })).toBeUndefined();
  });
});

describe("workspaceWorktree", () => {
  let tree: Tree;
  beforeEach(async () => {
    tree = await workspaceTree();
  });

  it("recognises a worktree, and a directory inside one", async () => {
    for (const from of [tree.worktree, tree.deep]) {
      const found = workspaceWorktree(from, tree.env);
      expect(found?.project).toBe("acme");
      expect(found?.worktree).toBe(tree.worktree);
      expect(found?.projectDir).toBe(tree.projectDir);
    }
  });

  it("declines the project directory, the mirror, and the workspace itself", async () => {
    expect(workspaceWorktree(tree.projectDir, tree.env)).toBeUndefined();
    expect(workspaceWorktree(join(tree.projectDir, "repo.git"), tree.env)).toBeUndefined();
    expect(workspaceWorktree(tree.workspace, tree.env)).toBeUndefined();
    expect(workspaceWorktree(join(tree.projectDir, "wt"), tree.env)).toBeUndefined();
  });

  it("declines a repository that is not in the workspace", async () => {
    const outside = await mkdtemp(join(tmpdir(), "sbx-outside-"));
    expect(workspaceWorktree(outside, tree.env)).toBeUndefined();
  });

  it("knows a project directory from anything else", async () => {
    expect(isWorkspaceProjectDir(tree.projectDir, tree.env)).toBe(true);
    expect(isWorkspaceProjectDir(tree.worktree, tree.env)).toBe(false);
    expect(isWorkspaceProjectDir(tree.workspace, tree.env)).toBe(false);
  });
});

describe("a managed worktree", () => {
  let tree: Tree;
  beforeEach(async () => {
    tree = await workspaceTree();
  });

  it("uses its own config, with the worktree as the root", async () => {
    await writeFile(join(tree.worktree, "sandboxer.yaml"), CONFIG("own"));

    const config = await loadConfig(tree.worktree, { env: tree.env });
    expect(config.project).toBe("own");
    expect(config.file).toBe(join(tree.worktree, "sandboxer.yaml"));
    expect(config.root).toBe(tree.worktree);
    expect(config.origin).toBe("repo");
  });

  it("falls back to the project-level config, and the root is still the worktree", async () => {
    await writeFile(join(tree.projectDir, "sandboxer.yaml"), CONFIG("shared"));

    const config = await loadConfig(tree.worktree, { env: tree.env });
    expect(config.project).toBe("shared");
    expect(config.file).toBe(join(tree.projectDir, "sandboxer.yaml"));
    expect(config.root).toBe(tree.worktree);
    expect(config.origin).toBe("project");
  });

  it("falls back from a subdirectory too", async () => {
    await writeFile(join(tree.projectDir, "sandboxer.yaml"), CONFIG("shared"));

    const config = await loadConfig(tree.deep, { env: tree.env });
    expect(config.root).toBe(tree.worktree);
    expect(config.origin).toBe("project");
  });

  it("prefers its own config over the project-level one", async () => {
    // A repository that has said how it should be run is never overruled by a
    // file outside it, which its authors cannot see and did not write.
    await writeFile(join(tree.projectDir, "sandboxer.yaml"), CONFIG("shared"));
    await writeFile(join(tree.worktree, "sandboxer.yaml"), CONFIG("own"));

    const config = await loadConfig(tree.worktree, { env: tree.env });
    expect(config.project).toBe("own");
    expect(config.file).toBe(join(tree.worktree, "sandboxer.yaml"));
    expect(config.root).toBe(tree.worktree);
    expect(config.origin).toBe("repo");
  });

  it("gives the ordinary error when neither exists", async () => {
    await expect(loadConfig(tree.worktree, { env: tree.env })).rejects.toThrow(
      /no sandboxer\.yaml here or in any parent directory/,
    );
  });

  it("names the project-level file when that file is the broken one", async () => {
    // The error has to name the file whose author has to edit it, and that file
    // is not in the worktree the command was run from.
    await writeFile(join(tree.projectDir, "sandboxer.yaml"), "project: 4\nsandboxer: '>=0.1.0'\n");

    await expect(loadConfig(tree.worktree, { env: tree.env })).rejects.toThrow(
      join(tree.projectDir, "sandboxer.yaml"),
    );
  });
});

/**
 * The bug the project-level config is the sanctioned version of.
 *
 * `findConfig` walks up to the filesystem root, so a file at
 * `<workspace>/<project>/sandboxer.yaml` was *already* found from inside a
 * worktree — and `root` was `dirname(file)`, so `/workspace` would have been the
 * project directory, with `repo.git` and every sibling worktree mounted into the
 * sandbox and every declared path resolving one directory too high.
 */
describe("the walk-up out of a worktree (regression)", () => {
  it("never resolves root to the workspace project directory", async () => {
    const tree = await workspaceTree();
    const sibling = join(tree.projectDir, "wt", "feature");
    await mkdir(sibling, { recursive: true });
    await writeFile(join(tree.projectDir, "sandboxer.yaml"), CONFIG("shared"));

    for (const from of [tree.worktree, tree.deep, sibling]) {
      const located = await locateConfig(from, { env: tree.env });
      expect(located?.root).not.toBe(tree.projectDir);
    }

    // And both worktrees get their own root, not one shared one.
    expect((await loadConfig(tree.worktree, { env: tree.env })).root).toBe(tree.worktree);
    expect((await loadConfig(sibling, { env: tree.env })).root).toBe(sibling);
  });

  it("refuses to run the project-level config from the project directory itself", async () => {
    const tree = await workspaceTree();
    const file = join(tree.projectDir, "sandboxer.yaml");
    await writeFile(file, CONFIG("shared"));

    // Both ways in: standing in the directory, and naming the file outright.
    await expect(loadConfig(tree.projectDir, { env: tree.env })).rejects.toThrow(/repo\.git and every worktree/);
    await expect(loadConfig(file, { env: tree.env })).rejects.toThrow(/repo\.git and every worktree/);
  });
});

describe("a repository outside the workspace", () => {
  it("is unaffected: the walk-up is unbounded and the root is the config's own directory", async () => {
    const tree = await workspaceTree();
    const repo = await mkdtemp(join(tmpdir(), "sbx-own-"));
    const deep = join(repo, "services", "api");
    await mkdir(deep, { recursive: true });
    await writeFile(join(repo, "sandboxer.yaml"), CONFIG("outside"));

    const config = await loadConfig(deep, { env: tree.env });
    expect(config.project).toBe("outside");
    expect(config.root).toBe(repo);
    expect(config.origin).toBe("repo");
  });

  it("keeps working for a project kept in a subdirectory of a larger repository", async () => {
    // `root` is the directory the config sits in, which for this shape is not
    // the top of the checkout. Nothing about the fallback may change that.
    const tree = await workspaceTree();
    const repo = await mkdtemp(join(tmpdir(), "sbx-sub-"));
    const inner = join(repo, "apps", "web");
    await mkdir(inner, { recursive: true });
    await writeFile(join(inner, "sandboxer.yaml"), CONFIG("inner"));

    const config = await loadConfig(inner, { env: tree.env });
    expect(config.root).toBe(inner);
  });

  it("does not see a project-level config from a workspace it is not in", async () => {
    const tree = await workspaceTree();
    await writeFile(join(tree.projectDir, "sandboxer.yaml"), CONFIG("shared"));

    const outside = await mkdtemp(join(tmpdir(), "sbx-elsewhere-"));
    await expect(loadConfig(outside, { env: tree.env })).rejects.toThrow(/no sandboxer\.yaml/);
  });
});
