// The entry point.
//
// `hydrateRoot` and not `createRoot`. Every URL on this site is a real static file
// with the whole page already in it, written by `build/prerender.mjs`, so there is
// nothing to create — the markup is there and this attaches to it. `createRoot`
// would throw all of it away and rebuild it, which shows up as a flash on every
// load and quietly makes the prerender pointless.

import { StrictMode } from "react";
import { createRoot, hydrateRoot } from "react-dom/client";

import "./docs.css";
import { App } from "./App.js";
import { PREFS_KEY, readPrefs, resolveTheme } from "./lib/prefs.js";

/**
 * The stored preferences, on `<html>`, before React runs.
 *
 * The blocking script in `index.html` has normally already done this — it has to,
 * because the browser paints the prerendered markup before any module loads, and
 * an effect that set the theme after hydration would show a frame of the light
 * page to everybody who chose dark.
 *
 * This is not that script repeated for nothing. That one is hand-written inline
 * and cannot import anything; this one goes through the same `readPrefs` and
 * `resolveTheme` the rest of the app uses. If the two ever disagree — a scheme
 * added here and not there — the app's answer wins, and it wins before React
 * renders rather than a frame later.
 */
const first = (): void => {
  try {
    const prefs = readPrefs(localStorage.getItem(PREFS_KEY));
    const dark = window.matchMedia?.("(prefers-color-scheme: dark)").matches ?? false;
    document.documentElement.dataset.theme = resolveTheme(prefs.theme, dark);
    document.documentElement.dataset.scheme = prefs.scheme;
  } catch {
    // A browser with site data blocked throws on `localStorage` itself. The
    // stylesheet's own defaults are then what everybody gets, which is fine.
  }
};

first();

const root = document.getElementById("root");
if (!root) throw new Error("the page has no #root to hydrate");

/**
 * The body that is already in the document, handed back to React as a prop.
 *
 * Page bodies are code-split, so the browser's first render cannot know the
 * article's HTML — the chunk holding it has not been imported yet. Without this,
 * that first render would produce an empty `.sbx-prose` where the static file has
 * a whole page, and hydration would be reconciling against markup that does not
 * match.
 *
 * So the body is read straight back out of the DOM before hydrating. It is the
 * same bytes the prerender wrote, which is the one thing that makes the first
 * client render provably identical to the file being hydrated.
 */
const prose = document.querySelector<HTMLElement>(".sbx-prose[data-slug]");
const body = prose ? { slug: prose.dataset.slug ?? "", html: prose.innerHTML } : undefined;

const tree = (
  <StrictMode>
    <App body={body} />
  </StrictMode>
);

/*
 * Hydrate the built site; render the dev server's empty shell.
 *
 * Every URL of the built site is a static file with the whole page in it, so
 * `hydrateRoot` is what attaches to it — `createRoot` would throw the markup away
 * and rebuild it, which is a flash on every load and makes the prerender
 * pointless.
 *
 * `vite dev` serves `index.html` untouched, and in that file `#root` contains only
 * the `<!--app-html-->` comment the prerender replaces. Hydrating nothing is a
 * mismatch: React recovers by client-rendering anyway, but it reports a hydration
 * error first, on every page load, in the one mode where a real one would matter.
 * So the branch is on whether there is markup to hydrate, and the built site
 * always has some.
 */
if (root.childElementCount > 0) {
  hydrateRoot(root, tree);
} else {
  createRoot(root).render(tree);
}
