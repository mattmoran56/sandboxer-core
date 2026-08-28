// What this covers:
//  - splitSummary: the conventional <b>…</b> opening, an em dash separator, and a
//    summary with no bold opening at all
//  - the rewriter, for each of the four kinds
//  - a class outside the four passes through untouched, opening and closing tag both
//  - the closing tag is only rewritten for a block whose opening tag was
//  - a stray </details> with no opening tag does not corrupt the page
//  - a single-quoted and an unquoted class attribute

import { describe, expect, it } from "vitest";
import { createDetailsRewriter, splitSummary } from "./details.js";

describe("splitSummary", () => {
  it("takes the bold opening as the chip and the rest as the text", () => {
    expect(splitSummary("<b>Details for an agent</b> — every flag it accepts", "agent")).toEqual({
      chip: "Details for an agent",
      text: "every flag it accepts",
    });
  });

  it("keeps inline markup in the text", () => {
    expect(splitSummary("<b>Fact sheet</b> — what <code>up</code> defaults to", "facts").text).toBe(
      "what <code>up</code> defaults to",
    );
  });

  it("strips a hyphen or an en dash separator as well as an em dash", () => {
    expect(splitSummary("<b>If it goes wrong</b> - the three usual causes", "failure").text).toBe(
      "the three usual causes",
    );
    expect(splitSummary("<b>If it goes wrong</b> – the three usual causes", "failure").text).toBe(
      "the three usual causes",
    );
  });

  it("handles a bold opening with nothing after it", () => {
    expect(splitSummary("<b>Fact sheet</b>", "facts")).toEqual({ chip: "Fact sheet", text: "" });
  });

  it("falls back to the kind's conventional opening when there is no bold run", () => {
    expect(splitSummary("every flag it accepts", "why")).toEqual({
      chip: "Why it works this way",
      text: "every flag it accepts",
    });
  });

  it("does not take a bold run that is not at the front", () => {
    expect(splitSummary("about <b>flags</b>", "agent").chip).toBe("Details for an agent");
  });
});

describe("createDetailsRewriter", () => {
  const open = (kind: string, summary = "<b>X</b> — y") =>
    `<details class="${kind}">\n<summary>${summary}</summary>\n`;

  it("rewrites each of the four kinds and names it in data-kind", () => {
    for (const kind of ["agent", "failure", "why", "facts"]) {
      const html = createDetailsRewriter()(open(kind));
      expect(html).toContain(`<details class="sbx-detail" data-kind="${kind}">`);
      expect(html).toContain('<svg class="sbx-detail__icon"');
      expect(html).toContain('<span class="sbx-detail__chip">X</span>');
      expect(html).toContain('<span class="sbx-detail__text">y</span>');
      expect(html).toContain('<svg class="sbx-detail__chevron"');
      expect(html).toContain('<div class="sbx-detail__body">');
    }
  });

  it("uses the conventional opening when the summary has no bold run", () => {
    expect(createDetailsRewriter()(open("failure", "what to check first"))).toContain(
      '<span class="sbx-detail__chip">If it goes wrong</span>',
    );
  });

  it("omits the text span when the summary was only a chip", () => {
    expect(createDetailsRewriter()(open("facts", "<b>Fact sheet</b>"))).not.toContain("sbx-detail__text");
  });

  it("closes the injected body wrapper on the closing tag", () => {
    const rewrite = createDetailsRewriter();
    rewrite(open("agent"));
    expect(rewrite("</details>\n")).toBe("</div></details>\n");
  });

  it("passes a class outside the four through, opening and closing", () => {
    const rewrite = createDetailsRewriter();
    const opening = '<details class="install-steps">\n<summary>Steps</summary>\n';
    expect(rewrite(opening)).toBe(opening);
    expect(rewrite("</details>\n")).toBe("</details>\n");
  });

  it("passes a details with no class at all through", () => {
    const rewrite = createDetailsRewriter();
    expect(rewrite("<details>\n<summary>More</summary>\n")).toBe("<details>\n<summary>More</summary>\n");
    expect(rewrite("</details>")).toBe("</details>");
  });

  it("keeps a rewritten and an unrewritten block straight when they are interleaved", () => {
    // The reason the rewriter has a stack at all: the closing tag arrives as its
    // own token and carries no clue which block it belongs to.
    const rewrite = createDetailsRewriter();
    rewrite(open("why"));
    expect(rewrite("</details>")).toBe("</div></details>");
    rewrite('<details class="other">');
    expect(rewrite("</details>")).toBe("</details>");
  });

  it("leaves a stray closing tag alone", () => {
    expect(createDetailsRewriter()("</details>")).toBe("</details>");
  });

  it("reads a single-quoted and an unquoted class", () => {
    expect(createDetailsRewriter()("<details class='agent'>")).toContain('data-kind="agent"');
    expect(createDetailsRewriter()("<details class=agent>")).toContain('data-kind="agent"');
  });

  it("reads a class alongside other attributes", () => {
    expect(createDetailsRewriter()('<details open class="facts" id="x">')).toContain('data-kind="facts"');
  });

  it("leaves surrounding text in the same chunk alone", () => {
    const rewrite = createDetailsRewriter();
    expect(rewrite(`<p>before</p>\n${open("agent")}`)).toContain("<p>before</p>");
  });
});
