// What the jsdom project needs before a component will render.
//
// The same idiom as `packages/web/src/test-setup.ts`: jsdom is a good DOM and not
// a browser, so several things this site uses are simply absent from it. Each is
// filled in with the smallest thing that behaves like the real one — never with a
// stub that always answers the same way, because a control tested against a fake
// that cannot change is a control whose change is not tested.
//
// Five gaps here rather than the dashboard's four, and the extra one is the
// clipboard. It matters more than the others: the copy button is the most-pressed
// thing on this site, and it has a fallback path for the case where the clipboard
// is absent or refuses. A fake that always succeeds would leave that path untested
// on the one host it exists for — an insecure `http://` preview.

import { afterEach, vi } from "vitest";
import { cleanup } from "@testing-library/react";

// The `/vitest` entry point rather than `/matchers`, and the difference is not
// cosmetic: `/matchers` only extends `expect` at runtime, so every `.test.tsx` in
// the package fails to typecheck with "Property 'toBeInTheDocument' does not
// exist". This one carries the `declare module "vitest"` augmentation as well.
import "@testing-library/jest-dom/vitest";

/**
 * The media query the theme switch reads.
 *
 * Controllable: `setSystemDark(true)` flips it and notifies every listener, which
 * is what lets a test assert that "follow this machine" really follows it rather
 * than only reading it once at mount.
 */
const listeners = new Set<(event: MediaQueryListEvent) => void>();
let systemDark = false;

export const setSystemDark = (dark: boolean): void => {
  systemDark = dark;
  for (const listener of listeners) {
    listener({ matches: dark } as MediaQueryListEvent);
  }
};

Object.defineProperty(window, "matchMedia", {
  writable: true,
  value: (query: string) => ({
    media: query,
    get matches() {
      return query.includes("dark") ? systemDark : false;
    },
    addEventListener: (_: string, listener: (event: MediaQueryListEvent) => void) => {
      listeners.add(listener);
    },
    removeEventListener: (_: string, listener: (event: MediaQueryListEvent) => void) => {
      listeners.delete(listener);
    },
    addListener: () => undefined,
    removeListener: () => undefined,
    dispatchEvent: () => false,
    onchange: null,
  }),
});

/**
 * The clipboard.
 *
 * Writable and configurable, so a test can take it away again — `delete
 * (navigator as …).clipboard` — and exercise the selection-based fallback. jsdom
 * ships no `navigator.clipboard` at all and, since it is defined on the prototype
 * as a getter in a real browser, a plain assignment would not have worked.
 */
export const clipboardWrites: string[] = [];

Object.defineProperty(navigator, "clipboard", {
  writable: true,
  configurable: true,
  value: {
    writeText: (text: string) => {
      clipboardWrites.push(text);
      return Promise.resolve();
    },
  },
});

/** The `<dialog>` fallback: jsdom has the element but not the top-layer methods. */
if (typeof HTMLDialogElement !== "undefined") {
  if (!HTMLDialogElement.prototype.showModal) {
    HTMLDialogElement.prototype.showModal = function showModal(this: HTMLDialogElement) {
      this.open = true;
    };
  }
  if (!HTMLDialogElement.prototype.close) {
    HTMLDialogElement.prototype.close = function close(this: HTMLDialogElement) {
      this.open = false;
      this.dispatchEvent(new Event("close"));
    };
  }
}

/** The table of contents watches the headings with one of these. */
if (!("IntersectionObserver" in globalThis)) {
  globalThis.IntersectionObserver = class {
    readonly root = null;
    readonly rootMargin = "";
    readonly thresholds: readonly number[] = [];
    observe(): void {}
    unobserve(): void {}
    disconnect(): void {}
    takeRecords(): IntersectionObserverEntry[] {
      return [];
    }
  } as unknown as typeof IntersectionObserver;
}

/**
 * Scrolling. Every navigation does it, and jsdom does neither.
 *
 * Assigned unconditionally rather than behind an `in` check, which is the trap
 * here: jsdom *defines* both of these, as stubs that log "Not implemented" to
 * stderr on every call. A guard therefore leaves the stub in place and every test
 * that navigates prints a warning it cannot act on.
 */
window.scrollTo = (() => undefined) as typeof window.scrollTo;
Element.prototype.scrollIntoView = () => undefined;

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  setSystemDark(false);
  listeners.clear();
  clipboardWrites.length = 0;
  localStorage.clear();
  // The theme and scheme are attributes on <html>, so one test's choice would
  // otherwise still be there for the next.
  document.documentElement.removeAttribute("data-theme");
  document.documentElement.removeAttribute("data-scheme");
  // Every test that navigates leaves the History API somewhere; the router reads
  // its first location straight out of it.
  history.replaceState(null, "", "/");
});
