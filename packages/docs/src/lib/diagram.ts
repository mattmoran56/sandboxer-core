// The design system, translated into the only vocabulary mermaid understands.
//
// A diagram on this site is drawn in the browser (see `Article.tsx`), and the
// reason it is drawn there rather than at build time is that it has to follow the
// reader's choices: light or dark, and one of three colour schemes. Six
// combinations, one palette — `@sandboxr/tokens/tokens.css`. So this file holds
// no hexes. It reads the tokens that are already in force and hands mermaid a
// `themeVariables` map built from them.
//
// **mermaid's theme is `base`.** That is the one theme intended to be
// configured; every other built-in computes its own palette from a seed colour
// and will quietly fight an override. `neutral` and `dark` — what this site used
// before — are exactly that, which is why the diagrams arrived in mermaid's own
// lavender-and-grey and in Trebuchet MS.

/**
 * The tokens a diagram needs, and the only ones it may use.
 *
 * Declared as a list rather than read ad hoc because `resolveTokens` has to
 * resolve each one through the DOM, one at a time — see the comment there.
 */
export const DIAGRAM_TOKENS = [
  "--font-sans",
  "--sb-sunken",
  "--sb-surface",
  "--sb-surface-2",
  "--sb-line",
  "--sb-line-strong",
  "--sb-ink",
  "--sb-ink-subtle",
  "--sb-brand",
  "--sb-brand-soft",
  "--sb-brand-line",
  "--sb-warn",
  "--sb-warn-soft",
  "--sb-bad",
  "--sb-bad-soft",
] as const;

export type DiagramToken = (typeof DIAGRAM_TOKENS)[number];

/** Answers a token with a value a colour parser can read: `rgb(…)`, not `var(…)`. */
export type TokenReader = (token: DiagramToken) => string;

/**
 * Every token, resolved for whatever theme and scheme are currently in force.
 *
 * **Not `getComputedStyle(root).getPropertyValue("--sb-ink")`.** That is the
 * obvious way to do this and it does not work: an unregistered custom property
 * computes to its own token stream, so the string that comes back is the literal
 * `light-dark(#0e1a1c, #e6eeec)` — both halves, unresolved, in a syntax mermaid's
 * colour library cannot parse. Handing that over produced diagrams whose every
 * fill was mermaid's fallback, which looks like the override never applied rather
 * than like a parsing failure.
 *
 * The way that does work is to make the browser *use* the value: assign
 * `var(--token)` to a real property on a throwaway element and read the property
 * back. A used value has had `light-dark()` resolved against the inherited
 * `color-scheme`, so `color` answers `rgb(14, 26, 28)` — and it follows
 * `data-theme` and `data-scheme` for free, which is the whole point.
 *
 * One element, one property per token, because each assignment has to be read
 * before the next overwrites it.
 */
export const resolveTokens = (): Record<DiagramToken, string> => {
  const probe = document.createElement("span");
  probe.setAttribute("aria-hidden", "true");
  probe.style.position = "fixed";
  probe.style.top = "0";
  probe.style.left = "-9999px";
  probe.style.width = "0";
  probe.style.height = "0";
  probe.style.pointerEvents = "none";
  // Inside the document, so it inherits the `color-scheme` the theme switch set
  // on <html> and the brand hue the scheme attribute selected. A detached
  // element inherits nothing and would resolve every token to its light value.
  (document.body ?? document.documentElement).appendChild(probe);

  const used = getComputedStyle(probe);
  const values = {} as Record<DiagramToken, string>;
  for (const token of DIAGRAM_TOKENS) {
    if (token === "--font-sans") {
      probe.style.fontFamily = `var(${token})`;
      values[token] = used.fontFamily;
      continue;
    }
    probe.style.color = `var(${token})`;
    values[token] = used.color;
  }

  probe.remove();
  return values;
};

/**
 * The map itself.
 *
 * Split from `resolveTokens` so the part with the design decisions in it is a
 * pure function of a lookup and can be tested without a browser.
 *
 * The intent, which is what to preserve if this is ever edited:
 *
 *  - **A node is a surface, not a colour.** `--sb-surface` on the `--sb-sunken`
 *    frame the diagram already sits in, bordered in `--sb-line-strong`. Fifteen
 *    of this site's seventeen diagrams are flowcharts of boxes and arrows; if
 *    every box were tinted the diagram would read as a warning, not a structure.
 *  - **The brand hue is emphasis.** It marks the two things that group or
 *    annotate — a subgraph, and a sequence diagram's loop and activation boxes —
 *    and nothing else. A diagram where everything is brand-coloured is as
 *    unbranded as one where nothing is.
 *  - **Text is `--sb-ink` wherever mermaid will paint text.** Neither muted grey
 *    appears on a label, on purpose: mermaid has no separate variable for a
 *    label that lands on a tinted fill, and `tokens.css` records that both lose
 *    AA on a `-soft` background. Since a label here can land on
 *    `--sb-brand-soft` or `--sb-warn-soft`, the only answer that holds in all
 *    six theme × scheme combinations is the full-strength ink. `--sb-ink-subtle`
 *    does appear, but only on the *lines*, where the bar is the 3:1 of a
 *    meaningful graphic rather than the 4.5:1 of text — see below.
 *
 * `darkMode` is not decoration either: mermaid derives the handful of variables
 * not set below by lightening or darkening the ones that are, and it picks the
 * direction from this flag.
 */
