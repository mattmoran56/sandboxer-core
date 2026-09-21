---
title: The brand
description: The name, the mark, the palette, the type and the voice — what sandboxr looks and sounds like, and the exact values to build it from.
---

Everything sandboxr shows a person is drawn from one small set of decisions: one name, one mark,
one palette, three typefaces, and a way of writing sentences. This page is that set, so a new
screen, a new page or a new tool can be made to look like the rest of it without guessing.

```prompt
Apply the sandboxr brand to a surface I am about to describe, then check the result against the
brand guide.

Read docs/brand.md first, and then packages/web/src/tokens.css, which is where the values
actually live. Build the surface from the semantic tokens — surface, line, ink, ink-muted, brand,
and the status hues — and never from a hex you typed yourself. Headings are the serif, body is the
sans, anything a machine cares about is the mono. Draw a panel or a card as a hairline on a
surface, not as a shadow. Write the wordmark as `Jef` in the dashboard and `sandboxr` on the
documentation site, with no letterspacing and no tagline.

Stop and ask me if the surface seems to need a colour the palette does not have, a second
typeface, a gradient, or the mark redrawn rather than rescaled.
```

Two apps render this brand — the [dashboard](guides/dashboard.md) and this documentation site —
and they share one stylesheet, `packages/web/src/tokens.css`. That file is the design system; this
page is what it means. Where the two disagree, the file is right and this page is the bug.

## The name

There are two names, and which one a surface carries depends on what that surface is.

**Jef** is the agent — the thing a person talks to. Capitalised, because it is a name and not a
noun. The dashboard is Jef's: its wordmark, its browser tab, its home-screen icon and the agent's
own introduction all say Jef. There is no tagline in the product itself: the dashboard's header
carries the mark, the word, and the domain it serves — nothing else.

**sandboxr** is the engine underneath. Always lowercase, including at the start of a sentence and
in a heading, and never letterspaced. The documentation site is the engine's, and its wordmark says
sandboxr.

In prose sandboxr is an ordinary noun. "sandboxr turns a git worktree into a running copy of a
whole project, on its own hostname." That sentence is the one-line pitch. Longer descriptions are
that sentence plus what it costs, never a new one.

The command is `sandboxr` too, and the config file is `sandboxr.yaml`, so the word is never
capitalised anywhere a reader could copy it into a terminal and be wrong. Jef goes the other way:
capitalised in every sentence a person reads, and lowercase only where it is an identifier rather
than a name — the `@jef/*` package scope and the `[jef]` prefix on the server's log lines.

<details class="agent">
<summary><b>Details for an agent</b> — how the name is written, everywhere it is written</summary>

| Where | Written |
|---|---|
| The engine in prose, mid-sentence | `sandboxr` |
| The engine in prose, at the start of a sentence | `sandboxr` — lowercase survives; rewrite the sentence rather than capitalise it |
| The engine in a heading or a page title | `sandboxr` |
| The command, the engine's package scope, the config file | `sandboxr`, `@sandboxr/*`, `sandboxr.yaml` |
| A container, volume or hostname | `sandboxr-<project>-<slug>` — see [Paths](reference/paths.md) |
| The agent, anywhere a person reads it | `Jef` |
| The dashboard's wordmark | `Jef`, one word, no letterspacing, no full stop |
| The dashboard's tab title | `Jef`, or `Jef — <view>` |
| The documentation site's wordmark | `sandboxr`, one word, no space, no letterspacing, no full stop |
| The product's package scope, the server's log prefix | `@jef/*`, `[jef]` |

**Never `Sandboxr`, `SandboxR` or `SANDBOXR`, and never `JEF` or `jef`** outside the two
identifiers above. The one exception is a place that upper-cases every word mechanically — an OS
window title, a package registry's own display of a name — where nothing in the repository decides
it.

The one-line pitch, verbatim from `README.md`:

> Turn any git worktree into a running copy of a whole project, on its own hostname.

The documentation site adds one word to the lockup and nowhere else: a `docs` chip beside the
wordmark, `brand-soft` behind `brand` text, saying which of the two tabs you are in. It is not part
of the name.

</details>

## The mark

![The sandboxr mark](assets/brand/mark.svg)

