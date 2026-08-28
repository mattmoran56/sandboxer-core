/// <reference types="vite/client" />

// The two modules `plugins/content.ts` invents.
//
// They are declared here rather than generated, because a hand-written
// declaration is a thing the compiler checks the plugin against: if the plugin
// starts emitting a different shape, every consumer fails to typecheck instead of
// failing in a browser.
//
// **The types are written as `import("./types.js").X` and that form is load-bearing.**
// The obvious spelling — a top-level `import type { Page } from "./types.js"` inside
// the `declare module` block — compiles without complaint and resolves to nothing:
// a relative specifier inside `declare module` is not resolved against this file,
// so `Page` silently became `any` and every consumer of `pages` was untyped. There
// was no error to notice, which is the worst version of this bug — the declaration
// looked like it was doing the checking it exists to do. An inline `import()` type
// does resolve against this file. If you change these, re-check with a line like
// `const bad: number = pages[0]!.slug` in a scratch file: it must fail to compile.

declare module "virtual:docs-content" {
  /**
   * Every page under `docs/` that is part of the site, in the order the
   * filesystem walk found them. The sidebar's order comes from `src/nav.ts`, not
   * from here.
   */
  export const pages: import("./types.js").Page[];
}

declare module "virtual:docs-search" {
  /**
   * The search corpus, in a module of its own so it is dynamically imported the
   * first time somebody opens search rather than shipped in the entry chunk.
   */
  export const documents: import("./types.js").SearchDoc[];
}
