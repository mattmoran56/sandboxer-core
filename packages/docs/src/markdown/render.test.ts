// What this covers:
//  - the whole pipeline over one synthetic page: frontmatter, headings, all five
//    markup conventions
//  - the headings array and the ids in the markup come from one slugger, collision
//    suffixes included
//  - a ```prompt fence's <code> text is the fence's content, byte for byte
//  - a <details> body is rendered as Markdown, table and fence and all
//  - GFM survives: tables, task lists, strikethrough, footnotes
//  - a fence inside a list item is still highlighted
//  - an image under docs/assets/ rewritten to its site path, and one that is not
//    left alone
//  - a page with no frontmatter renders rather than throwing
//  - and then the real pages under docs/, asserted on structure and never on prose,
//    because they are being rewritten while this is being written

import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { render } from "./render.js";
import { toPlainText } from "./text.js";

const page = (body: string, file = "guides/lifecycle.md") =>
  render({ source: `---\ntitle: A page\ndescription: One sentence.\n---\n${body}`, file });

/** What a browser's `textContent` would report for a `<code>` element's markup. */
const decode = (value: string): string =>
  value.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&amp;/g, "&");

describe("render", () => {
  it("returns the frontmatter and the body's HTML", async () => {
    const out = await page("Hello.\n");
    expect(out.frontmatter).toEqual({ title: "A page", description: "One sentence.", tableOfContents: true });
    expect(out.html).toContain("<p>Hello.</p>");
  });

  it("renders a page with no frontmatter rather than throwing", async () => {
    const out = await render({ source: "# Only a heading\n", file: "index.md" });
    expect(out.frontmatter.title).toBe("");
    expect(out.html).toContain("Only a heading");
  });
});

describe("headings", () => {
  it("gives every heading an id and a self-link", async () => {
    const { html } = await page("## What happens first\n");
    expect(html).toBe(
      '<h2 id="what-happens-first">What happens first' +
        '<a class="sbx-anchor" href="#what-happens-first" aria-label="Link to this section">#</a></h2>\n',
    );
  });

  it("collects h2 and h3 only, in document order", async () => {
    const { headings } = await page("# One\n\n## Two\n\n### Three\n\n#### Four\n");
    expect(headings).toEqual([
      { depth: 2, id: "two", text: "Two" },
      { depth: 3, id: "three", text: "Three" },
    ]);
  });

  it("slugs from the words a reader sees, not from the Markdown around them", async () => {
    const { headings, html } = await page("## The `--ttl` flag\n");
    expect(headings[0]?.text).toBe("The --ttl flag");
    expect(headings[0]?.id).toBe("the-ttl-flag");
    expect(html).toContain('id="the-ttl-flag"');
  });

  it("numbers a collision, and the array and the markup agree", async () => {
    const { headings, html } = await page("## Setup\n\n## Setup\n\n## Setup\n");
    expect(headings.map((heading) => heading.id)).toEqual(["setup", "setup-2", "setup-3"]);
    for (const heading of headings) expect(html).toContain(`id="${heading.id}"`);
  });

  it("gives a heading of only punctuation a linkable id", async () => {
    const { headings } = await page("## ???\n");
    expect(headings[0]?.id).toBe("section");
  });
});

describe("a ```prompt fence", () => {
  it("becomes the prompt card, not a highlighted block", async () => {
    const { html } = await page("```prompt\nInstall sandboxer.\n```\n");
    expect(html).toContain('<div class="sbx-prompt">');
    expect(html).toContain("Prompt for your agent");
    expect(html).not.toContain("shiki");
  });

  it("carries the fence's content byte for byte, escaping and all", async () => {
    const source = ['Read https://x.test/?a=1&b=2 first.', '', `Then: sandboxer up --env 'A="1"' <<'EOF'`, '  x & y > z'].join("\n");
    const { html } = await page(`\`\`\`prompt\n${source}\n\`\`\`\n`);
    const code = /<pre class="sbx-prompt__pre"><code>([\s\S]*?)<\/code><\/pre>/.exec(html)?.[1] ?? "";
    expect(decode(code)).toBe(source);
  });

  it("keeps only one copy of the text, so nothing can drift out of step", async () => {
    const { html } = await page("```prompt\nunique-marker\n```\n");
    expect(html.match(/unique-marker/g)).toHaveLength(1);
  });
});