Three horizontal bars in a flat brand-coloured rounded square. The bars are a worktree, a sandbox
running on it, and a hostname in front of that — the three things sandboxr makes out of a branch,
stacked in the order you meet them. The middle bar is the short one, so the shape reads as a
deliberate object rather than as a menu icon or a list.

It is flat. There is no gradient behind it, no glow under it and no second colour in it, which is
what lets it survive being printed, faxed, rendered by a launcher that ignores half of it, or
reversed out at 20 pixels.

The square's corner radius is 0.27 of its side, which is close to the radius the platforms round
an app icon to. Nothing else in the product uses that radius; a card is much tighter.

![The sandboxr lockup: the mark beside the wordmark](assets/brand/lockup.svg)

Both files above are committed — `docs/assets/brand/mark.svg` and `docs/assets/brand/lockup.svg` —
and they are the copies to hand somebody who needs the artwork. The wordmark inside the lockup is
live text in a serif stack rather than outlines, so a machine with none of those fonts renders it in
its own serif rather than not at all.

> [!NOTE] The icons have been looked at, not lived with
> Nobody has added the dashboard to a phone's Home Screen and seen the mark on a real wallpaper. The
> files are generated and checked; how the mark reads at that size on a device is not yet known. See
> [What is built](reference/status.md).

<details class="agent">
<summary><b>Details for an agent</b> — the two constructions, the exact paths, and every size it ships at</summary>

**There are two constructions of the same mark, on two grids.** They differ only in how much of the
plate the bars take, and each is used where it is used.

*The 32-unit construction* — the whole icon, plate included. It is what `packages/web/index.html`
and `packages/docs/index.html` embed as a `data:` URI favicon, and what `packages/web/build/icons.mjs`
rasterises into the PNGs. Both committed SVGs in `docs/assets/brand/` use it.

```svg
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32">
  <rect width="32" height="32" rx="8.6" fill="#0b5f5a"/>
  <g fill="none" stroke="#ffffff" stroke-width="2.6" stroke-linecap="round">
    <path d="M8 11h16"/>
    <path d="M8 16h10"/>
    <path d="M8 21h13"/>
  </g>
</svg>
```

*The 24-unit construction* — the glyph alone, drawn as `currentColor` strokes inside a plate the
surrounding element paints. It is `Mark` in `packages/docs/src/components/icons.tsx` and the inline
`<svg>` in `packages/web/src/components/shell/Header.tsx`.

```svg
<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round">
  <path d="M5 8h14M5 12h9M5 16h11"/>
</svg>
```

**The two are not the same proportion, and that is the one thing to know before unifying them.** In
the header the glyph is rendered at 15px inside a 28px plate, so its longest bar is 31% of the
plate's width; in the icon the longest bar is 50% of it. The icon's is the construction the PNGs are
generated from, so it is the one to keep if they are ever reconciled.

**Geometry, in units of the square's side** (`packages/web/build/icons.mjs` holds these as
fractions, so the raster and the SVG cannot drift):

| | Value | Of a 32-unit square |
|---|---|---|
| Corner radius | 0.269 | `rx="8.6"` |
| Bar stroke, round caps | 0.081 | `stroke-width="2.6"` |
| Bar inset, left | 0.25 | `x=8` |
| Bar spacing | 0.156 | `y=11, 16, 21` |
| Bar lengths — long, short, medium | 0.50 / 0.3125 / 0.406 | `h16`, `h10`, `h13` |

**The sizes it ships at:**

| Size | Where | Notes |
|---|---|---|
| 28px | Both headers' plate (`size-7`), glyph at 15px | The lockup's mark |
| 32px | The favicon, as a `data:` URI | A file would need a route of its own; `img-src 'self' data:` allows the URI |
| 180px | `apple-touch-icon-180.png` | Full bleed — iOS rounds the corners itself, and a pre-rounded PNG gets rounded twice |
| 192px, 512px | The manifest's `any` icons | Rounded corners, transparent outside them |
| 512px | `icon-maskable-512.png` | Full bleed, mark scaled to 0.85 so its **diagonal** clears the launcher's safe circle |

Regenerate the four PNGs with `npm --workspace @jef/web run icons` after any change to the
geometry or the brand hue. They are committed; the server serves them straight out of the build.

