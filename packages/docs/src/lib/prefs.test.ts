// What this covers:
//  - readPrefs on nothing, on rubbish, on valid JSON that is not an object
//  - readPrefs keeping the fields it recognises and defaulting the ones it does not
//  - the storage key and preference names `index.html`'s blocking script depends on
//  - resolveTheme, including the `system` case in both directions

import { describe, expect, it } from "vitest";

import { DEFAULTS, PREFS_KEY, readPrefs, resolveTheme, SCHEMES } from "./prefs.js";

describe("readPrefs", () => {
  it("gives the defaults for nothing stored", () => {
    expect(readPrefs(null)).toEqual(DEFAULTS);
    expect(readPrefs("")).toEqual(DEFAULTS);
  });

  it("gives the defaults rather than throwing on a string that is not JSON", () => {
    expect(readPrefs("{not json")).toEqual(DEFAULTS);
  });

  it("gives the defaults for JSON that is not an object", () => {
    expect(readPrefs("[1,2,3]")).toEqual(DEFAULTS);
    expect(readPrefs('"dark"')).toEqual(DEFAULTS);
    expect(readPrefs("null")).toEqual(DEFAULTS);
  });

  it("reads every field back", () => {
    expect(readPrefs('{"theme":"dark","scheme":"fern","expandAll":true}')).toEqual({
      theme: "dark",
      scheme: "fern",
      expandAll: true,
    });
  });

  it("defaults the fields it does not recognise and keeps the ones it does", () => {
    // A hand-edited value, a scheme that no longer exists, and a boolean stored as
    // the string a form would have submitted.
    expect(readPrefs('{"theme":"sepia","scheme":"tide","expandAll":"yes"}')).toEqual({
      theme: DEFAULTS.theme,
      scheme: "tide",
      expandAll: DEFAULTS.expandAll,
    });
  });

  it("ignores anything else in the object", () => {
    // The dashboard's own preferences, in case both apps ever share an origin.
    expect(readPrefs('{"theme":"light","grouping":"status","collapsed":["acme"]}')).toEqual({
      theme: "light",
      scheme: DEFAULTS.scheme,
      expandAll: DEFAULTS.expandAll,
    });
  });
});

describe("the contract with index.html", () => {
  // The blocking script in `index.html` is hand-written and cannot import this
  // module, so it names the key and the fields as literals. Renaming either here
  // would leave the script reading a key nothing writes — with no error, just a
  // flash of the wrong theme on every load.
  it("keeps the key and the three names the blocking script reads", () => {
    expect(PREFS_KEY).toBe("sandboxr.docs.prefs.v1");
    expect(Object.keys(DEFAULTS).sort()).toEqual(["expandAll", "scheme", "theme"]);
  });

  it("offers the three schemes the token file defines", () => {
    expect(SCHEMES.map((scheme) => scheme.id)).toEqual(["tide", "cobalt", "fern"]);
  });
});

describe("resolveTheme", () => {
  it("passes an explicit choice through, whatever the machine says", () => {
    expect(resolveTheme("light", true)).toBe("light");
    expect(resolveTheme("dark", false)).toBe("dark");
  });

  it("follows the machine when the choice is system", () => {
    expect(resolveTheme("system", true)).toBe("dark");
    expect(resolveTheme("system", false)).toBe("light");
  });
});
