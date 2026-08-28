// What this covers:
//
//  - the honest error state when the corpus chunk will not load
//  - the loading state, before the dynamically imported corpus has arrived
//  - `/` opens it, and does *not* while focus is in an input or a contenteditable
//  - ⌘K opens it from anywhere, including out of a text field
//  - an empty box offers pages rather than nothing
//  - ↑ and ↓ move the selection, and aria-activedescendant follows
//  - Enter navigates to the hit, heading anchor and all
//  - a hit is a real anchor whose href points at the heading
//  - Escape closes it
//  - the result count is announced, and each hit shows its sidebar group
//
// The two states that depend on the corpus *not* being there yet come first on
// purpose: the loaded corpus is cached in the module after the first success, and
// nothing can un-cache it from out here.
//
// `../state/router.js` is mocked because asserting on a navigation is easier than
// asserting on a jsdom location. The stand-in `Link` behaves like the real one in
// the only two ways this file cares about: it renders a real `href`, and a plain
// click navigates.
//
// **This file cannot run until the test config can resolve `virtual:docs-search`.**
// The corpus module is created by `plugins/content.ts` at build time, and the
// mock below replaces it — but a jsdom project is transformed in Vite's *web*
// mode, where an import that resolves to nothing is a hard transform error
// before any mock is consulted. So `Search.tsx` fails to load and every test
// here is reported as a failed suite. Six lines in `vitest.config.ts` fix it,
// and installing the real content plugin instead is not the fix: it reads and
// highlights every page under `docs/` before it answers anything.
//
//     plugins: [
//       {
//         name: "docs-search-stub",
//         resolveId: (id) => (id === "virtual:docs-search" ? "\0virtual:docs-search" : null),
//         load: (id) => (id === "\0virtual:docs-search" ? "export const documents = [];" : null),
//       },
//     ],

import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { useState, type AnchorHTMLAttributes, type ReactElement } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { SearchDoc } from "../types.js";
import { Search, useSearchShortcut } from "./Search.js";

const { navigate, fixture } = vi.hoisted(() => ({
  navigate: vi.fn(),
  fixture: { fail: false },
}));

vi.mock("../state/router.js", () => ({
  useRouter: () => ({ navigate }),
  Link: ({ to, ...rest }: { to: string } & AnchorHTMLAttributes<HTMLAnchorElement>) => (
    <a
      {...rest}
      href={to}
      onClick={(event) => {
        rest.onClick?.(event);
        event.preventDefault();
        navigate(to);
      }}
    />
  ),
}));

vi.mock("virtual:docs-search", () => ({
  get documents(): readonly SearchDoc[] {
    if (fixture.fail) throw new Error("the corpus chunk did not load");
    return CORPUS;
  },
}));

const CORPUS: readonly SearchDoc[] = [
  {
    slug: "guides/docker-capacity",
    title: "Giving Docker the whole machine",
    description: "How much memory and how many cores Docker may use.",
    headings: [
      { depth: 2, id: "how-much-memory", text: "How much memory" },
      { depth: 2, id: "where-it-goes-wrong", text: "Where it goes wrong" },
    ],
    text: "How much memory Docker Desktop is allowed is a setting, and eight gigabytes is the floor. Where it goes wrong A container that cannot start is usually a machine that ran out.",
  },
  {
    slug: "configuration/secrets",
    title: "Secrets",
    description: "How a secret reaches a sandbox without being written down.",
    headings: [],
    text: "A secret is read from the environment and never written into the plan.",
  },
];

const Harness = (): ReactElement => {
  const [open, setOpen] = useState(false);
  useSearchShortcut(() => setOpen(true));
  return (
    <>
      <input aria-label="somewhere else" />
      <Search open={open} onClose={() => setOpen(false)} />
    </>
  );
};

const box = (): HTMLInputElement => screen.getByRole("combobox") as HTMLInputElement;

const type = (value: string): void => {
  fireEvent.change(box(), { target: { value } });
};

const openWithSlash = (): void => {
  fireEvent.keyDown(document.body, { key: "/" });
};

afterEach(() => {
  fixture.fail = false;
  navigate.mockClear();
});

describe("before the corpus is there", () => {
  it("says so, honestly, when it will not load", async () => {
    fixture.fail = true;
    render(<Harness />);
    openWithSlash();
    type("docker");
    expect(await screen.findByText(/Every page is still in the sidebar/)).toBeTruthy();
    expect(screen.getByRole("status").textContent).toBe("Search could not load.");
  });

  it("shows a loading line until the corpus arrives", async () => {
    render(<Harness />);
    openWithSlash();
    type("docker");
    // Two elements say it: the line in the panel and the live region that
    // announces it. This is the visible one.
    expect(screen.getByText("Loading the search index\u2026")).toBeTruthy();
    expect(await screen.findByRole("option", { name: /Giving Docker/ })).toBeTruthy();
  });
});

