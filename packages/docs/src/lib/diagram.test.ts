// What this covers:
//  - diagramThemeVariables asking only for tokens that DIAGRAM_TOKENS declares,
//    so a typo cannot silently hand mermaid an `undefined`
//  - every colour in the map coming from a token: no hex, no named colour, no
//    second copy of the palette in this package
//  - the font coming from `--font-sans`, which is the whole complaint the map
//    exists to answer
//  - the design intent that is worth failing a build over: nodes are surfaces,
//    the brand hue is confined to the things that group or annotate, and no text
//    variable is set in one of the muted greys that lose AA on a tint
//  - darkMode reaching mermaid, since it picks the direction of every value
//    mermaid derives rather than being told

import { describe, expect, it } from "vitest";

import { DIAGRAM_TOKENS, diagramThemeVariables, type DiagramToken } from "./diagram.js";

/** A lookup that answers with the token's own name, so the map is inspectable. */
const echo = (token: DiagramToken): string => token;

const asked = (): DiagramToken[] => {
  const seen: DiagramToken[] = [];
  diagramThemeVariables((token) => {
    seen.push(token);
    return token;
  }, false);
  return seen;
};

/** The map, with each value being the name of the token it was built from. */
const named = (dark = false): Record<string, string | boolean> =>
  diagramThemeVariables(echo, dark);

describe("DIAGRAM_TOKENS", () => {
  it("lists each token once", () => {
    expect(new Set(DIAGRAM_TOKENS).size).toBe(DIAGRAM_TOKENS.length);
  });

  it("declares every token the map asks for", () => {
    // The type system catches this while both files are being edited together.
    // The test catches it when a token is dropped from the list months later,
    // which is the case where `resolveTokens` would answer `undefined` and
    // mermaid would fall back to its own palette for that one variable.
    for (const token of asked()) {
      expect(DIAGRAM_TOKENS).toContain(token);
    }
  });

  it("has nothing in it the map never asks for", () => {
    const wanted = new Set(asked());
    for (const token of DIAGRAM_TOKENS) {
      expect(wanted.has(token)).toBe(true);
    }
  });
});

describe("diagramThemeVariables", () => {
  it("takes every colour from a token and never from a literal", () => {
    // This is the rule `tokens.css` exists to enforce: one palette, in one
    // place. A hex here would be a second copy that nothing would notice going
    // stale — and it would follow neither the theme nor the three schemes.
    for (const [name, value] of Object.entries(named())) {
      if (typeof value !== "string") continue;
      if (name === "fontSize") continue;
      expect(value, name).toMatch(/^--(sb-|font-)/);
    }
  });

  it("draws its font from --font-sans", () => {
    expect(named().fontFamily).toBe("--font-sans");
  });

  it("passes darkMode through, because mermaid derives from it", () => {
    expect(named(true).darkMode).toBe(true);
    expect(named(false).darkMode).toBe(false);
  });

  it("fills a node with a surface rather than a colour", () => {
    const map = named();
    expect(map.mainBkg).toBe("--sb-surface");
    expect(map.nodeBkg).toBe("--sb-surface");
    expect(map.actorBkg).toBe("--sb-surface");
    expect(map.nodeBorder).toBe("--sb-line-strong");
  });

  it("keeps the brand hue to the things that group or annotate", () => {
    const map = named();
    const branded = Object.entries(map)
      .filter(([, value]) => typeof value === "string" && value.startsWith("--sb-brand"))
      .map(([name]) => name)
      .sort();
    // A flowchart's subgraph, a sequence diagram's loop tab and its activation
    // bar. If a node fill or an edge colour ever joins this list, the diagram has
    // become uniformly brand-coloured, which reads as no brand at all.
    expect(branded).toEqual([
      "activationBkgColor",
      "activationBorderColor",
      "clusterBkg",
      "clusterBorder",
      "labelBoxBkgColor",
      "labelBoxBorderColor",
      "titleColor",
    ]);
  });

  it("never sets a text colour in one of the muted greys", () => {
    // `tokens.css` records that `ink-subtle` and `ink-muted` lose AA on a tinted
    // `-soft` background, and mermaid offers no separate variable for a label
    // that lands on a tint — so a label here could be on `--sb-brand-soft` or
    // `--sb-warn-soft`. `ink-subtle` is allowed on the *lines*, where the bar is
    // 3:1 for a meaningful graphic rather than 4.5:1 for text.
    const map = named();
    const textish = Object.entries(map).filter(([name]) => /Text|titleColor/.test(name));
    expect(textish.length).toBeGreaterThan(5);
    for (const [name, value] of textish) {
      expect(value, name).not.toBe("--sb-ink-muted");
      expect(value, name).not.toBe("--sb-ink-subtle");
    }
  });

  it("gives a sequence number the surface colour, not ink", () => {
    // The digit is drawn on a disc filled with `signalColor`, not on the page.
    expect(named().signalColor).toBe("--sb-ink-subtle");
    expect(named().sequenceNumberColor).toBe("--sb-surface");
  });
});
