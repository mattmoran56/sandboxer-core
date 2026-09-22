// Tests for the `sandboxer:` version constraint grammar:
// - parseVersion: full, partial and v-prefixed versions, prereleases, build metadata, rubbish
// - compareVersions: each field, prerelease ordering, equality, antisymmetry
// - satisfies: every comparator, caret and tilde bounds including the 0.x rule, conjunctions, alternatives, wildcards
// - satisfies: the constraint both examples ship (">=0.1.0") against this tool's own version

import { describe, expect, it } from "vitest";

import { VersionError, compareVersions, parseVersion, satisfies } from "./version.js";

describe("parseVersion", () => {
  it.each([
    ["1.2.3", { major: 1, minor: 2, patch: 3, prerelease: "" }],
    ["v1.2.3", { major: 1, minor: 2, patch: 3, prerelease: "" }],
    ["1.2", { major: 1, minor: 2, patch: 0, prerelease: "" }],
    ["1", { major: 1, minor: 0, patch: 0, prerelease: "" }],
    ["0.1.0", { major: 0, minor: 1, patch: 0, prerelease: "" }],
    ["1.2.3-rc.1", { major: 1, minor: 2, patch: 3, prerelease: "rc.1" }],
    ["1.2.3+build9", { major: 1, minor: 2, patch: 3, prerelease: "" }],
    ["  1.2.3  ", { major: 1, minor: 2, patch: 3, prerelease: "" }],
  ])("parses %s", (input, want) => {
    expect(parseVersion(input)).toEqual(want);
  });

  it.each(["", "next", "1.x", "1.2.3.4", ">=1.0.0"])("rejects %s", (input) => {
    expect(() => parseVersion(input)).toThrow(VersionError);
  });
});

describe("compareVersions", () => {
  const v = parseVersion;

  it.each([
    ["major", "2.0.0", "1.9.9", 1],
    ["minor", "1.2.0", "1.1.9", 1],
    ["patch", "1.1.2", "1.1.1", 1],
    ["equality", "1.1.1", "1.1.1", 0],
    ["a release beats its prerelease", "1.0.0", "1.0.0-rc.1", 1],
    ["prereleases sort among themselves", "1.0.0-rc.1", "1.0.0-rc.2", -1],
  ])("orders by %s", (_name, a, b, want) => {
    expect(compareVersions(v(a), v(b))).toBe(want);
  });

  it("is antisymmetric", () => {
    expect(compareVersions(v("1.0.0"), v("2.0.0"))).toBe(-compareVersions(v("2.0.0"), v("1.0.0")));
  });
});

describe("satisfies", () => {
  const cases: Array<[constraint: string, version: string, want: boolean]> = [
    [">=0.1.0", "0.1.0", true],
    [">=0.1.0", "0.2.0", true],
    [">=0.1.0", "0.0.9", false],
    [">0.1.0", "0.1.0", false],
    ["<=1.0.0", "1.0.0", true],
    ["<1.0.0", "1.0.0", false],
    ["=1.2.3", "1.2.3", true],
    ["=1.2.3", "1.2.4", false],
    ["1.2.3", "1.2.3", true],
    ["1.2.3", "1.2.4", false],
    // ^0.x treats the minor as the breaking digit, which is what a pre-1.0
    // tool needs: 0.2 is allowed to break 0.1.
    ["^0.1.0", "0.1.9", true],
    ["^0.1.0", "0.2.0", false],
    ["^1.2.0", "1.9.9", true],
    ["^1.2.0", "2.0.0", false],
    ["^1.2.0", "1.1.0", false],
    ["~1.2.0", "1.2.9", true],
    ["~1.2.0", "1.3.0", false],
    [">=0.1.0 <1.0.0", "0.5.0", true],
    [">=0.1.0 <1.0.0", "1.0.0", false],
    [">=0.1.0, <1.0.0", "0.5.0", true],
    ["<0.1.0 || >=2.0.0", "2.1.0", true],
    ["<0.1.0 || >=2.0.0", "1.0.0", false],
    ["*", "9.9.9", true],
    ["", "9.9.9", true],
    [">=0.1.0", "1.0.0-rc.1", true],
    [">=1.0.0", "1.0.0-rc.1", false],
  ];

  it.each(cases)("%s is %s for %s", (constraint, version, want) => {
    expect(satisfies(version, constraint)).toBe(want);
  });

  it("rejects a constraint it cannot parse rather than accepting everything", () => {
    expect(() => satisfies("0.1.0", ">=banana")).toThrow(VersionError);
  });
});
