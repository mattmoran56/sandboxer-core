// What this covers:
// - `prepareTemplate`, run on the real `index.html`, strips the shell's `<title>`
//   without disturbing the comment above it — the comment whose own explanatory
//   text contains the string "<title>" and once broke an unanchored version of
//   this same regex.
// - `prepareTemplate` throws when the `<!--app-head-->`/`<!--app-html-->`
//   placeholders it depends on are missing.
// - `fillTemplate`, run after `prepareTemplate` on a fixture shaped like a real
//   `vite build` shell (title-inside-a-comment trap, injected stylesheet and
//   module script), produces a page with exactly one `<title>`, a stylesheet
//   `<link>`, a module `<script>`, and the rendered `#root` markup.

import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { prepareTemplate, fillTemplate } from "./prerender.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const indexHtmlPath = path.resolve(here, "..", "index.html");

describe("prepareTemplate", () => {
  it("strips the shell's <title> from the real index.html and keeps the comment above it closed", async () => {
    const raw = await readFile(indexHtmlPath, "utf8");

    const template = prepareTemplate(raw);

    // The comment that explains the strip — and contains the literal text
    // "<title>" as an example — must still close right before the placeholder
    // that used to sit a line below the stripped title. If the strip ever eats
    // into the comment again, its "-->" and "<!--app-head-->" stop being
    // adjacent like this.
    expect(template).toMatch(/-->\s*<!--app-head-->/);
    expect(template).toContain("<!--app-head-->");
    // Not a bare `.not.toContain("<title>")`: the comment above the stripped
    // element deliberately keeps the literal text "<title>" as an example, and
    // that text must survive. What must be gone is the *element*.
    expect(template).not.toMatch(/<title>[^<]*<\/title>/);
  });

  it("throws when the app-head/app-html placeholders are missing", () => {
    expect(() =>
      prepareTemplate("<html><head><title>x</title></head><body></body></html>"),
    ).toThrow(/app-head|app-html/);
  });
});

describe("fillTemplate", () => {
  it("produces a prerendered page with one title, a stylesheet, a module script and the rendered markup", () => {
    // Shaped like `vite build`'s output: the shell carries the same
    // title-inside-a-comment trap as the real index.html, plus the stylesheet
    // <link> and module <script> tags vite injects — the tags the original bug
    // stranded inside an unterminated comment.
    const shell = [
      "<!doctype html>",
      '<html lang="en">',
      "  <head>",
      '    <meta charset="utf-8" />',
      "    <!--",
      "      A document with two <title>s keeps the first, so this one is",
      "      stripped before the real one is substituted.",
      "    -->",
      "    <title>sandboxer documentation</title>",
      "    <!--app-head-->",
      '    <script type="module" crossorigin src="/assets/index-abc123.js"></script>',
      '    <link rel="stylesheet" crossorigin href="/assets/index-abc123.css">',
      "  </head>",
      "  <body>",
      '    <div id="root"><!--app-html--></div>',
      "  </body>",
      "</html>",
      "",
    ].join("\n");

    const template = prepareTemplate(shell);
    const page = fillTemplate(template, {
      head: "<title>Welcome</title>",
      html: "<p>content</p>",
    });

    // The fixture's comment also contains the literal text "<title>", so this
    // counts whole elements, not the substring.
    expect(page.match(/<title>[^<]*<\/title>/g)).toHaveLength(1);
    expect(page).toMatch(/<link rel="stylesheet"[^>]*>/);
    expect(page).toMatch(/<script type="module"[^>]*><\/script>/);
    expect(page).toContain('<div id="root"><p>content</p></div>');
  });
});
