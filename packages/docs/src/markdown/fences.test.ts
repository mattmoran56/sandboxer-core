// What this covers:
//  - promptBlock: the agreed markup, and that the <code> text is the source byte
//    for byte once the browser has decoded it — including <, &, quotes and a
//    blank line
//  - the copy button carries no copy of the source, only the class the handler needs
//  - diagramBlock: the source escaped two different ways, and the fallback visible
//  - codeBlock: this site's class threaded into Shiki's own <pre>

import { describe, expect, it } from "vitest";
import { codeBlock, diagramBlock, promptBlock } from "./fences.js";

/** What a browser's `textContent` would report for the markup's `<code>` element. */
const codeText = (html: string): string => {
  const match = /<code>([\s\S]*)<\/code>/.exec(html);
  if (!match || match[1] === undefined) throw new Error("no <code> in the markup");
  return match[1]
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");
};

describe("promptBlock", () => {
  it("writes the agreed markup", () => {
    const html = promptBlock("Install sandboxer.");
    expect(html).toMatch(/^<div class="sbx-prompt">/);
    expect(html).toContain('<div class="sbx-prompt__bar">');
    expect(html).toContain('<span class="sbx-prompt__label">');
    expect(html).toContain('<svg class="sbx-prompt__icon"');
    expect(html).toContain("Prompt for your agent</span>");
    expect(html).toContain('<button class="sbx-copy sbx-prompt__copy" type="button" data-copy aria-label="Copy this prompt">');
    expect(html).toContain('<span class="sbx-copy__word">Copy</span>');
    expect(html).toContain('<pre class="sbx-prompt__pre"><code>');
  });

  it("round-trips content with <, &, quotes and a blank line", () => {
    const source = [
      `Read the page at https://example.test/?a=1&b=2 first.`,
      ``,
      `Then run: sandboxer up --env 'A="1"' <<'EOF'`,
      `  x & y > z`,
      `EOF`,
    ].join("\n");
    expect(codeText(promptBlock(source))).toBe(source);
  });

  it("escapes the three characters that would otherwise be markup", () => {
    expect(promptBlock("a < b & c > d")).toContain("<code>a &lt; b &amp; c &gt; d</code>");
  });

  it("leaves quotes literal, so nothing copies a &quot;", () => {
    expect(promptBlock(`say "hi"`)).toContain(`<code>say "hi"</code>`);
  });

  it("emits nothing between <pre> and <code>, so a leading blank line survives", () => {
    // A newline immediately after a `<pre>` start tag is dropped by the HTML
    // parser. Pretty-printing this markup would eat the first line of a prompt.
    expect(promptBlock("\nfirst")).toContain('<pre class="sbx-prompt__pre"><code>\nfirst</code>');
  });

  it("never duplicates the source into an attribute", () => {
    const html = promptBlock("secret-looking text");
    expect(html.match(/secret-looking text/g)).toHaveLength(1);
  });

  it("adds no trailing newline of its own", () => {
    expect(codeText(promptBlock("one line"))).toBe("one line");
  });
});

describe("diagramBlock", () => {
  it("writes the agreed markup with the source in both places", () => {
    const html = diagramBlock('graph TD\n  A["a & b"] --> B');
    expect(html).toMatch(/^<figure class="sbx-diagram">/);
    expect(html).toContain('<div class="sbx-diagram__canvas" data-chart="graph TD\n');
    expect(html).toContain('<pre class="sbx-diagram__fallback">');
    expect(html.endsWith("</div></figure>")).toBe(true);
  });

  it("escapes the double quote in the attribute but not in the fallback", () => {
    const html = diagramBlock('A["x"]');
    expect(html).toContain('data-chart="A[&quot;x&quot;]"');
    expect(html).toContain('<pre class="sbx-diagram__fallback">A["x"]</pre>');
  });

  it("escapes the ampersand in both", () => {
    const html = diagramBlock("a & b");
    expect(html).toContain('data-chart="a &amp; b"');
    expect(html).toContain(">a &amp; b</pre>");
  });
});

describe("codeBlock", () => {
  const shiki = '<pre class="shiki shiki-themes github-light github-dark" style="--shiki-light:#111" tabindex="0"><code><span>ls</span></code></pre>';

  it("writes the agreed markup", () => {
    const html = codeBlock("bash", shiki);
    expect(html).toMatch(/^<div class="sbx-code" data-lang="bash">/);
    expect(html).toContain('<div class="sbx-code__bar">');
    expect(html).toContain('<span class="sbx-code__lang">bash</span>');
    expect(html).toContain('<button class="sbx-copy" type="button" data-copy aria-label="Copy this code">');
    expect(html.endsWith("</div>")).toBe(true);
  });

  it("threads its class into Shiki's own, keeping Shiki's style attribute", () => {
    const html = codeBlock("bash", shiki);
    expect(html).toContain('<pre class="sbx-code__pre shiki shiki-themes github-light github-dark"');
    expect(html).toContain('style="--shiki-light:#111"');
  });

  it("gives a bare <pre> the class rather than dropping it", () => {
    expect(codeBlock("text", "<pre><code>x</code></pre>")).toContain('<pre class="sbx-code__pre"><code>x</code></pre>');
  });

  it("escapes a language name, since it reaches an attribute and a text node", () => {
    const html = codeBlock('a"<b', "<pre><code></code></pre>");
    expect(html).toContain('data-lang="a&quot;&lt;b"');
    expect(html).toContain('<span class="sbx-code__lang">a"&lt;b</span>');
  });
});
