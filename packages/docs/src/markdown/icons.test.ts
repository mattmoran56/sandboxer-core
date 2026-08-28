// What this covers:
//  - every icon is one well-formed, self-closed <svg> element
//  - all five alert kinds and all four detail kinds have one
//  - the packages/web idiom: a 24-unit box, currentColor strokes, aria-hidden
//  - the class each icon carries is the one the stylesheet and the tests expect
//  - nothing is a paint fill or a hard-coded colour, so an icon follows its text

import { describe, expect, it } from "vitest";
import { ALERT_ICONS, CHEVRON_ICON, COPY_ICON, DETAIL_ICONS, PROMPT_ICON } from "./icons.js";

const all: Record<string, string> = {
  ...Object.fromEntries(Object.entries(ALERT_ICONS).map(([kind, icon]) => [`alert:${kind}`, icon])),
  ...Object.fromEntries(Object.entries(DETAIL_ICONS).map(([kind, icon]) => [`detail:${kind}`, icon])),
  chevron: CHEVRON_ICON,
  copy: COPY_ICON,
  prompt: PROMPT_ICON,
};

describe("the icon set", () => {
  it("has one for each of the five alert kinds", () => {
    expect(Object.keys(ALERT_ICONS).sort()).toEqual(["caution", "important", "note", "tip", "warning"]);
  });

  it("has one for each of the four detail kinds", () => {
    expect(Object.keys(DETAIL_ICONS).sort()).toEqual(["agent", "facts", "failure", "why"]);
  });

  for (const [name, icon] of Object.entries(all)) {
    describe(name, () => {
      it("is one closed svg element", () => {
        expect(icon).toMatch(/^<svg /);
        expect(icon.endsWith("</svg>")).toBe(true);
        expect(icon.match(/<svg /g)).toHaveLength(1);
      });

      it("draws in the 24-unit box, in currentColor, and is decorative", () => {
        expect(icon).toContain('viewBox="0 0 24 24"');
        expect(icon).toContain('stroke="currentColor"');
        expect(icon).toContain('fill="none"');
        expect(icon).toContain('aria-hidden="true"');
      });

      it("names no colour of its own", () => {
        expect(icon).not.toMatch(/#[0-9a-f]{3,8}\b/i);
        expect(icon).not.toContain("rgb(");
      });

      it("has a shape in it", () => {
        expect(icon).toMatch(/<(path|circle|rect|line|polyline|polygon) /);
      });

      it("uses HTML attribute spelling and not React's", () => {
        // These strings never pass through React, so `strokeWidth` would be
        // dropped by the parser and the icon would be drawn hairline-thin.
        expect(icon).not.toMatch(/strokeWidth|strokeLinecap|viewbox=/);
        expect(icon).toContain('stroke-width="1.75"');
      });
    });
  }

  it("carries the class each consumer looks for", () => {
    for (const icon of Object.values(ALERT_ICONS)) expect(icon).toContain('class="sbx-alert__icon"');
    for (const icon of Object.values(DETAIL_ICONS)) expect(icon).toContain('class="sbx-detail__icon"');
    expect(CHEVRON_ICON).toContain('class="sbx-detail__chevron"');
    expect(COPY_ICON).toContain('class="sbx-copy__icon"');
    expect(PROMPT_ICON).toContain('class="sbx-prompt__icon"');
  });
});
