// What this covers:
//  - tags dropped, entities decoded, whitespace collapsed
//  - the chrome this pipeline adds is dropped: the copy button's "Copy", the
//    language label, the prompt caption, the heading anchor's #, the whole diagram
//  - a block tag separates two words and an inline one does not
//  - &amp;lt; decodes to the literal text &lt; and not to a <
//  - the author's words survive: prose, code contents, a details chip, an alert title

import { describe, expect, it } from "vitest";
import { toPlainText } from "./text.js";

describe("toPlainText", () => {
  it("drops tags and collapses whitespace", () => {
    expect(toPlainText("<h2>Hello</h2>\n\n<p>A <em>word</em>.</p>")).toBe("Hello A word.");
  });

  it("decodes entities", () => {
    expect(toPlainText("<p>a &lt; b &amp; c &quot;d&quot; &hellip;</p>")).toBe(`a < b & c "d" …`);
  });

  it("decodes a numeric entity", () => {
    expect(toPlainText("<p>&#x3C;x&#62; &#8212;</p>")).toBe("<x> —");
  });

  it("decodes &amp;lt; to the literal text &lt; and not to a bracket", () => {
    // A two-pass decoder gets this wrong, and the corpus then says something the
    // page does not.
    expect(toPlainText("<p>&amp;lt;</p>")).toBe("&lt;");
  });

  it("leaves an entity it does not know alone rather than mangling it", () => {
    expect(toPlainText("<p>&notanentity;</p>")).toBe("&notanentity;");
  });

  it("drops the copy button, so no page matches a search for Copy", () => {
    const html =
      '<div class="sbx-code" data-lang="bash"><div class="sbx-code__bar">' +
      '<span class="sbx-code__lang">bash</span>' +
      '<button class="sbx-copy" type="button" data-copy aria-label="Copy this code">' +
      '<svg class="sbx-copy__icon"></svg><span class="sbx-copy__word">Copy</span></button>' +
      '</div><pre class="sbx-code__pre shiki"><code><span>sandboxer up</span></code></pre></div>';
    const text = toPlainText(html);
    expect(text).not.toContain("Copy");
    expect(text).not.toContain("bash");
    expect(text).toBe("sandboxer up");
  });

  it("drops the prompt card's caption but keeps the prompt", () => {
    const html =
      '<div class="sbx-prompt"><div class="sbx-prompt__bar">' +
      '<span class="sbx-prompt__label"><svg class="sbx-prompt__icon"></svg>Prompt for your agent</span>' +
      '<button class="sbx-copy sbx-prompt__copy" data-copy aria-label="Copy this prompt">' +
      '<span class="sbx-copy__word">Copy</span></button></div>' +
      '<pre class="sbx-prompt__pre"><code>Install sandboxer.</code></pre></div>';
    expect(toPlainText(html)).toBe("Install sandboxer.");
  });

  it("drops a diagram whole, source and fallback", () => {
    const html =
      '<p>Before.</p><figure class="sbx-diagram">' +
      '<div class="sbx-diagram__canvas" data-chart="graph TD&#10;  A --&gt; B">' +
      '<pre class="sbx-diagram__fallback">graph TD\n  A --&gt; B</pre></div></figure><p>After.</p>';
    expect(toPlainText(html)).toBe("Before. After.");
  });

  it("drops the # a heading's self-link is made of", () => {
    const html =
      '<h2 id="setup">Setup<a class="sbx-anchor" href="#setup" aria-label="Link to this section">#</a></h2>';
    expect(toPlainText(html)).toBe("Setup");
  });

  it("keeps an alert's title and body", () => {
    const html =
      '<div class="sbx-alert sbx-alert--warning" role="note">' +
      '<p class="sbx-alert__title"><svg class="sbx-alert__icon"></svg>The password is a root credential</p>' +
      "<p>Anyone who has it.</p></div>";
    expect(toPlainText(html)).toBe("The password is a root credential Anyone who has it.");
  });

  it("keeps a details chip and summary, which the author wrote", () => {
    const html =
      '<details class="sbx-detail" data-kind="agent"><summary class="sbx-detail__summary">' +
      '<span class="sbx-detail__chip">Details for an agent</span>' +
      '<span class="sbx-detail__text">every flag</span></summary>' +
      '<div class="sbx-detail__body"><p>Body.</p></div></details>';
    expect(toPlainText(html)).toBe("Details for an agent every flag Body.");
  });

  it("separates two table cells and two list items", () => {
    expect(toPlainText("<tr><td>a</td><td>b</td></tr>")).toBe("a b");
    expect(toPlainText("<ul><li>one</li><li>two</li></ul>")).toBe("one two");
  });

  it("does not separate a highlighted token from the one beside it", () => {
    // Shiki scopes the dashes of a flag separately, and a space between the spans
    // would mean a search for `--ttl` never finds the page that documents it.
    expect(toPlainText("<code><span>--</span><span>ttl</span></code>")).toBe("--ttl");
  });

  it("drops a script or a style a page wrote inline", () => {
    expect(toPlainText("<p>a</p><style>.x{color:red}</style><script>alert(1)</script><p>b</p>")).toBe("a b");
  });

  it("drops an HTML comment", () => {
    expect(toPlainText("<p>a</p><!-- a note to an editor --><p>b</p>")).toBe("a b");
  });

  it("returns the empty string for empty input", () => {
    expect(toPlainText("")).toBe("");
  });
});
