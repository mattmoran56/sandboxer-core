# `@sandboxer/tokens`

The design system, as one stylesheet: the palette, the three colour schemes, the two themes,
the fonts, the light/dark mechanism, the base layer and the named shapes.

One file, `tokens.css`. No build, one export:

```css
@import "@sandboxer/tokens/tokens.css";
```

**Its header comment is the document for it**, and [`docs/brand.md`](../../docs/brand.md) is
that header written for a reader.

## Why it is a package

Two apps render the same design — the documentation site (`packages/docs`) here, and the
product's dashboard in the repository built on this one — and neither may hold a second copy
of a hex. A palette that exists twice drifts, and it drifts silently: nothing about the
dashboard looking right tells you the docs site does.

It used to live in the dashboard, and the docs site imported it from there. That only worked
while the two were one repository. They are not: `packages/docs` publishes the engine's
documentation and came here with the engine, the dashboard stayed with the product, and an
engine package cannot depend on a product package. So the stylesheet both of them need
belongs to neither of them.

## What it depends on, and why

Nothing here is compiled. `tokens.css` is shipped as written, so its four `@import`s are
resolved from `node_modules` by whichever bundler is building the app — and that only works if
this package declares them itself.

| | Declared as | Why |
|---|---|---|
| `@fontsource/instrument-serif`, `@fontsource-variable/inter-tight`, `@fontsource-variable/jetbrains-mono` | `dependencies` | This is the file that imports them. The fonts are self-hosted from npm rather than a CDN because the dashboard serves a `font-src 'self'` Content-Security-Policy, so a stylesheet pointing at a font CDN would load nothing at all |
| `tailwindcss` | `peerDependencies` | The app's own `@tailwindcss/vite` is what resolves the import, so the Tailwind it reads has to be the app's copy. As an ordinary dependency npm would be free to nest a second Tailwind here at a different version from the one the plugin runs, and the symptom of that mismatch is a missing utility rather than an error. Both consumers already depend on Tailwind directly; the peer range only pins them to the major this file is written against |

These were the dashboard's dependencies until the tokens moved out, and npm's hoisting made
that look fine from there. It was not: this clone holds only the engine — core, cli, docs and
these tokens — and without them it would build a documentation site with no fonts in it.

**An app that imports this one must not import Tailwind again.** `@theme`, `@utility` and
`@custom-variant` are Tailwind at-rules, and a file using them without importing Tailwind is a
file of dead CSS — so the import is here, and it arrives with the tokens.

## Scripts

None. There is nothing to build, typecheck or test here. The arithmetic on these tokens —
every one declared as a `light-dark()` pair, every ink clearing WCAG AA on every surface it is
used on — is asserted by a test in the product's repository, which reads this file through the
export above; **nothing in this repository asserts it**, which is worth knowing before editing
a value. The root's `npm run build`, `typecheck` and `test` all pass `--if-present`, so a
package with no scripts is skipped rather than failing.
