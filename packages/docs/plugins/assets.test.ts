// What this covers:
//  - assetFileOf maps a request under /assets/ to the file it names under docs/
//  - a query string and a percent-escape are handled
//  - everything it must refuse: a path outside /assets/, a `..` climb (escaped or
//    not), a directory, a NUL, and a malformed escape
//  - the two committed brand files really are where the page and the plugin agree
//    they are

import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { assetFileOf } from "./assets.js";

describe("assetFileOf", () => {
  it("maps a request to the file it names under docs/", () => {
    expect(assetFileOf("/assets/brand/mark.svg")).toBe("assets/brand/mark.svg");
  });

  it("ignores a query string and a hash", () => {
    expect(assetFileOf("/assets/brand/mark.svg?v=2")).toBe("assets/brand/mark.svg");
    expect(assetFileOf("/assets/brand/mark.svg#top")).toBe("assets/brand/mark.svg");
  });

  it("decodes a percent-escape", () => {
    expect(assetFileOf("/assets/brand/a%20mark.svg")).toBe("assets/brand/a mark.svg");
  });

  it("refuses anything that is not under /assets/", () => {
    expect(assetFileOf("/reference/cli/")).toBeNull();
    expect(assetFileOf("/assets")).toBeNull();
    expect(assetFileOf("/index.html")).toBeNull();
  });

  it("refuses a climb, escaped or not", () => {
    // The dev server runs on a machine with the whole repository on it, so this
    // is the assertion the middleware exists to be able to make.
    expect(assetFileOf("/assets/../../../etc/passwd")).toBeNull();
    expect(assetFileOf("/assets/..%2f..%2fetc/passwd")).toBeNull();
    expect(assetFileOf("/assets/brand/../../secret")).toBeNull();
  });

  it("refuses a directory, a NUL and a malformed escape", () => {
    expect(assetFileOf("/assets/brand/")).toBeNull();
    expect(assetFileOf("/assets/brand/mark.svg%00.txt")).toBeNull();
    expect(assetFileOf("/assets/%zz")).toBeNull();
  });
});

describe("the committed brand artwork", () => {
  const DOCS = fileURLToPath(new URL("../../../docs/", import.meta.url));

  // docs/brand.md embeds both of these with relative paths, and the rewrite turns
  // each into the site path this test resolves back to a file. A missing file is a
  // broken image on GitHub and a 404 on the site, and neither build fails on one.
  it.each(["/assets/brand/mark.svg", "/assets/brand/lockup.svg"])("%s exists", (url) => {
    const file = assetFileOf(url);
    expect(file).not.toBeNull();
    expect(existsSync(path.join(DOCS, file!))).toBe(true);
  });
});
