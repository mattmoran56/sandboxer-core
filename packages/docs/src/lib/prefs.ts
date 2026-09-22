// The three preferences this site remembers, and how a stored string becomes them.
//
// **The key and the three names are fixed by `index.html`.** A blocking script in
// the document head reads `sandboxer.docs.prefs.v1` and applies `theme` and
// `scheme` to `<html>` before the bundle loads — see the comment there for why
// that has to happen ahead of the first paint. Renaming anything in this file
// without changing that script gives every reader who chose dark a white flash on
// every navigation, and nothing in a test would notice.
//
// It is a *different* key from whatever a product's dashboard uses, on purpose.
// The two apps have different shapes — there is no sidebar grouping here and no
// "expand everything" there — and on a machine where both are served from
// `localhost` they would share an origin and therefore share storage. One
// defensive parser reading the other app's object would quietly discard half of
// it and write its own back, so the two are kept apart by name.
//
// The parsing below is defensive to the point of paranoia because the input is a
// string somebody could have edited by hand, and a preference that throws on read
// would take the whole site down at start-up. Anything unrecognised falls back to
// the default rather than being repaired.

export type ThemeChoice = "light" | "dark" | "system";
export type SchemeId = "tide" | "cobalt" | "fern";

export interface Prefs {
  theme: ThemeChoice;
  scheme: SchemeId;
  /**
   * Whether every `<details>` block on a page starts open.
   *
   * A reader preference and not a per-page one, because the two people it is for
   * both want it everywhere: somebody who has decided they want the exact flags
   * wants them on the next page too, and an agent handed the site wants the whole
   * of every page flat. See `components/Article.tsx` for what those blocks hold.
   */
  expandAll: boolean;
}

export const DEFAULTS: Prefs = {
  theme: "system",
  scheme: "tide",
  expandAll: false,
};

/**
 * Where the preferences live. Read by `index.html` before the bundle loads.
 *
 * It was `sandboxr.docs.prefs.v1`, and the rename moved it deliberately rather
 * than reading the old key once. Nothing here is worth a compatibility path: a
 * reader's saved theme and scheme reset to the defaults once, on the next visit,
 * and they set them again in two clicks. Anything read from the old key would be
 * code that exists for one visit and then lives for ever.
 */
export const PREFS_KEY = "sandboxer.docs.prefs.v1";

export interface SchemeInfo {
  id: SchemeId;
  name: string;
  /** What the hue is, in words, for the swatch's label. */
  note: string;
}

/**
 * The colour schemes on offer — the dashboard's three, in the dashboard's order.
 *
 * The list is repeated here rather than imported because it is a *label* list:
 * the ids have to match `tokens.css`'s `[data-scheme]` blocks, and the names are
 * this site's own copy. `tokens.css` is the shared thing, and it is imported.
 */
export const SCHEMES: readonly SchemeInfo[] = [
  { id: "tide", name: "Tide", note: "deep teal" },
  { id: "cobalt", name: "Cobalt", note: "deep blue" },
  { id: "fern", name: "Fern", note: "moss green" },
];

const isOneOf = <T extends string>(value: unknown, allowed: readonly T[]): value is T =>
  typeof value === "string" && (allowed as readonly string[]).includes(value);

/** The stored string, as preferences. Anything unreadable is the default. */
export const readPrefs = (raw: string | null): Prefs => {
  if (!raw) return DEFAULTS;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return DEFAULTS;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return DEFAULTS;
  const held = parsed as Record<string, unknown>;

  return {
    theme: isOneOf<ThemeChoice>(held.theme, ["light", "dark", "system"])
      ? held.theme
      : DEFAULTS.theme,
    scheme: isOneOf<SchemeId>(
      held.scheme,
      SCHEMES.map((scheme) => scheme.id),
    )
      ? held.scheme
      : DEFAULTS.scheme,
    expandAll: typeof held.expandAll === "boolean" ? held.expandAll : DEFAULTS.expandAll,
  };
};

/**
 * Which of the two themes is actually on screen.
 *
 * `system` is resolved here rather than left to a CSS media query, so the
 * attribute on `<html>` is the single answer to "is this page dark". With both
 * mechanisms live they can disagree — a toggle set to light inside a dark system,
 * with half the tokens following one and half the other. The client-side mermaid
 * renderer reads that attribute too, which is a second reason it has to be the
 * only answer.
 */
export const resolveTheme = (choice: ThemeChoice, systemPrefersDark: boolean): "light" | "dark" =>
  choice === "system" ? (systemPrefersDark ? "dark" : "light") : choice;
