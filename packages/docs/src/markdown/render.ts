// The pipeline: one Markdown file in, one page's HTML out.
//
// This runs **at build time, in Node**, and nothing here reaches the browser. The
// caller is `plugins/content.ts`, which walks `docs/` and renders every page once;
// the browser receives the HTML, the headings and the frontmatter and never sees a
// Markdown file.
//
// The order of the passes is the design, and it is dictated by one awkward fact:
// **highlighting is asynchronous and rendering is not.** marked's renderer hooks
// are synchronous functions, and Shiki's API is a promise. Rather than pull in
// marked's async walk — which re-enters the whole tree for every page and makes
// every hook `await`-shaped — the pipeline lexes first, awaits the highlighting of
// every fence it found, and only then renders, synchronously, with the answers
// already in hand:
//
//  1. Split the frontmatter off.
//  2. Lex the body into tokens.
//  3. Walk the tokens once: highlight every ordinary fence, and lift the marker
//     off every GitHub alert. Both results are stored against the token itself, so
//     nothing has to be found twice or matched by position.
//  4. Parse the tokens to HTML, with the renderer hooks below.
//
// Step 3 mutates alert tokens in place. That is on purpose and is explained in
// `alerts.ts`: the body of an alert is Markdown that has already been lexed, and
// re-lexing a sliced string would be a second parse that can disagree with the
// first.
//
// Everything is per-page state — the slugger, the headings, the `<details>` stack —
// so a fresh `Marked` instance is built for each render. That is cheap. The
// expensive thing, the highlighter, is the one piece that is shared, and it lives
// in `highlight.ts`.

import { Marked, type Token, type Tokens } from "marked";

import type { Heading } from "../types.js";
import { renderAlert, takeAlert, type Alert } from "./alerts.js";
import { createDetailsRewriter } from "./details.js";
import { escapeAttribute } from "./escape.js";
import { codeBlock, diagramBlock, promptBlock } from "./fences.js";
import { parseFrontmatter } from "./frontmatter.js";
import { highlight } from "./highlight.js";
import { resolveDocHref } from "./links.js";
import { createSlugger } from "./slug.js";
import { toPlainText } from "./text.js";
import type { Frontmatter } from "./types.js";

export type { Frontmatter } from "./types.js";
export { parseFrontmatter } from "./frontmatter.js";

export interface RenderInput {
  /** The file's full text, frontmatter and all. */
  source: string;
  /** The page's path under `docs/`, e.g. "getting-started/install.md". Used to resolve relative links. */
  file: string;
}

export interface Rendered {
  frontmatter: Frontmatter;
  html: string;
  headings: Heading[];
}

/** The fence languages that are not code and are never handed to the highlighter. */
const PROMPT = "prompt";
const MERMAID = "mermaid";

/** The fence's tag, without the extra marked allows after it (` ```js title="x" `). */
const fenceLang = (token: Tokens.Code): string => (token.lang ?? "").trim().split(/\s+/)[0] ?? "";

