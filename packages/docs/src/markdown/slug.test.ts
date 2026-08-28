// What this covers:
//  - slugify: lowercasing, punctuation collapsing, edge trimming, accents kept
//  - createSlugger: the -2/-3 collision suffix, and that it is per-page state
//  - a heading of nothing but punctuation gets a usable id rather than ""
//  - a punctuation-only heading colliding with another one still numbers

import { describe, expect, it } from "vitest";
import { createSlugger, slugify } from "./slug.js";

describe("slugify", () => {
  it("lowercases and hyphenates", () => {
    expect(slugify("What happens first")).toBe("what-happens-first");
  });

  it("collapses a run of punctuation to one hyphen and trims the edges", () => {
    expect(slugify("  `sandboxr up` — the flags!  ")).toBe("sandboxr-up-the-flags");
  });

  it("keeps accented letters, as GitHub does", () => {
    expect(slugify("Café résumé")).toBe("café-résumé");
  });

  it("keeps digits", () => {
    expect(slugify("Step 2: plan.json")).toBe("step-2-plan-json");
  });

  it("returns the empty string for text with no letters or digits", () => {
    expect(slugify("?!—…")).toBe("");
  });
});

describe("createSlugger", () => {
  it("numbers a collision from 2", () => {
    const slug = createSlugger();
    expect(slug("Setup")).toBe("setup");
    expect(slug("Setup")).toBe("setup-2");
    expect(slug("Setup")).toBe("setup-3");
  });

  it("treats two headings that slugify the same as a collision", () => {
    const slug = createSlugger();
    expect(slug("The plan")).toBe("the-plan");
    expect(slug("The  plan!")).toBe("the-plan-2");
  });

  it("gives a punctuation-only heading a linkable id", () => {
    const slug = createSlugger();
    expect(slug("?!")).toBe("section");
    expect(slug("———")).toBe("section-2");
  });

  it("is per-page state, so a fresh slugger starts over", () => {
    const first = createSlugger();
    first("Setup");
    expect(createSlugger()("Setup")).toBe("setup");
  });
});
