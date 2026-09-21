// The preferences, held in one place and written straight through to storage.
//
// This is the dashboard's `prefs.tsx` with one difference, and the
// difference is the whole reason it is a separate file: **this site is
// prerendered.** Every page is real HTML written at build time, so the first
// render happens in Node with no `localStorage` at all, and the browser's first
// render has to produce the same markup or hydration mismatches.
//
// That rules out the dashboard's `useState(load)`. Reading storage during the
// first client render would give a reader who chose dark a theme switch with a
// different button pressed than the prerendered file has, on every page.
//
// So the load is a *layout* effect instead:
//
//  1. Node and the browser's first render both use `DEFAULTS`. The markup agrees.
//  2. A layout effect reads storage and sets the real preferences. Layout effects
//     run before the browser paints, so nothing on screen is ever the default.
//  3. Only once that has happened does anything get written to `<html>`.
//
// Step 3 is not tidiness. The blocking script in `index.html` has *already* put
// the right theme and scheme on the root before any of this ran; an effect that
// applied `DEFAULTS` first would undo it for one frame, which is exactly the
// flash the blocking script exists to prevent.

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";

import { DEFAULTS, PREFS_KEY, readPrefs, resolveTheme, type Prefs } from "../lib/prefs.js";

interface PrefsValue {
  prefs: Prefs;
  /** Merges a change in, writes it to storage, and re-applies the attributes. */
  set: (change: Partial<Prefs>) => void;
  /** Whichever of the two themes is on screen right now. */
  theme: "light" | "dark";
}

const PrefsContext = createContext<PrefsValue | null>(null);

/**
 * `useLayoutEffect`, except on the server where there is no layout.
 *
 * React warns about `useLayoutEffect` during `renderToString` — correctly, since
 * it cannot run — and the warning would appear once per prerendered page, which is
 * once per line of build output.
 */
const useBeforePaint = typeof window === "undefined" ? useEffect : useLayoutEffect;

const load = (): Prefs => {
  try {
    return readPrefs(localStorage.getItem(PREFS_KEY));
  } catch {
    // Storage can be unavailable outright — a browser with cookies and site data
    // blocked throws on `localStorage` itself, not on the read.
    return DEFAULTS;
  }
};

const save = (prefs: Prefs): void => {
  try {
    localStorage.setItem(PREFS_KEY, JSON.stringify(prefs));
  } catch {
    // A preference that cannot be remembered is still a preference that works for
    // this page. Failing here would take the site down over a setting.
  }
};

/** Applies the preferences that the stylesheet reads off `<html>`. */
export const applyPrefs = (prefs: Prefs, systemPrefersDark: boolean): void => {
  const root = document.documentElement;
  root.dataset.theme = resolveTheme(prefs.theme, systemPrefersDark);
  root.dataset.scheme = prefs.scheme;
};

export const PrefsProvider = ({ children }: { children: ReactNode }) => {
  const [prefs, setPrefs] = useState<Prefs>(DEFAULTS);
  const [systemDark, setSystemDark] = useState(false);
  // Nothing is written to `<html>` or to storage until the stored preferences
  // have been read, so the two frames before that cannot contradict the blocking
  // script that set them.
  const [loaded, setLoaded] = useState(false);

  useBeforePaint(() => {
    setSystemDark(window.matchMedia?.("(prefers-color-scheme: dark)").matches ?? false);
    setPrefs(load());
    setLoaded(true);
  }, []);

  // Followed even when the choice is not `system`: somebody who switches their
  // machine to dark and then sets the toggle back to "follow the system" gets the
  // right answer without a reload.
  useEffect(() => {
    const query = window.matchMedia?.("(prefers-color-scheme: dark)");
    if (!query) return;
    const onChange = (event: MediaQueryListEvent): void => setSystemDark(event.matches);
    query.addEventListener("change", onChange);
    return () => query.removeEventListener("change", onChange);
  }, []);

  useEffect(() => {
    if (!loaded) return;
    applyPrefs(prefs, systemDark);
  }, [loaded, prefs, systemDark]);

  // Writing to storage is an effect, not something the updaters do.
  //
  // A `setState` updater must be pure: React is allowed to call it more than once
  // for a single update, and under `<StrictMode>` in development it always does.
  // Saving from inside one meant every preference change wrote twice. The write
  // is idempotent so nothing broke, but a side effect in a reducer is the shape of
  // the bug rather than the bug — the next effect put there might not be.
  //
  // The first run after loading is skipped so that merely opening a page does not
  // write back what was just read.
  const written = useRef(false);
  useEffect(() => {
    if (!loaded) return;
    if (!written.current) {
      written.current = true;
      return;
    }
    save(prefs);
  }, [loaded, prefs]);

  const set = useCallback((change: Partial<Prefs>) => {
    setPrefs((current) => ({ ...current, ...change }));
  }, []);

  const value = useMemo<PrefsValue>(
    () => ({ prefs, set, theme: resolveTheme(prefs.theme, systemDark) }),
    [prefs, set, systemDark],
  );

  return <PrefsContext.Provider value={value}>{children}</PrefsContext.Provider>;
};

export const usePrefs = (): PrefsValue => {
  const value = useContext(PrefsContext);
  if (!value) throw new Error("usePrefs outside a PrefsProvider");
  return value;
};
