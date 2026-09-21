// Covers src/lib/route.ts:
//  - slugOfFile: a top-level page, a nested one, the front page's index.md, a
//    directory's index.md, a .mdx, a Windows-style separator, a leading slash,
//    and a filename that merely ends in "index"
//  - pathOfSlug: the root and a nested page, and that it always ends in a slash
//  - slugOfPath: a missing trailing slash, a doubled one, a query, a hash, and
//    that it round-trips with pathOfSlug
//  - editHref and sourceHref
//  - NOT_PAGES and OFF_SITE agreeing about contracts.md
//  - isNotPage: an exact path, a basename glob, and a directory prefix

import { describe, expect, it } from "vitest";

import { NOT_PAGES, OFF_SITE, REPO, editHref, isNotPage, pathOfSlug, slugOfFile, slugOfPath, sourceHref } from "./route.js";

describe("slugOfFile", () => {
  it.each([
    ["a top-level page", "introduction.md", "introduction"],
    ["a nested page", "reference/cli.md", "reference/cli"],
    ["the front page", "index.md", ""],
    ["a directory's front page", "getting-started/index.md", "getting-started"],
    ["a deeper directory's front page", "a/b/index.md", "a/b"],
    ["an .mdx page", "reference/glossary.mdx", "reference/glossary"],
    ["a Windows-style separator", "reference\\paths.md", "reference/paths"],
    ["a leading slash", "/reference/paths.md", "reference/paths"],
  ])("%s: %s", (_what, file, slug) => {
    expect(slugOfFile(file)).toBe(slug);
  });

  it("only strips a whole `index` segment", () => {
    // The trailing-index rule is anchored to a path boundary on purpose. Without
    // the `(^|\/)`, a page called `reindex.md` would have slugged to `re` — a URL
    // that renders as a 404 and looks like a routing bug rather than a regex one.
    expect(slugOfFile("guides/reindex.md")).toBe("guides/reindex");
    expect(slugOfFile("guides/index-of-things.md")).toBe("guides/index-of-things");
  });
});

describe("pathOfSlug", () => {
  it("serves the front page at the root", () => {
    expect(pathOfSlug("")).toBe("/");
  });

  it("gives every other page a directory URL", () => {
    expect(pathOfSlug("introduction")).toBe("/introduction/");
    expect(pathOfSlug("getting-started/install")).toBe("/getting-started/install/");
  });

  it("always ends in a slash", () => {
    // The trailing slash is the URL shape the Starlight site served, and it is
    // what is in people's history and in whatever has already linked here.
    for (const slug of ["", "introduction", "reference/cli"]) {
      expect(pathOfSlug(slug).endsWith("/")).toBe(true);
    }
  });
});

describe("slugOfPath", () => {
  it.each([
    ["the root", "/", ""],
    ["an empty path", "", ""],
    ["a directory URL", "/reference/cli/", "reference/cli"],
    ["no trailing slash", "/reference/cli", "reference/cli"],
    ["a doubled trailing slash", "/reference/cli//", "reference/cli"],
    ["a doubled leading slash", "//reference/cli/", "reference/cli"],
    ["a query", "/reference/cli/?q=up", "reference/cli"],
    ["a hash", "/reference/cli/#sandboxr-up", "reference/cli"],
    ["a query and a hash", "/reference/cli?q=up#sandboxr-up", "reference/cli"],
  ])("%s: %s", (_what, pathname, slug) => {
    expect(slugOfPath(pathname)).toBe(slug);
  });

  it("round-trips with pathOfSlug", () => {
    for (const slug of ["", "introduction", "getting-started/install", "architecture/plan-json"]) {
      expect(slugOfPath(pathOfSlug(slug))).toBe(slug);
    }
  });
});

describe("the two GitHub links", () => {
  it("points the edit link at the file under docs/", () => {
    expect(editHref("reference/cli.md")).toBe(`${REPO}/edit/main/docs/reference/cli.md`);
  });

  it("points the source link at the same file", () => {
    expect(sourceHref("reference/cli.md")).toBe(`${REPO}/blob/main/docs/reference/cli.md`);
  });

  it("uses the file path and not the slug", () => {
    // Both links are built from `file` rather than `slug` because a directory's
    // front page has a slug with no `index.md` in it, and an edit link to
    // `docs/getting-started` is a link to a directory.
    expect(editHref("getting-started/index.md")).toContain("getting-started/index.md");
  });
});

describe("the pages that are not pages", () => {
  it("excludes contracts.md, every README and all of Jef's half", () => {
    expect(NOT_PAGES).toContain("architecture/contracts.md");
    expect(NOT_PAGES).toContain("**/README.md");
    expect(NOT_PAGES).toContain("jef/**");
  });

  it("matches all three shapes and nothing beside them", () => {
    // The matcher is shared by the content loader and by nav.test.ts, which is
    // what keeps "a page under docs/ the sidebar does not name is a bug" true.
    expect(isNotPage("architecture/contracts.md")).toBe(true);
    expect(isNotPage("README.md")).toBe(true);
    expect(isNotPage("guides/README.md")).toBe(true);
    expect(isNotPage("jef/contracts.md")).toBe(true);
    expect(isNotPage("jef/guides/dashboard.md")).toBe(true);

    expect(isNotPage("architecture/state.md")).toBe(false);
    expect(isNotPage("guides/lifecycle.md")).toBe(false);
    // A prefix pattern is a directory, not a string prefix: `jefferson.md` is a
    // page, and a matcher written with startsWith and no slash would eat it.
    expect(isNotPage("jefferson.md")).toBe(false);
  });

  it("sends contracts.md off site rather than nowhere", () => {
    // It is excluded from the site *and* linked to from it, so the exclusion and
    // the redirect have to name the same file. A link to a page the walk skipped
    // and the redirect does not know about is a 404 inside the site.
    expect(OFF_SITE["architecture/contracts.md"]).toBe(`${REPO}/blob/main/docs/architecture/contracts.md`);
  });
});
