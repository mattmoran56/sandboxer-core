// The engine imports nothing from the product (contracts §2).
//
// Covers:
// - every import specifier under src/, tests included, is relative, `node:`-prefixed,
//   or one of yaml / zod / vitest — the three packages core is allowed to name
// - package.json declares yaml and zod as dependencies and nothing else, and names
//   no `@jef/*` anywhere in the file, dev dependencies included
// - no file under src/ mentions `@jef/`, and none reaches for a `session/`, `agent/`
//   or `code/` directory that used to be here
// - no file under src/ names the agent, with one allowlisted line that has to
// - the engine never says the name it used to have: no `sandboxr`, `SANDBOXR` or
//   `Sandboxr`, and no `@jef/` or `JEF_`, anywhere in packages/core/src,
//   packages/cli/src or container/
//
// Three assertions where one would do, and that is the point. The first
// subsumes the other two and fails with the file, the line and the specifier;
// the second and third fail with a sentence naming the rule, which is what a
// person who has just broken the boundary needs to read. This is an enforcement
// test rather than a linter because there is no linter in this repository and
// adding one for this would be disproportionate.

import { readFile, readdir } from "node:fs/promises";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const SRC = dirname(fileURLToPath(import.meta.url));
const PACKAGE_JSON = join(SRC, "..", "package.json");

/**
 * The only bare specifiers `@sandboxer/core` may name.
 *
 * `yaml` and `zod` are its two runtime dependencies (contracts §2). `vitest` is
 * here because the walk deliberately includes `*.test.ts`: a back-reference
 * introduced in a test is still a back-reference, and excluding tests would
 * leave the easiest place to add one unguarded.
 */
const ALLOWED = new Set(["yaml", "zod", "vitest"]);

/** The directories that left for `@jef/sessions`, spelled as an import would. */
const MOVED = ['"../session/', '"../agent/', '"../code/', '"./session/', '"./agent/', '"./code/'];

/**
 * The engine names no agent, and this is what catches it coming back.
 *
 * `@jef/` catches the package. It does not catch a *value*, and a value is how
 * this boundary actually broke: `CLAUDE_DIR` lived in `sandbox/layout.ts`,
 * `CLAUDE_VOLUME` in `naming.ts`, and `sandbox/run.ts` mounted one at the other
 * and set `CLAUDE_CONFIG_DIR` on every container — so `sandboxer up` on a machine
 * with no such agent installed mounted a credential store for a program that was
 * not in the image. None of it imported anything. Only a grep for the name would
 * have said so, which is why this assertion is by name and not by specifier.
 *
 * The engine takes `UpOptions.volumes` and `UpOptions.containerEnv` now, and the
 * product supplies all three, out of a package of its own.
 */
const AGENT_NAME = /claude/i;

/**
 * Lines that may name the agent anyway, each with the reason it has to.
 *
 * Keyed on the line's own text rather than on a file and a number, because a
 * number drifts with the next edit above it and an allowlist that drifts is an
 * allowlist that silently stops applying. Keyed on one line and never a file,
 * because exempting a file exempts everything somebody adds to it later.
 *
 * An incident comment that has to keep the word belongs here too. None does
 * today: every one of them was rewritten to record the same incident without
 * naming the vendor, because the rule each taught generalises and the name was
 * doing no work in it.
 */
const AGENT_NAME_ALLOWED = new Map<string, string>([
  [
    "expect(source).not.toMatch(/claude|anthropic/i);",
    "access/images.test.ts asserts that the engine's base image names no agent, " +
      "and an assertion that forbids a name has to spell it.",
  ],
]);

interface Specifier {
  file: string;
  line: number;
  specifier: string;
}

/**
 * Every import specifier in one file, with the line it is on.
 *
 * Four forms, because all four reach a module: the static `from "…"` of an
 * import or a re-export, a side-effect `import "…"`, a dynamic `import("…")`
 * and a `require("…")`. `[^;]*?` rather than a lazy `[\s\S]*?` between the
 * keyword and the `from`: the lazy form starts at one statement and runs to the
 * next one's closing quote, which silently reads two imports as one and misses
 * the first specifier entirely.
 */
