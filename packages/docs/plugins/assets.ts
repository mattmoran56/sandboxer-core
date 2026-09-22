// The files a page points at that are not pages: `docs/assets/`.
//
// The pages live in the repository's `docs/` directory so they read on GitHub
// without a build, and that constraint decides this file exactly as it decides
// `markdown/links.ts`. An image has to be written as a **relative file path** —
// `assets/brand/mark.svg` — because that is the only form GitHub resolves. This
// site serves files from its root, so one of the two has to be rewritten, and it
// cannot be GitHub's.
//
// The rule is therefore one sentence: **a file under `docs/assets/` is served at
// the same path under the site root.** `markdown/links.ts` rewrites the path;
// this copies the directory. Two halves of one rule, and neither works alone.
//
// It is a copy rather than an import through the bundler on purpose. A file the
// bundler processed would be content-hashed, and the hash is not something a
// Markdown file written for GitHub can know — the same string has to be a valid
// relative path in the repository and a valid URL on the site.

import { createReadStream, cpSync, existsSync } from "node:fs";
import path from "node:path";

import type { Plugin, ResolvedConfig } from "vite";

import { ASSETS_DIR } from "../src/lib/route.js";

/**
 * The site path a request has to have to be one of these files, and the file
 * under `docs/` it names — or null if it is not one.
 *
 * **The `..` check is the point of this function**, and it is why the dev
 * middleware below does not simply join the URL onto a directory. `/assets/`
 * followed by an escaped climb is the oldest static-file bug there is, and the
 * dev server runs on a machine with the whole repository on it.
 */
export const assetFileOf = (url: string): string | null => {
  const pathname = url.split(/[?#]/)[0] ?? "";
  let decoded: string;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    // A malformed `%` escape. Not a file, and not worth a stack trace.
    return null;
  }

  if (!decoded.startsWith(`/${ASSETS_DIR}/`)) return null;
  const rel = decoded.slice(1);
  // `normalize` resolves the climbs; anything still climbing is refused, as is a
  // NUL, which some filesystems truncate on.
  const normal = path.posix.normalize(rel);
  if (normal !== rel || rel.includes("\0")) return null;
  if (!normal.startsWith(`${ASSETS_DIR}/`) || normal.endsWith("/")) return null;
  return normal;
};

/** The content type for the handful of extensions a documentation image has. */
const TYPES: Readonly<Record<string, string>> = {
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".avif": "image/avif",
  ".ico": "image/x-icon",
};

export const docsAssets = (): Plugin => {
  let source = "";
  let config: ResolvedConfig;

  return {
    name: "sandboxer:docs-assets",

    configResolved(resolved) {
      config = resolved;
      // `config.root` is `packages/docs`; the content is two levels up. Derived
      // the same way `plugins/content.ts` derives it, and for the same reason.
      source = path.resolve(resolved.root, "..", "..", "docs", ASSETS_DIR);
    },

    configureServer(server) {
      // Registered here rather than from a returned function, so it runs *before*
      // Vite's own middlewares. The last of those is the SPA fallback, which
      // answers any unmatched path with `index.html` — a missing image would then
      // arrive as a page of HTML with a 200 on it, which is a confusing way to
      // find out a file is not there.
      server.middlewares.use((request, response, next) => {
        const file = request.url ? assetFileOf(request.url) : null;
        if (!file) return next();

        const on = path.join(path.dirname(source), file);
        if (!existsSync(on)) return next();

        const type = TYPES[path.extname(on).toLowerCase()];
        if (type) response.setHeader("Content-Type", type);
        // No caching in dev: an image being edited is the whole reason somebody
        // is looking at it.
        response.setHeader("Cache-Control", "no-store");
        // Streamed rather than read into memory, so a large screenshot does not
        // have to be buffered before the first byte moves.
        createReadStream(on).pipe(response);
        return undefined;
      });
    },

    writeBundle() {
      // The SSR build renders HTML strings and points at nothing on disk, and it
      // writes to `dist-ssr/`. Copying into it would put a second copy of every
      // image in a directory nothing serves.
      if (config.build.ssr) return;
      if (!existsSync(source)) return;
      cpSync(source, path.join(config.root, config.build.outDir, ASSETS_DIR), { recursive: true });
    },
  };
};