**Minimum size: 20px.** At 20px the stroke is 1.6px and the space between two bars is 1.5px, which
is as close as three lines can come before they read as a block. The favicon's 32px is the size the
geometry was drawn for.

**Clear space: half the square's side on every edge**, measured from the plate and not from the
bars. The lockup is the one exception, because the wordmark is part of the mark rather than a
neighbour of it: there the gap is 10px at a 28px mark, 0.36 of the side.

**The icon always uses the *light* half of the `tide` brand, `#0b5f5a`, in both themes.** A
home-screen icon sits on a wallpaper, not on the app's canvas, so it has no surface to be legible
against and no way to know which theme is in force. The dark half is chosen to survive on
near-black and disappears on a pale wallpaper.

</details>

## The wordmark and the lockup

The wordmark is the name set in **Instrument Serif**, in `ink`, at 20px with no letterspacing. It
is a word, not a logotype: nothing has been drawn by hand, so it is reproduced by setting it rather
than by finding a file.

The lockup is the mark, a 10px gap, and the wordmark, vertically centred on each other. **The
dashboard and the documentation site draw the same lockup down to the class list**, in the
identical sticky header over a hairline, because somebody with one in each tab has to see one
product rather than two sites that share a palette. Only the word differs: the dashboard sets
`Jef`, the documentation site sets `sandboxr`.

<details class="agent">
<summary><b>Details for an agent</b> — the lockup, in the two places it is drawn</summary>

Both headers draw the same three elements, and the classes are the same in each. Only the text
inside the second span changes — `Jef` in the dashboard, `sandboxr` on the documentation site:

```html
<span class="grid size-7 place-items-center rounded-[0.475rem] bg-brand text-brand-ink">…mark…</span>
<span class="font-serif text-xl leading-none text-ink">Jef</span>
```

- **The plate** is `size-7` (28px), `bg-brand`, radius `0.475rem` (7.6px, which is 0.27 of 28), with
  the glyph in `text-brand-ink` — white in light, near-black teal in dark.
- **The gap** is `gap-2.5` (10px) between plate and wordmark.
- **The wordmark** is `font-serif text-xl leading-none text-ink` — Instrument Serif, 20px, `ink`.
  `leading-none`, so its box is the height of the text and it centres against the plate rather than
  against a line box.
- **The whole lockup is a link to `/`** and takes `focus-visible:outline-offset-4`, so the focus ring
  clears the plate instead of cutting its corner.

`--font-serif` in `packages/web/src/tokens.css` is the stack:
`"Instrument Serif", ui-serif, Georgia, Cambria, "Times New Roman", serif`. `docs/assets/brand/lockup.svg`
carries a shortened form of it — the fonts are self-hosted from npm because the dashboard's
Content-Security-Policy is `font-src 'self'`, so an SVG that pointed at a font CDN would load
nothing, and one that embedded the face would carry a font in every copy of the file.

Below `md` the dashboard's header replaces the lockup with a back control and the worktree's name
when a worktree is open. That is the only place the lockup is dropped, and it is dropped rather than
shrunk.

</details>

## Colour

There is one neutral palette, three brand hues to pick between, and six status colours that never
change. Everything on screen is one of those, referred to by what it is for — `surface`, `line`,
`ink`, `brand` — and never by its hue. **A component that names a colour is the bug**: naming the
job is what makes a theme change one attribute on `<html>` rather than a sweep through every file.

Dark mode is not a variant. Every token carries both values, and the browser picks between them, so
a surface built from tokens is already correct in both themes.

The brand is one of three schemes — **Tide** (deep teal, the default), **Cobalt** (deep blue) and
**Fern** (moss green). Each is a hue, the ink that sits on it, a tint and a line. The status colours
are outside the schemes entirely: green means running and rose means something is wrong in every
scheme, because a colour that changes meaning between schemes is a colour nobody can learn.

Every value is chosen against a contrast ratio rather than by eye. Text clears **4.5:1** against
every surface it is put on, in both themes, and a test does the arithmetic rather than trusting
anybody's judgement.

<details class="agent">
<summary><b>Details for an agent</b> — every token, both halves, from packages/web/src/tokens.css</summary>

Written `light / dark`. Each is a CSS custom property `--sb-<name>` and a Tailwind colour utility of
the same name — `--sb-surface` is `bg-surface`, `--sb-ink-muted` is `text-ink-muted`.

