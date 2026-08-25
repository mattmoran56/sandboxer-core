import { docsSchema } from "@astrojs/starlight/schema";
import { glob } from "astro/loaders";
import { defineCollection } from "astro:content";

/**
 * The pages live in the repository's `docs/` directory, not inside this package.
 *
 * That is deliberate: somebody who opens the repository on GitHub should be able
 * to read the documentation there, in order, without running a static site
 * generator. This package is only the machinery that also publishes it as a
 * site, so it reaches back up for its content rather than owning it.
 *
 * Two things under `docs/` are deliberately not pages:
 *
 * - `architecture/contracts.md` is the engineering contract. It has no
 *   frontmatter, it is the authority every package is checked against, and the
 *   documentation never edits it — so it is linked to on GitHub rather than
 *   rendered here.
 * - `README.md` files are GitHub's own front door for a directory. The site
 *   uses each group's `index.md` for the same job.
 */
export const collections = {
  docs: defineCollection({
    loader: glob({
      base: "../../docs",
      pattern: ["**/[^_]*.{md,mdx}", "!architecture/contracts.md", "!**/README.md"],
    }),
    schema: docsSchema(),
  }),
};
