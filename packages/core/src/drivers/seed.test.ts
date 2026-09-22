// Tests for seed-source choice and the content-addressed cache:
// - chooseSeed: the preference order, availability of each source, an explicit preference, no sources at all
// - chooseSeed: a public sandbox is offered only fixtures or an anonymised dump, and refuses with a message when it has neither
// - chooseSeed: the refusal separates access from availability — a permitted-but-unreachable source names what to start or fetch, a blocked one cites §5.3, and both are reported when both apply
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
      sandboxer: ">=0.1.0",
      access: { apps },
      database: { driver: "mysql", seed_from: seed, migrate: { command: "migrate" } },
    },
    "/repo/sandboxer.yaml",
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
      { project: "acme", sandboxer: ">=0.1.0", database: { driver: "none" } },
      "/repo/sandboxer.yaml",
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

  // The two filters — what access permits, and what this machine can reach —
  // are independent, and the message has to say which one applied. Conflating
  // them told somebody with a private project and a stopped container to make
  // the sandbox public.
  describe("the refusal", () => {
    const localOnly = { local: { container: "taxonomy_db", database: "app" } };

    it("names the container that is not running, rather than blaming access", () => {
      const call = () => chooseSeed(configWith(localOnly), { localAvailable: false });
      expect(call).toThrow(/database\.seed_from\.local is permitted here but not available/);
      expect(call).toThrow(/the container "taxonomy_db" is not running/);
    });

    it("does not tell a private project to change its access", () => {
      const call = () => chooseSeed(configWith(localOnly), { localAvailable: false });
      expect(call).not.toThrow(/5\.3/);
      expect(call).not.toThrow(/access\.apps/);
      expect(call).toThrow(/Make one of them available here/);
    });

    it("names the dump that is not on this disk", () => {
      const call = () => chooseSeed(configWith({ file: "/seeds/d.sql" }), { fileAvailable: false });
      expect(call).toThrow(/database\.seed_from\.file is permitted here but not available/);
      expect(call).toThrow(/the dump "\/seeds\/d\.sql" was not found here/);
    });

    it("cites §5.3 for a source access excluded, and offers the access fix", () => {
      const call = () => chooseSeed(configWith(localOnly, "public"));
      expect(call).toThrow(/database\.seed_from\.local is not permitted/);
      expect(call).toThrow(/Set access\.apps to private/);
    });

    // A public project with an anonymised dump that is not on this machine and
    // a live fork it may not use: one source is out on policy, the other on
    // availability, and silently reporting either alone sends the reader to the
    // wrong fix.
    it("reports both reasons when both apply", () => {
      const config = configWith(
        { local: { container: "taxonomy_db" }, file: "/seeds/d.sql", anonymised: true },
        "public",
      );
      const call = () => chooseSeed(config, { fileAvailable: false });
      expect(call).toThrow(/database\.seed_from\.local is not permitted/);
      expect(call).toThrow(/database\.seed_from\.file is permitted here but not available/);
      expect(call).toThrow(/Set access\.apps to private/);
    });

    it("still names the permitted set for an explicit preference", () => {
      expect(() => chooseSeed(configWith(all, "public"), { prefer: "local" })).toThrow(
        /permitted sources are fixtures/,
      );
    });

    // Nothing to refuse: the config names no source at all, so there is no
    // rule to cite and no container to start.
    it("answers none when the config names nothing", () => {
      expect(chooseSeed(configWith({ anonymised: true }))).toEqual({ source: "none" });
    });
  });
});

describe("cacheEntry", () => {
  it("names the artifact after the project and the key", () => {
    const entry = cacheEntry("/home/.sandboxer", "acme", "abc123", ".sql.zst");
    expect(entry.path).toBe("/home/.sandboxer/cache/seed-acme-abc123.sql.zst");
    expect(entry.metaPath).toBe("/home/.sandboxer/cache/seed-acme-abc123.meta.json");
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