**Neutrals.** Cool-grey warmed a shade towards the brand's green, so a hairline on white does not
read as blue.

| Token | Light | Dark | For |
|---|---|---|---|
| `bg` | `#f3f5f4` | `#0c1213` | The canvas behind everything |
| `surface` | `#ffffff` | `#121a1b` | A panel, a card, a bar |
| `surface-2` | `#f8faf9` | `#161f20` | A surface on a surface |
| `sunken` | `#e9eeec` | `#0a0f10` | An inset: a track, a log, a current nav item |
| `hover` | `#eef2f0` | `#1a2526` | The hover tint |
| `line` | `#d9e1de` | `#22302f` | The hairline — the only thing separating a panel from the canvas |
| `line-strong` | `#b9c6c2` | `#35474a` | An interactive card's hover, and the scrollbar thumb |
| `ink` | `#0e1a1c` | `#e6eeec` | Body text and headings |
| `ink-muted` | `#4f6366` | `#9db0ad` | Secondary text — the only secondary ink allowed on a tint |
| `ink-subtle` | `#606d70` | `#7c8d8b` | Quietest text, **neutral surfaces only** |

**The brand, per scheme**, selected by `data-scheme` on `<html>`. A root with no attribute is Tide.

| Token | `tide` | `cobalt` | `fern` |
|---|---|---|---|
| `brand` | `#0b5f5a` / `#4fd1c5` | `#1d4ed8` / `#7ba6ff` | `#3f6a0b` / `#a3e635` |
| `brand-ink` | `#ffffff` / `#052a27` | `#ffffff` / `#06152e` | `#ffffff` / `#14210a` |
| `brand-soft` | `#d7ecea` / `#0f2f2d` | `#e0e9fd` / `#101f3c` | `#e7f2d9` / `#1a2610` |
| `brand-line` | `#9fcdc8` / `#1e4f4a` | `#adc4f6` / `#26406e` | `#bcd99a` / `#35521a` |

`accent` is `#be123c` / `#fb7185` in all three: teal against rose, blue against rose, green against
rose. It is the complement, not a second brand hue, and it is the same one everywhere so that a
scheme is one decision rather than two.

Each brand's dark half is **lighter** than its light half, not darker. The teal that reads confident
on white reads muddy on near-black and fails its ratio against it.

**Status. Identical in every scheme**, because each one carries a meaning.

| Token | Light | Dark | Tint (`-soft`) light / dark | Means |
|---|---|---|---|---|
| `ok` | `#0f794c` | `#34d399` | `#d6f1e3` / `#0c2f26` | Running, healthy, done |
| `busy` | `#1d5fbf` | `#38bdf8` | `#dbe7f9` / `#0a2536` | Starting, working |
| `bad` | `#b3213f` | `#fb7185` | `#f8dde3` / `#35131f` | Failed, gone, stale |
| `idle` | `#5e6c6f` | `#94a3b8` | `#e6ebea` / `#1a2334` | Stopped, nothing happening |
| `warn` | `#8a5a00` | `#fbbf24` | `#f9ecd1` / `#2a1e05` | **Waiting on you** — a permission ask, an escalated question |
| `merged` | `#6d28d9` | `#c084fc` | `#ece2fd` / `#241638` | A pull request that landed |

`warn` outranks every other thing a card can say about itself: attention is the primary signal.
`merged` is named for its meaning rather than its hue because there is exactly one thing it is
allowed to say, and no scheme contains a purple, so nothing else can be mistaken for it.

**The contrast rule, and its one documented failure.**

- Any token that becomes text clears **4.5:1** against every surface it is put on, in both themes.
- A status colour is checked against the surface *and* against its own `-soft` tint, which is the
  tighter of the two — a badge is coloured text on a tint of itself.
- A brand hue is checked twice more: as link text on the surface, and as the fill under the
  **white** label of a primary button. That second sum is what pins the light-mode brands as dark as
  they are.
- **`ink-subtle` may never sit on a tint.** It clears 4.5 on every neutral surface and falls to
  about 4.36 on a `-soft` one, which a selected sidebar row is. Secondary text that can land on a
  tint uses `ink-muted`.

