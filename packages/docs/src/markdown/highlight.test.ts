// What this covers:
//  - every language the docs use is loaded up front and highlights
//  - dual-theme output: CSS variables for both themes, no baked-in colour
//  - an unknown language falls back to plain text instead of throwing
//  - a language Shiki has in its bundle but this file did not list is loaded on demand
//  - an empty language tag, and one with trailing junk
//  - the highlighter is built once and shared

import { describe, expect, it } from "vitest";
import { highlight, LANGS, THEMES } from "./highlight.js";

describe("highlight", () => {
  it("highlights every language the pages use", async () => {
    for (const lang of LANGS) {
      const done = await highlight("x", lang);
      expect(done.lang).toBe(lang);
      expect(done.html).toContain("<pre class=\"shiki");
    }
  });

  it("emits both themes as CSS variables, so one build serves light and dark", async () => {
    const { html } = await highlight("echo hi", "bash");
    expect(html).toContain(`${THEMES.light} ${THEMES.dark}`);
    expect(html).toContain("--shiki-light:");
    expect(html).toContain("--shiki-dark:");
    // `defaultColor: false` is what removes the plain `color:` — with one present
    // the light theme wins in both appearances and dark code is unreadable.
    expect(html).not.toMatch(/<span style="color:/);
  });

  it("escapes the source rather than emitting it raw", async () => {
    const { html } = await highlight("a < b && c", "bash");
    expect(html).not.toContain("a < b");
    expect(html).toContain("&#x3C;");
  });

  it("falls back to plain text for a language that does not exist", async () => {
    const done = await highlight("nonsense", "definitely-not-a-language");
    expect(done.lang).toBe("text");
    expect(done.html).toContain("nonsense");
  });

  it("falls back to plain text for an empty language tag", async () => {
    expect((await highlight("x", "")).lang).toBe("text");
    expect((await highlight("x", "   ")).lang).toBe("text");
  });

  it("loads a bundled language it was not asked for up front", async () => {
    // The build must not fail because a page started using a new language, and it
    // must not lose the highlighting either.
    const done = await highlight("FROM node:22\n", "dockerfile");
    expect(done.lang).toBe("dockerfile");
    expect(done.html).toContain("--shiki-light:");
  });

  it("accepts an alias of a loaded language", async () => {
    expect((await highlight("ls", "sh")).lang).toBe("sh");
    expect((await highlight("const a = 1", "ts")).lang).toBe("ts");
  });

  it("folds the case of a language tag", async () => {
    expect((await highlight("ls", "BASH")).lang).toBe("bash");
  });

  it("reuses one highlighter, so a page is not a fresh WASM load", async () => {
    // Loading a highlighter is most of a second; the second call has to be fast.
    await highlight("ls", "bash");
    const started = performance.now();
    await highlight("ls", "bash");
    expect(performance.now() - started).toBeLessThan(250);
  });
});
