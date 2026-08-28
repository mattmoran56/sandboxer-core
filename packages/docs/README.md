# packages/docs

The machinery that publishes the documentation as a website. A Vite build, React and Tailwind, and
no server: what it produces is a directory of static HTML files.

This file is deliberately not a site page. Neither is `AUTHORING.md`, and neither is
`docs/architecture/contracts.md` — see `src/lib/route.ts` for the exclusions and why each one is
there.

## The content is not in here

The pages live in the repository's `docs/` directory, as plain Markdown. That is so somebody who
opens the repository on GitHub can read the documentation there, in order, without running
anything. This package reaches up for its content rather than owning it.

`plugins/content.ts` does the reaching. At build time it walks `docs/`, parses each page's
frontmatter, renders its Markdown, highlights its code fences and extracts its search text, and
hands the app structured data. The browser never sees a Markdown file. Read that file before
changing anything about how a page loads.

## How a page becomes a route

A page's path under `docs/` with the extension and any trailing `index` removed is its **slug**,
and its slug plus slashes is its URL. `docs/reference/cli.md` is the slug `reference/cli` and the
URL `/reference/cli/`. `docs/getting-started/index.md` is the slug `getting-started` and the URL
`/getting-started/`. `docs/index.md` is the empty slug and the front page.

That is all of it. There is no route table. `src/lib/route.ts` holds the derivation, once, because
the build, the link rewriter, the router and the sidebar all need the same answer.

## The sidebar is hand-maintained

`src/nav.ts` is a hand-written list, and nothing derives it — order is editorial, and no sorting
rule knows that "Install it" has to come before "Your first sandbox". Add, move or remove a page
and you must update it.

`src/nav.test.ts` is what makes that safe. It fails if a name in the sidebar has no file behind
it, if a file under `docs/` is not named in the sidebar, or if a page's `title` frontmatter does
not match its sidebar label. Its output is a worklist: it names every missing file on its own
line.

## There are two builds

`npm run build` runs three steps. The first is the ordinary browser bundle. The second is an SSR
bundle of `src/entry-server.tsx`. The third, `build/prerender.mjs`, runs the second against the
first and writes one `index.html` per route, plus a `404.html` carrying the same shell.

The second build exists because there is no server. A deep link like `/reference/cli/` has to be a
real file, or a static host answers it with a 404 and the site only works from the front page.
Prerendering also puts each article's body in the markup, so a page reads with JavaScript off and
reads to a crawler.

## Commands

```bash
npm run docs:dev                              # the site on http://localhost:4321/, watching docs/
npm --workspace @sandboxr/docs run build      # both builds, then the static files, into dist/
npm --workspace @sandboxr/docs run preview    # serve dist/ as a static host would
npm --workspace @sandboxr/docs run test       # vitest
npm --workspace @sandboxr/docs run typecheck  # tsc, no emit
```

`dev` watches `docs/` as well as this package, so editing a page reloads the browser. Adding or
deleting one is picked up too.
