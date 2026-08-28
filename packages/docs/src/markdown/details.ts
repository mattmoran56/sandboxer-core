// The collapsible detail block.
//
// Every page's main text is written for a person reading it for the first time.
// The exact paths, full command syntax, schema fields and failure modes that a
// coding agent needs to operate the system live in one of these instead, so the
// page stays readable and the detail stays present rather than being cut.
//
// The summary always says **who the block is for and what is inside**, in that
// order, because a disclosure triangle labelled "More" tells a reader nothing
// about whether it is worth opening. That is what the chip is: the audience,
// lifted out of the summary and set in a label, so a page of four closed blocks
// can be skimmed for the one that is addressed to you.
//
// The four kinds and their conventional openings, from AUTHORING.md:
//
//  - `agent`   — "Details for an agent": exact fields, paths and syntax.
//  - `failure` — "If it goes wrong": what breaks here and how to fix it.
//  - `why`     — "Why it works this way": the reasoning behind a choice a reader
//                might otherwise reverse.
//  - `facts`   — "Fact sheet": the numbers and defaults, in one place.
//
// It is written as plain HTML in the Markdown, not a component, because GitHub
// renders `<details>` natively and strips the `class` — which is harmless there and
// is what this file reads here. The body needs a blank line either side, which is
// GitHub's requirement, and it is also what lets marked lex the body as Markdown:
// the opening tag plus its `<summary>` arrive as one HTML block token, the body as
// ordinary tokens, and `</details>` as a second HTML block token. This file
// rewrites the two HTML tokens and leaves everything between them alone.

import { DETAIL_ICONS, CHEVRON_ICON } from "./icons.js";

export type DetailKind = "agent" | "failure" | "why" | "facts";

/** The conventional summary opening for each kind, used when the author wrote no `<b>`. */
const OPENINGS: Readonly<Record<DetailKind, string>> = {
  agent: "Details for an agent",
  failure: "If it goes wrong",
  why: "Why it works this way",
  facts: "Fact sheet",
};

const isKind = (value: string): value is DetailKind => value in OPENINGS;

/** `<details …>` with an optional `<summary>…</summary>` after it, or a closing tag. */
const DETAILS_TAG =
  /<details\b([^>]*)>[ \t\r\n]*(?:<summary\b[^>]*>([\s\S]*?)<\/summary>)?|<\/details[ \t]*>/gi;

/** The `class="…"` of an opening tag, single or double quoted, or bare. */
const CLASS_ATTRIBUTE = /\bclass[ \t]*=[ \t]*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i;

export interface Summary {
  /** The audience label. */
  chip: string;
  /** What is inside. May be empty, and may contain inline HTML the author wrote. */
  text: string;
}

/**
 * Splits a summary into its chip and its text.
 *
 * The convention is `<b>Details for an agent</b> — every flag it accepts`, so the
 * bold run at the front is the audience and the rest is the contents. When the
 * author wrote no bold opening the kind's conventional opening is used instead and
 * the whole summary becomes the text — which keeps a page that forgot the `<b>`
 * readable rather than unlabelled, and is why this never fails.
 *
 * The separator is stripped because the chip and the text are two elements now; an
 * em dash left at the front of the second one reads as a typo.
 */
export const splitSummary = (summary: string, kind: DetailKind): Summary => {
  const bold = /^[ \t\r\n]*<b\b[^>]*>([\s\S]*?)<\/b>/i.exec(summary);
  if (!bold || bold[1] === undefined) return { chip: OPENINGS[kind], text: summary.trim() };

  const rest = summary.slice(bold[0].length).replace(/^[ \t\r\n]*[—–-][ \t\r\n]*/, "");
  return { chip: bold[1].trim(), text: rest.trim() };
};

/**
 * A rewriter for one page.
 *
 * Stateful, and it has to be: `</details>` arrives as its own token, long after the
 * opening tag whose class decided whether this block was rewritten at all. Without
 * the stack, a `<details class="install-steps">` — which is passed through
 * untouched — would still have its closing tag rewritten into `</div></details>`,
 * closing a `<div>` that was never opened. That produces markup a browser silently
 * repairs by moving the rest of the page inside the block.
 *
 * **A class outside the four is not an error.** It is passed through exactly as
 * written: `<details>` is valid HTML and a page is allowed to use one plainly.
 *
 * Nesting is not supported — AUTHORING.md forbids it — but the stack means a
 * nested pair does not corrupt the page either; the inner one is just rewritten as
 * if it were an outer one.
 */
export const createDetailsRewriter = (): ((html: string) => string) => {
  const rewritten: boolean[] = [];

  return (html: string): string =>
    html.replace(DETAILS_TAG, (matched, attributes: string | undefined, summary: string | undefined) => {
      if (attributes === undefined) {
        // A closing tag. `pop()` on an empty stack is a stray `</details>` in the
        // page; leaving it alone is the same thing a browser would do with it.
        return rewritten.pop() === true ? "</div></details>" : matched;
      }

      const classes = CLASS_ATTRIBUTE.exec(attributes);
      const kind = (classes?.[1] ?? classes?.[2] ?? classes?.[3] ?? "").trim();
      if (!isKind(kind)) {
        rewritten.push(false);
        return matched;
      }

      rewritten.push(true);
      const { chip, text } = splitSummary(summary ?? "", kind);

      return (
        `<details class="sbx-detail" data-kind="${kind}">` +
        `<summary class="sbx-detail__summary">` +
        `${DETAIL_ICONS[kind] ?? ""}` +
        `<span class="sbx-detail__chip">${chip}</span>` +
        (text === "" ? "" : `<span class="sbx-detail__text">${text}</span>`) +
        `${CHEVRON_ICON}` +
        `</summary>` +
        `<div class="sbx-detail__body">`
      );
    });
};
