// What this covers:
//  - assetFileOf maps a request under /assets/ to the file it names under docs/
//  - a query string and a percent-escape are handled
//  - everything it must refuse: a path outside /assets/, a `..` climb (escaped or
//    not), a directory, a NUL, and a malformed escape

import { describe, expect, it } from "vitest";

import { assetFileOf } from "./assets.js";

describe("assetFileOf", () => {
  it("maps a request to the file it names under docs/", () => {
    expect(assetFileOf("/assets/guides/diagram.svg")).toBe("assets/guides/diagram.svg");
  });

  it("ignores a query string and a hash", () => {
    expect(assetFileOf("/assets/guides/diagram.svg?v=2")).toBe("assets/guides/diagram.svg");
    expect(assetFileOf("/assets/guides/diagram.svg#top")).toBe("assets/guides/diagram.svg");
  });

  it("decodes a percent-escape", () => {
    expect(assetFileOf("/assets/guides/a%20diagram.svg")).toBe("assets/guides/a diagram.svg");
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
    expect(assetFileOf("/assets/guides/../../secret")).toBeNull();
  });

  it("refuses a directory, a NUL and a malformed escape", () => {
    expect(assetFileOf("/assets/guides/")).toBeNull();
    expect(assetFileOf("/assets/guides/diagram.svg%00.txt")).toBeNull();
    expect(assetFileOf("/assets/%zz")).toBeNull();
  });
});