`packages/web/src/app.css.test.ts` reads the stylesheet and does every one of those sums, including
pinning that last failure *as* a failure — a rule nobody can fail is a rule that gets forgotten.

</details>

## Type

Three faces, each with one job.

- **Instrument Serif** is the display face: the wordmark, page headings, panel titles, and a number
  that is itself the content.
- **Inter Tight** is everything a person reads as prose — body copy, labels, buttons.
- **JetBrains Mono** is anything a machine cares about: a branch, a slug, a hostname, a path, a
  commit sha, a port.

The one flourish is a single italic serif phrase in the brand colour, at the end of the dashboard's
greeting. It is derived from the same facts as the paragraph beneath it rather than written by hand,
so the headline and the working cannot disagree, and it is an `<em>` rather than a coloured span —
somebody who cannot see the teal still gets the emphasis.

<details class="agent">
<summary><b>Details for an agent</b> — the stacks, the scale, and where each size is used</summary>

The stacks, from `packages/web/src/tokens.css`:

| Token | Stack | Utility |
|---|---|---|
| `--font-serif` | `"Instrument Serif", ui-serif, Georgia, Cambria, "Times New Roman", serif` | `font-serif` |
| `--font-sans` | `"Inter Tight Variable", ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif` | `font-sans` (the body default) |
| `--font-mono` | `"JetBrains Mono Variable", ui-monospace, SFMono-Regular, Menlo, Consolas, monospace` | `font-mono` |

All three are self-hosted from `@fontsource` rather than fetched from a CDN, because the dashboard's
CSP is `font-src 'self'`.

The sizes that carry the design:

| Size | Face | Where |
|---|---|---|
| 44px (`md:text-[2.75rem]`), 34px below `md` | Serif | The greeting at the top of the dashboard's home pane |
| 34px (`text-[2.125rem]`) | Serif | A stat tile's numeral, where a number is the content |
| 24px (`text-2xl`) | Serif | A section heading |
| 19px (`text-[1.1875rem]`) | Serif | A panel title, and an escalation's question |
| 15px (`text-[0.9375rem]`) | Sans | The lede under a heading |
| 14px (`text-sm`) | Sans | Body, rows, form labels |
| 12px (`text-xs`) | Mono | A domain, a slug, a path, a sha |

`body` carries `letter-spacing: 0.006em`. Inter Tight is a tight face already, and a hair of extra
tracking at body size stops it reading cramped. The serif sets its own and takes negative tracking
at the largest size (`tracking-[-0.015em]` on the greeting).

Headings are `leading-none` or `leading-tight`, and the serif is left at `font-normal` — a display
serif emboldened is a different typeface.

</details>

## Shape and material

The product is drawn with **hairlines, not shadows**. A panel, a card, a row, the header, the tab
bar and a sheet are each a solid surface with a one-pixel line around them. An interactive card's
hover is that line going one shade darker, and nothing moves.

Only two things carry a shadow, and both really are off the page: a popover and a dialog. There is
one exception, one pixel under the selected segment of a segmented control, which is what stops that
control reading as a flat label.

Nothing is translucent and nothing is blurred. The radii are named rather than typed as numbers, and
the ones on a phone are **concentric** — an inner radius is the outer one minus the padding between
them, so nested curves share a centre.

<details class="agent">
<summary><b>Details for an agent</b> — the shadows, the radii and the chain</summary>

**Shadows.** `--shadow-card` and `--shadow-panel` are `none`, and they are declared rather than
deleted so that a call site still asking for one gets nothing instead of an elevation nobody chose.

| Token | Value | For |
|---|---|---|
| `--shadow-raise` | `0 1px 2px var(--sb-shade-1)` | The selected segment of a segmented control, and nowhere else |
| `--shadow-pop` | `0 18px 40px -18px var(--sb-shade-2)` | A popover |
| `--shadow-modal` | `0 24px 60px -24px var(--sb-shade-3)` | A dialog |

The three shades are the ink's own hue in light and plain black in dark, where a tinted shadow on a
near-black surface reads as a smudge.

**Radii.**

| Token | Value | For |
|---|---|---|
| `--radius-card` | 12px | A card |
| `--radius-panel` | 14px | A panel |
| `--radius-chat` | 16px | A panel that is the whole pane: the agent transcript, and its composer |
| `--radius-control` | 9px | A button (`--radius-control-sm`, 7px, when it is small) |
| `--radius-input` | 10px | Anything that takes typing — a hair softer than something that takes a press |

