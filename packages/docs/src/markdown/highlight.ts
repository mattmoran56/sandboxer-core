// Syntax highlighting, at build time only.
//
// Shiki runs in Node during the build and its output is plain HTML with inline
// styles, so nothing is fetched and no highlighter ships to the browser. That is
// not a preference: the site loads no script from another origin, at build time or
// after it, and a client-side highlighter would also mean every code block on the
// page arriving unstyled and then reflowing.
//
// **Two decisions here are about build time rather than output.**
//
// The highlighter is created once and shared by every page. Creating one loads the
// WASM regex engine and every grammar and theme, which is most of a second; doing
// it per page turned a fifty-page build into minutes. It is held as a *promise* and
// not an instance so that two pages rendering concurrently share the one
// construction instead of racing to start two.
//
// The grammar list is the languages the pages actually use, and no more. Each
// grammar is a sizeable JSON file that has to be parsed, and loading Shiki's whole
// bundle to serve six languages is time spent on nothing. An unknown language is
// handled by loading it on demand — see `highlight` — so a page that gains a new
// language keeps working without an edit here.

import type { Highlighter } from "shiki";

import { escapeText } from "./escape.js";

/**
 * The two themes, emitted together as CSS variables.
 *
 * One build has to serve both appearances, because the theme is an attribute on
 * `<html>` that a reader can change after the page has loaded — a single-theme
 * render is baked into the HTML and cannot follow it. Shiki's dual-theme output
 * puts `--shiki-light` and `--shiki-dark` on every span and lets CSS choose, which
 * costs a little markup and nothing at runtime.
 *
 * `github-light` and `github-dark` because the pages are read on GitHub too, and a
 * command highlighted one way there and another way here reads as two different
 * commands. They also sit correctly on this site's code background — `--sb-sunken`,
 * which is a very light grey and a near-black navy: GitHub's foregrounds are
 * `#24292e` and `#e1e4e8`, so both are around 12:1 on it, and none of the accent
 * hues drops near the 4.5:1 floor.
 */
export const THEMES = { light: "github-light", dark: "github-dark" } as const;

/**
 * The grammars loaded up front: every fence language present in `docs/`.
 *
 * `bash` also answers `sh`, `shell` and `zsh`, and `typescript` answers `ts`, so
 * the aliases the pages use are covered without listing them.
 */
export const LANGS = ["bash", "yaml", "json", "jsonc", "sql", "typescript"] as const;

/** Shiki's own name for "do not highlight this". Always available, never throws. */
const PLAIN = "text";

let started: Promise<Highlighter> | undefined;

/** The shared highlighter. First caller builds it; everyone else waits on the same promise. */
const highlighter = (): Promise<Highlighter> => {
  started ??= import("shiki").then((shiki) =>
    shiki.createHighlighter({ themes: [THEMES.light, THEMES.dark], langs: [...LANGS] }),
  );
  return started;
};

export interface Highlighted {
  /** Shiki's `<pre class="shiki …">…</pre>`. */
  html: string;
  /** The language it was actually highlighted as: the fence's, or `"text"`. */
  lang: string;
}

/**
 * One code block, highlighted.
 *
 * **Never throws.** Shiki throws on a language it has not loaded, and a fence with
 * a typo in its tag — or a language a page has newly started using — must not fail
 * the build of the whole site. So an unknown tag is first tried against Shiki's
 * bundle and loaded if it is a real language, and only then falls back to plain
 * text. The fallback keeps the block, the copy button and the styling; it loses
 * only the colours.
 */
export const highlight = async (code: string, lang: string): Promise<Highlighted> => {
  const shiki = await highlighter();
  const wanted = lang.trim().toLowerCase();
  const usable = wanted === "" ? PLAIN : await ensureLanguage(shiki, wanted);

  try {
    return { html: shiki.codeToHtml(code, { lang: usable, themes: THEMES, defaultColor: false }), lang: usable };
  } catch {
    // Reached only if plain text itself fails, which would mean the highlighter is
    // broken rather than the page. The code is still emitted, escaped by hand and
    // wearing Shiki's class so it is styled: a build that loses the contents of
    // every code block is worse than one that loses their colours, and silently so.
    return { html: `<pre class="shiki"><code>${escapeText(code)}</code></pre>`, lang: PLAIN };
  }
};

/** The language to ask Shiki for: `wanted` if it can serve it, otherwise plain text. */
const ensureLanguage = async (shiki: Highlighter, wanted: string): Promise<string> => {
  if (shiki.getLoadedLanguages().includes(wanted)) return wanted;

  try {
    const { bundledLanguages, bundledLanguagesAlias } = await import("shiki");
    if (!(wanted in bundledLanguages) && !(wanted in bundledLanguagesAlias)) return PLAIN;
    await shiki.loadLanguage(wanted as Parameters<Highlighter["loadLanguage"]>[0]);
    return wanted;
  } catch {
    return PLAIN;
  }
};
