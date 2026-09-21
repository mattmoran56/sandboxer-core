# `@sandboxr/tokens`

The design system, as one stylesheet: the palette, the three colour schemes, the two themes,
the fonts, the light/dark mechanism, the base layer and the named shapes.

One file, `tokens.css`. No build, no dependencies, one export:

```css
@import "@sandboxr/tokens/tokens.css";
```

**Its header comment is the document for it**, and [`docs/brand.md`](../../docs/brand.md) is
that header written for a reader.

## Why it is a package

Two apps render this product — the dashboard (`packages/web`) and the documentation site
(`packages/docs`) — and neither may hold a second copy of a hex. A palette that exists twice
drifts, and it drifts silently: nothing about the dashboard looking right tells you the docs
site does.

It used to live in the dashboard, and the docs site imported `@jef/web/tokens.css`. That only
worked while the two were one repository. `packages/docs` publishes the engine's documentation
and leaves with the engine; the dashboard is Jef's and stays. An engine package cannot depend
on a product package, so the stylesheet both of them need belongs to neither of them.

## It brings Tailwind with it

`tokens.css` opens with `@import "tailwindcss"`, because `@theme`, `@utility` and
`@custom-variant` are Tailwind at-rules and a file using them without it is a file of dead
CSS. An app that imports this one must not import Tailwind again.

## Scripts

None. There is nothing to build, typecheck or test here: the arithmetic on these tokens — every
one declared as a `light-dark()` pair, every ink clearing WCAG AA on every surface it is used
on — is asserted by `packages/web/src/app.css.test.ts`, which reads this file through the
export above. The root's `npm run build`, `typecheck` and `test` all pass `--if-present`, so a
package with no scripts is skipped rather than failing.
