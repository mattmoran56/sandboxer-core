// The engine imports nothing from the product (contracts §2).
//
// Covers:
// - every import specifier under src/, tests included, is relative, `node:`-prefixed,
//   or one of yaml / zod / vitest — the three packages core is allowed to name
// - package.json declares yaml and zod as dependencies and nothing else, and names
//   no `@jef/*` anywhere in the file, dev dependencies included
// - no file under src/ mentions `@jef/`, and none reaches for a `session/`, `agent/`
//   or `code/` directory that used to be here
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
 * The only bare specifiers `@sandboxr/core` may name.
 *
 * `yaml` and `zod` are its two runtime dependencies (contracts §2). `vitest` is
 * here because the walk deliberately includes `*.test.ts`: a back-reference
 * introduced in a test is still a back-reference, and excluding tests would
 * leave the easiest place to add one unguarded.
 */
const ALLOWED = new Set(["yaml", "zod", "vitest"]);

/** The directories that left for `@jef/sessions`, spelled as an import would. */
const MOVED = ['"../session/', '"../agent/', '"../code/', '"./session/', '"./agent/', '"./code/'];

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
});