export const diagramThemeVariables = (
  token: TokenReader,
  dark: boolean,
): Record<string, string | boolean> => ({
  darkMode: dark,

  // The complaint that started this: mermaid's default is Trebuchet MS, and the
  // config value wins over anything CSS says, because mermaid writes it inline
  // on the text elements it measures.
  fontFamily: token("--font-sans"),
  fontSize: "15px",

  // The frame the diagram is drawn in, so anything mermaid fills with "the
  // background" disappears into it rather than punching a white hole.
  background: token("--sb-sunken"),

  /* Nodes. `primaryColor` and `primaryBorderColor` are the seeds `mainBkg` and
     `nodeBorder` are derived from; both are set so nothing is left to derive. */
  primaryColor: token("--sb-surface"),
  mainBkg: token("--sb-surface"),
  nodeBkg: token("--sb-surface"),
  primaryBorderColor: token("--sb-line-strong"),
  nodeBorder: token("--sb-line-strong"),
  border2: token("--sb-line"),
  primaryTextColor: token("--sb-ink"),
  nodeTextColor: token("--sb-ink"),
  textColor: token("--sb-ink"),

  /* The secondary and tertiary ramps barely surface in a flowchart or a sequence
     diagram, but every one of them is derived from `primaryColor` by rotating its
     hue, and their text colours by inverting them. Left alone they are where a
     stray lavender or a black-on-black label comes from. */
  secondaryColor: token("--sb-surface-2"),
  secondaryBorderColor: token("--sb-line"),
  secondaryTextColor: token("--sb-ink"),
  tertiaryColor: token("--sb-sunken"),
  tertiaryBorderColor: token("--sb-line"),
  tertiaryTextColor: token("--sb-ink"),

  /* Edges, and the one place a line is *not* `--sb-line-strong`.
     A node's border delimits a shape whose fill already separates it from the
     page, so the quiet line token is right there. An arrow is different: it is
     the only thing carrying the diagram's meaning, and `--sb-line-strong` on the
     `--sb-sunken` frame is about 1.15:1 — nowhere near the 3:1 a meaningful
     graphic needs. `--sb-ink-subtle` measures 4.55:1 in light and 5.6:1 in dark
     against that frame, and still sits clearly behind the ink of the labels. */
  lineColor: token("--sb-ink-subtle"),
  arrowheadColor: token("--sb-ink-subtle"),
  defaultLinkColor: token("--sb-ink-subtle"),
  /* Backed in the frame colour, so an edge label reads as a gap in its line
     rather than a sticker on top of it. */
  edgeLabelBackground: token("--sb-sunken"),

  /* Subgraphs. The one place the brand hue appears in a flowchart: a group is
     the diagram's structure, and structure is worth emphasising. `titleColor` is
     the subgraph's own label, and brand-on-brand-soft clears AA in all six
     combinations — it was checked, not assumed. */
  clusterBkg: token("--sb-brand-soft"),
  clusterBorder: token("--sb-brand-line"),
  titleColor: token("--sb-brand"),

  /* Sequence diagrams. An actor is a node, so it is a node's surface. */
  actorBkg: token("--sb-surface"),
  actorBorder: token("--sb-line-strong"),
  actorTextColor: token("--sb-ink"),
  actorLineColor: token("--sb-line-strong"),
  signalColor: token("--sb-ink-subtle"),
  signalTextColor: token("--sb-ink"),
  /* The loop/alt tab and an activation bar are the sequence diagram's grouping,
     so they take the brand tint that a subgraph takes in a flowchart. */
  labelBoxBkgColor: token("--sb-brand-soft"),
  labelBoxBorderColor: token("--sb-brand-line"),
  labelTextColor: token("--sb-ink"),
  loopTextColor: token("--sb-ink"),
  activationBkgColor: token("--sb-brand-soft"),
  activationBorderColor: token("--sb-brand-line"),
  /* `sequenceNumberColor` is the digit, and it is drawn on a disc filled with
     `signalColor` rather than on the page — so it is the *surface* colour, which
     clears 5.15:1 on that disc in light and 5.36:1 in dark. Ink would be 3.4:1. */
  sequenceNumberColor: token("--sb-surface"),
  /* A note is an aside, and amber is the palette's fifth hue precisely so that
     an aside does not have to borrow a status colour that means something. */
  noteBkgColor: token("--sb-warn-soft"),
  noteBorderColor: token("--sb-warn"),
  noteTextColor: token("--sb-ink"),

  /* Only reached if mermaid renders its own error card. This site catches a
     parse failure and leaves the source visible instead, so these are here to
     stop the fallback path being the one thing on the page in mermaid's red. */
  errorBkgColor: token("--sb-bad-soft"),
  errorTextColor: token("--sb-bad"),
});
