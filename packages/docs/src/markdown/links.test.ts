// What this covers:
//  - a sibling link, a ../ link and a link to a directory's index.md
//  - an #anchor kept across the rewrite
//  - architecture/contracts.md, the off-site escape, with and without an anchor
//  - what must be left alone: https://, /absolute, #anchor-only, mailto:, a .png,
//    and a ../ chain that climbs out of docs/
//  - which links are reported as leaving the site

import { describe, expect, it } from "vitest";
import { resolveDocHref } from "./links.js";

describe("resolveDocHref", () => {
  it("rewrites a sibling link", () => {
    expect(resolveDocHref("first-sandbox.md", "getting-started/install.md")).toEqual({
      href: "/getting-started/first-sandbox/",
      external: false,
    });
  });

  it("rewrites a ../ link", () => {
    expect(resolveDocHref("../reference/cli.md", "getting-started/install.md").href).toBe("/reference/cli/");
  });

  it("rewrites a ./ link", () => {
    expect(resolveDocHref("./install.md", "getting-started/index.md").href).toBe("/getting-started/install/");
  });

  it("rewrites a link to a directory's index.md to the directory", () => {
    expect(resolveDocHref("../reference/index.md", "guides/lifecycle.md").href).toBe("/reference/");
  });

  it("rewrites a link to the front page to the root", () => {
    expect(resolveDocHref("../index.md", "guides/lifecycle.md").href).toBe("/");
  });

  it("keeps an anchor", () => {
    expect(resolveDocHref("../reference/cli.md#sandboxr-up", "guides/lifecycle.md").href).toBe(
      "/reference/cli/#sandboxr-up",
    );
  });

  it("sends a link to the contract off the site", () => {
    const resolved = resolveDocHref("../architecture/contracts.md", "guides/lifecycle.md");
    expect(resolved.href).toBe(
      "https://github.com/mattmoran56/sandboxr/blob/main/docs/architecture/contracts.md",
    );
    expect(resolved.external).toBe(true);
  });

  it("keeps the anchor on an off-site link", () => {
    expect(resolveDocHref("architecture/contracts.md#8-actions", "index.md").href).toBe(
      "https://github.com/mattmoran56/sandboxr/blob/main/docs/architecture/contracts.md#8-actions",
    );
  });

  it("leaves an external URL alone but marks it as leaving the site", () => {
    expect(resolveDocHref("https://docs.docker.com/", "index.md")).toEqual({
      href: "https://docs.docker.com/",
      external: true,
    });
  });

  it("leaves an absolute site path alone", () => {
    expect(resolveDocHref("/reference/cli/", "index.md")).toEqual({
      href: "/reference/cli/",
      external: false,
    });
  });

  it("leaves a bare anchor alone", () => {
    expect(resolveDocHref("#what-happens-first", "guides/lifecycle.md")).toEqual({
      href: "#what-happens-first",
      external: false,
    });
  });

  it("leaves mailto: alone and does not send it to a new tab", () => {
    expect(resolveDocHref("mailto:hi@example.com", "index.md")).toEqual({
      href: "mailto:hi@example.com",
      external: false,
    });
  });

  it("leaves a link to something that is not a Markdown file alone", () => {
    expect(resolveDocHref("../assets/diagram.png", "guides/lifecycle.md").href).toBe("../assets/diagram.png");
  });

  it("leaves a ../ chain that climbs out of docs/ alone", () => {
    expect(resolveDocHref("../../CONTRIBUTING.md", "guides/lifecycle.md").href).toBe("../../CONTRIBUTING.md");
  });

  it("folds a backslash written on Windows into a path separator", () => {
    expect(resolveDocHref("cli.md", "reference\\index.md").href).toBe("/reference/cli/");
  });

  it("handles .mdx as well as .md", () => {
    expect(resolveDocHref("../reference/cli.mdx", "guides/lifecycle.md").href).toBe("/reference/cli/");
  });
});
