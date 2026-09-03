// Tests for the slug a worktree is given when derivation cannot name it uniquely:
// - normaliseRecordedSlug: accepts what sanitizeSlug produces, refuses everything else, and bounds the length
// - writeRecordedSlug then readRecordedSlug: the value comes back, and the directory is created on the way
// - writeRecordedSlug: a value that is not a slug is refused rather than stored and read back as nothing
// - readRecordedSlug: no file, no directory, a hand-edited file and a huge file all read as "no recorded slug"
// - slugToken: four characters of [a-z0-9]
// - uniqueSlug: appends a token, re-rolls against the taken set, and keeps the result inside SLUG_MAX
// - worktreeKey: keys a managed worktree on its directory name, from inside it too, and refuses one outside the workspace
// - slugFor: explicit beats recorded beats derived, and a recorded slug is read by every caller
// - slugFor: a branch of "?" is folded away rather than sanitised into a throw

import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { beforeEach, describe, expect, it } from "vitest";

import { NamingError, SLUG_MAX } from "./naming.js";
import { paths } from "./paths.js";
import {
  SLUG_TOKEN_LEN,
  normaliseRecordedSlug,
  readRecordedSlug,
  removeRecordedSlug,
  slugFor,
  slugToken,
  uniqueSlug,
  worktreeKey,
  writeRecordedSlug,
} from "./worktree-slug.js";

let env: NodeJS.ProcessEnv;
let workspace: string;

// The environment is passed rather than set on the process, per the note on
// `paths()`: the whole tree moves to a temporary directory without the test
// having to mutate anything global.
beforeEach(async () => {
  const home = await mkdtemp(join(tmpdir(), "sandboxr-slug-"));
  workspace = join(home, "workspace");
  env = { SANDBOXR_HOME: home, SANDBOXR_WORKSPACE: workspace };
});

/** `<workspace>/<project>/wt/<dir>`, created on disk so realpath can resolve it. */
async function managed(project: string, dir: string): Promise<string> {
  const path = join(workspace, project, "wt", dir);
  await mkdir(path, { recursive: true });
  return path;
}

describe("normaliseRecordedSlug", () => {
  it.each(["eng-3941", "eng-3941-7k2f", "main", "a1"])("accepts %s", (slug) => {
    expect(normaliseRecordedSlug(slug)).toBe(slug);
  });

  it("trims, so the trailing newline the file carries never becomes part of the slug", () => {
    expect(normaliseRecordedSlug("eng-3941-7k2f\n")).toBe("eng-3941-7k2f");
  });

  // Everything here is a shape `sanitizeSlug` cannot produce, so a file holding
  // one was edited by hand — and its value would otherwise become a container
  // name and a hostname label.
  it.each(["", "   ", "Eng-3941", "eng_3941", "-eng", "eng-", "eng--3941", "eng 3941", "eng/3941", "eng.3941"])(
    "refuses %s",
    (raw) => {
      expect(normaliseRecordedSlug(raw)).toBeNull();
    },
  );

  it("refuses a slug over the ceiling, which the lock-name budget depends on", () => {
    expect(normaliseRecordedSlug("a".repeat(SLUG_MAX))).toBe("a".repeat(SLUG_MAX));
    expect(normaliseRecordedSlug("a".repeat(SLUG_MAX + 1))).toBeNull();
  });
});

describe("the store", () => {
  it("reads back what it wrote, creating the directory on the way", async () => {
    await writeRecordedSlug("acme", "feat-eng-3941-run-selector", "eng-3941-7k2f", env);
    expect(await readRecordedSlug("acme", "feat-eng-3941-run-selector", env)).toBe("eng-3941-7k2f");
  });

  it("keys on the worktree directory and not on the slug", async () => {
    await writeRecordedSlug("acme", "feat-eng-3941-run-selector", "eng-3941-7k2f", env);
    expect(await readRecordedSlug("acme", "eng-3941-7k2f", env)).toBeNull();
  });

  it("keeps two projects' records apart", async () => {
    await writeRecordedSlug("acme", "wt-one", "eng-3941-7k2f", env);
    expect(await readRecordedSlug("demo", "wt-one", env)).toBeNull();
  });

  // Strict on the way in, because the value becomes a hostname. A bad value
  // stored here would read back as null on the next call and silently move the
  // sandbox to a different name.
  it("refuses to store something that is not a slug", async () => {
    await expect(writeRecordedSlug("acme", "wt-one", "Not A Slug", env)).rejects.toThrow(NamingError);
    expect(await readRecordedSlug("acme", "wt-one", env)).toBeNull();
  });

  it.each([
    ["no file", async () => {}],
    [
      "a file edited by hand into something that is not a slug",
      async () => {
        const file = paths(env).slugFile("acme", "wt-one");
        await mkdir(join(file, ".."), { recursive: true });
        await writeFile(file, "Whatever I Felt Like\n");
      },
    ],
    [
      "a file far longer than a slug",
      async () => {
        const file = paths(env).slugFile("acme", "wt-one");
        await mkdir(join(file, ".."), { recursive: true });
        await writeFile(file, "a".repeat(100_000));
      },
    ],
  ])("reads %s as no recorded slug", async (_name, arrange) => {
    await arrange();
    expect(await readRecordedSlug("acme", "wt-one", env)).toBeNull();
  });

  it("forgets a record, and forgetting one that is not there is not an error", async () => {
    await writeRecordedSlug("acme", "wt-one", "eng-3941-7k2f", env);
    await removeRecordedSlug("acme", "wt-one", env);
    expect(await readRecordedSlug("acme", "wt-one", env)).toBeNull();
    await expect(removeRecordedSlug("acme", "never-existed", env)).resolves.toBeUndefined();
  });
});

