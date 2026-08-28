// The server half of the site, which exists only so there is no server.
//
// There is nowhere to run one: the documentation is a directory of files on a
// static host. So the whole site is rendered here, once, at build time, and
// `build/prerender.mjs` writes the result out as one `index.html` per route. Two
// things follow from that, and both are the reason it is worth the second build:
//
//  - **A deep link works.** `/reference/cli/` is a real file, so a static host
//    serves it without a rewrite rule, and nothing about the site depends on the
//    host being configured a particular way.
//  - **A page reads with JavaScript off**, and reads to a crawler. The article's
//    body is in the markup, not fetched after hydration.
//
// The body is awaited before rendering for exactly that reason. `pages[].load()`
// is a dynamic import — the bodies are code-split — and a page rendered without
// awaiting it would prerender to the chrome and an empty article, which looks
// like a working build right up until somebody reads it.

import { renderToString } from "react-dom/server";
import { pages } from "virtual:docs-content";

import { App } from "./App.js";
import { headHtml, headOf } from "./lib/head.js";
import { pathOfSlug, slugOfPath } from "./lib/route.js";
import { NAV_ORDER } from "./nav.js";

/**
 * Every URL path the site has a static file for.
 *
 * Ordered by `NAV_ORDER`, so the prerenderer's output reads in the site's own
 * reading order and a diff of the build is legible.
 *
 * **A slug the nav names with no page behind it is not a route.** Pages are
 * written and the sidebar is updated at different moments, and a build that
 * insisted on every named page existing would be unbuildable for as long as one
 * was outstanding. `nav.test.ts` is where that gap is supposed to hurt.
 *
 * A page that exists and the nav does *not* name still gets a file, appended at
 * the end. That is a nav bug — `nav.test.ts` fails on it too — but skipping the
 * file would turn a one-line omission into a 404 on a page somebody may already
 * have linked to.
 */
export const routes = (): string[] => {
  const available = new Set(pages.map((page) => page.slug));
  const named = NAV_ORDER.filter((entry) => available.has(entry.slug)).map((entry) => entry.slug);
  const listed = new Set(named);
  const unlisted = pages.map((page) => page.slug).filter((slug) => !listed.has(slug));
  return [...named, ...unlisted].map(pathOfSlug);
};

/** One page, rendered to HTML for its static file. */
export const render = async (path: string): Promise<{ html: string; head: string }> => {
  const slug = slugOfPath(path);
  const page = pages.find((candidate) => candidate.slug === slug);

  // The 404 shell. It is a real render rather than a hand-written page so the
  // header, the sidebar and the search dialog are all there — somebody who
  // mistypes a URL should land somewhere they can navigate out of.
  if (!page) {
    return {
      head: [
        "<title>Not found — sandboxr</title>",
        // No canonical and no Open Graph: this file answers every wrong URL on
        // the site, and a canonical link would be claiming they are all one page.
        '<meta name="robots" content="noindex" />',
      ].join("\n    "),
      html: renderToString(<App path={pathOfSlug(slug)} />),
    };
  }

  const body = await page.load();
  return {
    head: headHtml(headOf(page)),
    html: renderToString(<App path={pathOfSlug(slug)} body={{ slug: page.slug, html: body.html }} />),
  };
};
