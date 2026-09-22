// Tests for finding the engine's own installation:
// - SANDBOXER_INSTALL wins, resolved to an absolute path, and an empty one is ignored
// - the walk up finds a tree with the engine's markers and **no packages/server**,
//   which is what an engine repository of its own looks like
// - the walk up refuses a tree that has only the product's marker
// - a tree with neither marker is an error naming the variable, not a silent `/`
// - containerDir hangs off whatever root was found
//
// The second and third are the cases that matter. The marker list used to name
// `packages/server/package.json` — the *product's* file — and every test in this
// repository runs inside a tree that has it, so nothing failed. The failure
// would have arrived on a colleague's first `sandboxer init` from a cold clone of
// the engine, as a walk to `/` and a throw with nothing in it naming the cause.

import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { describe, expect, it } from "vitest";

import { InstallError, containerDir, installRoot } from "./install.js";

/** A tree holding exactly the files named, under a fresh temporary directory. */
async function tree(files: string[]): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "sandboxer-install-"));
  for (const file of files) {
    await mkdir(dirname(join(root, file)), { recursive: true });
    await writeFile(join(root, file), "x\n", "utf8");
  }
  return root;
}

/** Somewhere deep inside a tree, which is where a walk would really start. */
async function deepIn(root: string): Promise<string> {
  const dir = join(root, "packages", "core", "dist", "access");
  await mkdir(dir, { recursive: true });
  return dir;
}

describe("installRoot", () => {
  it("takes SANDBOXER_INSTALL, resolved", async () => {
    const root = await tree([]);
    expect(installRoot({ SANDBOXER_INSTALL: root })).toBe(root);
  });

  it("ignores an empty SANDBOXER_INSTALL and walks instead", async () => {
    const root = await tree(["container/base/Dockerfile", "packages/core/package.json"]);
    expect(installRoot({ SANDBOXER_INSTALL: "" }, await deepIn(root))).toBe(root);
  });

  // **The engine's markers are the engine's own.** A clone of the engine has no
  // `packages/server`, and a marker naming one would walk this to `/` and throw
  // on every `init`, every `up` and every image build.
  it("finds a tree that has no packages/server at all", async () => {
    const root = await tree(["container/base/Dockerfile", "packages/core/package.json"]);
    expect(installRoot({}, await deepIn(root))).toBe(root);
    expect(containerDir({ SANDBOXER_INSTALL: root })).toBe(join(root, "container"));
  });

  // The other half of the same rule: a tree that is only the product is not an
  // engine installation, whatever else is in it.
  it("refuses a tree that has only the product's marker", async () => {
    const root = await tree(["packages/server/package.json"]);
    expect(() => installRoot({}, root)).toThrow(InstallError);
  });

  it("names the variable rather than walking silently to the root", async () => {
    const root = await tree([]);
    expect(() => installRoot({}, root)).toThrow(/SANDBOXER_INSTALL/);
  });
});