describe("a ```mermaid fence", () => {
  it("becomes a diagram with its source on the attribute and in the fallback", async () => {
    const { html } = await page('```mermaid\ngraph TD\n  A["a & b"] --> B\n```\n');
    expect(html).toContain('<figure class="sbx-diagram">');
    expect(html).toContain('data-chart="graph TD');
    expect(html).toContain("&quot;a &amp; b&quot;");
    expect(html).toContain('<pre class="sbx-diagram__fallback">');
    expect(html).toContain('A["a &amp; b"] --&gt; B');
  });

  it("falls back to a code block for an empty fence, so the mistake is visible", async () => {
    const { html } = await page("```mermaid\n\n```\n");
    expect(html).not.toContain("sbx-diagram");
    expect(html).toContain('<div class="sbx-code"');
  });
});

describe("every other fence", () => {
  it("becomes the code block, highlighted in both themes", async () => {
    const { html } = await page('```bash\nsandboxer up --ttl 12h\n```\n');
    expect(html).toContain('<div class="sbx-code" data-lang="bash">');
    expect(html).toContain('<span class="sbx-code__lang">bash</span>');
    expect(html).toContain("data-copy");
    expect(html).toContain('<pre class="sbx-code__pre shiki');
    expect(html).toContain("--shiki-light:");
    expect(html).toContain("--shiki-dark:");
  });

  it("labels an untagged fence as text", async () => {
    const { html } = await page("```\nplain\n```\n");
    expect(html).toContain('data-lang="text"');
  });

  it("labels a fence with an unknown language as text rather than failing", async () => {
    const { html } = await page("```wat\nplain\n```\n");
    expect(html).toContain('data-lang="text"');
    expect(html).toContain("plain");
  });

  it("highlights a fence inside a list item", async () => {
    const { html } = await page("1. Run it:\n\n   ```bash\n   sandboxer up\n   ```\n");
    expect(html).toContain('<div class="sbx-code" data-lang="bash">');
  });

  it("highlights a fence inside a blockquote", async () => {
    const { html } = await page("> Try:\n>\n> ```bash\n> sandboxer up\n> ```\n");
    expect(html).toContain('<div class="sbx-code" data-lang="bash">');
  });

  it("leaves inline code as inline code", async () => {
    expect((await page("A `sandboxer up` command.\n")).html).toContain("<code>sandboxer up</code>");
  });
});

describe("alerts", () => {
  it("renders all five kinds with their titles", async () => {
    const source = [
      "> [!NOTE] A note\n> Body.",
      "> [!TIP] A tip\n> Body.",
      "> [!IMPORTANT] Important\n> Body.",
      "> [!WARNING] The password is a root credential\n> Body.",
      "> [!CAUTION] Careful\n> Body.",
    ].join("\n\n");
    const { html } = await page(`${source}\n`);
    for (const kind of ["note", "tip", "important", "warning", "caution"]) {
      expect(html).toContain(`<div class="sbx-alert sbx-alert--${kind}" role="note">`);
    }
    expect(html).toContain('<svg class="sbx-alert__icon"');
    expect(html).toContain("The password is a root credential</p>");
  });

  it("leaves an ordinary blockquote as a blockquote", async () => {
    const { html } = await page("> Just a quotation.\n");
    expect(html).toContain("<blockquote>");
    expect(html).not.toContain("sbx-alert");
  });
});