function specifiersIn(file: string, text: string): Specifier[] {
  const found: Specifier[] = [];
  const at = (index: number): number => text.slice(0, index).split("\n").length;
  const patterns = [
    /^(?:import|export)\b[^;]*?\bfrom\s+["']([^"']+)["']/gm,
    /^import\s+["']([^"']+)["']/gm,
    /\bimport\(\s*["']([^"']+)["']\s*\)/g,
    /\brequire\(\s*["']([^"']+)["']\s*\)/g,
  ];
  for (const pattern of patterns) {
    for (const match of text.matchAll(pattern)) {
      found.push({ file, line: at(match.index), specifier: match[1] as string });
    }
  }
  return found;
}

/**
 * This file, which is the one file under `src/` exempt from its own rules.
 *
 * It has to spell `@jef/`, `../agent/` and a bare `import "…"` in order to
 * forbid them, so including it makes every assertion fail on the assertion's
 * own text. Nothing else is exempt, and the exemption is by path rather than by
 * a marker comment so that it cannot be claimed by a second file.
 */
const SELF = fileURLToPath(import.meta.url);

async function filesUnder(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  const out: string[] = [];
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...(await filesUnder(full)));
    else if (entry.name.endsWith(".ts") && full !== SELF) out.push(full);
  }
  return out.sort();
}

/**
 * The names this engine answered to before, and the product's, in every spelling
 * that was ever written down.
 *
 * Case-sensitive on purpose. `sandboxRule` and `sandboxRouteLabels` are
 * `sandbox` plus a capitalised word and have nothing to do with the old name, so
 * a case-insensitive rule would forbid two correct exports and teach whoever hit
 * it to weaken the test.
 *
 * `@jef/` and `JEF_` are the product's package scope and variable prefix. They
 * are here rather than only in the import rule above because a name reaches a
 * boundary through a *string* as often as through an import: a label read back,
 * a variable looked up, a comment somebody later follows.
 */
const OLD_NAMES = ["sandboxr", "SANDBOXR", "Sandboxr", "@jef/", "JEF_"] as const;

/**
 * Every tree the engine ships code in, for the old-name sweep.
 *
 * `container/` is in it because the shell scripts are the half no type-checker
 * reads: a `$SANDBOXR_D1_DIR` left behind there is an empty variable at run time
 * inside a container, which surfaces as a database that was never created.
 */
const SWEPT = [SRC, join(SRC, "..", "..", "cli", "src"), join(SRC, "..", "..", "..", "container")];

/**
 * The three files that have to say the old name, each with the reason.
 *
 * Keyed on the path relative to `packages/`, and asserted from both ends: an
 * entry whose file has stopped saying an old name is an exemption that has
 * outlived its reason, and the test fails on that too. Whole files rather than
 * lines because two of these are prose about the rename, which gets reworded.
 *
 * Nothing else may be added here without the same shape of justification. "The
 * old name is mentioned" is not one; "this is the code that tells somebody
 * their data is under the old name" is.
 */
const OLD_NAME_ALLOWED = new Map<string, string>([
  ["core/src/paths.ts", "legacyHomeNotice has to name ~/.sandboxr to tell somebody to move it"],
  ["core/src/paths.test.ts", "it drives legacyHomeNotice against a home holding the old directory"],
  ["core/src/access/images.test.ts", "it drives init against a home holding the old directory, and reads the sentence back"],
  ["core/src/secrets.ts", "it states that the old SANDBOXR_ prefix is not read, which is the rule"],
]);

/** Every file under one of the swept trees, whatever its extension. */
async function allFilesUnder(dir: string): Promise<string[]> {
  const out: string[] = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...(await allFilesUnder(full)));
    // Both boundary tests are exempt: each has to spell what it forbids.
    else if (entry.name !== "boundary.test.ts") out.push(full);
  }
  return out.sort();
}

const sources = await filesUnder(SRC);
const contents = new Map<string, string>(
  await Promise.all(sources.map(async (file) => [file, await readFile(file, "utf8")] as const)),
);

