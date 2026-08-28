import { defineConfig, type Plugin } from "vitest/config";

// The projects live in vitest.workspace.ts — one for the pure logic and one that
// renders into jsdom. This file holds what both of them share, and its existence
// is also what keeps vite.config.ts out of the test run: that config installs the
// content plugin, which reads, renders and syntax-highlights every page under
// `docs/` before it answers anything. A unit test has no business paying for that.
//
// Which leaves one gap, and `emptyContent` fills it.

/**
 * The two virtual content modules, emptied out.
 *
 * `src/components/Search.tsx` dynamically imports `virtual:docs-search`, and that
 * specifier has to stay a literal string — it is what gives the corpus a chunk of
 * its own instead of putting three quarters of a megabyte of prose into the entry
 * bundle. But a jsdom test file is transformed in Vite's *web* mode, where an
 * import that resolves to nothing is a hard transform error, and that error lands
 * **before any `vi.mock` is consulted** — so the suite failed to load rather than
 * failing an assertion, and no amount of mocking inside the test file could reach
 * it. Nor is the answer to install the real content plugin: it would highlight
 * every page in the repository in order to test one dialog.
 *
 * So the modules resolve here, to nothing. A test that wants a corpus supplies one
 * with `vi.mock`, which now has something to intercept. A test that does not gets
 * an empty site, which is the honest starting state for a component that has to
 * render before its corpus has arrived.
 *
 * **It has to be listed on each project in vitest.workspace.ts, not only here.** A
 * workspace project does not inherit this file's plugins, which is why exporting it
 * is the point of it being here at all.
 */
export const emptyContent = (): Plugin => {
  const modules: Record<string, string> = {
    "virtual:docs-search": "export const documents = [];",
    "virtual:docs-content": "export const pages = [];",
  };
  return {
    name: "docs-empty-content",
    resolveId: (id) => (id in modules ? `\0${id}` : null),
    load: (id) => (id.startsWith("\0") ? (modules[id.slice(1)] ?? null) : null),
  };
};

export default defineConfig({
  plugins: [emptyContent()],
});
