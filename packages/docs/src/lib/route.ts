// Where a page lives, in all four of the forms it has to be written in.
//
// A page has a file path under `docs/`, a slug, a URL on this site, and — for the
// two links in its footer — a URL on GitHub. Every one of those is derived here,
// once, because the build, the link rewriter, the router and the sidebar all need
// the same answer and a second implementation is how a link ends up pointing at a
// page that renders but is not the one it names.
//
// **The URL shape is the one the Starlight site already served**, and that is a
// constraint rather than a preference: `/getting-started/install/` is what is in
// people's history and in whatever has already linked to it. A rewrite that
// quietly moved every page would have been a rewrite that broke every link.

/** The repository, for the two links a page's footer carries. */
export const REPO = "https://github.com/mattmoran56/sandboxr";

/**
 * Pages that live under `docs/` and are deliberately **not** part of the site.
 *
 * `contracts.md` is the engineering contract: it has no frontmatter, it is the
 * authority every package is checked against, and the documentation never edits
 * it. A link to it therefore has to leave the site rather than 404 inside it.
 *
 * `README.md` files are excluded too, but they need no entry here — a README is
 * GitHub's front door for a directory and the docs never link to one.
 */
export const OFF_SITE: Readonly<Record<string, string>> = {
  "architecture/contracts.md": `${REPO}/blob/main/docs/architecture/contracts.md`,
};

/** The files under `docs/` that are not pages, as glob patterns for the walk. */
export const NOT_PAGES: readonly string[] = ["architecture/contracts.md", "**/README.md"];

/**
 * A path under `docs/`, as a slug.
 *
 * `index.md` is the front page and its slug is the empty string; a directory's
 * `index.md` is that directory. Both of those are why the slug is a string and not
 * a non-empty one — the root really has no name.
 */
export const slugOfFile = (file: string): string =>
  file
    .replace(/\\/g, "/")
    .replace(/^\/+/, "")
    .replace(/\.mdx?$/, "")
    .replace(/(^|\/)index$/, "");

/** A slug, as the URL this site serves it at. Always ends in a slash. */
export const pathOfSlug = (slug: string): string => (slug === "" ? "/" : `/${slug}/`);

/**
 * A URL path, as a slug.
 *
 * Tolerant of a missing trailing slash, a doubled one, and a query or hash left
 * on the end, because all three arrive from somebody's address bar sooner or later.
 */
export const slugOfPath = (pathname: string): string => {
  const withoutQuery = pathname.split(/[?#]/)[0] ?? "";
  return withoutQuery.replace(/^\/+/, "").replace(/\/+$/, "");
};

/** Where a page's Markdown can be edited. */
export const editHref = (file: string): string => `${REPO}/edit/main/docs/${file}`;

/** Where a page's Markdown can be read as a file, for anybody who would rather. */
export const sourceHref = (file: string): string => `${REPO}/blob/main/docs/${file}`;
