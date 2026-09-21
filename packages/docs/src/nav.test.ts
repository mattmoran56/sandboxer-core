// Covers src/nav.ts against the real contents of the repository's docs/ directory:
//  - every slug the sidebar names has a file behind it (per entry, and once as a
//    single worklist of everything missing)
//  - every file that is eligible to be a page appears in the sidebar exactly once
//  - slugs are unique, and none carries a slash on either end or an extension
//  - a page's `title` frontmatter equals its sidebar label, where the file exists
//  - NAV_ORDER covers every page, and neighbours() agrees with it at both ends
//
// "Eligible to be a page" is `isNotPage` in src/lib/route.ts, the same rule the
// content loader applies, so the walk and the build cannot disagree about which
// files are pages.
//
// **This is the test that makes a hand-maintained sidebar safe to keep.** Nothing
// derives `NAV` — that is the point of it, because the order is editorial — so a
// page added under docs/ and not named there renders at its URL and is reachable
// by nobody, and a name there with no file behind it is a dead link in every
// sidebar on the site. Neither shows up as an error anywhere else.

import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { NAV, NAV_ORDER, neighbours, type NavPage } from "./nav.js";
import { isNotPage } from "./lib/route.js";

/** The content is not in this package; see plugins/content.ts for why. */
const DOCS = fileURLToPath(new URL("../../../docs/", import.meta.url));

const walk = (dir: string, prefix = ""): string[] =>
  readdirSync(dir, { withFileTypes: true })
    .sort((a, b) => (a.name < b.name ? -1 : 1))
    .flatMap((entry) => {
      if (entry.name.startsWith(".") || entry.name.startsWith("_")) return [];
      const rel = prefix === "" ? entry.name : `${prefix}/${entry.name}`;
      if (entry.isDirectory()) return walk(path.join(dir, entry.name), rel);
      if (!/\.mdx?$/.test(entry.name)) return [];
      if (isNotPage(rel)) return [];
      return [rel];
    });

/** Every page file under docs/, as a path relative to it. */
const FILES = walk(DOCS);

/**
 * The file a slug names, or null.
 *
 * Two shapes are allowed and they mean the same thing: `reference/cli` is either
 * `reference/cli.md` or `reference/cli/index.md`, and which one a page uses is a
 * decision about whether it will later grow children.
 */
const fileOf = (slug: string): string | null => {
  const candidates = slug === "" ? ["index.md"] : [`${slug}.md`, `${slug}/index.md`, `${slug}.mdx`];
  return candidates.find((candidate) => FILES.includes(candidate)) ?? null;
};

/** The candidate paths a slug could have been, for a message that says where to put it. */
const wantedAt = (slug: string): string =>
  slug === "" ? "docs/index.md" : `docs/${slug}.md (or docs/${slug}/index.md)`;

