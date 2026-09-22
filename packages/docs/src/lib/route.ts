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

/**
 * The repository, for the two links a page's footer carries.
 *
 * `sandboxer-core` and not `sandboxer`: the repository name is the one thing the
 * rename could not derive from the tool's name, and a footer link to a
 * repository that does not exist is a 404 nobody reports.
 */
export const REPO = "https://github.com/mattmoran56/sandboxer-core";

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

/**
 * The files under `docs/` that are not pages, as glob patterns for the walk.
 *
 * Short on purpose: **a page under `docs/` that this list does not name is a page
 * the sidebar must name**, and `nav.test.ts` fails when one is not. Every entry
 * here is a page the site deliberately does not publish, and each needs a reason.
 *
 * The product's half of the documentation used to be here as `jef/**`, while the
 * engine and the product shared a tree. They do not any more — there is no
 * `docs/jef/` in this repository — so the entry is gone and the rule is back to
 * being about two files.
 */
export const NOT_PAGES: readonly string[] = ["architecture/contracts.md", "**/README.md"];

/**
 * Whether one `NOT_PAGES` pattern matches one path under `docs/`.
 *
 * Three shapes, and no more: an exact path, `**\/<basename>` for a filename
 * anywhere under `docs/`, and `<dir>/**` for a whole directory. The directory
 * shape has no entry using it today and is kept because the incident that shaped
 * it is worth keeping: **a prefix pattern is a directory, not a string prefix.**
 * Written with a bare `startsWith`, `jef/**` also matched `jefferson.md` and
 * silently unpublished a page whose name merely began the same way.
 */
export const matchesNotPage = (rel: string, pattern: string): boolean => {
  if (pattern.startsWith("**/")) return rel.split("/").pop() === pattern.slice(3);
  if (pattern.endsWith("/**")) return rel.startsWith(pattern.slice(0, -2));
  return rel === pattern;
};

/** True for a path under `docs/` that `NOT_PAGES` excludes. */
export const isNotPage = (rel: string): boolean =>
  NOT_PAGES.some((pattern) => matchesNotPage(rel, pattern));

/**
 * The one directory under `docs/` that holds files rather than pages.
 *
 * An image is the only thing a page can point at that is neither another page nor
 * a URL, and it has the same problem a link has: GitHub can only follow a
 * **relative file path**, and this site serves files from its root. So every image
 * lives under `docs/assets/`, a page writes `assets/brand/mark.svg` relative to
 * itself, and both ends of the build agree on one rule — a file under `docs/assets/`
 * is served at the same path under the site root. `plugins/assets.ts` copies the
 * directory into the build; `markdown/links.ts` rewrites the path.
 *
 * It is one directory and not "any file that is not Markdown" so that the rewrite
 * has something to refuse: an image written anywhere else is left exactly as the
 * author typed it, and is visibly broken on the site rather than silently rewritten
 * to a path nothing was ever copied to.
 */
export const ASSETS_DIR = "assets";

/** True for a path under `docs/` that is one of those files. */
export const isAssetPath = (path: string): boolean => path.startsWith(`${ASSETS_DIR}/`);

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
