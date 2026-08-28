// The page itself, and the four things this site does to markup it did not write.
//
// The body arrives as an HTML string from the build — parsed, highlighted and
// transformed in Node — and goes in with `dangerouslySetInnerHTML`. That is the
// right call and not a shortcut: the alternative is shipping a Markdown parser and
// a syntax highlighter to every reader in order to re-derive something the build
// already knows. It does mean React owns none of what is inside, so everything
// interactive in there is a **delegated listener on the wrapper** rather than a
// component, and there are exactly four of them:
//
//  1. **Copying.** One click handler for every `data-copy` button on the page.
//  2. **Links.** A relative link between two pages navigates in place instead of
//     reloading the site.
//  3. **Diagrams.** Mermaid, rendered in the browser so a diagram can follow the
//     reader's theme, which a build-time render cannot.
//  4. **Expand everything.** One control that opens every collapsed block.
//
// Each of those is an effect keyed on the body, so a client-side navigation to
// another page re-wires them against the new markup.

import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";

import { cn } from "../lib/cn.js";
import { diagramThemeVariables, resolveTokens } from "../lib/diagram.js";
import { Button } from "./ui.js";
import { Fold, Unfold } from "./icons.js";

export interface ArticleProps {
  title: string;
  description: string;
  /** The rendered body. `null` while the page's chunk is still arriving. */
  html: string | null;
  /** The page this body belongs to. Read back out of the DOM before hydration. */
  slug: string;
  expandAll: boolean;
  onExpandAll: (next: boolean) => void;
  /**
   * Whether a relative link inside the prose navigates in place.
   *
   * A prop rather than `useRouter()` so this component can be rendered in a test
   * without a router around it — and so that the one place a click on injected
   * markup can change the URL is visible in the caller.
   */
  onNavigate?: (to: string) => void;
  /** The prev/next and edit links. Passed in so this file knows nothing about the nav. */
  footer?: ReactNode;
}

/** How long a copy button says "Copied" before going back to "Copy". */
const COPIED_FOR = 1800;

/**
 * Writes text to the clipboard, by whichever route works.
 *
 * `navigator.clipboard` is not something to assume. It is absent on an insecure
 * origin, which is exactly what a documentation preview served over plain
 * `http://` on a LAN address is, and it can also be present and refuse — a denied
 * permission rejects rather than throwing. Either way the button must not appear
 * to work and do nothing, so there is a second route: a throwaway `<textarea>`,
 * selected, and `document.execCommand("copy")`, which needs no permission because
 * the browser treats it as the reader's own selection.
 *
 * Returns false only when both have failed, and the caller then says so on the
 * button instead of pretending.
 */
const writeClipboard = async (text: string): Promise<boolean> => {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    // Refused, or unavailable behind a feature policy. Fall through.
  }

  try {
    const scratch = document.createElement("textarea");
    scratch.value = text;
    // Off-screen rather than hidden: a `display: none` textarea cannot be
    // selected, and an unselectable one cannot be copied.
    scratch.setAttribute("readonly", "");
    scratch.style.position = "fixed";
    scratch.style.top = "-1000px";
    scratch.style.opacity = "0";
    document.body.appendChild(scratch);
    scratch.select();
    const ok = document.execCommand?.("copy") ?? false;
    scratch.remove();
    return ok;
  } catch {
    return false;
  }
};

/** Selects a block's code, so a reader whose clipboard is barred can press ⌘C. */
const selectCode = (code: Element): void => {
  const selection = window.getSelection?.();
  if (!selection) return;
  const range = document.createRange();
  range.selectNodeContents(code);
  selection.removeAllRanges();
  selection.addRange(range);
};

