// Search: the one thing this site would be worse at than the one it replaced.
//
// Starlight shipped a search dialog. Nothing else here does, so this file is it,
// and the shape of it is copied from the dashboard's Modal for the same reason
// that one gives: it is a native `<dialog>` opened with `showModal()`, so focus
// trapping, an inert page behind it, Escape and the browser's top layer are all
// the browser's. Every hand-rolled version of those gets one of them subtly wrong
// for somebody using a keyboard or a screen reader.
//
// Three more things it does on purpose:
//
//  - **The corpus is dynamically imported the first time it opens.** Half a
//    megabyte of page text has no business in the chunk that renders the page you
//    landed on, and most readers never search at all. So the first open shows a
//    loading line, and the module is kept afterwards.
//  - **A hit is a real anchor.** It navigates in place through the router on a
//    plain left click, and a middle-click still opens the page — at the heading —
//    in a new tab.
//  - **An empty box offers the pages a first-time reader wants** rather than
//    nothing. A blank panel is a dead end, and "install it" is very often the
//    answer anyway.

import {
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type ReactElement,
  type ReactNode,
} from "react";

import { cn } from "../lib/cn.js";
import { pathOfSlug } from "../lib/route.js";
import { buildIndex, search, type Hit } from "../lib/search.js";
import { labelOf, NAV } from "../nav.js";
import { Link, useRouter } from "../state/router.js";
import type { Heading, SearchDoc } from "../types.js";

/* --- the corpus ---------------------------------------------------------- */

type Corpus = readonly SearchDoc[];

// Module-level, not component state: the corpus is immutable build output, so
// once one dialog has paid for it every later one should open instantly. Only
// ever written from `loadCorpus`, which only ever runs in a browser.
let loaded: Corpus | null = null;

const loadCorpus = async (): Promise<Corpus> => {
  if (loaded) return loaded;
  // The specifier has to stay a literal. It is what makes the bundler give the
  // corpus a chunk of its own, and `/* @vite-ignore */` with a variable would
  // leave the browser asking for a module nothing serves. The cost is that any
  // transform which cannot resolve `virtual:docs-search` fails on this line —
  // see the note at the top of `Search.test.tsx`.
  const { documents } = await import("virtual:docs-search");
  // Fold it here rather than on the first keystroke. It is a few milliseconds,
  // but they are milliseconds while the reader is still reaching for a key.
  buildIndex(documents);
  loaded = documents;
  return documents;
};

/* --- the small pieces --------------------------------------------------- */

/** A key cap, for the hints along the bottom. */
const Kbd = ({ children }: { children: ReactNode }): ReactElement => (
  <kbd className="rounded border border-line bg-sunken px-1.5 py-0.5 font-mono text-[0.6875rem] text-ink-muted">
    {children}
  </kbd>
);

/** The magnifier: a 24-unit box with `currentColor` strokes, as every icon here is. */
const Magnifier = (): ReactElement => (
  <svg
    width={18}
    height={18}
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth={1.75}
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden="true"
    focusable="false"
    className="shrink-0 text-ink-subtle"
  >
    <circle cx="11" cy="11" r="7" />
    <path d="M20 20l-3.6-3.6" />
  </svg>
);

/**
 * A snippet with its matched ranges marked.
 *
 * The library hands over text and offsets rather than HTML, so the marking
 * happens here, in JSX, where React escapes the page's own words for us. Building
 * `<mark>` tags in the library would have meant `dangerouslySetInnerHTML` over
 * documentation that contains angle brackets on purpose.
 */
const Marked = ({ snippet }: { snippet: Hit["snippet"] }): ReactElement => {
  const pieces: ReactNode[] = [];
  let at = 0;
  for (const [from, to] of snippet.marks) {
    if (from > at) pieces.push(snippet.text.slice(at, from));
    pieces.push(
      <mark key={`${from}-${to}`} className="rounded bg-brand-soft text-brand">
        {snippet.text.slice(from, to)}
      </mark>,
    );
    at = to;
  }
  pieces.push(snippet.text.slice(at));
  return <>{pieces}</>;
};

