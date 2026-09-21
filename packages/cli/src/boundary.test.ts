// The `sandboxr` command imports nothing from the product (contracts §2).
//
// Covers:
// - every import specifier under src/, tests included, is relative, `node:`-prefixed,
//   `@sandboxr/core`, or vitest
// - package.json declares `@sandboxr/core` as its only dependency and names no
//   `@jef/*` anywhere in the file
//
// The cut-down half of `packages/core/src/boundary.test.ts`, and it exists for
// its own reason rather than for symmetry: the CLI is the engine's whole face,
// so a product import here would ship in the binary a colleague installs. It
// touches no session, no agent and no dashboard today, and this is what keeps
// that true.

import { readFile, readdir } from "node:fs/promises";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const SRC = dirname(fileURLToPath(import.meta.url));
const PACKAGE_JSON = join(SRC, "..", "package.json");

/** The engine, and the test runner. Nothing else. */
const ALLOWED = new Set(["@sandboxr/core", "vitest"]);

/** This file, exempt for core's copy's reason: it must spell what it forbids. */
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

/** See the note in core's copy: `[^;]*?` and not a lazy `[\s\S]*?`. */
const PATTERNS = [
  /^(?:import|export)\b[^;]*?\bfrom\s+["']([^"']+)["']/gm,
  /^import\s+["']([^"']+)["']/gm,
  /\bimport\(\s*["']([^"']+)["']\s*\)/g,
  /\brequire\(\s*["']([^"']+)["']\s*\)/g,
];

const sources = await filesUnder(SRC);

describe("the CLI imports nothing from the product", () => {
  it("walks every TypeScript file in the package", () => {
    expect(sources.length).toBeGreaterThan(3);
  });

  it("names only relative paths, node: builtins, @sandboxr/core and vitest", async () => {
    const offenders: string[] = [];
    for (const file of sources) {
      const text = await readFile(file, "utf8");
      const at = (index: number): number => text.slice(0, index).split("\n").length;
      for (const pattern of PATTERNS) {
        for (const match of text.matchAll(pattern)) {
          const specifier = match[1] as string;
          if (specifier.startsWith("./") || specifier.startsWith("../")) continue;
          if (specifier.startsWith("node:")) continue;
          if (ALLOWED.has(specifier)) continue;
          offenders.push(`${relative(SRC, file)}:${at(match.index)} imports ${specifier}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  it("declares @sandboxr/core as its only dependency, and names no @jef package", async () => {
    const text = await readFile(PACKAGE_JSON, "utf8");
    const manifest = JSON.parse(text) as { dependencies?: Record<string, string> };
    expect(Object.keys(manifest.dependencies ?? {})).toEqual(["@sandboxr/core"]);
    expect(text).not.toContain("@jef/");
  });
});