describe("the engine imports nothing from the product", () => {
  // The walk is worth asserting on its own: a test that found no files would
  // pass every assertion below and mean nothing.
  it("walks every TypeScript file in the package", () => {
    expect(sources.length).toBeGreaterThan(50);
  });

  it("names only relative paths, node: builtins, yaml, zod and vitest", () => {
    const offenders: string[] = [];
    for (const file of sources) {
      for (const found of specifiersIn(file, contents.get(file) as string)) {
        const { specifier } = found;
        if (specifier.startsWith("./") || specifier.startsWith("../")) continue;
        if (specifier.startsWith("node:")) continue;
        if (ALLOWED.has(specifier)) continue;
        offenders.push(`${relative(SRC, file)}:${found.line} imports ${specifier}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it("declares yaml and zod as its dependencies, and names no @jef package", async () => {
    const text = await readFile(PACKAGE_JSON, "utf8");
    const manifest = JSON.parse(text) as { dependencies?: Record<string, string> };
    expect(Object.keys(manifest.dependencies ?? {}).sort()).toEqual(["yaml", "zod"]);
    // The whole file and not only `dependencies`: a `@jef/*` in
    // `devDependencies` or `peerDependencies` is the same boundary failing, and
    // it would not show up as a failed import until somebody used it.
    expect(text).not.toContain("@jef/");
  });

  it("mentions no product package, and no directory that left for one", () => {
    const offenders: string[] = [];
    for (const file of sources) {
      const text = contents.get(file) as string;
      const name = relative(SRC, file);
      // Comments included, deliberately. A comment pointing at `../agent/` is a
      // path that no longer exists, and the day somebody follows it back is the
      // day the import comes with it.
      if (text.includes("@jef/")) offenders.push(`${name} mentions @jef/`);
      for (const moved of MOVED) {
        if (text.includes(moved)) offenders.push(`${name} reaches for ${moved.slice(1)}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it("names the agent nowhere, except on the one line allowed to", () => {
    const offenders: string[] = [];
    for (const file of sources) {
      const name = relative(SRC, file);
      const lines = (contents.get(file) as string).split("\n");
      for (const [index, line] of lines.entries()) {
        if (!AGENT_NAME.test(line)) continue;
        if (AGENT_NAME_ALLOWED.has(line.trim())) continue;
        offenders.push(`${name}:${index + 1} names the agent: ${line.trim()}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  // The allowlist is asserted from the other end too. An entry whose line has
  // been edited or deleted stops exempting anything and starts being a claim
  // about the codebase that is no longer true, which is how a list like this
  // rots into a list nobody can safely shorten.
  it("allows no line that is not there", () => {
    const all = [...contents.values()].flatMap((text) => text.split("\n").map((line) => line.trim()));
    for (const [line, why] of AGENT_NAME_ALLOWED) {
      expect(all, `allowlisted but absent (${why}): ${line}`).toContain(line);
    }
  });
});

describe("the engine never says the name it used to have", () => {
  // The rename from `sandboxr` to `sandboxer` was one commit and a three-
  // expression sed, and a sed is exactly the tool that leaves a name in the one
  // file nobody re-read. None of what it would leave behind is a compile error:
  // an old config filename is "this is not a project", an old label is a sandbox
  // the listing cannot see, an old variable is an empty string inside a
  // container. Every one of them looks like something other than a rename.
  //
  // **No compatibility window, by decision** (contracts §3.3). The old names are
  // not read anywhere, so a survivor is a bug and never a fallback.
  it("says no old name anywhere in core, the CLI or container/", async () => {
    const offenders: string[] = [];
    for (const dir of SWEPT) {
      for (const file of await allFilesUnder(dir)) {
        const key = relative(join(SRC, "..", ".."), file);
        if (OLD_NAME_ALLOWED.has(key)) continue;
        const text = await readFile(file, "utf8");
        for (const [index, line] of text.split("\n").entries()) {
          for (const name of OLD_NAMES) {
            if (line.includes(name)) offenders.push(`${key}:${index + 1} says ${name}`);
          }
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  it("exempts nothing that has stopped needing it", async () => {
    // The other end of the allowlist. An entry left behind after its file was
    // rewritten is a hole in the rule that nothing else would report, and a
    // fourth file could then be slipped in beside it as "one of the exceptions".
    const stale: string[] = [];
    for (const [key, reason] of OLD_NAME_ALLOWED) {
      const text = await readFile(join(SRC, "..", "..", key), "utf8");
      if (!OLD_NAMES.some((name) => text.includes(name))) stale.push(`${key} no longer says one: ${reason}`);
    }
    expect(stale).toEqual([]);
  });

  it("sweeps all three trees, and every file in them", async () => {
    // A walk that found nothing would pass the assertion above and mean nothing,
    // and the container tree is the one most easily lost to a wrong path.
    const counts = await Promise.all(SWEPT.map(async (dir) => (await allFilesUnder(dir)).length));
    for (const count of counts) expect(count).toBeGreaterThan(5);
  });
});
