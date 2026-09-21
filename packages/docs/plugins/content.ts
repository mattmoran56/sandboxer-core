// Where the site's content comes from.
//
// **The pages are not in this package.** They live in the repository's `docs/`
// directory as plain Markdown, so somebody who opens the repository on GitHub can
// read the documentation there, in order, without running a site generator. This
// package is only the machinery that also publishes it as a site, so it reaches
// back up for its content rather than owning it.
//
// Three things under `docs/` are deliberately not pages, and all three come from
// `NOT_PAGES` in `src/lib/route.ts` rather than being restated here:
//
//  - `architecture/contracts.md` is the engineering contract. It has no
//    frontmatter, it is the authority every package is checked against, and the
//    documentation never edits it — so it is linked to on GitHub (`OFF_SITE`)
//    rather than rendered here.
//  - `README.md` files are GitHub's own front door for a directory. The site uses
//    each group's `index.md` for the same job.
//  - `jef/` is the product's half of the documentation. This site is the engine's
//    and leaves with it; Jef's pages stay readable on GitHub and get a site of
//    their own later.
//
// A leading `_` on a basename is excluded too: it is the conventional mark for a
// draft or a fragment, and it is what the Astro glob this replaced used.
//
// Everything a page becomes is decided here, in Node, at build time: frontmatter
// parsed, Markdown rendered, fences highlighted, headings collected, search text
// extracted. The browser never sees a Markdown file and never parses one.

import { execFileSync } from "node:child_process";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";

import type { Plugin, ResolvedConfig } from "vite";

import { isNotPage, slugOfFile } from "../src/lib/route.js";
import { parseFrontmatter, render } from "../src/markdown/render.js";
import { toPlainText } from "../src/markdown/text.js";
import type { PageMeta, SearchDoc } from "../src/types.js";

/** Everything the app needs, in one module: `PageMeta` plus a `load()` per page. */
const CONTENT_ID = "virtual:docs-content";

/** The search corpus, on its own so the search dialog can import it lazily. */
const SEARCH_ID = "virtual:docs-search";

/** One module per page body, so each body is its own chunk. See `pageId`. */
const PAGE_PREFIX = "virtual:docs-page/";

/**
 * The id a page's body module has *inside* the bundler.
 *
 * Keyed on the file path with the extension dropped rather than on the slug,
 * because the front page's slug is the empty string and `virtual:docs-page/` is
 * not an id. The file path is unique by construction and reads well as a chunk
 * name.
 */
const pageId = (file: string): string => `${PAGE_PREFIX}${file.replace(/\.mdx?$/, "")}`;

/** Rollup's convention: a `\0` prefix marks an id no filesystem should be asked about. */
const own = (id: string): string => `\0${id}`;

interface LoadedPage {
  meta: PageMeta;
  html: string;
  /** The body as plain text, for the search corpus. */
  text: string;
}