describe("a <details> block", () => {
  const detail = (kind: string, summary: string, body: string) =>
    `<details class="${kind}">\n<summary>${summary}</summary>\n\n${body}\n\n</details>\n`;

  it("renders each of the four kinds", async () => {
    for (const kind of ["agent", "failure", "why", "facts"]) {
      const { html } = await page(detail(kind, "<b>X</b> — y", "Body."));
      expect(html).toContain(`<details class="sbx-detail" data-kind="${kind}">`);
      expect(html).toContain('<div class="sbx-detail__body">');
      expect(html).toContain("</div></details>");
    }
  });

  it("splits a conventional summary into a chip and a text", async () => {
    const { html } = await page(
      detail("agent", "<b>Details for an agent</b> — every flag <code>sandboxer up</code> accepts", "Body."),
    );
    expect(html).toContain('<span class="sbx-detail__chip">Details for an agent</span>');
    expect(html).toContain('<span class="sbx-detail__text">every flag <code>sandboxer up</code> accepts</span>');
  });

  it("labels a summary with no bold opening from its kind", async () => {
    const { html } = await page(detail("why", "the reasoning", "Body."));
    expect(html).toContain('<span class="sbx-detail__chip">Why it works this way</span>');
    expect(html).toContain('<span class="sbx-detail__text">the reasoning</span>');
  });

  it("renders the body as Markdown: a table and a fence", async () => {
    const body = "| Flag | Means |\n|---|---|\n| `--ttl 12h` | Stop it |\n\n```bash\nsandboxer up\n```";
    const { html } = await page(detail("agent", "<b>Details for an agent</b> — flags", body));
    expect(html).toContain("<table>");
    expect(html).toContain("<code>--ttl 12h</code>");
    expect(html).toContain('<div class="sbx-code" data-lang="bash">');
  });

  it("passes a class outside the four through untouched, and does not crash", async () => {
    const { html } = await page(detail("install-steps", "Steps", "Body."));
    expect(html).toContain('<details class="install-steps">');
    expect(html).not.toContain("sbx-detail");
    // The closing tag must not have gained a </div> for a <div> nobody opened.
    expect(html).not.toContain("</div></details>");
    expect(html).toContain("<p>Body.</p>");
  });

  it("keeps two blocks straight when one is rewritten and the other is not", async () => {
    const { html } = await page(
      detail("agent", "<b>Details for an agent</b> — a", "One.") + "\n" + detail("other", "b", "Two."),
    );
    expect(html.match(/<\/div><\/details>/g)).toHaveLength(1);
    expect(html).toContain("<p>One.</p>");
    expect(html).toContain("<p>Two.</p>");
  });
});

describe("links", () => {
  it("rewrites a relative .md link to the URL this site serves", async () => {
    const { html } = await page("See [the CLI](../reference/cli.md#sandboxer-up).\n");
    expect(html).toContain('<a href="/reference/cli/#sandboxer-up">the CLI</a>');
  });

  it("sends a link to the contract off the site, in a new tab", async () => {
    const { html } = await page("See [the contract](../architecture/contracts.md).\n");
    expect(html).toContain(
      '<a href="https://github.com/mattmoran56/sandboxer-core/blob/main/docs/architecture/contracts.md" target="_blank" rel="noreferrer">',
    );
  });

  it("opens an external link in a new tab and withholds the referrer", async () => {
    const { html } = await page("See [Docker](https://docs.docker.com/).\n");
    expect(html).toContain('target="_blank" rel="noreferrer"');
  });

  it("leaves a bare anchor and an absolute path in place, in this tab", async () => {
    const { html } = await page("[a](#setup) and [b](/reference/cli/)\n");
    expect(html).toContain('<a href="#setup">a</a>');
    expect(html).toContain('<a href="/reference/cli/">b</a>');
    expect(html).not.toContain("target=");
  });

  it("keeps a link title", async () => {
    expect((await page('[a](../reference/cli.md "The CLI")\n')).html).toContain('title="The CLI"');
  });

  it("rewrites a link inside a table cell and inside a details body", async () => {
    const { html } = await page(
      "| a |\n|---|\n| [x](../reference/cli.md) |\n\n" +
        '<details class="agent">\n<summary><b>Details for an agent</b> — a</summary>\n\n' +
        "[y](../reference/cli.md)\n\n</details>\n",
    );
    expect(html.match(/href="\/reference\/cli\/"/g)).toHaveLength(2);
  });
});