describe("the shortcut", () => {
  it("opens on /", () => {
    render(<Harness />);
    expect(screen.queryByRole("combobox")).toBeNull();
    openWithSlash();
    expect(screen.queryByRole("combobox")).not.toBeNull();
  });

  it("does not open on / while focus is in a text field", () => {
    render(<Harness />);
    const elsewhere = screen.getByLabelText("somewhere else");
    elsewhere.focus();
    fireEvent.keyDown(elsewhere, { key: "/" });
    expect(screen.queryByRole("combobox")).toBeNull();
  });

  it("does not open on / while focus is in a contenteditable", () => {
    render(<Harness />);
    const editable = document.createElement("div");
    // jsdom does not implement `isContentEditable`, so it is defined here — the
    // component reads exactly that property.
    Object.defineProperty(editable, "isContentEditable", { value: true });
    document.body.append(editable);
    fireEvent.keyDown(editable, { key: "/" });
    expect(screen.queryByRole("combobox")).toBeNull();
  });

  it("opens on ⌘K even out of a text field", () => {
    render(<Harness />);
    const elsewhere = screen.getByLabelText("somewhere else");
    elsewhere.focus();
    fireEvent.keyDown(elsewhere, { key: "k", metaKey: true });
    expect(screen.queryByRole("combobox")).not.toBeNull();
  });

  it("opens on Ctrl+K", () => {
    render(<Harness />);
    fireEvent.keyDown(document.body, { key: "k", ctrlKey: true });
    expect(screen.queryByRole("combobox")).not.toBeNull();
  });
});

describe("with the corpus loaded", () => {
  const opened = async (query?: string): Promise<void> => {
    render(<Harness />);
    openWithSlash();
    await waitFor(() => expect(screen.getAllByRole("option").length).toBeGreaterThan(0));
    if (query !== undefined) type(query);
  };

  it("offers pages to start from when nothing has been typed", async () => {
    await opened();
    const options = screen.getAllByRole("option");
    expect(options.length).toBeGreaterThan(2);
    expect(options[0]?.getAttribute("href")).toBe("/getting-started/install/");
  });

  it("finds the page both terms are on and links to the best heading", async () => {
    await opened("docker memory");
    const hits = await screen.findAllByRole("option");
    expect(hits).toHaveLength(1);
    expect(hits[0]?.getAttribute("href")).toBe("/guides/docker-capacity/#how-much-memory");
  });

  it("shows the sidebar group each hit belongs to", async () => {
    await opened("secret");
    expect(await screen.findByText("Describing your project")).toBeTruthy();
  });

  it("moves the selection with the arrow keys", async () => {
    await opened();
    const options = screen.getAllByRole("option");
    expect(box().getAttribute("aria-activedescendant")).toBe(options[0]?.id);
    fireEvent.keyDown(box(), { key: "ArrowDown" });
    expect(box().getAttribute("aria-activedescendant")).toBe(options[1]?.id);
    expect(options[1]?.getAttribute("aria-selected")).toBe("true");
    fireEvent.keyDown(box(), { key: "ArrowUp" });
    expect(box().getAttribute("aria-activedescendant")).toBe(options[0]?.id);
  });

  it("wraps round the ends of the list", async () => {
    await opened();
    const options = screen.getAllByRole("option");
    fireEvent.keyDown(box(), { key: "ArrowUp" });
    expect(box().getAttribute("aria-activedescendant")).toBe(options[options.length - 1]?.id);
  });

  it("navigates to the selected hit on Enter", async () => {
    await opened("docker memory");
    await screen.findAllByRole("option");
    fireEvent.keyDown(box(), { key: "Enter" });
    expect(navigate).toHaveBeenCalledWith("/guides/docker-capacity/#how-much-memory");
  });

  it("navigates on a click too", async () => {
    await opened("docker memory");
    const hits = await screen.findAllByRole("option");
    fireEvent.click(hits[0] as HTMLElement);
    expect(navigate).toHaveBeenCalledWith("/guides/docker-capacity/#how-much-memory");
  });

  it("closes on Escape", async () => {
    await opened();
    fireEvent.keyDown(box(), { key: "Escape" });
    expect(screen.queryByRole("combobox")).toBeNull();
  });

  it("announces how many results there are", async () => {
    await opened("docker memory");
    await waitFor(() =>
      expect(screen.getByRole("status").textContent).toBe("1 result for docker memory."),
    );
  });

  it("says when nothing matched, rather than showing an empty box", async () => {
    await opened("kubernetes");
    expect(await screen.findByText(/Nothing matches/)).toBeTruthy();
    expect(screen.queryAllByRole("option")).toHaveLength(0);
  });

  it("marks the matched words in the snippet", async () => {
    await opened("gigabytes");
    const marks = await waitFor(() => {
      const found = document.querySelectorAll("mark");
      expect(found.length).toBeGreaterThan(0);
      return found;
    });
    expect(marks[0]?.textContent).toBe("gigabytes");
  });
});
