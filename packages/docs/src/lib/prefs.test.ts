// What this covers:
//  - readPrefs on nothing, on rubbish, on valid JSON that is not an object
//  - readPrefs keeping the fields it recognises and defaulting the ones it does not
//  - the storage key and preference names `index.html`'s blocking script depends on
//  - a `scheme` left in storage by an older version of the site being ignored
//  - resolveTheme, including the `system` case in both directions

import { describe, expect, it } from "vitest";

import { DEFAULTS, PREFS_KEY, readPrefs, resolveTheme } from "./prefs.js";

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
    expect(readPrefs('{"theme":"dark","expandAll":true}')).toEqual({
      theme: "dark",
      expandAll: true,
    });
  });

  it("defaults the fields it does not recognise and keeps the ones it does", () => {
    // A hand-edited value, and a boolean stored as the string a form would have
    // submitted.
    expect(readPrefs('{"theme":"sepia","expandAll":"yes"}')).toEqual({
      theme: DEFAULTS.theme,
      expandAll: DEFAULTS.expandAll,
    });
  });

  it("ignores anything else in the object", () => {
    // The dashboard's own preferences, in case both apps ever share an origin.
    expect(readPrefs('{"theme":"light","grouping":"status","collapsed":["acme"]}')).toEqual({
      theme: "light",
      expandAll: DEFAULTS.expandAll,
    });
  });

  it("drops the colour scheme an older version of the site stored", () => {
    // The site once offered three colour schemes and wrote the reader's pick
    // under the same key. It is read past rather than migrated, and never
    // written back.
    expect(readPrefs('{"theme":"dark","scheme":"fern","expandAll":true}')).toEqual({
      theme: "dark",
      expandAll: true,
    });
  });
});

describe("the contract with index.html", () => {
  // The blocking script in `index.html` is hand-written and cannot import this
  // module, so it names the key and the fields as literals. Renaming either here
  // would leave the script reading a key nothing writes — with no error, just a
  // flash of the wrong theme on every load.
  it("keeps the key and the names the blocking script reads", () => {
    expect(PREFS_KEY).toBe("sandboxer.docs.prefs.v1");
    expect(Object.keys(DEFAULTS).sort()).toEqual(["expandAll", "theme"]);
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