describe("images", () => {
  it("rewrites an image under docs/assets/ to the path the build copies it to", async () => {
    const { html } = await page("![The mark](../assets/brand/mark.svg)\n");
    expect(html).toContain('<img src="/assets/brand/mark.svg" alt="The mark"');
  });

  it("carries the alt text, a title, and the lazy attributes", async () => {
    const { html } = await page('![The mark](../assets/brand/mark.svg "Three bars")\n');
    expect(html).toContain('alt="The mark"');
    expect(html).toContain('title="Three bars"');
    expect(html).toContain('loading="lazy"');
    expect(html).toContain('decoding="async"');
  });

  it("leaves an image that is not under docs/assets/ alone", async () => {
    const { html } = await page("![a](screenshot.png)\n");
    expect(html).toContain('<img src="screenshot.png"');
  });
});

describe("GFM", () => {
  it("keeps tables, task lists, strikethrough and footnotes", async () => {
    const { html } = await page(
      "| a | b |\n|---|---|\n| 1 | 2 |\n\n" +
        "- [x] done\n- [ ] not\n\n" +
        "~~gone~~\n\n" +
        "A claim[^1]\n\n[^1]: The reason.\n",
    );
    expect(html).toContain("<table>");
    expect(html).toContain('type="checkbox"');
    expect(html).toContain("<del>gone</del>");
    expect(html).toContain("The reason.");
  });
});

// The real pages. Structure only — the prose is being rewritten by other agents
// while this runs, so anything asserted about wording would be a test that fails
// for the wrong reason. What is worth asserting is that the conventions the pages
// actually use come out the far end, which no synthetic fixture can promise.
describe("the real pages under docs/", () => {
  const root = path.resolve(import.meta.dirname, "../../../../docs");
  const read = (file: string) => readFileSync(path.join(root, file), "utf8");
  const files = ["index.md", "how-it-works.md", "reference/cli.md"];

  for (const file of files) {
    it(`renders ${file}`, async () => {
      const { frontmatter, html, headings } = await render({ source: read(file), file });

      expect(frontmatter.title).not.toBe("");
      expect(frontmatter.description).not.toBe("");
      expect(html.length).toBeGreaterThan(200);

      // Every heading in the markup has an id, and every id is unique.
      const ids = [...html.matchAll(/<h[1-6] id="([^"]*)"/g)].map((match) => match[1]);
      expect(ids.every((id) => id !== "")).toBe(true);
      expect(new Set(ids).size).toBe(ids.length);

      // Every collected heading exists in the markup, which is the table of
      // contents and the anchors agreeing.
      for (const heading of headings) expect(ids).toContain(heading.id);

      // Nothing was left half-transformed.
      expect(html).not.toContain("[!NOTE]");
      expect(html).not.toContain("[!WARNING]");
      expect(html).not.toContain('class="mermaid');
      expect(html).not.toMatch(/href="[^"]*\.mdx?[#"]/);
      expect(html).not.toContain("language-prompt");

      // And the search text is the author's words, not the pipeline's chrome.
      const text = toPlainText(html);
      expect(text).not.toContain("Prompt for your agent");
      expect(text.split(/\s+/)).not.toContain("Copy");
    });
  }

  it("renders the same conventions the pages actually use", async () => {
    // Asserted across the three together rather than per file, because which page
    // carries a prompt or a diagram is an editorial decision that moves.
    const rendered = await Promise.all(files.map(async (file) => (await render({ source: read(file), file })).html));
    const all = rendered.join("\n");
    expect(all).toContain('<div class="sbx-prompt">');
    expect(all).toContain('<div class="sbx-code"');
    expect(all).toMatch(/<a href="\/[a-z-]/);
  });
});
