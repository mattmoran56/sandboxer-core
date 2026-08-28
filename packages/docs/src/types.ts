// The contract between the build and the app.
//
// Everything the site knows about a page is decided at build time, in Node, by
// `plugins/content.ts`: the frontmatter is parsed, the Markdown is rendered, the
// fences are highlighted, the headings are collected and the search text is
// extracted. The browser receives these shapes and nothing else — it never sees a
// Markdown file, and there is no runtime fetch of one.
//
// The split between `PageMeta` and `PageBody` is the reason the site is not one
// enormous bundle. `docs/` is around half a megabyte of Markdown, and highlighted
// HTML is several times its source, so the bodies are code-split: the metadata for
// every page is in the entry chunk (the sidebar, the prev/next links and the head
// tags all need it) and each body arrives as its own chunk, already in the static
// HTML for the page you landed on.

/** A heading the table of contents can link to. `h2` and `h3` only — deeper is noise. */
export interface Heading {
  depth: 2 | 3;
  /** The anchor id, GitHub-style, deduplicated within the page. */
  id: string;
  /** The heading's plain text, with any inline markup flattened. */
  text: string;
}

/** Everything about a page except its body. Small enough that all of them ship together. */
export interface PageMeta {
  /**
   * The page's identity: its path under `docs/` with the extension and any
   * trailing `index` removed. `""` is the front page, `"reference/cli"` is
   * `docs/reference/cli.md`.
   */
  slug: string;
  /** The path under `docs/`, kept so the edit link and the git date can find the file. */
  file: string;
  title: string;
  description: string;
  headings: Heading[];
  /** False when the page's frontmatter turned the table of contents off. */
  tableOfContents: boolean;
  /**
   * The ISO date of the last commit that touched the file, or null.
   *
   * Null is a real answer and not a failure: a page that has been written but not
   * yet committed has no date, and so does a checkout with no git history.
   */
  lastUpdated: string | null;
}

/** A page's rendered body. One of these per page, each in its own chunk. */
export interface PageBody {
  html: string;
}

/** A page as the app sees it: its metadata, plus a way to get the body. */
export interface Page extends PageMeta {
  load: () => Promise<PageBody>;
}

/** One page as the search index holds it. */
export interface SearchDoc {
  slug: string;
  title: string;
  description: string;
  headings: Heading[];
  /** The body as plain text: markup stripped, whitespace collapsed. */
  text: string;
}