/* --- rows --------------------------------------------------------------- */

/** A row in the list: a hit, or one of the suggestions an empty box shows. */
interface Row {
  key: string;
  href: string;
  title: string;
  /** The sidebar group the page sits in, so two similar titles are told apart. */
  group: string | null;
  heading: Heading | null;
  snippet: Hit["snippet"] | null;
}

/** Which group of the sidebar a slug belongs to. */
const GROUPS = new Map<string, string>(
  NAV.flatMap(({ label, pages }) =>
    label === null ? [] : pages.map((page): [string, string] => [page.slug, label]),
  ),
);

const hrefOf = (slug: string, heading: Heading | null): string =>
  `${pathOfSlug(slug)}${heading ? `#${heading.id}` : ""}`;

/**
 * What an empty box offers.
 *
 * The pages somebody who has just found this site actually wants, in the order
 * they want them — not the most recently changed pages, and not nothing.
 */
const STARTERS: readonly string[] = [
  "getting-started/install",
  "getting-started/first-sandbox",
  "configuration/sandboxer-yaml",
  "reference/cli",
  "reference/cheat-sheet",
  "troubleshooting",
];

const starterRows = (): Row[] =>
  STARTERS.map((slug) => ({
    key: slug,
    href: pathOfSlug(slug),
    title: labelOf(slug) ?? slug,
    group: GROUPS.get(slug) ?? null,
    heading: null,
    snippet: null,
  }));

/** How many hits are worth reading before a query needs to be narrowed instead. */
const LIMIT = 12;

/* --- the dialog --------------------------------------------------------- */

