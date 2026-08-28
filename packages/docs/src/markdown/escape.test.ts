// What this covers:
//  - escapeText handles &, < and > and leaves quotes as literal characters
//  - escapeAttribute additionally handles the double quote that would end the attribute
//  - the ampersand is escaped first, so an escape is never double-escaped

import { describe, expect, it } from "vitest";
import { escapeAttribute, escapeText } from "./escape.js";

describe("escapeText", () => {
  it("escapes the three characters a text node cares about", () => {
    expect(escapeText('a < b & c > d')).toBe("a &lt; b &amp; c &gt; d");
  });

  it("leaves quotes alone, because a copied prompt must not gain &quot;", () => {
    expect(escapeText(`he said "no" and 'no'`)).toBe(`he said "no" and 'no'`);
  });

  it("does not double-escape an existing entity", () => {
    expect(escapeText("&amp;")).toBe("&amp;amp;");
  });
});

describe("escapeAttribute", () => {
  it("escapes the double quote that would close the attribute", () => {
    expect(escapeAttribute('say "hi" & <go>')).toBe("say &quot;hi&quot; &amp; &lt;go&gt;");
  });
});