export const Article = ({
  title,
  description,
  html,
  slug,
  expandAll,
  onExpandAll,
  onNavigate,
  footer,
}: ArticleProps) => {
  const prose = useRef<HTMLDivElement>(null);
  // How many collapsible blocks this page has. Counted from the DOM after the
  // body is in, which is also why the control is absent on the prerendered file
  // and appears on hydration — the server has the markup but the count is not in
  // `PageMeta`, and adding it there for one button would put it in every page's
  // metadata for every reader.
  const [details, setDetails] = useState(0);
  // What a screen reader is told when a copy button changes. The button's own
  // label has to stay "Copy this code" for the reader who has not pressed it yet,
  // so the outcome is announced from a live region instead.
  const [announce, setAnnounce] = useState("");

  /* --- 1 and 2: one click handler over the whole body -------------------- */

  useEffect(() => {
    const host = prose.current;
    if (!host) return;

    const timers = new Set<number>();

    const say = (button: HTMLElement, word: string, state: string): void => {
      const label = button.querySelector(".sbx-copy__word");
      // The word it started with, not a literal "Copy". The button's text belongs
      // to the pipeline that emitted it, and restoring a guess would rename every
      // button on the page the first time somebody used one.
      const before = label?.textContent ?? "";
      if (label) label.textContent = word;
      button.dataset.state = state;
      setAnnounce(word);
      const timer = window.setTimeout(() => {
        if (label) label.textContent = before;
        delete button.dataset.state;
        timers.delete(timer);
      }, COPIED_FOR);
      timers.add(timer);
    };

    const copy = async (button: HTMLElement): Promise<void> => {
      // The nearest block, and its `code` element's text. The source is never
      // duplicated into an attribute — see the vocabulary in the contract — so
      // this text is the only copy of it and is exactly what should land on the
      // clipboard.
      const block = button.closest(".sbx-code, .sbx-prompt");
      const code = block?.querySelector("code");
      if (!code) return;
      const text = code.textContent ?? "";
      if (await writeClipboard(text)) {
        say(button, "Copied", "copied");
        return;
      }
      // Both routes refused. Leave the reader something they can act on rather
      // than a button that blinked and did nothing.
      selectCode(code);
      say(button, "Press ⌘C", "failed");
    };

    const onClick = (event: MouseEvent): void => {
      const from = event.target as Element | null;
      if (!from) return;

      const button = from.closest<HTMLElement>("[data-copy]");
      if (button) {
        void copy(button);
        return;
      }

      if (!onNavigate) return;
      const anchor = from.closest<HTMLAnchorElement>("a[href]");
      if (!anchor) return;
      // Everything the browser has its own answer for is left to the browser —
      // the same rule as `<Link>`, applied to markup React never rendered.
      if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) {
        return;
      }
      if (anchor.target && anchor.target !== "_self") return;
      const url = new URL(anchor.href, window.location.href);
      if (url.origin !== window.location.origin) return;
      event.preventDefault();
      onNavigate(`${url.pathname}${url.hash}`);
    };

    host.addEventListener("click", onClick);
    return () => {
      host.removeEventListener("click", onClick);
      for (const timer of timers) window.clearTimeout(timer);
    };
  }, [html, onNavigate]);

  /* --- 3: the diagrams -------------------------------------------------- */

  useEffect(() => {
    const host = prose.current;
    if (!host) return;
    // Nothing is imported unless the page has a diagram on it. mermaid is the
    // largest dependency in this site by an order of magnitude and most pages
    // have no diagram at all, so it is a dynamic import behind this check rather
    // than an entry-chunk import behind a no-op.
    if (host.querySelector(".sbx-diagram__canvas") === null) return;

    let live = true;
    let pass = 0;

    const draw = async (): Promise<void> => {
      const nodes = [...host.querySelectorAll<HTMLElement>(".sbx-diagram__canvas")];
      if (nodes.length === 0) return;

      const { default: mermaid } = await import("mermaid");
      if (!live) return;

      // The attribute is the single answer to "is this page dark" — see
      // `resolveTheme` in lib/prefs.ts. The media query is only the fallback for
      // a document where the blocking script never ran.
      const chosen = document.documentElement.dataset.theme;
      const dark = chosen
        ? chosen === "dark"
        : (window.matchMedia?.("(prefers-color-scheme: dark)").matches ?? false);

      // `base` is the only mermaid theme meant to be configured; the rest derive
      // their own palettes from a seed and override unevenly. Everything it is
      // configured *with* comes from the tokens currently in force, so a diagram
      // follows all six theme × scheme combinations without this file knowing a
      // single colour. See lib/diagram.ts.
      const tokens = resolveTokens();
      mermaid.initialize({
        startOnLoad: false,
        theme: "base",
        securityLevel: "strict",
        flowchart: { useMaxWidth: true, curve: "basis" },
        themeVariables: diagramThemeVariables((name) => tokens[name], dark),
      });

      // The id has to differ every pass. mermaid keys its internal definitions by
      // it, and re-rendering the same id after a theme change gave back the first
      // pass's SVG — a diagram that stayed light on a dark page.
      pass += 1;
      for (const [index, node] of nodes.entries()) {
        const chart = node.dataset.chart;
        if (!chart) continue;
        try {
          const { svg } = await mermaid.render(`sbx-diagram-${pass}-${index}`, chart);
          if (!live) return;
          node.innerHTML = svg;
        } catch {
          // Leave the source visible rather than an empty box: a diagram that
          // will not parse is still readable as text, and the failure is then
          // obvious to whoever wrote it.
        }
      }
    };

    void draw();

    // Re-drawn on a theme change, which is the whole reason diagrams are rendered
    // here and not at build time — and on a *scheme* change too. Watching only
    // `data-theme` was a real bug: the brand hue is baked into the SVG at render
    // time, so switching tide to fern left every subgraph and every sequence
    // label sitting in the previous scheme's colour, on a page that had otherwise
    // changed completely.
    const observer = new MutationObserver(() => void draw());
    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["data-theme", "data-scheme"],
    });

    return () => {
      live = false;
      observer.disconnect();
    };
  }, [html]);

  /* --- 4: expand everything --------------------------------------------- */

  /*
   * Why those blocks exist at all, and therefore why one control opens them.
   *
   * Every page's main text is written for a person reading it for the first time.
   * The exact paths, full command syntax, schema fields and failure modes that a
   * coding agent needs in order to operate the system live inside a `<details>`
   * instead, so the page stays readable and the detail stays present.
   *
   * That balance is right for the first reader and wrong for the second. An agent
   * handed this URL wants the whole page flat, and so does a person who has read
   * the prose once and come back for the flags. One control does it, and the
   * choice is remembered — because somebody who wanted the detail on this page
   * wants it on the next one too.
   */
  useEffect(() => {
    const host = prose.current;
    if (!host) return;
    const blocks = host.querySelectorAll<HTMLDetailsElement>(".sbx-detail");
    setDetails(blocks.length);
    for (const block of blocks) block.open = expandAll;
  }, [html, expandAll]);

  /* --- arriving at a section of a page that had not loaded yet ----------- */

  useEffect(() => {
    if (!html) return;
    const hash = window.location.hash;
    if (!hash) return;
    // The router scrolls on navigation, but a link carrying a hash into *another*
    // page names an element that does not exist yet: bodies are code-split, so
    // the target appears a tick after the click. This is the other half of that,
    // and it runs whenever a body lands.
    const target = document.getElementById(decodeURIComponent(hash.slice(1)));
    target?.scrollIntoView();
  }, [html]);

  /*
   * The injected HTML, as one object that only changes when the body does.
   *
   * This is not a micro-optimisation, it is the fix for a bug that took a while
   * to see. React decides whether to re-apply `dangerouslySetInnerHTML` by
   * comparing the *prop* — the object — not the string inside it, and then sets
   * `innerHTML` unconditionally. A fresh `{ __html: … }` literal on every render
   * is therefore a fresh `innerHTML` assignment on every render, which throws away
   * every DOM change the effects below have made: the `open` flag on each
   * `<details>`, and the "Copied" a copy button had just put on itself. It showed
   * up as a copy button that confirmed and then instantly un-confirmed, on any
   * render triggered by something else — and this component re-renders itself the
   * moment a copy button is pressed, because that is how the announcement is made.
   */
  const injected = useMemo(() => ({ __html: html ?? "" }), [html]);

  return (
    <article className="min-w-0">
      <header className="mb-8 border-b border-line pb-6">
        <h1 className="font-serif text-4xl leading-tight text-ink sm:text-[2.75rem]">{title}</h1>
        {description ? (
          <p className="mt-3 max-w-[46rem] text-[1.0625rem] leading-relaxed text-ink-muted">
            {description}
          </p>
        ) : null}

        {details > 0 ? (
          <div className="mt-5 flex items-center gap-3">
            <Button
              tone={expandAll ? "primary" : "quiet"}
              size="sm"
              aria-pressed={expandAll}
              onClick={() => onExpandAll(!expandAll)}
              title={
                expandAll
                  ? "Fold every block of detail away again"
                  : "Open every block of detail on every page, and remember it"
              }
            >
              {expandAll ? <Fold size={14} /> : <Unfold size={14} />}
              {expandAll ? "Collapse everything" : "Expand everything"}
            </Button>
            <span className="text-xs text-ink-subtle">
              {details === 1 ? "1 block of detail" : `${details} blocks of detail`}
            </span>
          </div>
        ) : null}
      </header>

      {/*
        `data-slug` is not decoration. `main.tsx` reads this element's own
        `innerHTML` back out of the prerendered document before hydrating, so the
        browser's first render is the same markup the static file already
        contains. See the comment there.
      */}
      <div
        ref={prose}
        className={cn("sbx-prose", !html && "min-h-[40vh]")}
        data-slug={slug}
        dangerouslySetInnerHTML={injected}
      />

      <p role="status" aria-live="polite" className="sr-only">
        {announce}
      </p>

      {footer}
    </article>
  );
};