export const Search = ({
  open,
  onClose,
}: {
  open: boolean;
  onClose: () => void;
}): ReactElement => {
  const dialog = useRef<HTMLDialogElement>(null);
  const field = useRef<HTMLInputElement>(null);
  const { navigate } = useRouter();

  const [corpus, setCorpus] = useState<Corpus | null>(loaded);
  const [broken, setBroken] = useState(false);
  const [query, setQuery] = useState("");
  const [at, setAt] = useState(0);

  const base = useId();
  const listId = `${base}-list`;

  // `showModal()` is what puts it in the top layer and makes the page behind it
  // inert. Calling it on an already-open dialog throws, hence the guards.
  useEffect(() => {
    const element = dialog.current;
    if (!element) return;
    if (open && !element.open) element.showModal();
    if (!open && element.open) element.close();
  }, [open]);

  useEffect(() => {
    if (!open) return;
    // `showModal` focuses the first focusable child, which is this field
    // anyway; doing it here as well is what selects the last query, so
    // reopening and typing replaces it instead of appending to it.
    field.current?.focus();
    field.current?.select();
  }, [open]);

  useEffect(() => {
    if (!open || corpus || broken) return;
    let dropped = false;
    void loadCorpus().then(
      (documents) => {
        if (!dropped) setCorpus(documents);
      },
      () => {
        // A chunk that will not load is not a state to hide: without the corpus
        // this dialog can do nothing at all, and the reader needs to be told to
        // use the sidebar instead of typing into a box that will never answer.
        if (!dropped) setBroken(true);
      },
    );
    return () => {
      dropped = true;
    };
  }, [open, corpus, broken]);

  const typed = query.trim();
  const hits = useMemo(
    () => (corpus && typed.length > 0 ? search(corpus, typed, LIMIT) : []),
    [corpus, typed],
  );

  const rows = useMemo<Row[]>(() => {
    if (typed.length === 0) return starterRows();
    return hits.map((hit) => ({
      key: `${hit.slug}#${hit.heading?.id ?? ""}`,
      href: hrefOf(hit.slug, hit.heading),
      title: hit.title,
      group: GROUPS.get(hit.slug) ?? null,
      heading: hit.heading,
      snippet: hit.snippet,
    }));
  }, [typed, hits]);

  // Clamped rather than reset in an effect: the list changes on every keystroke,
  // and an effect that corrected the index afterwards would render one frame with
  // a selection pointing past the end of it.
  const active = rows.length === 0 ? -1 : Math.min(at, rows.length - 1);

  useEffect(() => {
    if (active < 0) return;
    // Optional call: jsdom has no `scrollIntoView`, and neither does every
    // embedded browser this documentation gets read in.
    document.getElementById(`${listId}-r${active}`)?.scrollIntoView?.({ block: "nearest" });
  }, [active, listId]);

  const move = (step: number): void => {
    if (rows.length === 0) return;
    setAt((was) => {
      const from = Math.min(was, rows.length - 1);
      return (from + step + rows.length) % rows.length;
    });
  };

  const go = (href: string): void => {
    onClose();
    navigate(href);
  };

  const waiting = typed.length > 0 && !corpus && !broken;
  // Whether the listbox is on the page at all. The combobox's `aria-controls`
  // and `aria-activedescendant` have to go with it: an id that points at nothing
  // is worse than no attribute, because a screen reader will look for it.
  const listed = !broken && !waiting && rows.length > 0;
  const announcement = broken
    ? "Search could not load."
    : waiting
      ? "Loading the search index."
      : typed.length === 0
        ? ""
        : rows.length === 0
          ? `No results for ${typed}.`
          : `${rows.length} result${rows.length === 1 ? "" : "s"} for ${typed}.`;

  return (
    <dialog
      ref={dialog}
      aria-label="Search the documentation"
      onCancel={(event) => {
        event.preventDefault();
        onClose();
      }}
      onClick={(event) => {
        // The backdrop is the dialog element itself; anything inside is the box.
        if (event.target === dialog.current) onClose();
      }}
      className={cn(
        "sbx-search mx-auto mt-[10vh] mb-auto w-[calc(100vw-2rem)] max-w-2xl p-0",
        "rounded-panel border border-line bg-surface text-ink shadow-modal",
        // The one literal in this file, exactly as the dashboard's Modal has it:
        // a backdrop has to darken the page in both themes, which is the one job
        // no palette token does.
        "backdrop:bg-black/45 backdrop:backdrop-blur-sm",
      )}
    >
      {open ? (
        <div className="flex max-h-[75vh] flex-col">
          <div className="flex items-center gap-2.5 border-b border-line px-4">
            <Magnifier />
            <input
              ref={field}
              type="text"
              role="combobox"
              aria-expanded={listed}
              aria-controls={listed ? listId : undefined}
              aria-autocomplete="list"
              aria-activedescendant={listed && active >= 0 ? `${listId}-r${active}` : undefined}
              aria-label="Search the documentation"
              placeholder="Search the documentation"
              autoComplete="off"
              spellCheck={false}
              value={query}
              onChange={(event) => {
                setQuery(event.currentTarget.value);
                // Back to the top of a new list. Keeping the old index would
                // leave Enter opening whatever happened to be in that position.
                setAt(0);
              }}
              onKeyDown={(event) => {
                if (event.key === "ArrowDown") {
                  event.preventDefault();
                  move(1);
                } else if (event.key === "ArrowUp") {
                  event.preventDefault();
                  move(-1);
                } else if (event.key === "Home") {
                  event.preventDefault();
                  setAt(0);
                } else if (event.key === "End") {
                  event.preventDefault();
                  setAt(rows.length - 1);
                } else if (event.key === "Enter") {
                  const row = rows[active];
                  if (!row) return;
                  event.preventDefault();
                  go(row.href);
                } else if (event.key === "Escape") {
                  // A `<dialog>` answers Escape with a `cancel` event, handled
                  // above. Handling it here too covers the browsers that do not
                  // fire one while a text field has focus, and closing an
                  // already-closing dialog costs nothing.
                  event.preventDefault();
                  onClose();
                }
              }}
              className="h-12 w-full bg-transparent text-base text-ink placeholder:text-ink-subtle focus:outline-none"
            />
            <Kbd>esc</Kbd>
          </div>

          <p role="status" aria-live="polite" className="sr-only">
            {announcement}
          </p>

          {broken ? (
            <p className="px-4 py-6 text-sm leading-relaxed text-ink-muted">
              Search could not load. Every page is still in the sidebar, and your browser&rsquo;s
              own find-in-page still searches the page you are on.
            </p>
          ) : waiting ? (
            <p className="px-4 py-6 text-sm text-ink-muted">Loading the search index&hellip;</p>
          ) : rows.length === 0 ? (
            <p className="px-4 py-6 text-sm leading-relaxed text-ink-muted">
              Nothing matches <span className="font-medium text-ink">{typed}</span>. Every word has
              to appear on the page, so a shorter query finds more.
            </p>
          ) : (
            <>
              {typed.length === 0 ? (
                <p className="px-4 pt-3 text-[0.6875rem] font-semibold uppercase tracking-wider text-ink-subtle">
                  Start here
                </p>
              ) : null}
              <ul
                id={listId}
                role="listbox"
                aria-label="Search results"
                className="min-h-0 flex-1 overflow-y-auto p-2"
              >
                {rows.map((row, index) => (
                  <li key={row.key} role="presentation">
                    <Link
                      to={row.href}
                      id={`${listId}-r${index}`}
                      role="option"
                      aria-selected={index === active}
                      onMouseEnter={() => setAt(index)}
                      onClick={() => onClose()}
                      className={cn(
                        "block rounded-card px-3 py-2",
                        index === active ? "bg-brand-soft" : "hover:bg-hover",
                      )}
                    >
                      <span className="flex items-baseline gap-2">
                        <span
                          className={cn(
                            "truncate font-medium",
                            index === active ? "text-brand" : "text-ink",
                          )}
                        >
                          {row.title}
                        </span>
                        {row.heading ? (
                          <span className="truncate text-xs text-ink-muted">
                            <span aria-hidden="true">&rsaquo; </span>
                            {row.heading.text}
                          </span>
                        ) : null}
                        {row.group ? (
                          <span className="ml-auto shrink-0 text-[0.6875rem] uppercase tracking-wider text-ink-subtle">
                            {row.group}
                          </span>
                        ) : null}
                      </span>
                      {row.snippet && row.snippet.text.length > 0 ? (
                        <span className="mt-0.5 block truncate text-xs text-ink-muted">
                          <Marked snippet={row.snippet} />
                        </span>
                      ) : null}
                    </Link>
                  </li>
                ))}
              </ul>
            </>
          )}

          <div className="flex items-center gap-3 border-t border-line px-4 py-2 text-[0.6875rem] text-ink-subtle">
            <span className="flex items-center gap-1.5">
              <Kbd>&uarr;</Kbd>
              <Kbd>&darr;</Kbd> to move
            </span>
            <span className="flex items-center gap-1.5">
              <Kbd>&crarr;</Kbd> to open
            </span>
            <span className="ml-auto flex items-center gap-1.5">
              <Kbd>&#8984;K</Kbd> from anywhere
            </span>
          </div>
        </div>
      ) : null}
    </dialog>
  );
};

/* --- the shortcut ------------------------------------------------------- */

const FIELDS = new Set(["INPUT", "TEXTAREA", "SELECT"]);

/**
 * Whether the keystroke belongs to something the reader is typing into.
 *
 * This is the bug every `/`-to-search implementation ships with: without it, the
 * first slash of a path typed into any text box on the page opens the search
 * dialog and eats the character.
 */
const isTyping = (target: EventTarget | null): boolean => {
  if (!(target instanceof HTMLElement)) return false;
  return FIELDS.has(target.tagName) || target.isContentEditable;
};

/** Wires `/` and ⌘K. Call it once, high in the tree. */
export const useSearchShortcut = (open: () => void): void => {
  // Through a ref, so a caller passing an inline arrow — which is every caller —
  // does not re-bind the listener on every render.
  const latest = useRef(open);
  useEffect(() => {
    latest.current = open;
  }, [open]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
        // Firefox gives ⌘K to its own search bar, so this has to be claimed.
        event.preventDefault();
        latest.current();
        return;
      }
      if (event.key !== "/" || event.metaKey || event.ctrlKey || event.altKey) return;
      if (isTyping(event.target)) return;
      event.preventDefault();
      latest.current();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
};
