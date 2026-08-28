// What this covers:
//
//  - nothing at all under two headings
//  - h2 and h3 both listed, with the h3 marked as the deeper one
//  - the scroll-spy marks the heading in the band with aria-current="location"
//  - the marker stays on the last heading when nothing is in the band
//  - a click scrolls past the sticky header rather than under it, and replaces
//    the hash instead of pushing a history entry
//  - a ⌘-click is left to the browser, so "open in new tab" still works
//
// The IntersectionObserver is stubbed here rather than taken from the shared test
// setup, because a scroll-spy tested against an observer that cannot be made to
// fire is a scroll-spy whose behaviour is not tested at all.

import { act, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { Heading } from "../types.js";
import { Toc } from "./Toc.js";

let fire: ((visible: readonly string[]) => void) | null = null;
let rootMargin: string | null = null;

class FakeObserver {
  private readonly targets: Element[] = [];

  constructor(callback: IntersectionObserverCallback, init?: IntersectionObserverInit) {
    rootMargin = init?.rootMargin ?? null;
    fire = (visible) => {
      act(() => {
        callback(
          this.targets.map(
            (target) =>
              ({ target, isIntersecting: visible.includes(target.id) }) as IntersectionObserverEntry,
          ),
          this as unknown as IntersectionObserver,
        );
      });
    };
  }

  observe(target: Element): void {
    this.targets.push(target);
  }
  unobserve(): void {}
  disconnect(): void {}
  takeRecords(): IntersectionObserverEntry[] {
    return [];
  }
}

const h = (id: string, text: string, depth: 2 | 3 = 2): Heading => ({ depth, id, text });

const HEADINGS = [
  h("what-happens-first", "What happens first"),
  h("the-go-module-cache", "The Go module cache", 3),
  h("where-to-go-next", "Where to go next"),
];

/** The page as the article renders it: a sticky header, the headings, the toc. */
const page = (headings: readonly Heading[]) => (
  <>
    <header style={{ position: "sticky" }}>the site header</header>
    {headings.map((heading) => (
      <h2 key={heading.id} id={heading.id}>
        {heading.text}
      </h2>
    ))}
    <Toc headings={headings} />
  </>
);

const entry = (text: string): HTMLAnchorElement => screen.getByRole("link", { name: text });

beforeEach(() => {
  fire = null;
  rootMargin = null;
  vi.stubGlobal("IntersectionObserver", FakeObserver);
});

afterEach(() => {
  vi.unstubAllGlobals();
  history.replaceState(null, "", "/");
});

describe("under two headings", () => {
  it("renders nothing for one heading", () => {
    render(page([HEADINGS[0] as Heading]));
    expect(screen.queryByRole("navigation")).toBeNull();
  });

  it("renders nothing for none", () => {
    render(page([]));
    expect(screen.queryByRole("navigation")).toBeNull();
  });
});

it("lists h2 and h3, marking which is which", () => {
  render(page(HEADINGS));
  expect(screen.getAllByRole("link").map((link) => link.getAttribute("data-depth"))).toEqual([
    "2",
    "3",
    "2",
  ]);
});

describe("the scroll-spy", () => {
  it("marks the heading in the band with aria-current=location", () => {
    render(page(HEADINGS));
    fire?.(["the-go-module-cache"]);
    expect(entry("The Go module cache").getAttribute("aria-current")).toBe("location");
    expect(entry("What happens first").getAttribute("aria-current")).toBeNull();
  });

  it("keeps the last one current when nothing is in the band", () => {
    render(page(HEADINGS));
    fire?.(["the-go-module-cache"]);
    fire?.([]);
    expect(entry("The Go module cache").getAttribute("aria-current")).toBe("location");
  });

  it("prefers the first heading in document order when two are in the band", () => {
    render(page(HEADINGS));
    fire?.(["the-go-module-cache", "where-to-go-next"]);
    expect(entry("The Go module cache").getAttribute("aria-current")).toBe("location");
    expect(entry("Where to go next").getAttribute("aria-current")).toBeNull();
  });

  it("keeps the sticky header out of the band", () => {
    render(page(HEADINGS));
    // The stub's header has no measurable height in jsdom, so this asserts the
    // shape and the direction of the margin, not the number.
    expect(rootMargin).toMatch(/^-\d+px 0px -65% 0px$/);
  });
});

describe("clicking an entry", () => {
  const stubHeights = (): void => {
    const header = document.querySelector("header");
    if (header) {
      header.getBoundingClientRect = () => ({ height: 56, top: 0 }) as DOMRect;
    }
    const target = document.getElementById("where-to-go-next");
    if (target) {
      target.getBoundingClientRect = () => ({ height: 30, top: 300 }) as DOMRect;
    }
  };

  it("scrolls to the heading, offset by the sticky header, and replaces the hash", () => {
    const scrollTo = vi.spyOn(window, "scrollTo").mockImplementation(() => undefined);
    render(page(HEADINGS));
    stubHeights();

    act(() => {
      entry("Where to go next").click();
    });

    // 300 (the heading's top) - 56 (the header) - 12 (the gap).
    expect(scrollTo).toHaveBeenCalledWith({ top: 232, behavior: "smooth" });
    expect(location.hash).toBe("#where-to-go-next");
    expect(entry("Where to go next").getAttribute("aria-current")).toBe("location");
  });

  it("leaves a ⌘-click to the browser", () => {
    const scrollTo = vi.spyOn(window, "scrollTo").mockImplementation(() => undefined);
    render(page(HEADINGS));
    stubHeights();

    act(() => {
      entry("Where to go next").dispatchEvent(
        new MouseEvent("click", { bubbles: true, cancelable: true, metaKey: true }),
      );
    });

    expect(scrollTo).not.toHaveBeenCalled();
  });
});