/** A page's `title`, or null if it has no frontmatter or no title in it. */
const titleOf = (file: string): string | null => {
  const source = readFileSync(path.join(DOCS, file), "utf8");
  const block = /^---\r?\n([\s\S]*?)\r?\n---/.exec(source);
  if (!block?.[1]) return null;
  const line = /^title:[ \t]*(.+)$/m.exec(block[1]);
  if (!line?.[1]) return null;
  return line[1].trim().replace(/^(['"])(.*)\1$/, "$2").trim() || null;
};

const ENTRIES: readonly NavPage[] = NAV.flatMap((group) => group.pages);

describe("every page the sidebar names exists", () => {
  it.each(ENTRIES.map((entry) => [entry.slug === "" ? "(the front page)" : entry.slug, entry] as const))(
    "%s",
    (_slug, entry) => {
      expect(fileOf(entry.slug), `${entry.label}: no file at ${wantedAt(entry.slug)}`).not.toBeNull();
    },
  );

  it("has no page left to write", () => {
    // The same assertion again, as one list. A per-entry failure says which page,
    // but a reader who is *writing* the missing pages wants all of them at once —
    // so this one prints a worklist, one file per line.
    const missing = ENTRIES.filter((entry) => fileOf(entry.slug) === null);
    expect(
      missing.length === 0,
      missing.length === 0
        ? ""
        : [
            `${missing.length} page(s) named in src/nav.ts have no file under docs/:`,
            ...missing.map((entry) => `  ${wantedAt(entry.slug)}  — "${entry.label}"`),
          ].join("\n"),
    ).toBe(true);
  });
});

describe("every page under docs/ is in the sidebar", () => {
  const slugFiles = new Map<string, NavPage[]>();
  for (const entry of ENTRIES) {
    const file = fileOf(entry.slug);
    if (!file) continue;
    slugFiles.set(file, [...(slugFiles.get(file) ?? []), entry]);
  }

  it.each(FILES)("%s", (file) => {
    const naming = slugFiles.get(file) ?? [];
    const labels = naming.map((entry) => entry.label);
    expect(
      naming.length,
      naming.length === 0
        ? `docs/${file} is not named in src/nav.ts, so nothing on the site links to it`
        : `docs/${file} is named ${naming.length} times in src/nav.ts: ${labels.join(", ")}`,
    ).toBe(1);
  });
});

describe("the slugs themselves", () => {
  it("are unique across the whole nav", () => {
    const seen = new Set<string>();
    const repeated = ENTRIES.map((entry) => entry.slug).filter((slug) => {
      if (seen.has(slug)) return true;
      seen.add(slug);
      return false;
    });
    expect(repeated, `these slugs appear more than once: ${repeated.join(", ")}`).toEqual([]);
  });

  it.each(ENTRIES.map((entry) => entry.slug).filter((slug) => slug !== ""))("%s is written as a slug", (slug) => {
    // A slug is not a URL and not a filename: `pathOfSlug` adds the slashes and
    // the loader strips the extension. A slug carrying either would produce
    // `//reference/cli//` or `/reference/cli.md/` and match nothing.
    expect(slug.startsWith("/"), "a slug has no leading slash").toBe(false);
    expect(slug.endsWith("/"), "a slug has no trailing slash").toBe(false);
    expect(/\.mdx?$/.test(slug), "a slug has no extension").toBe(false);
    expect(slug.includes("//"), "a slug has no empty segment").toBe(false);
  });

  it("has a label for every entry", () => {
    for (const entry of ENTRIES) expect(entry.label.trim()).not.toBe("");
  });
});

describe("a label is the page's title", () => {
  // AUTHORING.md requires it: the sidebar and the page heading disagreeing is how
  // a reader ends up unsure whether they clicked the right thing. Only asserted
  // where the file exists — a missing page is already a failure above, and should
  // not fail twice.
  const withFiles = ENTRIES.map((entry) => [entry, fileOf(entry.slug)] as const).filter(
    (pair): pair is readonly [NavPage, string] => pair[1] !== null,
  );

  it.each(withFiles.map(([entry, file]) => [file, entry] as const))("%s", (file, entry) => {
    const title = titleOf(file);
    if (title === null) return; // A page with no title is the loader's warning, not the nav's.
    expect(title, `docs/${file}'s title does not match its sidebar label`).toBe(entry.label);
  });
});

describe("NAV_ORDER and neighbours", () => {
  it("is every page in every group, in order", () => {
    expect(NAV_ORDER.map((entry) => entry.slug)).toEqual(ENTRIES.map((entry) => entry.slug));
  });

  it("gives the first page no previous and the last page no next", () => {
    const first = NAV_ORDER[0];
    const last = NAV_ORDER[NAV_ORDER.length - 1];
    expect(first).toBeDefined();
    expect(last).toBeDefined();
    expect(neighbours(first!.slug).prev).toBeNull();
    expect(neighbours(last!.slug).next).toBeNull();
  });

  it("steps through the whole reading order in both directions", () => {
    // Group boundaries are deliberately not walls: the last page of Getting
    // started leads to the first page of the next group, because that is the step
    // a first-time reader should be offered.
    NAV_ORDER.forEach((entry, at) => {
      const { prev, next } = neighbours(entry.slug);
      expect(prev, `prev of ${entry.slug || "(front page)"}`).toEqual(NAV_ORDER[at - 1] ?? null);
      expect(next, `next of ${entry.slug || "(front page)"}`).toEqual(NAV_ORDER[at + 1] ?? null);
    });
  });

  it("knows nothing about a slug that is not in the nav", () => {
    expect(neighbours("not/a/page")).toEqual({ prev: null, next: null });
  });
});
