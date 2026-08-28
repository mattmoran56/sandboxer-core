// Links between pages, rewritten from the only form GitHub can follow.
//
// This is a port of the Astro site's `rehypeDocLinks`, and its reasoning is worth
// keeping whole. The content lives in the repository's `docs/` directory as plain
// Markdown so that anyone can read it without running a site generator. That
// constraint is what this file pays for: a link from one page to another is
// written as a **relative file path** (`../reference/cli.md`), because that is the
// only form GitHub resolves from a file in a directory, and the site serves clean
// URLs (`/reference/cli/`) instead. One of the two forms has to be rewritten, and
// it cannot be GitHub's.
//
// An absolute site path (`/reference/cli/`) in a page is therefore a bug, not a
// shortcut: it works here and 404s on GitHub. This file leaves it alone rather
// than repairing it, so the mistake stays visible.
//
// What is new relative to the Astro version: a link that leaves the site is
// reported as such, so the renderer can add `target="_blank" rel="noreferrer"`.
// That is the reason an off-site link has to be *distinguishable* rather than
// merely correct.

import { posix } from "node:path";
import { OFF_SITE, pathOfSlug, slugOfFile } from "../lib/route.js";

export interface ResolvedHref {
  href: string;
  /** True when following it leaves this site, and so should open in a new tab. */
  external: boolean;
}

/**
 * A relative link to a Markdown file, with an optional anchor.
 *
 * The `[^:#?]+` head is what keeps a scheme (`https:`), a bare anchor (`#x`) and a
 * query out: anything with a colon before the extension is a URL and not a path.
 */
const RELATIVE_DOC_LINK = /^[^:#?]+\.mdx?(#.*)?$/;

/** Anything with a scheme. Matched case-insensitively; `MAILTO:` is a scheme too. */
const HAS_SCHEME = /^[a-z][a-z0-9+.-]*:/i;

/**
 * One href, as this site should serve it.
 *
 * `file` is the linking page's path under `docs/` — `getting-started/install.md` —
 * because a relative link resolves against the page's *directory* and nothing else
 * in the pipeline knows which page it is rendering.
 */
export const resolveDocHref = (href: string, file: string): ResolvedHref => {
  // An absolute site path and a bare anchor are already what they should be. A
  // bare anchor especially: it is a link within the page, and resolving it
  // against the page's directory would turn it into a link to the directory.
  if (href.startsWith("/") || href.startsWith("#")) return { href, external: false };

  if (HAS_SCHEME.test(href)) {
    // `mailto:` and `tel:` leave the browser rather than the site, and a new tab
    // for one is an empty tab left behind after the mail client opens.
    const external = /^https?:/i.test(href);
    return { href, external };
  }

  if (!RELATIVE_DOC_LINK.test(href)) return { href, external: false };

  const [target = "", hash] = splitHash(href);
  // Resolved *relatively*, so the result is a path under `docs/` and never carries
  // the machine's own directory into a URL. Deliberately not joined onto a leading
  // `/`: `posix.normalize` swallows a `..` that climbs above the root, which would
  // turn `../../CONTRIBUTING.md` into a link to a page called CONTRIBUTING that
  // does not exist. Kept relative, that climb survives as a leading `..` and can
  // be recognised below.
  //
  // `\` is folded to `/` first. A link written on Windows with a backslash
  // otherwise resolves to one path segment containing one, which reaches the href
  // as a literal `%5C`.
  const path = posix.normalize(posix.join(posix.dirname(file.split("\\").join("/")), target));

  // A `../` chain that climbs out of `docs/` has no page behind it, and neither
  // does an empty path. `slugOfFile` would happily make a slug of either, so both
  // are left exactly as the author wrote them.
  if (path === "" || path === ".." || path.startsWith("../")) return { href, external: false };

  const offSite = OFF_SITE[path];
  if (offSite) return { href: hash ? `${offSite}#${hash}` : offSite, external: true };

  return { href: pathOfSlug(slugOfFile(path)) + (hash ? `#${hash}` : ""), external: false };
};

/** Splits `path#anchor`, keeping any further `#` inside the anchor. */
const splitHash = (href: string): [string, string | undefined] => {
  const at = href.indexOf("#");
  return at < 0 ? [href, undefined] : [href.slice(0, at), href.slice(at + 1)];
};
