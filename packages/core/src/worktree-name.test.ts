// Tests for a worktree's display name:
// - normaliseDisplayName: trims, treats the empty string as "clear it", refuses control characters and newlines in every spelling, bounds the length in code points
// - writeDisplayName then readDisplayName: the name comes back, and the name directory is created on the way
// - writeDisplayName: an empty or whitespace-only value clears the name rather than storing one
// - readDisplayName: an unnamed worktree, and a home with no name directory at all, read as null
// - readDisplayName: a file edited by hand into something that is not a name reads as null, not as a mangled name
// - readDisplayName: a huge file is refused rather than truncated into a name it does not contain
// - the name survives the thing a keep marker does not: nothing about it is keyed on a sandbox instance
// - removeDisplayName: hands the worktree back to its branch, and removing one that is not there does not throw

import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { beforeEach, describe, expect, it } from "vitest";

import { paths } from "./paths.js";
import {
  DISPLAY_NAME_MAX,
  DisplayNameError,
  normaliseDisplayName,
  readDisplayName,
  removeDisplayName,
  writeDisplayName,
} from "./worktree-name.js";

let env: NodeJS.ProcessEnv;

// SANDBOXR_HOME is passed as an environment rather than set on the process, per
// the note on `paths()`: the whole tree moves to a temporary directory without
// the test having to mutate anything global.
beforeEach(async () => {
  env = { SANDBOXR_HOME: await mkdtemp(join(tmpdir(), "sandboxr-name-")) };
});

describe("normaliseDisplayName", () => {
  it("keeps the name it was given", () => {
    expect(normaliseDisplayName("the checkout flow rewrite")).toBe("the checkout flow rewrite");
  });

  it("trims, so the trailing newline the file carries never becomes part of the name", () => {
    expect(normaliseDisplayName("  the checkout flow rewrite\n")).toBe("the checkout flow rewrite");
  });

  // The empty string is an instruction, not a mistake: a cleared form field is
  // how somebody asks for the branch name back.
  it("reads an empty value as clear it", () => {
    expect(normaliseDisplayName("")).toBeNull();
    expect(normaliseDisplayName("   \n ")).toBeNull();
  });

  it("refuses a newline in any spelling a renderer honours", () => {
    for (const bad of ["one\ntwo", "one\rtwo", "one\u2028two", "one\u2029two"]) {
      expect(() => normaliseDisplayName(bad)).toThrow(DisplayNameError);
    }
  });

  it("refuses control characters, including the ones a terminal would act on", () => {
    for (const bad of ["a\u0007b", "a\u001bb", "a\tb", "a\u007fb"]) {
      expect(() => normaliseDisplayName(bad)).toThrow(DisplayNameError);
    }
  });

  it("accepts a name exactly at the ceiling and refuses one past it", () => {
    expect(normaliseDisplayName("x".repeat(DISPLAY_NAME_MAX))).toHaveLength(DISPLAY_NAME_MAX);
    expect(() => normaliseDisplayName("x".repeat(DISPLAY_NAME_MAX + 1))).toThrow(DisplayNameError);
  });

  // Counted in code points, so an emoji costs one character and not the two
  // UTF-16 units it is stored as — otherwise the ceiling is half as generous
  // for anybody not writing in ASCII.
  it("counts code points rather than UTF-16 units", () => {
    const name = "🚀".repeat(DISPLAY_NAME_MAX);
    expect(normaliseDisplayName(name)).toBe(name);
  });

  // Markup is not refused: the browser escapes it, and refusing every character
  // that looks like markup would rule out perfectly ordinary names.
  it("leaves markup alone, because escaping is the renderer's job", () => {
    expect(normaliseDisplayName("<b>billing</b> & co")).toBe("<b>billing</b> & co");
  });
});

