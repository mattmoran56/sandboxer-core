// Turns the two builds into a directory of files.
//
// `vite build` has produced `dist/` — the browser bundle and the HTML shell — and
// `vite build --ssr` has produced `dist-ssr/entry-server.js`. This runs the second
// against the first: for every route the site has, it renders the page and writes
// `dist/<slug>/index.html`. After this there is no server-side anything; there is
// a directory a static host can serve.
//
// Plain JavaScript on purpose. It runs under `node` directly, after the build, so
// it is the one file in the package that is neither bundled nor typechecked —
// `tsconfig.json` does not include `build/`.

import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const dist = path.resolve(here, "..", "dist");

// The shell's own `<title>` is dropped before the per-page one is inserted.
// A document with two `<title>` elements is not an error and browsers do not
// pick the last: they take the first, so leaving the shell's in place gave every
// one of these files the title "sandboxer documentation" while the correct tag sat
// a few lines below it, present and ignored.
//
// Anchored to the start of a line, and no `<` allowed inside the title text.
// The previous regex (`/[ \t]*<title>[\s\S]*?<\/title>\r?\n?/`, unanchored, `.`
// matching newlines) once matched a `<title>` that was not an element: the
// comment directly above the real one, explaining why this strip exists,
// contains the literal text "<title>" as an example. That match ran lazily
// from inside the comment to the real closing `</title>` and deleted
// everything between — including the comment's own closing `-->` — which left
// the rest of `<head>` (the stylesheet link and the module script) inside an
// unterminated comment the browser never rendered. Requiring the tag to start
// a line, and its text to contain no `<`, means the pattern can only match an
// actual `<title>…</title>` element sitting on its own line, never a comment
// that happens to mention one.
export function prepareTemplate(raw) {
  const template = raw.replace(/^[ \t]*<title>[^<\r\n]*<\/title>\r?\n?/m, "");

  if (!template.includes("<!--app-head-->") || !template.includes("<!--app-html-->")) {
    throw new Error("prerender: dist/index.html has no <!--app-head--> / <!--app-html--> placeholder.");
  }

  return template;
}

/** Drops one rendered page's `<head>` additions and markup into the template. */
export function fillTemplate(template, { head, html }) {
  return template.replace("<!--app-head-->", head).replace("<!--app-html-->", html);
}

/** `/` is `dist/index.html`; `/reference/cli/` is `dist/reference/cli/index.html`. */
export const fileFor = (route) => path.join(dist, route.replace(/^\/+|\/+$/g, ""), "index.html");

const write = async (file, contents) => {
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, contents, "utf8");
};

async function main() {
  const { routes, render } = await import("../dist-ssr/entry-server.js");

  const raw = await readFile(path.join(dist, "index.html"), "utf8");

  let template;
  try {
    template = prepareTemplate(raw);
  } catch (error) {
    console.error(error.message);
    process.exit(1);
    return;
  }

  const fill = (page) => fillTemplate(template, page);

  let pages = 0;
  for (const route of routes()) {
    await write(fileFor(route), fill(await render(route)));
    pages += 1;
  }

  // The host's 404 page, carrying the same app shell. A static host that has one
  // serves it for every path with no file, and the app then renders its own
  // not-found view inside the site's chrome rather than the host's bare page.
  // Counted separately from the pages, so an empty site cannot look like a build
  // that wrote one file.
  await write(path.join(dist, "404.html"), fill(await render("/404/")));

  console.log(`prerender: wrote ${pages} pages and 404.html into dist/`);

  if (pages === 0) {
    // Nothing to serve. Almost always the content loader having skipped every page,
    // which it does quietly by design — so the failure has to be raised here.
    console.error("prerender: no pages were rendered. Is there any page under docs/?");
    process.exit(1);
  }
}

// Only run the build when this file is executed directly (`node build/prerender.mjs`),
// not when something imports `prepareTemplate`/`fillTemplate` for their own sake — a
// test that pulled in the whole build would need `dist/` and `dist-ssr/` to exist
// just to check a string replace.
if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  await main();
}
