import { describe, expect, it } from "vitest";

import { Output, type Writer } from "./output.js";

function recorder(isTTY = false): Writer & { stdout: string; stderr: string } {
  const sink = {
    stdout: "",
    stderr: "",
    isTTY,
    out: (text: string) => {
      sink.stdout += text;
    },
    err: (text: string) => {
      sink.stderr += text;
    },
  };
  return sink;
}

describe("Output", () => {
  // The whole point of the split: `--json | jq` works while a person still sees
  // the progress, and an agent reads stdout without stripping decoration out.
  it.each([
    ["line", (out: Output) => out.line("hello")],
    ["prompt", (out: Output) => out.prompt("hello")],
    ["step", (out: Output) => out.step("hello")],
    ["ok", (out: Output) => out.ok("hello")],
    ["warn", (out: Output) => out.warn("hello")],
    ["error", (out: Output) => out.error("hello")],
    ["dim", (out: Output) => out.dim("hello")],
    ["bold", (out: Output) => out.bold("hello")],
    ["table", (out: Output) => out.table(["H"], [["hello"]])],
  ])("%s writes to stderr and never stdout", (_name, write) => {
    const sink = recorder();
    write(new Output(sink));
    expect(sink.stdout).toBe("");
    expect(sink.stderr).toContain("hello");
  });

  // A prompt has to leave the cursor where the answer is typed, so it is the one
  // thing here that does not end its own line.
  it("prompt writes exactly what it was given, with no newline", () => {
    const sink = recorder();
    new Output(sink).prompt("value for KEY: ");
    expect(sink.stderr).toBe("value for KEY: ");
  });

  it("data writes JSON to stdout and nothing to stderr", () => {
    const sink = recorder();
    new Output(sink).data({ slug: "feat-1" });
    expect(sink.stderr).toBe("");
    expect(JSON.parse(sink.stdout)).toEqual({ slug: "feat-1" });
  });

  it("ends the JSON with a newline, so it is a line a pipe can read", () => {
    const sink = recorder();
    new Output(sink).data([1, 2]);
    expect(sink.stdout.endsWith("\n")).toBe(true);
  });

  it("line with no argument writes a blank line", () => {
    const sink = recorder();
    new Output(sink).line();
    expect(sink.stderr).toBe("\n");
  });

  it("adds no colour when stderr is not a terminal", () => {
    const sink = recorder(false);
    const out = new Output(sink);
    out.ok("done");
    out.error("broken");
    expect(sink.stderr).not.toContain("[");
  });

  it("adds colour when stderr is a terminal", () => {
    const sink = recorder(true);
    new Output(sink).ok("done");
    expect(sink.stderr).toContain("[32m");
    expect(sink.stderr).toContain("[0m");
  });

  it("reports the json flag it was constructed with", () => {
    expect(new Output(recorder(), true).json).toBe(true);
    expect(new Output(recorder()).json).toBe(false);
  });
});

describe("Output.table", () => {
  it("pads every column to its widest cell", () => {
    const sink = recorder();
    new Output(sink).table(
      ["PROJECT", "SLUG"],
      [
        ["acme", "feat-1"],
        ["acme", "a-much-longer-slug"],
      ],
    );
    const [header, first] = sink.stderr.split("\n");
    expect(header).toBe("PROJECT  SLUG");
    expect(first).toBe("acme     feat-1");
  });

  it("trims the trailing padding off every row", () => {
    const sink = recorder();
    new Output(sink).table(["A", "B"], [["x", ""]]);
    for (const row of sink.stderr.split("\n")) expect(row).toBe(row.trimEnd());
  });

  it("renders a header with no rows", () => {
    const sink = recorder();
    new Output(sink).table(["PROJECT"], []);
    expect(sink.stderr).toBe("PROJECT\n");
  });

  it("tolerates a row shorter than the header", () => {
    const sink = recorder();
    new Output(sink).table(["A", "B"], [["x"]]);
    expect(sink.stderr).toBe("A  B\nx\n");
  });
});
