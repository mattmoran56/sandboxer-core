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

const { routes, render } = await import("../dist-ssr/entry-server.js");

const raw = await readFile(path.join(dist, "index.html"), "utf8");

// The shell's own `<title>` is dropped before the per-page one is inserted.
// A document with two `<title>` elements is not an error and browsers do not
// pick the last: they take the first, so leaving the shell's in place gave every
// one of these files the title "sandboxer documentation" while the correct tag sat
// a few lines below it, present and ignored.
const template = raw.replace(/[ \t]*<title>[\s\S]*?<\/title>\r?\n?/, "");

if (!template.includes("<!--app-head-->") || !template.includes("<!--app-html-->")) {
  console.error("prerender: dist/index.html has no <!--app-head--> / <!--app-html--> placeholder.");
  process.exit(1);
}

const fill = ({ head, html }) =>
  template.replace("<!--app-head-->", head).replace("<!--app-html-->", html);

/** `/` is `dist/index.html`; `/reference/cli/` is `dist/reference/cli/index.html`. */
const fileFor = (route) => path.join(dist, route.replace(/^\/+|\/+$/g, ""), "index.html");

const write = async (file, contents) => {
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, contents, "utf8");
};

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
