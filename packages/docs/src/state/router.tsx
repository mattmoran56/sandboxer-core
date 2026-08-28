// Where the reader is, and how they get somewhere else.
//
// `packages/web/src/state/router.tsx`, ported, with three differences that all
// come from this being a prerendered documentation site rather than an app.
//
//  - **The first path is a prop.** The prerender renders one page per URL in
//    Node, where there is no `location` to read. The browser omits the prop and
//    reads `location` as the dashboard does.
//  - **A navigation scrolls.** The dashboard's views are panes and keep their
//    scroll; a documentation page is a document, and arriving a third of the way
//    down the next one is disorienting. `navigate` does it rather than an effect
//    on the path, so that `popstate` is left alone — going *back* should return to
//    where the reader was, and the browser already restores that.
//  - **`slug` is derived here**, so no component has to know that the URL for
//    `reference/cli` has a trailing slash on it.
//
// Anchors are still real anchors. `<Link>` renders an `<a href>` with a click
// handler that calls `preventDefault` only for a plain left click — so
// middle-click, ⌘-click and "open in new tab" all still do what the browser does,
// and the address bar shows somewhere real that can be copied and sent to
// somebody. On this site that matters more than on the dashboard: every URL here
// is a page somebody may want to send.

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type AnchorHTMLAttributes,
  type ReactNode,
} from "react";

import { slugOfPath } from "../lib/route.js";

export interface NavigateOptions {
  replace?: boolean;
}

interface RouterValue {
  /** The current path, including any `#hash`. */
  path: string;
  /** The page the path names: `""` for the front page, `"reference/cli"` and so on. */
  slug: string;
  /** The `#hash` on the current path, including the `#`, or `""`. */
  hash: string;
  navigate: (to: string, options?: NavigateOptions) => void;
}

const RouterContext = createContext<RouterValue | null>(null);

const here = (): string => `${location.pathname}${location.hash}`;

/** Splits a path into the part that names a page and the part that names a section. */
const split = (path: string): { pathname: string; hash: string } => {
  const at = path.indexOf("#");
  return at < 0
    ? { pathname: path, hash: "" }
    : { pathname: path.slice(0, at), hash: path.slice(at) };
};

export const RouterProvider = ({
  initialPath,
  children,
}: {
  /** Supplied by the prerender. The browser omits it and reads `location`. */
  initialPath?: string;
  children: ReactNode;
}) => {
  const [path, setPath] = useState(
    () => initialPath ?? (typeof window === "undefined" ? "/" : here()),
  );

  useEffect(() => {
    const onPop = (): void => setPath(here());
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, []);

  const navigate = useCallback((to: string, options: NavigateOptions = {}) => {
    // Resolved against the current URL so a relative target works, and so that
    // the pathname stored is always the canonical one rather than whatever form
    // the caller happened to have.
    const url = new URL(to, location.href);
    const next = `${url.pathname}${url.hash}`;

    // Same place, no entry. Without this, clicking the link you are already on
    // stacks history entries that all look identical to the back button.
    if (next !== here()) {
      if (options.replace) history.replaceState(null, "", next);
      else history.pushState(null, "", next);
      setPath(next);
    }

    // Two different jobs, and only one of them can be done from here.
    //
    // A link with no hash means "the start of another page", so the window goes
    // to the top — nothing else does it, because React is only swapping the
    // contents of one element and the scroll position survives that.
    //
    // A link *with* a hash may point into a body that has not been fetched yet:
    // page bodies are code-split, so the element with that id exists a tick or
    // two later. `Article` finishes that job when the body it injected arrives,
    // and this only handles the case where the target is already on screen.
    if (url.hash) {
      const target = document.getElementById(decodeURIComponent(url.hash.slice(1)));
      target?.scrollIntoView();
    } else {
      window.scrollTo({ top: 0 });
    }
  }, []);

  const value = useMemo<RouterValue>(() => {
    const { pathname, hash } = split(path);
    return { path, slug: slugOfPath(pathname), hash, navigate };
  }, [path, navigate]);

  return <RouterContext.Provider value={value}>{children}</RouterContext.Provider>;
};

export const useRouter = (): RouterValue => {
  const value = useContext(RouterContext);
  if (!value) throw new Error("useRouter outside a RouterProvider");
  return value;
};

export type LinkProps = AnchorHTMLAttributes<HTMLAnchorElement> & {
  to: string;
  replace?: boolean;
};

/** A real anchor that navigates in place on a plain left click, and nothing else. */
export const Link = ({ to, replace, onClick, ...rest }: LinkProps) => {
  const { navigate } = useRouter();
  return (
    <a
      // `href` is written *after* the spread on purpose. With it before, a caller
      // passing `href` alongside `to` would silently win the attribute while the
      // click handler still navigated to `to` — an anchor whose address bar and
      // behaviour disagree, and only for middle-clicks.
      {...rest}
      href={to}
      onClick={(event) => {
        onClick?.(event);
        if (event.defaultPrevented) return;
        // Everything the browser has its own answer for is left to the browser.
        if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) {
          return;
        }
        if (rest.target && rest.target !== "_self") return;
        event.preventDefault();
        navigate(to, replace === undefined ? {} : { replace });
      }}
    />
  );
};