An outlined box at a large radius reads as a pill rather than as a sheet of paper, which is why the
ladder is as tight as it is.

**The concentric chain**, for the sheets on a phone: `--radius-screen` (55px) is the device's own
corner, `--gutter` is 16px, `--radius-sheet` is `screen − gutter`, and `--radius-inset` is one step
further in again.

The material is described from the dashboard's side, with what it replaced, in
[The dashboard → The material is an outline](guides/dashboard.md#the-material-is-an-outline).

</details>

## Voice

sandboxr writes in lowercase, plain, slightly literary British English. It uses sentences where a
lesser interface would use a label, and it says what a thing will do rather than what it is called.

Four rules, and each has a real string behind it.

**An empty state is a sentence, and it says where to go next.** Never an empty box, and never the
word "empty". Most of these states are ordinary — a project with nothing running is the normal
condition of most projects.

> This sandbox is not running, so there is no shell to attach to. Start it and the terminal opens
> here — a socket to a stopped container is a connection that can only fail.

**Nothing is described as broken when it is only waiting.** The dashboard says "needs you", not
"needs attention", because the set is faults *plus* an agent stopped on a question.

> Nothing needs you right now. A card appears here the moment the orchestrator wants your eyes on a
> session — and if it is a question, an answer box comes with it.

**A control says what happens, and a confirmation says what survives.** Not "Reload" but "Rebuild
front-ends"; not "Prune" but "Collect garbage".

> Delete this sandbox? Its container, its database and its uploaded files go with it. The worktree
> on disk is left alone.

**When the product cannot be sure, it says so in the first person of the screen.** A dashboard that
quietly goes stale is worse than one that admits it.

> the last few refreshes failed — what is on screen may be out of date

<details class="agent">
<summary><b>Details for an agent</b> — the rules those four strings are examples of</summary>

- **Lowercase for the product's own words.** `sandboxr`, `live`, `stale`, `docs`. Sentence case for
  everything that is a sentence, and for a control's label.
- **No exclamation marks, no "Oops", no "Whoops", no emoji.** A failure is described plainly and
  followed by the thing to do about it.
- **British spelling**: `colour`, `behaviour`, `licence` as a noun, `-ise` where either is allowed.
- **Second person for what the reader does, and the passive only for what the machine does to
  itself.** "Start it and the terminal opens here", not "the terminal will be opened".
- **Name the thing the reader is afraid of losing.** Every destructive confirmation says what goes
  *and* what stays.
- **No word the page has not introduced.** Anything with a [glossary](reference/glossary.md) entry
  is linked on its first use.
- **Never claim something works that has not been run.** Where a feature is unproven, say so once
  and precisely, on the page it affects, and link [What is built](reference/status.md).

The documentation has its own contract on top of these — two readers, five markup conventions, and
a prompt at the top of every page somebody can arrive at cold. It is `packages/docs/AUTHORING.md`.

</details>

## What not to do

- **No gradient.** The brand is one flat hue. The second brand hue a gradient needed no longer
  exists, in the palette or in the mark.
- **No glass.** Nothing is translucent and nothing is blurred. There is no `backdrop-filter`, and
  no preference to turn one off.
- **No capital S, and no lowercase J.** `sandboxr` and `Jef`, everywhere a person or a machine can
  read them — bar the `@jef/*` scope and the `[jef]` log prefix, which are identifiers.
- **No letterspaced wordmark**, no all-caps wordmark, and no tagline attached to it.
- **No colour named in a component.** A component asks for `surface`, `line`, `ink` or `brand`; if
  what it needs has no token, the palette is what changes.
- **No second palette in another app.** Anything sandboxr renders imports
  `@jef/web/tokens.css`. A palette that exists twice drifts, and it drifts silently — nothing
  about the dashboard looking right tells you the documentation site does.
- **No shadow under a card or a panel**, and no radius typed as a number where a named one exists.
- **No status colour reused for decoration.** Green means running; a green that means "nice" costs
  the green its meaning.

---

**Next:** [The dashboard](guides/dashboard.md) to see the material in the app it was designed for,
or [What is built](reference/status.md) for what has actually been run.