export const docsContent = (): Plugin => {
  let docsDir = "";
  let repoRoot = "";
  let warn: (message: string) => void = (message) => console.warn(message);

  // Two caches with different lifetimes. `listing` is the filesystem walk, thrown
  // away when a file is added or deleted; `rendered` is per file, thrown away only
  // for the file that changed, because rendering is the expensive half (Shiki) and
  // editing one page should not re-highlight forty.
  let listing: string[] | null = null;
  const rendered = new Map<string, Promise<LoadedPage | null>>();
  const dates = new Map<string, string | null>();

  const walk = (dir: string, prefix: string): string[] => {
    const out: string[] = [];
    // Sorted, so `pages` has a stable order across machines. Nothing derives the
    // sidebar from it — that is `src/nav.ts` — but an unstable order would move
    // chunk contents around between builds for no reason.
    for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1))) {
      if (entry.name.startsWith(".") || entry.name.startsWith("_")) continue;
      const rel = prefix === "" ? entry.name : `${prefix}/${entry.name}`;
      if (entry.isDirectory()) {
        out.push(...walk(path.join(dir, entry.name), rel));
        continue;
      }
      if (!/\.mdx?$/.test(entry.name)) continue;
      if (isNotPage(rel)) continue;
      out.push(rel);
    }
    return out;
  };

  const files = (): string[] => (listing ??= walk(docsDir, ""));

  /**
   * The ISO date of the last commit that touched a page, or null.
   *
   * Null is a real answer in two different situations and neither is a failure: a
   * page that has been written but not committed has no date, and a checkout with
   * no git history — a tarball, a Docker build context, a CI shallow clone that
   * did not fetch the file's history — has none either. Both used to surface as a
   * build that died on `git` exiting non-zero, which is a spectacular way to fail
   * a documentation build.
   */
  const lastUpdated = (file: string): string | null => {
    const cached = dates.get(file);
    if (cached !== undefined) return cached;
    let answer: string | null = null;
    try {
      const out = execFileSync("git", ["log", "-1", "--format=%cI", "--", `docs/${file}`], {
        cwd: repoRoot,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
      });
      answer = out.trim() === "" ? null : out.trim();
    } catch {
      answer = null;
    }
    dates.set(file, answer);
    return answer;
  };

  /**
   * One page, rendered — or null, with a warning, if it cannot be.
   *
   * **Nothing here may throw.** Eleven of the pages `src/nav.ts` names are being
   * written while this is being read, and a half-written page is the normal state
   * of this directory rather than an exception: a build that died on one would
   * make the whole site unbuildable until every page landed. A skipped page shows
   * up in the sidebar as a dimmed entry (agent D's Sidebar) and in `nav.test.ts`
   * as a failure, which are the two places somebody will actually see it.
   */
  const renderOne = (file: string): Promise<LoadedPage | null> => {
    const existing = rendered.get(file);
    if (existing) return existing;

    const work = (async (): Promise<LoadedPage | null> => {
      const where = `docs/${file}`;
      let source: string;
      try {
        source = readFileSync(path.join(docsDir, file), "utf8");
      } catch (error) {
        warn(`[docs] skipped ${where}: could not be read (${describe(error)})`);
        return null;
      }

      // Checked before rendering so the message can say which of the two problems
      // it is. A page with no frontmatter block at all is usually a file that was
      // never meant to be a page; a page with a block but no title is usually a
      // draft mid-edit.
      if (!/^---\r?\n/.test(source)) {
        warn(`[docs] skipped ${where}: no frontmatter. A page needs a title and a description.`);
        return null;
      }

      try {
        const { frontmatter } = parseFrontmatter(source);
        if (frontmatter.title.trim() === "") {
          warn(`[docs] skipped ${where}: its frontmatter has no title.`);
          return null;
        }
        if (frontmatter.description.trim() === "") {
          // Kept, not skipped: the description is the page's subtitle, its search
          // summary and its meta description, and all three degrade to empty
          // gracefully. AUTHORING.md still requires one.
          warn(`[docs] ${where} has no description. It is the page's subtitle and its search summary.`);
        }

        const { frontmatter: front, html, headings } = await render({ source, file });
        const meta: PageMeta = {
          slug: slugOfFile(file),
          file,
          title: front.title,
          description: front.description,
          headings,
          tableOfContents: front.tableOfContents,
          lastUpdated: lastUpdated(file),
        };
        return { meta, html, text: toPlainText(html) };
      } catch (error) {
        warn(`[docs] skipped ${where}: it did not render (${describe(error)})`);
        return null;
      }
    })();

    rendered.set(file, work);
    return work;
  };

  const all = async (): Promise<LoadedPage[]> => {
    const loaded = await Promise.all(files().map(renderOne));
    return loaded.filter((page): page is LoadedPage => page !== null);
  };

  /** `virtual:docs-content`: every page's metadata, and a dynamic import per body. */
  const contentModule = async (): Promise<string> => {
    const pages = await all();
    const entries = pages.map((page) => {
      const body = JSON.stringify(pageId(page.meta.file));
      return `  { ...${JSON.stringify(page.meta)}, load: () => import(${body}) },`;
    });
    return [
      "// Generated by plugins/content.ts. Do not edit.",
      "export const pages = [",
      ...entries,
      "];",
      "",
    ].join("\n");
  };

  /** `virtual:docs-search`: the corpus, built inline from `PageMeta` plus plain text. */
  const searchModule = async (): Promise<string> => {
    const documents: SearchDoc[] = (await all()).map((page) => ({
      slug: page.meta.slug,
      title: page.meta.title,
      description: page.meta.description,
      headings: page.meta.headings,
      text: page.text,
    }));
    return [
      "// Generated by plugins/content.ts. Do not edit.",
      `export const documents = ${JSON.stringify(documents)};`,
      "",
    ].join("\n");
  };

  /** One body. The whole point of the separate module is that this is a chunk of its own. */
  const bodyModule = async (id: string): Promise<string | null> => {
    const page = (await all()).find((candidate) => own(pageId(candidate.meta.file)) === id);
    if (!page) return null;
    return `// Generated by plugins/content.ts. Do not edit.\nexport const html = ${JSON.stringify(page.html)};\n`;
  };

  return {
    name: "sandboxr:docs-content",
    // Ahead of the resolver, so nothing tries to find `virtual:docs-content` on disk.
    enforce: "pre",

    configResolved(config: ResolvedConfig) {
      // Derived from the Vite root rather than from `import.meta.url`, because
      // this file is bundled into a temporary module before it runs and the
      // bundler is free to rewrite `import.meta.url` to wherever that lands.
      // `config.root` is `packages/docs` and is always the truth.
      repoRoot = path.resolve(config.root, "..", "..");
      docsDir = path.join(repoRoot, "docs");
      warn = (message) => config.logger.warn(message);
    },

    resolveId(id) {
      if (id === CONTENT_ID || id === SEARCH_ID) return own(id);
      if (id.startsWith(PAGE_PREFIX)) return own(id);
      return null;
    },

    async load(id) {
      if (id === own(CONTENT_ID)) return contentModule();
      if (id === own(SEARCH_ID)) return searchModule();
      if (id.startsWith(own(PAGE_PREFIX))) return bodyModule(id);
      return null;
    },

    configureServer(server) {
      // `docs/` is outside the Vite root, so the dev server does not watch it
      // unless it is told to. Without this, editing a page changed nothing on
      // screen and the only way to see it was to restart the server.
      server.watcher.add(docsDir);

      const touched = (absolute: string, structural: boolean) => {
        if (!absolute.startsWith(`${docsDir}${path.sep}`)) return;
        if (!/\.mdx?$/.test(absolute)) return;
        const file = path.relative(docsDir, absolute).split(path.sep).join("/");

        // Adding or deleting a page changes the page *list*, which every one of
        // our modules depends on; editing one only changes that page's body.
        if (structural) {
          listing = null;
          rendered.clear();
          dates.clear();
        } else {
          rendered.delete(file);
          dates.delete(file);
        }

        const bodies = structural ? files().map((each) => pageId(each)) : [pageId(file)];
        const ids = [own(CONTENT_ID), own(SEARCH_ID), ...bodies.map(own)];
        for (const environment of Object.values(server.environments)) {
          for (const target of ids) {
            const mod = environment.moduleGraph.getModuleById(target);
            if (mod) environment.moduleGraph.invalidateModule(mod);
          }
        }

        // A full reload rather than an HMR update. The body is injected as HTML
        // and the chrome is built from the page list, so there is no component
        // boundary a hot update could stop at.
        server.hot.send({ type: "full-reload" });
      };

      server.watcher.on("change", (file) => touched(file, false));
      server.watcher.on("add", (file) => touched(file, true));
      server.watcher.on("unlink", (file) => touched(file, true));
    },
  };
};

/** An unknown throw, as one line fit to print. */
const describe = (error: unknown): string =>
  error instanceof Error ? error.message.split("\n")[0]! : String(error);
