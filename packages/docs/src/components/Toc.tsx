// The table of contents, and the scroll-spy that keeps it honest.
//
// Two decisions are worth knowing about before changing anything here.
//
//  - **Under two headings it renders nothing.** A table of contents over one
//    heading is furniture: it takes a column of the page to tell the reader
//    something the page's own first line already said.
//  - **A click scrolls the page itself rather than letting the browser follow the
//    fragment.** The site header is sticky, so the browser's own jump — which puts
//    the target's top edge at the viewport's top edge — leaves the heading
//    underneath the header, and the reader lands looking at the paragraph *after*
//    the one they asked for. The offset is measured from the header rather than
//    hard-coded, so it stays right when the header changes height.

import { useEffect, useId, useState, type MouseEvent, type ReactElement } from "react";

import { cn } from "../lib/cn.js";
import type { Heading } from "../types.js";

/** Breathing room between the sticky header and the heading scrolled to. */
const GAP = 12;

/**
 * How much of the top of the viewport is covered by something fixed in place.
 *
 * Measured, not configured: this file has no way to know how tall the header is,
 * and a constant that disagreed with it would be wrong in exactly the way this
 * whole function exists to prevent.
 */
const stickyOffset = (): number => {
  const header = document.querySelector("header");
  if (!header) return GAP;
  const { position } = getComputedStyle(header);
  if (position !== "sticky" && position !== "fixed") return GAP;
  return header.getBoundingClientRect().height + GAP;
};

export const Toc = ({ headings }: { headings: readonly Heading[] }): ReactElement | null => {
  const labelId = useId();
  const [active, setActive] = useState<string | null>(null);

  // The ids as one string, so the effect below re-runs when the *page* changes
  // and not merely because the parent handed down a new array of the same
  // headings.
  const key = headings.map((heading) => heading.id).join("|");

  useEffect(() => {
    const ids = key.length > 0 ? key.split("|") : [];
    if (ids.length < 2 || typeof IntersectionObserver === "undefined") return;

    const elements = ids
      .map((id) => document.getElementById(id))
      .filter((element): element is HTMLElement => element !== null);
    if (elements.length === 0) return;

    const visible = new Set<string>();
    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (entry.isIntersecting) visible.add(entry.target.id);
          else visible.delete(entry.target.id);
        }
        const first = ids.find((id) => visible.has(id));
        // Nothing in the band means the reader is somewhere in the middle of a
        // long section, and the section they are in is still the last one they
        // scrolled past. Keeping the previous answer is what stops the marker
        // blinking off between headings.
        if (first) setActive(first);
      },
      {
        // A band across the top of the page: below whatever is stuck there, and
        // stopping short of the bottom so a heading only becomes current once it
        // is near the top rather than the moment it appears.
        rootMargin: `-${stickyOffset()}px 0px -65% 0px`,
        threshold: 0,
      },
    );

    for (const element of elements) observer.observe(element);
    return () => observer.disconnect();
  }, [key]);

  // Every hook above runs unconditionally, because `headings` changes on every
  // navigation and a component that returned early before them would be calling
  // a different number of hooks per page.
  if (headings.length < 2) return null;

  const jump = (event: MouseEvent<HTMLAnchorElement>, id: string): void => {
    // Everything the browser has an answer for is left to the browser: a
    // middle-click or a ⌘-click on one of these opens the page at that heading
    // in a new tab, and that only works if the anchor stays a real anchor.
    if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) {
      return;
    }
    const target = document.getElementById(id);
    if (!target) return;
    event.preventDefault();
    window.scrollTo({
      top: target.getBoundingClientRect().top + window.scrollY - stickyOffset(),
      behavior: "smooth",
    });
    // `replaceState` and not `pushState`: moving within one page is not a place
    // in history, and an entry per heading would fill the back button with
    // stops the reader does not remember making. It also keeps the fragment out
    // of the router's `popstate` handler, which resolves a path and has nothing
    // to say about a hash.
    history.replaceState(null, "", `#${id}`);
    setActive(id);
  };

  return (
    <nav className="sbx-toc text-sm" aria-labelledby={labelId}>
      <p
        id={labelId}
        className="mb-2 text-[0.6875rem] font-semibold uppercase tracking-wider text-ink-subtle"
      >
        On this page
      </p>
      <ul className="border-l border-line">
        {headings.map((heading) => {
          const current = heading.id === active;
          return (
            <li key={heading.id}>
              <a
                href={`#${heading.id}`}
                data-depth={heading.depth}
                aria-current={current ? "location" : undefined}
                onClick={(event) => jump(event, heading.id)}
                className={cn(
                  "-ml-px block border-l py-1 pr-2 leading-snug transition-colors",
                  heading.depth === 3 ? "pl-6 text-[0.8125rem]" : "pl-3",
                  current
                    ? "border-brand-line font-medium text-brand"
                    : "border-transparent text-ink-muted hover:text-ink",
                )}
              >
                {heading.text}
              </a>
            </li>
          );
        })}
      </ul>
    </nav>
  );
};
