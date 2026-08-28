// What this covers:
//  - every page in `NAV` appearing, under its group heading
//  - the current page marked with `aria-current="page"`, and only that one
//  - a slug the build produced no page for rendering dimmed, unclickable and
//    labelled as unwritten rather than as a link into a 404
//  - the drawer's copy of the tree closing itself after a link is followed

import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { NAV, NAV_ORDER } from "../nav.js";
import { RouterProvider } from "../state/router.js";
import { NavTree } from "./Sidebar.js";

const everything = new Set(NAV_ORDER.map((page) => page.slug));

const mount = (
  slug: string,
  known: ReadonlySet<string> = everything,
  onNavigate?: () => void,
) =>
  render(
    <RouterProvider initialPath="/">
      <NavTree slug={slug} known={known} {...(onNavigate ? { onNavigate } : {})} />
    </RouterProvider>,
  );

describe("NavTree", () => {
  it("lists every page the nav names", () => {
    mount("");
    for (const page of NAV_ORDER) {
      expect(screen.getByText(page.label)).toBeInTheDocument();
    }
  });

  it("shows the group headings", () => {
    mount("");
    for (const group of NAV) {
      if (group.label) expect(screen.getByText(group.label)).toBeInTheDocument();
    }
  });

  it("marks the page being read, and nothing else", () => {
    mount("reference/cli");
    const current = screen.getAllByRole("link").filter((link) => link.getAttribute("aria-current"));
    expect(current).toHaveLength(1);
    expect(current[0]).toHaveTextContent("CLI commands");
  });

  it("links to the URL shape the site serves", () => {
    mount("");
    expect(screen.getByText("CLI commands")).toHaveAttribute("href", "/reference/cli/");
    expect(screen.getByText("Welcome")).toHaveAttribute("href", "/");
  });
});

describe("a nav entry with no page behind it", () => {
  // The build warns and skips a page it cannot render, because the content is
  // written at the same time as the site. This is that rule in the UI: the entry
  // is visibly unfinished rather than a link that 404s.
  const missing = new Set(everything);
  missing.delete("reference/cli");

  it("is not a link", () => {
    mount("", missing);
    const entry = screen.getByText("CLI commands");
    expect(entry.tagName).toBe("SPAN");
    expect(entry).toHaveAttribute("aria-disabled", "true");
  });

  it("says what is wrong with it", () => {
    mount("", missing);
    expect(screen.getByText("CLI commands")).toHaveAttribute(
      "title",
      "This page is in the sidebar but has not been written yet.",
    );
  });

  it("leaves every other entry alone", () => {
    mount("", missing);
    expect(screen.getByText("Cheat sheet").tagName).toBe("A");
  });
});

describe("the drawer's copy", () => {
  it("closes itself once a link has been followed", () => {
    const onNavigate = vi.fn();
    mount("", everything, onNavigate);
    fireEvent.click(screen.getByText("CLI commands"));
    expect(onNavigate).toHaveBeenCalled();
  });
});
