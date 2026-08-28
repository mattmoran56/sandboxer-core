// What this covers:
//  - the two required keys and the optional boolean
//  - a missing block, a missing key and a non-boolean tableOfContents are reported, not thrown
//  - YAML's trailing-comment rule: stripped from an unquoted value, kept inside a quoted one
//  - the body is everything after the closing fence, with the fence's newline consumed
//  - CRLF line endings and a leading byte-order mark
//  - a `---` that is not the first thing in the file is not frontmatter

import { describe, expect, it } from "vitest";
import { parseFrontmatter } from "./frontmatter.js";

const page = (frontmatter: string, body = "# Body\n") => `---\n${frontmatter}\n---\n${body}`;

describe("parseFrontmatter", () => {
  it("reads the two required keys and defaults the contents column on", () => {
    const parsed = parseFrontmatter(page("title: Your first sandbox\ndescription: One sentence."));
    expect(parsed.frontmatter).toEqual({
      title: "Your first sandbox",
      description: "One sentence.",
      tableOfContents: true,
    });
    expect(parsed.problems).toEqual([]);
    expect(parsed.body).toBe("# Body\n");
  });

  it("reads tableOfContents: false, comment and all", () => {
    const parsed = parseFrontmatter(page("title: T\ndescription: D.\ntableOfContents: false   # optional"));
    expect(parsed.frontmatter.tableOfContents).toBe(false);
    expect(parsed.problems).toEqual([]);
  });

  it("reports a file with no frontmatter and hands back the whole text as the body", () => {
    const parsed = parseFrontmatter("# Just a heading\n");
    expect(parsed.problems).toEqual(["no frontmatter block: the file must open with a --- fence"]);
    expect(parsed.body).toBe("# Just a heading\n");
    expect(parsed.frontmatter.title).toBe("");
  });

  it("reports each missing key separately", () => {
    expect(parseFrontmatter(page("title: T")).problems).toEqual(["frontmatter has no description"]);
    expect(parseFrontmatter(page("description: D.")).problems).toEqual(["frontmatter has no title"]);
    expect(parseFrontmatter(page("other: x")).problems).toHaveLength(2);
  });

  it("reports a tableOfContents that is not a boolean, and keeps the default", () => {
    const parsed = parseFrontmatter(page("title: T\ndescription: D.\ntableOfContents: maybe"));
    expect(parsed.problems).toEqual(['tableOfContents must be true or false, not "maybe"']);
    expect(parsed.frontmatter.tableOfContents).toBe(true);
  });

  it("keeps a # that is inside a quoted value", () => {
    const parsed = parseFrontmatter(page('title: T\ndescription: "Ports, like 8080 # not a comment."'));
    expect(parsed.frontmatter.description).toBe("Ports, like 8080 # not a comment.");
  });

  it("strips a trailing comment from an unquoted value", () => {
    const parsed = parseFrontmatter(page("title: T # the sidebar label\ndescription: D."));
    expect(parsed.frontmatter.title).toBe("T");
  });

  it("ignores unknown keys and comment lines", () => {
    const parsed = parseFrontmatter(page("# a comment\ntitle: T\nsidebar: x\ndescription: D."));
    expect(parsed.problems).toEqual([]);
    expect(parsed.frontmatter.title).toBe("T");
  });

  it("survives CRLF line endings", () => {
    const parsed = parseFrontmatter("---\r\ntitle: T\r\ndescription: D.\r\n---\r\nBody\r\n");
    expect(parsed.frontmatter.title).toBe("T");
    expect(parsed.body).toBe("Body\r\n");
  });

  it("survives a leading byte-order mark", () => {
    const parsed = parseFrontmatter(`﻿${page("title: T\ndescription: D.")}`);
    expect(parsed.problems).toEqual([]);
  });

  it("does not treat a --- further down the file as frontmatter", () => {
    const parsed = parseFrontmatter("Intro\n\n---\ntitle: T\n---\n");
    expect(parsed.problems).toHaveLength(1);
    expect(parsed.body).toBe("Intro\n\n---\ntitle: T\n---\n");
  });
});
