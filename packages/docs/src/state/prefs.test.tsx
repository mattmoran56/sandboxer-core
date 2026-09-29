// What this covers:
//  - the stored theme reaching `<html>` as `data-theme`, and nothing else with it
//  - `system` resolving against the machine, and following it when it changes
//  - a change being written back to storage under the key `index.html` reads
//  - the first render using the defaults, so hydration has the same markup to
//    reconcile against as the prerendered file

import { act, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

import { PREFS_KEY } from "../lib/prefs.js";
import { PrefsProvider, usePrefs } from "./prefs.js";
import { setSystemDark } from "../test-setup.js";

const root = () => document.documentElement;

const Probe = () => {
  const { prefs, set, theme } = usePrefs();
  return (
    <>
      <p data-testid="state">
        {prefs.theme}/{String(prefs.expandAll)}/{theme}
      </p>
      <button type="button" onClick={() => set({ theme: "dark" })}>
        dark
      </button>
      <button type="button" onClick={() => set({ expandAll: true })}>
        expand
      </button>
    </>
  );
};

const state = (): string => screen.getByTestId("state").textContent ?? "";

const mount = () =>
  render(
    <PrefsProvider>
      <Probe />
    </PrefsProvider>,
  );

describe("PrefsProvider", () => {
  it("puts the stored theme on <html>, and no scheme even when an old one is stored", () => {
    localStorage.setItem(PREFS_KEY, JSON.stringify({ theme: "dark", scheme: "cobalt" }));
    mount();
    expect(root().dataset.theme).toBe("dark");
    expect(root().dataset.scheme).toBeUndefined();
  });

  it("resolves `system` against the machine rather than leaving it to a media query", () => {
    setSystemDark(true);
    mount();
    expect(state()).toBe("system/false/dark");
    expect(root().dataset.theme).toBe("dark");
  });

  it("follows the machine when it changes at sunset", () => {
    mount();
    expect(root().dataset.theme).toBe("light");
    act(() => setSystemDark(true));
    expect(root().dataset.theme).toBe("dark");
  });

  it("keeps an explicit choice when the machine changes", () => {
    localStorage.setItem(PREFS_KEY, JSON.stringify({ theme: "light" }));
    mount();
    act(() => setSystemDark(true));
    expect(root().dataset.theme).toBe("light");
  });

  it("writes the theme switch's answer to <html> and to storage", () => {
    mount();
    act(() => screen.getByText("dark").click());
    expect(root().dataset.theme).toBe("dark");
    expect(JSON.parse(localStorage.getItem(PREFS_KEY) ?? "{}")).toMatchObject({ theme: "dark" });
  });

  it("remembers expand-everything", () => {
    mount();
    act(() => screen.getByText("expand").click());
    expect(state()).toContain("/true/");
    expect(JSON.parse(localStorage.getItem(PREFS_KEY) ?? "{}")).toMatchObject({ expandAll: true });
  });

  it("renders the defaults with no browser at all, which is what the prerender does", () => {
    localStorage.setItem(PREFS_KEY, JSON.stringify({ theme: "dark", expandAll: true }));
    // React warns about `useLayoutEffect` during a server render. Under jsdom
    // `typeof window` is defined, so the provider takes the browser branch and the
    // warning is an artefact of testing a Node path in a fake browser — it does not
    // happen in the real prerender.
    const quiet = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const markup = renderToStaticMarkup(
      <PrefsProvider>
        <Probe />
      </PrefsProvider>,
    );
    quiet.mockRestore();
    // The defaults, not the stored preferences. The static file has to be the same
    // for every reader — it is one file — and the browser's first render has to
    // agree with it or hydration is reconciling against markup that never existed.
    expect(markup).toContain("system/false/light");
  });

  it("does not write the defaults back merely because a page was opened", () => {
    // Opening a page is not a choice. Writing here would turn every reader's first
    // visit into a stored preference and make "follow this machine" sticky.
    mount();
    expect(localStorage.getItem(PREFS_KEY)).toBeNull();
  });
});
