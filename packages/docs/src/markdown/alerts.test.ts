// What this covers:
//  - all five kinds, detected off a blockquote's first paragraph
//  - the optional inline title after the marker, and the kind's name without one
//  - the empty-text-node case the Astro version fixed: no stray leading space
//  - a marker that is the whole paragraph leaves no empty <p>
//  - an ordinary blockquote is untouched
//  - the body's Markdown survives being lifted out from under the marker
//  - the markup: class, role, title paragraph, icon

import { Marked, type Tokens } from "marked";
import { describe, expect, it } from "vitest";
import { renderAlert, takeAlert } from "./alerts.js";

/** Lexes one blockquote and hands back the token, so a test can mutate it. */
const quoteOf = (source: string): Tokens.Blockquote => {
  const token = new Marked({ gfm: true }).lexer(source)[0];
  if (!token || token.type !== "blockquote") throw new Error(`not a blockquote: ${token?.type}`);
  return token as Tokens.Blockquote;
};

const renderOf = (source: string): string => {
  const marked = new Marked({ gfm: true });
  const quote = quoteOf(source);
  const alert = takeAlert(quote);
  const body = marked.parser(quote.tokens);
  return alert ? renderAlert(alert, body) : body;
};

describe("takeAlert", () => {
  it("recognises all five kinds", () => {
    for (const kind of ["NOTE", "TIP", "IMPORTANT", "WARNING", "CAUTION"]) {
      expect(takeAlert(quoteOf(`> [!${kind}]\n> Body.\n`))?.kind).toBe(kind.toLowerCase());
    }
  });

  it("takes the inline title after the marker", () => {
    expect(takeAlert(quoteOf("> [!WARNING] The password is a root credential\n> Anyone who has it.\n"))).toEqual({
      kind: "warning",
      title: "The password is a root credential",
    });
  });

  it("falls back to the kind's own name when there is no inline title", () => {
    expect(takeAlert(quoteOf("> [!TIP]\n> Try this.\n"))?.title).toBe("Tip");
  });

  it("leaves an ordinary blockquote alone", () => {
    const quote = quoteOf("> Just a quotation.\n");
    expect(takeAlert(quote)).toBeNull();
    expect(quote.tokens).toHaveLength(1);
  });

  it("does not treat a marker further down the quote as an alert", () => {
    expect(takeAlert(quoteOf("> First line.\n> [!NOTE] not a marker\n"))).toBeNull();
  });

  it("does not treat an unknown marker as an alert", () => {
    expect(takeAlert(quoteOf("> [!ASIDE] hello\n> Body.\n"))).toBeNull();
  });
});

describe("the marker's removal", () => {
  it("leaves no stray space before the body when the marker had no title", () => {
    // This is the empty-text-node case. The marker line becomes an empty text
    // node at the head of the paragraph, and left in place it renders as a space
    // in front of the first word.
    expect(renderOf("> [!NOTE]\n> **Docker** must be running.\n")).toContain(
      "<p><strong>Docker</strong> must be running.</p>",
    );
  });

  it("leaves no empty paragraph when the marker was the whole body", () => {
    const html = renderOf("> [!CAUTION] This deletes the volume\n");
    expect(html).not.toContain("<p></p>");
    expect(html).toContain('<p class="sbx-alert__title">');
  });

  it("keeps the body's Markdown", () => {
    const html = renderOf("> [!NOTE] Two things\n> A `command` and a [link](../reference/cli.md).\n");
    expect(html).toContain("<code>command</code>");
    expect(html).toContain("<a href=");
  });

  it("keeps a multi-block body", () => {
    const html = renderOf("> [!TIP] Steps\n>\n> - one\n> - two\n");
    expect(html).toContain("<li>one</li>");
  });
});

describe("renderAlert", () => {
  it("writes the agreed markup", () => {
    const html = renderAlert({ kind: "warning", title: "Careful" }, "<p>Body.</p>");
    expect(html).toMatch(/^<div class="sbx-alert sbx-alert--warning" role="note">/);
    expect(html).toContain('<p class="sbx-alert__title">');
    expect(html).toContain('<svg class="sbx-alert__icon"');
    expect(html).toContain("Careful</p>");
    expect(html).toContain("<p>Body.</p>");
  });

  it("escapes a title with markup characters in it", () => {
    expect(renderAlert({ kind: "note", title: "Use <stdin> & wait" }, "")).toContain(
      "Use &lt;stdin&gt; &amp; wait",
    );
  });

  it("marks the icon as decorative, since the title says the same thing", () => {
    expect(renderAlert({ kind: "note", title: "Note" }, "")).toContain('aria-hidden="true"');
  });
});