describe("slugToken", () => {
  it("is four characters of the slug alphabet", () => {
    for (let attempt = 0; attempt < 50; attempt += 1) {
      const token = slugToken();
      expect(token).toHaveLength(SLUG_TOKEN_LEN);
      expect(token).toMatch(/^[a-z0-9]+$/);
    }
  });
});

describe("uniqueSlug", () => {
  it("reads like the slug it replaces", () => {
    expect(uniqueSlug("eng-3941", ["eng-3941"], () => "7k2f")).toBe("eng-3941-7k2f");
  });

  it("re-rolls until the token is free", () => {
    const tokens = ["7k2f", "7k2f", "b3xq"];
    let index = 0;
    expect(uniqueSlug("eng-3941", ["eng-3941", "eng-3941-7k2f"], () => tokens[index++] as string)).toBe(
      "eng-3941-b3xq",
    );
  });

  // The ceiling is the MySQL lock-name budget, and a *given* slug is subject to
  // it exactly like a derived one. A UUID would blow it outright, which is why
  // the token is four characters.
  it("stays inside the ceiling, trimming the base rather than overflowing it", () => {
    const given = uniqueSlug("a".repeat(SLUG_MAX), [], () => "7k2f");
    expect(given.length).toBeLessThanOrEqual(SLUG_MAX);
    expect(given.endsWith("-7k2f")).toBe(true);
  });

  it("never joins with a double dash", () => {
    const base = `${"a".repeat(SLUG_MAX - 6)}-bbbbbb`;
    expect(uniqueSlug(base, [], () => "7k2f")).not.toContain("--");
  });

  it("gives up rather than looping for ever", () => {
    expect(() => uniqueSlug("eng-3941", ["eng-3941-7k2f"], () => "7k2f")).toThrow(NamingError);
  });
});

describe("worktreeKey", () => {
  it("keys a managed worktree on its directory name", async () => {
    const path = await managed("acme", "feat-eng-3941-run-selector");
    expect(worktreeKey(path, "acme", env)).toEqual({ project: "acme", worktreeDir: "feat-eng-3941-run-selector" });
  });

  // A command is legitimately run from deep inside a worktree, and it must key
  // on the worktree rather than on whatever directory somebody is standing in.
  it("keys on the worktree from a directory inside it", async () => {
    const path = await managed("acme", "feat-eng-3941-run-selector");
    const inside = join(path, "packages", "web");
    await mkdir(inside, { recursive: true });
    expect(worktreeKey(inside, undefined, env)?.worktreeDir).toBe("feat-eng-3941-run-selector");
  });

  // sandboxr never cut it, so it cannot have recorded a slug for it — and
  // inventing a key would read a stranger's file into a hostname.
  it("has no key for a checkout outside the workspace", () => {
    expect(worktreeKey("/home/someone/code/acme/.worktrees/eng-3941", "acme", env)).toBeUndefined();
    expect(worktreeKey(undefined, "acme", env)).toBeUndefined();
  });
});

describe("slugFor", () => {
  it("derives when nothing is recorded, exactly as deriveSlug would", async () => {
    const path = await managed("acme", "feat-eng-3941-run-selector");
    expect(await slugFor({ worktree: path, project: "acme", branch: "feat/eng-3941-run-selector", env })).toBe(
      "eng-3941",
    );
  });

  it("prefers a recorded slug to the one it would derive", async () => {
    const path = await managed("acme", "feat-eng-3941-run-selector");
    await writeRecordedSlug("acme", "feat-eng-3941-run-selector", "eng-3941-7k2f", env);
    expect(await slugFor({ worktree: path, project: "acme", branch: "feat/eng-3941-run-selector", env })).toBe(
      "eng-3941-7k2f",
    );
  });

  // The project name is optional because it is in the path, and it has to give
  // the same answer either way: the dashboard passes it and `up` does not.
  it("finds the record without being told the project", async () => {
    const path = await managed("acme", "feat-eng-3941-run-selector");
    await writeRecordedSlug("acme", "feat-eng-3941-run-selector", "eng-3941-7k2f", env);
    expect(await slugFor({ worktree: path, branch: "feat/eng-3941-run-selector", env })).toBe("eng-3941-7k2f");
  });

  it("lets an explicit argument beat a recorded slug", async () => {
    const path = await managed("acme", "feat-eng-3941-run-selector");
    await writeRecordedSlug("acme", "feat-eng-3941-run-selector", "eng-3941-7k2f", env);
    expect(await slugFor({ explicit: "checkout-demo", worktree: path, env })).toBe("checkout-demo");
    expect(await slugFor({ explicit: "  ", worktree: path, env })).toBe("eng-3941-7k2f");
  });

  it("ignores a record for a worktree outside the workspace", async () => {
    await writeRecordedSlug("acme", "eng-3941", "eng-3941-7k2f", env);
    expect(await slugFor({ worktree: "/home/someone/code/acme/.worktrees/eng-3941", project: "acme", env })).toBe(
      "eng-3941",
    );
  });

  // "?" is what a Worktree reports for a branch nothing could recover.
  // `deriveSlug` would sanitise it to the empty string and throw, and the
  // dashboard used to hand it straight in while `up` dropped it by hand.
  it("folds an unresolvable branch away rather than throwing on it", async () => {
    const path = await managed("acme", "spike");
    expect(await slugFor({ worktree: path, project: "acme", branch: "?", env })).toBe("spike");
  });
});