export const render = async (input: RenderInput): Promise<Rendered> => {
  const { frontmatter, body } = parseFrontmatter(input.source);

  // GFM on: tables, task lists, strikethrough and footnotes are all used by the
  // pages and all of them are GitHub's dialect rather than CommonMark's, which is
  // the dialect the pages are written in because GitHub is where they are read.
  const marked = new Marked({ gfm: true });
  const tokens = marked.lexer(body);

  // Keyed by the token object rather than by an index or by the code's text: two
  // fences on a page can hold the same string, and a token's position moves when
  // an alert drops an empty paragraph out of a blockquote.
  const highlighted = new Map<Tokens.Code, { html: string; lang: string }>();
  const alerts = new Map<Tokens.Blockquote, Alert>();
  await scan(tokens, highlighted, alerts);

  const slug = createSlugger();
  const headings: Heading[] = [];
  const rewriteDetails = createDetailsRewriter();

  // Method shorthand and not arrow functions, which is the one place this package
  // departs from its own style: marked binds `this` to the renderer and `this.parser`
  // is the only way to render a token's children. An arrow function here loses it
  // and every nested list, quote and heading comes out empty.
  marked.use({
    renderer: {
      code(token: Tokens.Code): string {
        const lang = fenceLang(token);
        if (lang === PROMPT) return `${promptBlock(token.text)}\n`;
        if (lang === MERMAID) {
          const source = token.text.trim();
          // An empty mermaid fence would become a diagram with nothing in it and
          // no fallback to explain the empty box. Let it fall through and be a
          // plain code block instead, which is visibly a mistake.
          if (source !== "") return `${diagramBlock(source)}\n`;
        }
        const done = highlighted.get(token);
        return `${codeBlock(done?.lang ?? lang ?? "text", done?.html ?? "")}\n`;
      },

      blockquote(token: Tokens.Blockquote): string {
        const body = this.parser.parse(token.tokens);
        const alert = alerts.get(token);
        // The trailing newline is marked's own convention for a block element, and
        // keeping it means the page's HTML is not half newline-separated and half not.
        return `${alert ? renderAlert(alert, body) : `<blockquote>${body}</blockquote>`}\n`;
      },

      heading(token: Tokens.Heading): string {
        const inner = this.parser.parseInline(token.tokens);
        // The id comes from the *rendered* heading run to plain text, so a heading
        // holding `<code>` or a link slugs from the words a reader sees rather than
        // from the Markdown around them.
        const text = toPlainText(inner);
        const id = slug(text);
        if (token.depth === 2 || token.depth === 3) headings.push({ depth: token.depth, id, text });
        // The self-link is a `#` and not an icon, because it is copied by right-
        // clicking it and a reader has to be able to see there is something there.
        const anchor = `<a class="sbx-anchor" href="#${escapeAttribute(id)}" aria-label="Link to this section">#</a>`;
        return `<h${token.depth} id="${escapeAttribute(id)}">${inner}${anchor}</h${token.depth}>\n`;
      },

      html(token: Tokens.HTML | Tokens.Tag): string {
        return rewriteDetails(token.text);
      },

      link(token: Tokens.Link): string {
        const inner = this.parser.parseInline(token.tokens);
        return renderLink(token, inner, input.file);
      },
    },
  });

  return { frontmatter, html: marked.parser(tokens), headings };
};

/**
 * The one walk over the token tree.
 *
 * Recursive over every shape marked nests children in, which is four different
 * property names — `tokens` on most things, `items` on a list, `rows` and `header`
 * on a table. Missing one of them means a fence inside a list item silently comes
 * out unhighlighted, and a list item is exactly where a fence usually is.
 */
const scan = async (
  tokens: readonly Token[],
  highlighted: Map<Tokens.Code, { html: string; lang: string }>,
  alerts: Map<Tokens.Blockquote, Alert>,
): Promise<void> => {
  for (const token of tokens) {
    if (token.type === "code") {
      const code = token as Tokens.Code;
      const lang = fenceLang(code);
      if (lang !== PROMPT && lang !== MERMAID) {
        highlighted.set(code, await highlight(code.text, lang));
      }
      continue;
    }

    if (token.type === "blockquote") {
      const quote = token as Tokens.Blockquote;
      const alert = takeAlert(quote);
      if (alert) alerts.set(quote, alert);
    }

    // Every branch is guarded with `Array.isArray` and not merely with a
    // truthiness check, because a table *cell* carries `header: true` — a boolean
    // under one of the same property names a token uses for its children. Reading
    // it as a list of tokens throws "tokens is not iterable" from inside a table,
    // which reads like a bug in marked rather than one here.
    const nested = token as Record<string, unknown>;
    for (const key of ["tokens", "items", "header"]) {
      const children = nested[key];
      if (Array.isArray(children)) await scan(children as Token[], highlighted, alerts);
    }
    if (Array.isArray(nested.rows)) {
      for (const row of nested.rows) {
        if (Array.isArray(row)) await scan(row as Token[], highlighted, alerts);
      }
    }
  }
};

/**
 * A link, with its href rewritten and a new tab where it leaves the site.
 *
 * `rel="noreferrer"` and not `noopener` alone: `noreferrer` implies `noopener` and
 * additionally withholds the referrer, and a documentation link has no reason to
 * tell a third-party site which page somebody was reading.
 */
const renderLink = (token: Tokens.Link, inner: string, file: string): string => {
  const { href, external } = resolveDocHref(token.href, file);
  const title = token.title ? ` title="${escapeAttribute(token.title)}"` : "";
  const target = external ? ` target="_blank" rel="noreferrer"` : "";
  return `<a href="${escapeAttribute(href)}"${title}${target}>${inner}</a>`;
};
