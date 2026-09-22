// The half-dozen tags that are different on every page.
//
// They are built here, once, because two different things emit them: the
// prerenderer writes them into each static file as text, and the client router
// writes them onto `document` after an in-app navigation. If those two disagreed,
// a page's title would depend on whether you arrived at it or clicked to it —
// which is exactly the kind of difference nobody notices until a link somebody
// shared has the wrong title on it.

import { pathOfSlug } from "./route.js";

/**
 * Where the site is served from.
 *
 * **The default is a placeholder and nothing has been deployed to it.** This
 * repository's own `docs/reference/status.md` says remote deployment does not
 * exist yet, so a canonical URL asserting a live origin would be a claim nobody
 * has run. It is here because a canonical link and an `og:url` have to be
 * absolute to mean anything at all; set `SANDBOXER_DOCS_URL` at build time to the
 * origin the files are actually served from.
 *
 * `process` is reached through a guard because this module also runs in the
 * browser, where Vite does not define it and a bare `process.env` is a
 * `ReferenceError` at import time — one that takes the whole app down before
 * anything renders.
 */
export const SITE_URL = (
  (typeof process !== "undefined" ? process.env?.SANDBOXER_DOCS_URL : undefined) ?? "https://sandboxer.dev"
).replace(/\/+$/, "");

export interface HeadTags {
  title: string;
  description: string;
  canonical: string;
}

/**
 * A page's tags.
 *
 * The front page is titled `sandboxer documentation` rather than
 * `Welcome — sandboxer`, because the front page's title is the site's name in a
 * bookmark bar and in a search result, and "Welcome" names nothing.
 */
export const headOf = (page: { slug: string; title: string; description: string }): HeadTags => ({
  title: page.slug === "" ? "sandboxer documentation" : `${page.title} — sandboxer`,
  description: page.description,
  canonical: `${SITE_URL}${pathOfSlug(page.slug)}`,
});

/** The tags as HTML, for the static file. */
export const headHtml = (tags: HeadTags): string =>
  [
    `<title>${escapeText(tags.title)}</title>`,
    `<meta name="description" content="${escapeAttribute(tags.description)}" />`,
    `<link rel="canonical" href="${escapeAttribute(tags.canonical)}" />`,
    `<meta property="og:title" content="${escapeAttribute(tags.title)}" />`,
    `<meta property="og:description" content="${escapeAttribute(tags.description)}" />`,
    `<meta property="og:type" content="article" />`,
    `<meta property="og:url" content="${escapeAttribute(tags.canonical)}" />`,
    `<meta name="twitter:card" content="summary" />`,
  ].join("\n    ");

/**
 * The same tags, on `document`, for a client-side navigation.
 *
 * A no-op without a `document`, so it is safe to call from code that also runs in
 * the server pass. The server's path is `headHtml`, not this.
 */
export const applyHead = (tags: HeadTags): void => {
  if (typeof document === "undefined") return;
  document.title = tags.title;
  setMeta("name", "description", tags.description);
  setMeta("property", "og:title", tags.title);
  setMeta("property", "og:description", tags.description);
  setMeta("property", "og:type", "article");
  setMeta("property", "og:url", tags.canonical);
  setMeta("name", "twitter:card", "summary");
  setCanonical(tags.canonical);
};

/** Updates the tag if the prerendered HTML already carried one, and adds it if not. */
const setMeta = (key: "name" | "property", value: string, content: string): void => {
  const selector = `meta[${key}="${value}"]`;
  let tag = document.head.querySelector<HTMLMetaElement>(selector);
  if (!tag) {
    tag = document.createElement("meta");
    tag.setAttribute(key, value);
    document.head.append(tag);
  }
  tag.setAttribute("content", content);
};

const setCanonical = (href: string): void => {
  let tag = document.head.querySelector<HTMLLinkElement>('link[rel="canonical"]');
  if (!tag) {
    tag = document.createElement("link");
    tag.rel = "canonical";
    document.head.append(tag);
  }
  tag.href = href;
};

// A title is text and an attribute is quoted, and the two need different
// escaping. Both are here rather than borrowed from the markdown pipeline because
// a page's title and description come from frontmatter somebody typed, and a
// stray `"` in a description used to end the attribute and put the rest of the
// sentence into the tag as markup.
const escapeText = (value: string): string =>
  value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

const escapeAttribute = (value: string): string => escapeText(value).replace(/"/g, "&quot;");