describe("writeDisplayName", () => {
  it("writes the name, creating the name directory", async () => {
    expect(await writeDisplayName("acme", "tkt-1", "the checkout flow rewrite", env)).toBe(
      "the checkout flow rewrite",
    );
    expect((await readFile(paths(env).nameFile("acme", "tkt-1"), "utf8")).trim()).toBe(
      "the checkout flow rewrite",
    );
  });

  it("replaces the name of a worktree that already had one", async () => {
    await writeDisplayName("acme", "tkt-1", "first go", env);
    await writeDisplayName("acme", "tkt-1", "second go", env);
    expect(await readDisplayName("acme", "tkt-1", env)).toBe("second go");
  });

  it("clears the name when the value is empty", async () => {
    await writeDisplayName("acme", "tkt-1", "the checkout flow rewrite", env);
    expect(await writeDisplayName("acme", "tkt-1", "  ", env)).toBeNull();
    expect(await readDisplayName("acme", "tkt-1", env)).toBeNull();
  });

  it("refuses to store something that is not a name", async () => {
    await expect(writeDisplayName("acme", "tkt-1", "one\ntwo", env)).rejects.toThrow(DisplayNameError);
    expect(await readDisplayName("acme", "tkt-1", env)).toBeNull();
  });
});

describe("readDisplayName", () => {
  it("reads back what was written", async () => {
    await writeDisplayName("acme", "tkt-1", "the checkout flow rewrite", env);
    expect(await readDisplayName("acme", "tkt-1", env)).toBe("the checkout flow rewrite");
  });

  it("reads an unnamed worktree as null", async () => {
    await writeDisplayName("acme", "tkt-1", "the checkout flow rewrite", env);
    expect(await readDisplayName("acme", "tkt-2", env)).toBeNull();
  });

  it("reads as null when nothing has ever been named", async () => {
    expect(await readDisplayName("acme", "tkt-1", env)).toBeNull();
  });

  it("does not confuse two projects that share a slug", async () => {
    await writeDisplayName("acme", "tkt-1", "the checkout flow rewrite", env);
    expect(await readDisplayName("demo", "tkt-1", env)).toBeNull();
  });

  // The file is in somebody's home directory and can be edited by hand. A file
  // that is not a name reads as no name — the worktree shows its branch again,
  // which is visible and undoable — rather than putting a control character on
  // a page or being silently rewritten on disk.
  it("reads a hand-edited file that is not a name as null", async () => {
    await writeDisplayName("acme", "tkt-1", "fine", env);
    await writeFile(paths(env).nameFile("acme", "tkt-1"), "two\nlines\n", "utf8");
    expect(await readDisplayName("acme", "tkt-1", env)).toBeNull();
  });

  it("refuses a file far longer than a name rather than truncating it into one", async () => {
    await writeDisplayName("acme", "tkt-1", "fine", env);
    await writeFile(paths(env).nameFile("acme", "tkt-1"), "x".repeat(100_000), "utf8");
    expect(await readDisplayName("acme", "tkt-1", env)).toBeNull();
  });
});

describe("removeDisplayName", () => {
  it("hands the worktree back to its branch name", async () => {
    await writeDisplayName("acme", "tkt-1", "the checkout flow rewrite", env);
    await removeDisplayName("acme", "tkt-1", env);
    expect(await readDisplayName("acme", "tkt-1", env)).toBeNull();
  });

  it("does not throw when there is no name to remove", async () => {
    await expect(removeDisplayName("acme", "never-named", env)).resolves.toBeUndefined();
  });
});

// The difference from the keep-alive marker, stated as a test because it is the
// whole reason this file exists separately from keep.ts: a keep marker carries
// the `sandboxr.created` of the container it applies to and is ignored when that
// does not match, so it dies with its sandbox. A name belongs to the worktree,
// which outlives every sandbox cut on it — nothing here is keyed on an instance,
// so there is nothing a stop-and-recreate can invalidate.
describe("a name is not stamped with a sandbox instance", () => {
  it("survives anything that happens to the sandbox on the worktree", async () => {
    await writeDisplayName("acme", "tkt-1", "the checkout flow rewrite", env);
    // Whatever a sandbox did in between — stopped, removed, created again with a
    // new `sandboxr.created` — this call takes no instance and reads the same.
    expect(await readDisplayName("acme", "tkt-1", env)).toBe("the checkout flow rewrite");
  });
});
