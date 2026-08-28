// GitHub alerts, turned into callouts this site can style.
//
// A port of the Astro site's `rehypeGithubAlerts`, moved from hast to marked's
// token tree. The reasoning is unchanged. A callout is written as a GitHub alert:
//
// ```md
// > [!WARNING] The password is a root credential
// > Anyone who has it can run every action the dashboard offers.
// ```
//
// GitHub renders that shape natively, which is the point — it is a blockquote with
// a marker, so a reader on GitHub sees a styled callout and a reader here sees the
// same thing built out of this site's own markup. The marker line is lifted out of
// the body and becomes the title, and CSS does the rest.
//
// The title after the marker is optional. Without one the kind's own name is used,
// which is what GitHub does; with one, GitHub shows it as the first words of the
// alert, so the page reads correctly in both places either way.

import type { Tokens } from "marked";
import { escapeText } from "./escape.js";
import { ALERT_ICONS } from "./icons.js";

export type AlertKind = "note" | "tip" | "important" | "warning" | "caution";

export interface Alert {
  kind: AlertKind;
  /** The inline title after the marker, or the kind's own name when there was none. */
  title: string;
}

/** The fallback title, one per kind. Capitalised as GitHub captions them. */
const NAMES: Readonly<Record<AlertKind, string>> = {
  note: "Note",
  tip: "Tip",
  important: "Important",
  warning: "Warning",
  caution: "Caution",
};

/** The marker, plus an optional title running to the end of its line. */
const MARKER = /^\[!(NOTE|TIP|IMPORTANT|WARNING|CAUTION)\][ \t]*(.*)(\n|$)/;

/**
 * Reads the marker off a blockquote, **mutating it** to remove the marker line.
 *
 * Mutation rather than a rebuilt token because the body is ordinary Markdown that
 * marked has already lexed — bold, links, tables, nested fences and all — and
 * re-lexing it from a sliced string would be a second parse that can disagree with
 * the first. Only the first few characters of the first text node change.
 *
 * Returns `null` for an ordinary blockquote, which is left completely alone.
 */
export const takeAlert = (token: Tokens.Blockquote): Alert | null => {
  const first = token.tokens?.find((child) => child.type !== "space");
  if (!first || first.type !== "paragraph") return null;

  const paragraph = first as Tokens.Paragraph;
  const text = paragraph.tokens?.[0];
  if (!text || text.type !== "text") return null;

  const match = MARKER.exec(text.text);
  if (!match || !match[1]) return null;

  const kind = match[1].toLowerCase() as AlertKind;
  const inlineTitle = (match[2] ?? "").trim();

  text.text = text.text.slice(match[0].length).replace(/^\n+/, "");
  text.raw = text.text;

  if (text.text === "") {
    // A marker with nothing after it leaves an empty text node at the head of the
    // paragraph, which would render as a stray space before the content.
    if (paragraph.tokens.length > 1) paragraph.tokens.shift();
    // And a marker that was the *whole* paragraph leaves an empty paragraph, which
    // renders as `<p></p>` — an unexplained gap under the title of a title-only
    // alert. The two cases are exclusive and must stay in one branch: dropping the
    // text node first and then testing the length again would delete a paragraph
    // that had just been left with real content in it.
    else token.tokens = token.tokens.filter((child) => child !== paragraph);
  }

  return { kind, title: inlineTitle || NAMES[kind] };
};

/**
 * The alert's markup, wrapped around its already-rendered body.
 *
 * `role="note"` rather than `role="alert"`: an alert role is an assertive live
 * region, and a page of five callouts would interrupt a screen reader five times
 * on load. The title is a paragraph and not a heading for the same class of
 * reason — a callout title in the heading outline would show up in the table of
 * contents.
 *
 * The title is escaped rather than treated as Markdown, which is what the hast
 * version did by putting it in a text node. It is one line of a marker, and
 * rendering it as Markdown would mean a title containing `_` or `*` silently
 * changing shape between GitHub and here.
 */
export const renderAlert = (alert: Alert, body: string): string =>
  `<div class="sbx-alert sbx-alert--${alert.kind}" role="note">` +
  `<p class="sbx-alert__title">${ALERT_ICONS[alert.kind] ?? ""}${escapeText(alert.title)}</p>` +
  `${body}</div>`;
