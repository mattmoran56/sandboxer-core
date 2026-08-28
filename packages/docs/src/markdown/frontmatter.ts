// The frontmatter block, parsed without a YAML library.
//
// There is no YAML dependency here on purpose. AUTHORING.md makes the frontmatter
// a closed shape — exactly two required keys and one optional one, each a single
// `key: value` line — so what a YAML parser would buy is the ability to accept
// shapes the contract already forbids, at the cost of a dependency that has to be
// kept current for the rest of the site's life.
//
// **What is deliberately not supported**, and would be a bug in the page rather
// than in this file:
//
//  - block scalars (`description: |` / `>-`) and any value continued on a second line
//  - nested maps, sequences, anchors, aliases, tags, multiple documents
//  - single-quoted values with an escaped quote inside (`'it''s'`); double-quoted
//    values with a backslash escape inside (`"a \" b"`)
//  - any key other than the three named below — an unknown key is ignored, not an error
//
// The one real YAML rule that *is* implemented is the comment rule, because
// AUTHORING.md's own example uses it: `tableOfContents: false   # optional`. In
// YAML an unquoted scalar ends at the first ` #`, and a quoted one does not, so a
// description containing " #" has to be quoted. Doing it any other way — always
// stripping, or never — breaks one of those two cases.

import type { Frontmatter } from "./types.js";

/** What the caller needs to decide whether the page is publishable. */
export interface ParsedFrontmatter {
  frontmatter: Frontmatter;
  /** The page's Markdown, with the frontmatter block removed. */
  body: string;
  /**
   * Why this page cannot be published, in words, or empty if it can.
   *
   * A page with no frontmatter is *expected* during development — the sidebar is
   * written before the pages are — so this is a report and not an exception. The
   * loader warns and skips; nothing throws, because one unwritten page must not
   * fail a build.
   */
  problems: readonly string[];
}

/** The default for the optional key: every page has a contents column unless it says not to. */
const DEFAULT_TABLE_OF_CONTENTS = true;

/**
 * Splits the leading `---` block off the source.
 *
 * The opening fence must be the very first thing in the file, which is also
 * GitHub's rule — a `---` after a blank line is a horizontal rule, and a page
 * whose frontmatter is one line too low renders its own metadata as a table.
 */
const FRONTMATTER_BLOCK = /^---[ \t]*\r?\n([\s\S]*?)\r?\n?---[ \t]*(?:\r?\n|$)/;

/** Strips the wrapping quotes from a value, or applies YAML's trailing-comment rule. */
const readScalar = (raw: string): string => {
  const value = raw.trim();
  if ((value.startsWith('"') && value.endsWith('"') && value.length > 1) ||
      (value.startsWith("'") && value.endsWith("'") && value.length > 1)) {
    return value.slice(1, -1);
  }
  // Unquoted: everything from the first ` #` onwards is a comment.
  return value.replace(/\s+#.*$/, "").trim();
};

export const parseFrontmatter = (source: string): ParsedFrontmatter => {
  // A byte-order mark ahead of the `---` stops the fence matching, and the
  // symptom is "this one page has no frontmatter" with a file that looks correct
  // in every editor. Editors on Windows add it.
  const text = source.replace(/^﻿/, "");
  const match = FRONTMATTER_BLOCK.exec(text);

  if (!match || match[1] === undefined) {
    return {
      frontmatter: { title: "", description: "", tableOfContents: DEFAULT_TABLE_OF_CONTENTS },
      body: text,
      problems: ["no frontmatter block: the file must open with a --- fence"],
    };
  }

  const fields = new Map<string, string>();
  for (const line of match[1].split(/\r?\n/)) {
    if (line.trim() === "" || line.trimStart().startsWith("#")) continue;
    const at = line.indexOf(":");
    if (at < 0) continue;
    fields.set(line.slice(0, at).trim(), line.slice(at + 1));
  }

  const problems: string[] = [];
  const title = readScalar(fields.get("title") ?? "");
  const description = readScalar(fields.get("description") ?? "");
  if (title === "") problems.push("frontmatter has no title");
  if (description === "") problems.push("frontmatter has no description");

  let tableOfContents = DEFAULT_TABLE_OF_CONTENTS;
  const rawToc = fields.get("tableOfContents");
  if (rawToc !== undefined) {
    const value = readScalar(rawToc);
    if (value === "true" || value === "false") tableOfContents = value === "true";
    else problems.push(`tableOfContents must be true or false, not ${JSON.stringify(value)}`);
  }

  return {
    frontmatter: { title, description, tableOfContents },
    body: text.slice(match[0].length),
    problems,
  };
};
