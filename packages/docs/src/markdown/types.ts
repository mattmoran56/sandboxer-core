// The shapes the pipeline's own files pass between each other.
//
// `Frontmatter` lives here rather than in `render.ts` so that `frontmatter.ts` can
// name it without importing the module that imports it — the pipeline's entry
// point re-exports it, which is where a caller should read it from.

/** A page's frontmatter, per AUTHORING.md: two required keys and one optional one. */
export interface Frontmatter {
  title: string;
  description: string;
  tableOfContents: boolean;
}
