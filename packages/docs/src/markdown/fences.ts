// The three things a fenced code block can become.
//
// A ` ```prompt ` fence is a card. A ` ```mermaid ` fence is a diagram. Everything
// else is a highlighted code block. All three are written as ordinary fences so
// that the page still reads on GitHub, which renders every one of them as a plain
// code block — a prompt you can still copy, a diagram GitHub draws itself, and a
// command you can still run.
//
// The markup here is a fixed vocabulary shared with the stylesheet and with the
// browser-side behaviour: the copy handler, the mermaid renderer and the CSS all
// look for these exact class names. Changing one of them is changing three files.

import { escapeAttribute, escapeText } from "./escape.js";
import { COPY_ICON, PROMPT_ICON } from "./icons.js";

/**
 * The copy button.
 *
 * **It carries no copy of the source.** The handler finds the nearest
 * `.sbx-code`/`.sbx-prompt` ancestor and reads its `<code>` element's
 * `textContent`, so the text on screen and the text on the clipboard are the same
 * string by construction. Duplicating the source into a `data-` attribute would be
 * a second copy that can drift from the first — and it drifted in exactly one
 * direction every time: the visible block was re-escaped and the attribute was not.
 */
const copyButton = (extraClass: string, label: string): string =>
  `<button class="sbx-copy${extraClass}" type="button" data-copy aria-label="${label}">` +
  `${COPY_ICON}<span class="sbx-copy__word">Copy</span></button>`;

/**
 * A ` ```prompt ` fence.
 *
 * This is the most important element on the site. The reader's primary use case is
 * handing a prompt to their coding agent, and everything about this block exists to
 * make that one click work:
 *
 *  - **Not highlighted.** A prompt is prose addressed to a machine, not code. Any
 *    highlighter would wrap it in spans, and while `textContent` would survive
 *    that, the block would read as something to inspect rather than to take.
 *  - **`<code>`'s text is the fence's content, byte for byte.** No prompt
 *    character, no line numbers, no trailing newline beyond the source's own —
 *    whatever is here is what lands in the agent's input. Only `&`, `<` and `>`
 *    are escaped, which the browser undoes on the way back out; a quote is left
 *    literal, because escaping it would put `&quot;` in the copied text.
 *  - **Nothing is emitted between `<pre>` and `<code>`.** The HTML parser drops a
 *    single newline immediately after a `<pre>` start tag, and a pretty-printed
 *    version of this markup would silently eat the first line of a prompt that
 *    began with a blank one.
 */
export const promptBlock = (source: string): string =>
  `<div class="sbx-prompt">` +
  `<div class="sbx-prompt__bar">` +
  `<span class="sbx-prompt__label">${PROMPT_ICON}Prompt for your agent</span>` +
  copyButton(" sbx-prompt__copy", "Copy this prompt") +
  `</div>` +
  `<pre class="sbx-prompt__pre"><code>${escapeText(source)}</code></pre>` +
  `</div>`;

/**
 * A ` ```mermaid ` fence.
 *
 * GitHub renders these itself. Here the source is carried on a `data-chart`
 * attribute and swapped for an SVG in the browser, which is what lets a diagram
 * follow the site's light and dark themes — a diagram drawn at build time is drawn
 * in one of them and wrong in the other.
 *
 * **The fallback stays visible until the SVG replaces it, and stays for good if the
 * source will not parse.** A diagram that fails is still readable as text, and the
 * failure is then obvious rather than being an empty box nobody notices. It is also
 * what a reader with no JavaScript gets, and what the static HTML contains.
 *
 * The source goes into the markup twice, escaped two different ways, which is the
 * reason `escape.ts` has two functions.
 */
export const diagramBlock = (source: string): string =>
  `<figure class="sbx-diagram">` +
  `<div class="sbx-diagram__canvas" data-chart="${escapeAttribute(source)}">` +
  `<pre class="sbx-diagram__fallback">${escapeText(source)}</pre>` +
  `</div></figure>`;

/**
 * Every other fence.
 *
 * `highlighted` is Shiki's own `<pre class="shiki …" style="…"><code>…</code></pre>`,
 * with this site's class threaded into the list it already wrote rather than
 * wrapped in another element — Shiki's `style` carries the theme variables and has
 * to stay on the element the CSS styles.
 *
 * `data-lang` is on the outer element as well as in the visible label, so a
 * stylesheet can treat one language differently without reading the label's text.
 */
export const codeBlock = (lang: string, highlighted: string): string =>
  `<div class="sbx-code" data-lang="${escapeAttribute(lang)}">` +
  `<div class="sbx-code__bar">` +
  `<span class="sbx-code__lang">${escapeText(lang)}</span>` +
  copyButton("", "Copy this code") +
  `</div>` +
  withClass(highlighted, "sbx-code__pre") +
  `</div>`;

/**
 * Adds a class to the first `<pre class="…">` in a string.
 *
 * Shiki always emits one and always with a `class`, so the fallback of prefixing a
 * bare `<pre>` is for the day it stops — better a block with the right class and no
 * highlighting than a page whose code blocks lose their styling entirely.
 */
const withClass = (html: string, className: string): string => {
  if (html.startsWith('<pre class="')) return `<pre class="${className} ${html.slice('<pre class="'.length)}`;
  if (html.startsWith("<pre")) return `<pre class="${className}"${html.slice("<pre".length)}`;
  return html;
};
