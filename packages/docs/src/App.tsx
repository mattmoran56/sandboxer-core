// The whole page, in one component, rendered twice.
//
// **Everything here has to run in Node.** `build/prerender.mjs` renders this tree
// once per URL to produce the static files the site is actually served as, and
// that pass has no `window`, no `document`, no `localStorage`, no `matchMedia` and
// no `IntersectionObserver`. Anything that touches one of those belongs inside a
// `useEffect` or behind a `typeof window` guard, everywhere below and in every
// component this renders. A page that only renders in a browser would still look
// right in development and ship as an empty `<div id="root">`.
//
// The layout is three columns and a sticky header: the sidebar of every page, the
// article at about 50rem — the measure the previous site used, and long-form prose
// does not want more — and the table of contents. Below `lg` it collapses to one
// column and the sidebar becomes a real drawer. The middle column keeps its width
// on a wide screen whether or not a page has a table of contents, because a
// content column that moved sideways between pages would make every navigation
// feel like a layout bug.

import { useEffect, useMemo, useRef, useState } from "react";

import { pages } from "virtual:docs-content";

import { PrefsProvider, usePrefs } from "./state/prefs.js";
import { RouterProvider, useRouter } from "./state/router.js";
import { applyHead, headOf } from "./lib/head.js";
import { Header } from "./components/Header.js";
import { Sidebar } from "./components/Sidebar.js";
import { MobileNav } from "./components/MobileNav.js";
import { Article } from "./components/Article.js";
import { PageFooter } from "./components/PageFooter.js";
import { Toc } from "./components/Toc.js";
import { Search, useSearchShortcut } from "./components/Search.js";

export interface AppProps {
  /** The path to start at. The server passes it; the browser omits it and reads `location`. */
  path?: string;
  /** The current page's body, when the caller already has it — the server always does. */
  body?: { slug: string; html: string };
}

const NOT_FOUND_HTML =
  "<p>The address you followed does not name a page on this site. " +
  "It may have been renamed, or the link may have been typed by hand. " +
  "Everything the documentation contains is in the sidebar.</p>";

const FAILED_HTML =
  "<p>This page's text could not be loaded. That is a network failure rather than " +
  "a missing page — reloading usually fixes it.</p>";

const Site = ({ body }: { body?: { slug: string; html: string } }) => {
  const { slug, navigate } = useRouter();
  const { prefs, set } = usePrefs();
  const [menuOpen, setMenuOpen] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);
  useSearchShortcut(() => setSearchOpen(true));

  // Which slugs the build produced a page for. The sidebar dims the ones it did
  // not, so a nav entry written ahead of its Markdown is visible as unfinished
  // rather than as a broken link.
  const known = useMemo(() => new Set(pages.map((page) => page.slug)), []);
  const page = pages.find((candidate) => candidate.slug === slug) ?? null;

  /*
   * Bodies are code-split, so they arrive one page at a time and are kept.
   *
   * A ref rather than state because the cache is not what the render reads *from*
   * — it is a store the render consults — and putting a growing map in state
   * would mean every entry added re-created it. `bump` exists only to ask for a
   * re-render once an entry lands.
   */
  const cache = useRef<Map<string, string>>(
    new Map(body ? [[body.slug, body.html] as const] : []),
  );
  const [, bump] = useState(0);
  const [failed, setFailed] = useState<string | null>(null);

  useEffect(() => {
    if (!page || cache.current.has(page.slug)) return;
    let live = true;
    page
      .load()
      .then((loaded) => {
        cache.current.set(page.slug, loaded.html);
        if (live) bump((count) => count + 1);
      })
      .catch(() => {
        // A chunk that will not load is a network problem, not a missing page,
        // and the two deserve different sentences.
        if (live) setFailed(page.slug);
      });
    return () => {
      live = false;
    };
  }, [page]);

  // The title, description and canonical URL follow a client-side navigation.
  // Without this the tab keeps the name of the page somebody arrived on, and so
  // does anything they then bookmark.
  useEffect(() => {
    if (!page) return;
    applyHead(headOf({ slug: page.slug, title: page.title, description: page.description }));
  }, [page]);

  const html = page
    ? page.slug === failed
      ? FAILED_HTML
      : (cache.current.get(page.slug) ?? null)
    : NOT_FOUND_HTML;

  return (
    <div className="min-h-dvh">
      {/*
        The first thing in the tab order, and visible only once it has focus. This
        site puts sixty links in a sidebar ahead of the text on every page, and
        tabbing past all of them to reach the article is the difference between
        usable and not for anybody navigating by keyboard.
      */}
      <a
        href="#content"
        className="sr-only rounded-lg bg-surface px-3 py-2 text-sm text-ink shadow-panel focus:not-sr-only focus:absolute focus:left-3 focus:top-3 focus:z-30"
      >
        Skip to the page
      </a>

      <Header onSearch={() => setSearchOpen(true)} onMenu={() => setMenuOpen(true)} />

      <MobileNav
        open={menuOpen}
        onClose={() => setMenuOpen(false)}
        slug={slug}
        known={known}
      />

      <div className="mx-auto flex w-full max-w-[105rem]">
        <Sidebar slug={slug} known={known} />

        <main id="content" className="min-w-0 flex-1 px-5 py-10 sm:px-8 lg:px-12">
          <div className="mx-auto w-full max-w-[50rem]">
            <Article
              title={page ? page.title : "Page not found"}
              description={page ? page.description : ""}
              html={html}
              slug={page ? page.slug : slug}
              expandAll={prefs.expandAll}
              onExpandAll={(expandAll) => set({ expandAll })}
              onNavigate={navigate}
              footer={
                page ? (
                  <PageFooter slug={page.slug} file={page.file} lastUpdated={page.lastUpdated} />
                ) : null
              }
            />
          </div>
        </main>

        {/*
          The column is reserved on a wide screen whether or not this page fills
          it — see the note at the top about the content column not moving.
        */}
        <div className="sticky top-14 hidden h-[calc(100dvh-3.5rem)] w-[15.5rem] shrink-0 overflow-y-auto py-10 pr-6 xl:block">
          {page && page.tableOfContents ? <Toc headings={page.headings} /> : null}
        </div>
      </div>

      <Search open={searchOpen} onClose={() => setSearchOpen(false)} />
    </div>
  );
};

export const App = ({ path, body }: AppProps) => (
  <PrefsProvider>
    <RouterProvider initialPath={path}>
      <Site body={body} />
    </RouterProvider>
  </PrefsProvider>
);
