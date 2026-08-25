import { describe, expect, it } from "vitest";

import { flagBoolean, flagList, flagNumber, flagString, parseArgs } from "./args.js";

describe("parseArgs", () => {
  it("takes the first positional word as the command", () => {
    const args = parseArgs(["up", "feat-1"]);
    expect(args.command).toBe("up");
    expect(args.positional).toEqual(["feat-1"]);
  });

  it("is empty for no arguments at all", () => {
    expect(parseArgs([])).toEqual({ command: "", positional: [], flags: {}, rest: [] });
  });

  it.each([
    ["a value flag taking the next word", ["up", "--slug", "a"], { slug: "a" }],
    ["a value flag written with =", ["up", "--slug=a"], { slug: "a" }],
    ["a bare flag", ["up", "--detach"], { detach: true }],
    ["an unknown long flag with a following word", ["up", "--detach", "x"], { detach: true }],
    ["--no- turning a flag off", ["up", "--no-detach"], { detach: false }],
    ["=false on a value flag", ["up", "--slug=false"], { slug: "false" }],
    ["clustered short flags", ["logs", "-fq"], { f: true, q: true }],
  ])("parses %s", (_name, argv, want) => {
    expect(parseArgs(argv).flags).toEqual(want);
  });

  it("does not consume the next word when it looks like a flag", () => {
    const args = parseArgs(["up", "--slug", "--detach"]);
    expect(args.flags).toEqual({ slug: true, detach: true });
  });

  it("keeps a word after an unknown flag as positional", () => {
    const args = parseArgs(["up", "--detach", "feat-1"]);
    expect(args.positional).toEqual(["feat-1"]);
  });

  // Everything after a bare `--` belongs to whatever the command shells out to.
  it("passes everything after -- through untouched", () => {
    const args = parseArgs(["shell", "--", "bash", "-lc", "--slug=no"]);
    expect(args.rest).toEqual(["bash", "-lc", "--slug=no"]);
    expect(args.flags).toEqual({});
  });

  it("stops interpreting at the first bare --", () => {
    const args = parseArgs(["db", "shell", "--", "--", "-x"]);
    expect(args.rest).toEqual(["--", "-x"]);
  });

  it("keeps the last value when a flag is repeated", () => {
    expect(parseArgs(["up", "--slug", "a", "--slug", "b"]).flags["slug"]).toBe("b");
  });

  it("treats a lone - as positional", () => {
    expect(parseArgs(["db", "-"]).positional).toEqual(["-"]);
  });
});

describe("flagString", () => {
  it.each([
    ["a string value", ["up", "--slug=a"], "a"],
    ["a bare flag", ["up", "--slug"], undefined],
    ["a flag that was not given", ["up"], undefined],
    ["an empty value", ["up", "--slug="], ""],
  ])("%s", (_name, argv, want) => {
    expect(flagString(parseArgs(argv), "slug")).toBe(want);
  });
});

describe("flagBoolean", () => {
  it.each([
    ["a bare flag", ["up", "--detach"], false, true],
    ["--no- form", ["up", "--no-detach"], true, false],
    ["missing, with the default", ["up"], true, true],
    ["missing, no default", ["up"], false, false],
    ["the string false", ["up", "--detach=false"], false, false],
    ["the string 0", ["up", "--detach=0"], false, false],
    ["any other string", ["up", "--detach=yes"], false, true],
  ])("%s", (_name, argv, fallback, want) => {
    expect(flagBoolean(parseArgs(argv), "detach", fallback)).toBe(want);
  });
});

describe("flagNumber", () => {
  it.each([
    ["an integer", ["logs", "--tail=50"], 50],
    ["zero", ["logs", "--tail=0"], 0],
    ["a negative number", ["logs", "--tail=-1"], -1],
    ["not a number", ["logs", "--tail=lots"], undefined],
    ["missing", ["logs"], undefined],
    ["an empty value", ["logs", "--tail="], undefined],
  ])("%s", (_name, argv, want) => {
    expect(flagNumber(parseArgs(argv), "tail")).toBe(want);
  });
});

describe("flagList", () => {
  it.each([
    ["a single name", ["up", "--with=cms"], ["cms"]],
    ["several names", ["up", "--with=cms,worker"], ["cms", "worker"]],
    ["surrounding spaces", ["up", "--with= cms , worker "], ["cms", "worker"]],
    ["empty entries", ["up", "--with=cms,,worker,"], ["cms", "worker"]],
    ["an empty value", ["up", "--with="], []],
    ["missing", ["up"], undefined],
  ])("%s", (_name, argv, want) => {
    expect(flagList(parseArgs(argv), "with")).toEqual(want);
  });
});
