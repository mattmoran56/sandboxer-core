/**
 * The three transforms that let one set of Markdown files read well in two
 * places: browsed directly on GitHub, and built into this site.
 *
 * The content lives in the repository's `docs/` directory as plain Markdown —
 * no imports, no JSX — so that anyone can read it without running a static site
 * generator. That constraint is what these plugins pay for:
 *
 * 1. Links between pages are written as **relative file paths** (`../use/lifecycle.md`),
 *    which is the only form GitHub can follow. The site needs `/use/lifecycle/`.
 * 2. Callouts are written as **GitHub alerts** (`> [!WARNING]`), which GitHub
 *    styles natively. The site needs its own markup to style them.
 * 3. Diagrams are written as **mermaid code fences**, which GitHub renders
 *    natively. The site renders them client-side so they can follow the theme.
 */

import { dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/** The repository's `docs/` directory: the root every page path is relative to. */
const CONTENT_ROOT = fileURLToPath(new URL("../../../docs/", import.meta.url));

/**
 * Pages that live under `docs/` and are deliberately **not** part of the site.
 *
 * `contracts.md` is the engineering contract, has no frontmatter, and is never
 * edited by the docs. A link to it has to leave the site.
 */
const OFF_SITE = {
  "architecture/contracts.md":
    "https://github.com/mattmoran56/sandboxr/blob/main/docs/architecture/contracts.md",
};

/** Walks a hast tree, calling `visitor` on every element. */
function walk(node, visitor, parent = undefined) {
  if (node.type === "element" || node.type === "root") {
    if (node.type === "element") visitor(node, parent);
    for (const child of node.children ?? []) walk(child, visitor, node);
  }
}

const RELATIVE_DOC_LINK = /^[^:#?]+\.mdx?(#.*)?$/;

/**
 * Rewrites a relative link to a Markdown file into the URL the site serves it at.
 *
 * Written relative because that is the only form GitHub can follow from a file
 * in a directory; rewritten here because the site serves clean URLs.
 */
export function rehypeDocLinks() {
  return (tree, file) => {
    const from = file?.path ? dirname(file.path) : CONTENT_ROOT;

    walk(tree, (node) => {
      if (node.tagName !== "a") return;
      const href = node.properties?.href;
      if (typeof href !== "string") return;
      if (href.startsWith("/") || href.startsWith("#")) return;
      if (!RELATIVE_DOC_LINK.test(href)) return;

      const [target, hash] = href.split("#");
      const path = relative(CONTENT_ROOT, resolve(from, target)).split("\\").join("/");

      const offSite = OFF_SITE[path];
      if (offSite) {
        node.properties.href = hash ? `${offSite}#${hash}` : offSite;
        return;
      }

      const slug = path.replace(/\.mdx?$/, "").replace(/(^|\/)index$/, "");
      node.properties.href = `/${slug ? `${slug}/` : ""}${hash ? `#${hash}` : ""}`;
    });
  };
}

const ALERTS = {
  NOTE: "Note",
  TIP: "Tip",
  IMPORTANT: "Important",
  WARNING: "Warning",
  CAUTION: "Caution",
};

/**
 * Turns a GitHub alert blockquote into a callout this site can style.
 *
 * ```md
 * > [!WARNING] The password is a root credential
 * > Anyone who has it can run every action the dashboard offers.
 * ```
 *
 * GitHub renders that shape itself. Here it becomes a `<blockquote>` carrying a
 * kind, with the marker line lifted out into a title, so CSS can do the rest.
 * A title after the marker is optional; GitHub shows it as the first words of
 * the alert, which reads correctly either way.
 */
export function rehypeGithubAlerts() {
  return (tree) => {
    walk(tree, (node) => {
      if (node.tagName !== "blockquote") return;

      const first = (node.children ?? []).find((child) => child.type === "element");
      if (!first || first.tagName !== "p") return;

      const text = first.children?.[0];
      if (!text || text.type !== "text") return;

      const match = /^\[!(NOTE|TIP|IMPORTANT|WARNING|CAUTION)\][ \t]*(.*)(\n|$)/.exec(text.value);
      if (!match) return;

      const [, kind, inlineTitle] = match;
      text.value = text.value.slice(match[0].length).replace(/^\n+/, "");
      // A marker with nothing after it leaves an empty text node at the head of
      // the paragraph, which would render as a stray space before the content.
      if (text.value === "" && first.children.length > 1) first.children.shift();

      node.properties = node.properties ?? {};
      node.properties.className = ["sbx-alert", `sbx-alert--${kind.toLowerCase()}`];

      node.children.unshift({
        type: "element",
        tagName: "p",
        properties: { className: ["sbx-alert__title"] },
        children: [{ type: "text", value: inlineTitle || ALERTS[kind] }],
      });
    });
  };
}

/**
 * Turns a mermaid code fence into the element the client-side renderer looks for.
 *
 * GitHub renders these fences itself. Here the source is carried on a data
 * attribute and swapped for an SVG in the browser, which is what lets a diagram
 * follow the site's light and dark themes. The source stays visible until then,
 * and stays visible for good if it will not parse — a diagram that fails is
 * still readable as text, and the failure is then obvious.
 *
 * This one is a **remark** plugin rather than a rehype one, because the site's
 * code blocks are rewritten wholesale by its syntax highlighter before rehype
 * ever sees them, and a fence in an unknown language is not worth handing it.
 */
export function remarkMermaid() {
  return (tree) => {
    const visit = (node) => {
      const children = node.children;
      if (!children) return;
      for (const [index, child] of children.entries()) {
        if (child.type === "code" && child.lang === "mermaid") {
          const source = String(child.value ?? "").trim();
          if (source === "") continue;
          children[index] = {
            type: "html",
            value:
              `<figure class="mermaid-figure">` +
              `<div class="mermaid-diagram" data-chart="${escapeAttribute(source)}">` +
              `<pre class="mermaid-fallback">${escapeText(source)}</pre>` +
              `</div></figure>`,
          };
          continue;
        }
        visit(child);
      }
    };
    visit(tree);
  };
}

function escapeAttribute(value) {
  return value.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function escapeText(value) {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
