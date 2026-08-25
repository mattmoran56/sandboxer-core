// Tests for seed-source choice and the content-addressed cache:
// - chooseSeed: the preference order, availability of each source, an explicit preference, no sources at all
// - chooseSeed: a public sandbox is offered only fixtures or an anonymised dump, and refuses with a message when it has neither
// - cacheEntry: the name carries the project and the key, and the meta file sits beside the artifact
// - ageHours / isFresh: fresh, expired, missing, force, and an unparseable timestamp
// - partialPath: an interrupted artifact cannot be mistaken for a complete one
// - formatBytes: each unit boundary

import { describe, expect, it } from "vitest";

import { resolveConfig } from "../config/load.js";
import type { ResolvedConfig } from "../config/types.js";
import { SeedError, ageHours, cacheEntry, chooseSeed, formatBytes, isFresh, partialPath } from "./seed.js";

function configWith(seed: Record<string, unknown>, apps: "public" | "private" = "private"): ResolvedConfig {
  return resolveConfig(
    {
      project: "acme",
      sandboxr: ">=0.1.0",
      access: { apps },
      database: { driver: "mysql", seed_from: seed, migrate: { command: "migrate" } },
    },
    "/repo/sandboxr.yaml",
    { enforceAccess: false },
  );
}

describe("chooseSeed", () => {
  const all = { local: { container: "src", database: "app" }, file: "/seeds/d.sql", fixtures: "seeds/f.sql" };

  it("prefers a live fork, which is the freshest data there is", () => {
    expect(chooseSeed(configWith(all))).toMatchObject({ source: "local", container: "src", database: "app" });
  });

  it("falls back to the dump when the source container is not running", () => {
    expect(chooseSeed(configWith(all), { localAvailable: false })).toMatchObject({ source: "file" });
  });

  it("falls back to fixtures when neither is available here", () => {
    expect(chooseSeed(configWith(all), { localAvailable: false, fileAvailable: false })).toMatchObject({
      source: "fixtures",
    });
  });

  it("carries the fixtures path whichever source is chosen", () => {
    expect(chooseSeed(configWith(all)).fixtures).toBe("seeds/f.sql");
  });

  it("honours an explicit preference", () => {
    expect(chooseSeed(configWith(all), { prefer: "file" })).toMatchObject({ source: "file" });
  });

  it("refuses an explicit preference that is not permitted, naming what is", () => {
    expect(() => chooseSeed(configWith(all, "public"), { prefer: "local" })).toThrow(SeedError);
  });

  it("answers none for a project with no database", () => {
    const config = resolveConfig(
      { project: "acme", sandboxr: ">=0.1.0", database: { driver: "none" } },
      "/repo/sandboxr.yaml",
    );
    expect(chooseSeed(config)).toEqual({ source: "none" });
  });

  describe("a public sandbox", () => {
    it("is never offered a live fork", () => {
      const choice = chooseSeed(configWith({ local: { container: "src" }, fixtures: "f.sql" }, "public"));
      expect(choice.source).toBe("fixtures");
    });

    it("is never offered an unmarked dump", () => {
      const choice = chooseSeed(configWith({ file: "/seeds/d.sql", fixtures: "f.sql" }, "public"));
      expect(choice.source).toBe("fixtures");
    });

    it("may restore a dump that says it is anonymised", () => {
      const choice = chooseSeed(configWith({ file: "/seeds/d.sql", anonymised: true }, "public"));
      expect(choice.source).toBe("file");
    });

    // The refusal has to say which rule excluded the source, or it reads as the
    // tool simply not working.
    it("refuses, citing §5.3, when it has no permissible source", () => {
      expect(() => chooseSeed(configWith({ local: { container: "src" } }, "public"))).toThrow(/5\.3/);
    });
  });
});

describe("cacheEntry", () => {
  it("names the artifact after the project and the key", () => {
    const entry = cacheEntry("/home/.sandboxr", "acme", "abc123", ".sql.zst");
    expect(entry.path).toBe("/home/.sandboxr/cache/seed-acme-abc123.sql.zst");
    expect(entry.metaPath).toBe("/home/.sandboxr/cache/seed-acme-abc123.meta.json");
  });

  it("keeps two projects' seeds apart", () => {
    expect(cacheEntry("/h", "one", "k", ".sql").path).not.toBe(cacheEntry("/h", "two", "k", ".sql").path);
  });
});

describe("ageHours", () => {
  const now = new Date("2026-08-25T12:00:00Z");

  it.each([
    ["an hour ago", "2026-08-25T11:00:00Z", 1],
    ["a day ago", "2026-08-24T12:00:00Z", 24],
    ["right now", "2026-08-25T12:00:00Z", 0],
  ])("%s is %s hours", (_name, createdAt, want) => {
    expect(ageHours(createdAt, now)).toBe(want);
  });

  it.each([undefined, "", "not a date"])("treats %s as infinitely old", (createdAt) => {
    expect(ageHours(createdAt, now)).toBe(Number.POSITIVE_INFINITY);
  });
});

describe("isFresh", () => {
  const now = new Date("2026-08-25T12:00:00Z");

  it.each([
    ["a recent entry", { exists: true, createdAt: "2026-08-25T11:00:00Z" }, true],
    ["an entry past the ttl", { exists: true, createdAt: "2026-08-23T11:00:00Z" }, false],
    ["a missing entry", { exists: false, createdAt: "2026-08-25T11:00:00Z" }, false],
    ["an entry with no meta", { exists: true }, false],
    ["a forced refresh", { exists: true, createdAt: "2026-08-25T11:59:00Z", force: true }, false],
  ])("%s", (_name, input, want) => {
    expect(isFresh({ ...input, now })).toBe(want);
  });

  it("respects a ttl of its own", () => {
    expect(isFresh({ exists: true, createdAt: "2026-08-25T10:00:00Z", ttlHours: 1, now })).toBe(false);
    expect(isFresh({ exists: true, createdAt: "2026-08-25T11:30:00Z", ttlHours: 1, now })).toBe(true);
  });
});

describe("partialPath", () => {
  // An interrupted dump must not be mistaken for a complete cache entry, which
  // is why it is written under another name and renamed only on success.
  it("differs from the final name", () => {
    expect(partialPath("/c/seed.sql.zst")).toBe("/c/seed.sql.zst.partial");
  });
});

describe("formatBytes", () => {
  it.each([
    [0, "0 B"],
    [512, "512 B"],
    [1023, "1023 B"],
    [1024, "1 KB"],
    [1_048_576, "1 MB"],
    [1_073_741_824, "1.0 GB"],
    [5_368_709_120, "5.0 GB"],
  ])("%s bytes reads as %s", (bytes, want) => {
    expect(formatBytes(bytes)).toBe(want);
  });
});
