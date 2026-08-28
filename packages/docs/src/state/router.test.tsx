// What this covers:
//  - the first path coming from the prop (the prerender) or from `location` (the browser)
//  - the slug and hash derived from the path
//  - <Link> navigating in place on a plain left click, and only then: a modified
//    click, a middle click and a `target` are all left to the browser
//  - a navigation with no hash scrolling to the top, and one with a hash not doing so
//  - the back button

import { act, fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { Link, RouterProvider, useRouter } from "./router.js";

const Probe = () => {
  const { path, slug, hash } = useRouter();
  return (
    <p>
      path={path} slug=[{slug}] hash=[{hash}]
    </p>
  );
};

const at = (): string => screen.getByText(/^path=/).textContent ?? "";

const mount = (initialPath?: string) =>
  render(
    <RouterProvider {...(initialPath === undefined ? {} : { initialPath })}>
      <Probe />
      <Link to="/reference/cli/">CLI</Link>
      <Link to="/guides/#logs">Logs</Link>
      <Link to="/setups/" target="_blank">
        Setups in a tab
      </Link>
    </RouterProvider>,
  );

describe("RouterProvider", () => {
  it("starts at the path it is given, which is how the prerender renders a page", () => {
    mount("/reference/cli/");
    expect(at()).toContain("slug=[reference/cli]");
  });

  it("starts at `location` when no path is given, which is what the browser does", () => {
    history.replaceState(null, "", "/architecture/plan-json/");
    mount();
    expect(at()).toContain("slug=[architecture/plan-json]");
  });

  it("splits a hash off the path", () => {
    mount("/guides/#logs");
    expect(at()).toContain("slug=[guides]");
    expect(at()).toContain("hash=[#logs]");
  });

  it("calls the front page the empty slug", () => {
    mount("/");
    expect(at()).toContain("slug=[]");
  });
});

describe("Link", () => {
  it("navigates in place on a plain left click", () => {
    mount("/");
    fireEvent.click(screen.getByText("CLI"));
    expect(at()).toContain("slug=[reference/cli]");
    expect(location.pathname).toBe("/reference/cli/");
  });

  it("renders a real href so the address can be copied or opened in a tab", () => {
    mount("/");
    expect(screen.getByText("CLI")).toHaveAttribute("href", "/reference/cli/");
  });

  for (const modifier of ["metaKey", "ctrlKey", "shiftKey", "altKey"] as const) {
    it(`leaves a ${modifier} click to the browser`, () => {
      mount("/");
      fireEvent.click(screen.getByText("CLI"), { [modifier]: true });
      expect(at()).toContain("slug=[]");
    });
  }

  it("leaves a middle click to the browser", () => {
    mount("/");
    fireEvent.click(screen.getByText("CLI"), { button: 1 });
    expect(at()).toContain("slug=[]");
  });

  it("leaves a link with a target to the browser", () => {
    mount("/");
    fireEvent.click(screen.getByText("Setups in a tab"));
    expect(at()).toContain("slug=[]");
  });

  it("scrolls to the top when the target has no hash", () => {
    const scrollTo = vi.spyOn(window, "scrollTo").mockImplementation(() => undefined);
    mount("/");
    fireEvent.click(screen.getByText("CLI"));
    expect(scrollTo).toHaveBeenCalledWith({ top: 0 });
  });

  it("does not scroll to the top when the target names a section", () => {
    // A hash points into a body that may not have loaded yet, so Article finishes
    // that job — and jumping to the top first would undo it.
    const scrollTo = vi.spyOn(window, "scrollTo").mockImplementation(() => undefined);
    mount("/");
    fireEvent.click(screen.getByText("Logs"));
    expect(at()).toContain("hash=[#logs]");
    expect(scrollTo).not.toHaveBeenCalled();
  });

  it("adds no history entry for the page it is already on", () => {
    // Without this, clicking the link you are already on — which readers do, from
    // the sidebar — stacks entries that all look identical to the back button.
    mount("/");
    fireEvent.click(screen.getByText("CLI"));
    const push = vi.spyOn(history, "pushState");
    fireEvent.click(screen.getByText("CLI"));
    expect(push).not.toHaveBeenCalled();
  });
});

describe("the back button", () => {
  it("puts the reader back where they were", () => {
    mount("/");
    fireEvent.click(screen.getByText("CLI"));
    expect(at()).toContain("slug=[reference/cli]");

    act(() => {
      history.replaceState(null, "", "/");
      window.dispatchEvent(new PopStateEvent("popstate"));
    });
    expect(at()).toContain("slug=[]");
  });
});
