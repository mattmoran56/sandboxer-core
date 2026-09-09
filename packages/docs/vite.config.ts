// How the documentation site is built.
//
// Three things about it are worth knowing before changing anything here.
//
//  - **The content is not in this package.** The pages live in the repository's
//    `docs/` directory as plain Markdown so they read on GitHub without a build.
//    `plugins/content.ts` reaches up for them, renders them at build time and
//    hands the app structured data — so nothing is fetched or parsed in the
//    browser. See that file for what is excluded and why. `plugins/assets.ts`
//    does the same for the one thing under `docs/` that is not text: the images
//    in `docs/assets/`, copied into the build rather than bundled, because a
//    hashed filename is not something a Markdown file written for GitHub can
//    know.
//  - **There are two builds.** The first is the ordinary browser bundle. The
//    second is an SSR bundle of `src/entry-server.tsx`, which `build/prerender.mjs`
//    then uses to write one static HTML file per route. That is what makes a deep
//    link work on a plain static host — there is no server for this site — and
//    what makes a page readable with JavaScript off.
//  - **The design tokens come from `@sandboxr/web`.** `src/docs.css` imports
//    `@sandboxr/web/tokens.css` rather than restating a palette, because somebody
//    with the dashboard in one tab and the docs in the other has to see one
//    product. Only the long-form prose layer belongs to this package.

import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwind from "@tailwindcss/vite";

import { docsAssets } from "./plugins/assets.js";
import { docsContent } from "./plugins/content.js";

export default defineConfig({
  plugins: [react(), tailwind(), docsContent(), docsAssets()],
  build: {
    outDir: "dist",
    emptyOutDir: true,
    sourcemap: true,
  },
  server: {
    port: 4321,
  },
  preview: {
    port: 4321,
  },
});
