// Rendered HTML, as the words the author wrote.
//
// This is what the search index is built from, and the interesting part is not the
// tag stripping — it is what gets removed *before* the tag stripping. The pipeline
// adds a fair amount of chrome to a page: a copy button on every code block, a
// language label above it, a caption on every prompt card, a `#` on every heading,
// and the mermaid source printed twice as a fallback. All of that is this
// pipeline's words rather than the author's, and left in the corpus it makes every
// page on the site a match for "copy", every page with a shell command a match for
// "bash", and every page with a diagram a match for "graph TD".
//
// The mermaid source is the clearest case. It is not prose, nobody searches for it,
// and it appears twice per diagram — so a page with three diagrams would outrank a
// page that actually explains the thing.
//
// The chip on a `<details>` is deliberately kept. AUTHORING.md has the author write
// it themselves, as `<b>Details for an agent</b>`, and it is a real part of the
// page; it is only this pipeline's words in the rare block that forgot the bold
// opening. Code *contents* are kept too — a reader searching for `sandboxr up`
// should find the page that shows it.

/** The chrome this pipeline adds, removed whole, contents and all. */
const CHROME: readonly RegExp[] = [
  // The diagram, including its data-chart attribute and its duplicated fallback.
  /<figure class="sbx-diagram">[\s\S]*?<\/figure>/gi,
  // The copy button, and with it the word "Copy" and its icon.
  /<button\b[^>]*\bdata-copy\b[^>]*>[\s\S]*?<\/button>/gi,
  // The language label over a code block, and the prompt card's caption.
  /<span class="sbx-code__lang">[\s\S]*?<\/span>/gi,
  /<span class="sbx-prompt__label">[\s\S]*?<\/span>/gi,
  // The `#` a heading's self-link is made of.
  /<a class="sbx-anchor"[^>]*>[\s\S]*?<\/a>/gi,
  // Neither can appear in this pipeline's output, but a page is allowed inline
  // HTML and one arriving would otherwise put a stylesheet in the search corpus.
  /<(script|style)\b[^>]*>[\s\S]*?<\/\1>/gi,
];

/**
 * This pipeline's own elements, which separate two words whatever tag they use.
 *
 * A `<details>` summary is built out of two adjacent spans — the chip and the
 * text — and without this they run together as `Details for an agentevery flag`.
 * Scoped to the `sbx-` prefix rather than applied to every span, because Shiki's
 * spans must *not* separate: see the block comment below.
 */
const OWN_MARKUP = /\bclass[ \t]*=[ \t]*["']?sbx-/i;

/**
 * The tags that separate two words.
 *
 * Everything absent from this set is inline and joins them instead.
 */
const BLOCK = new Set([
  "address", "article", "aside", "blockquote", "br", "caption", "dd", "details",
  "div", "dl", "dt", "figcaption", "figure", "footer", "h1", "h2", "h3", "h4",
  "h5", "h6", "header", "hr", "li", "main", "nav", "ol", "p", "pre", "section",
  "summary", "table", "tbody", "td", "tfoot", "th", "thead", "tr", "ul",
]);

/** The named entities marked emits. Everything else numeric is handled generically. */
const NAMED: Readonly<Record<string, string>> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
  hellip: "…",
  mdash: "—",
  ndash: "–",
  copy: "©",
  laquo: "«",
  raquo: "»",
};

/**
 * Decodes the entities in a text run.
 *
 * `&amp;` is decoded in the same single pass as everything else, which matters: a
 * two-pass decoder turns `&amp;lt;` — the escaped form of the literal text
 * `&lt;` — into a `<`, and a corpus is then subtly not what the page says.
 */
const decode = (value: string): string =>
  value.replace(/&(#x?[0-9a-f]+|[a-z][a-z0-9]*);/gi, (matched, body: string) => {
    if (body.startsWith("#")) {
      const code = body[1] === "x" || body[1] === "X" ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10);
      return Number.isFinite(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : matched;
    }
    return NAMED[body.toLowerCase()] ?? matched;
  });

export const toPlainText = (html: string): string => {
  let text = html;
  for (const pattern of CHROME) text = text.replace(pattern, " ");

  // A **block-level** tag becomes a space and an inline one becomes nothing, and
  // the distinction is load-bearing in both directions. Without the space,
  // `<td>a</td><td>b</td>` reads as the single word `ab` and a table matches
  // nothing. With a space on inline tags, a highlighted `--ttl` — which Shiki
  // splits into `<span>--</span><span>ttl</span>` because the grammar scopes the
  // dashes separately — becomes `-- ttl` and a search for the flag misses it.
  text = text.replace(/<\/?([a-z][a-z0-9]*)\b([^>]*)>/gi, (_matched, tag: string, attributes: string) =>
    BLOCK.has(tag.toLowerCase()) || OWN_MARKUP.test(attributes) ? " " : "",
  );
  // Anything left that looked like a tag but had no name: a comment, a doctype.
  text = text.replace(/<[^>]*>/g, " ");

  return decode(text).replace(/\s+/g, " ").trim();
};
