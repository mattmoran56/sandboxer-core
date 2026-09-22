// Tests for the container paths the host and the container share:
// - seedMount: an artifact in the host cache is named inside the cache mount and needs no mount of its own
// - seedMount: an artifact anywhere else is mounted at its own path under /sandboxer/seed
// - seedMount: the basename is kept, because the container picks a decompressor by extension
// - seedMount: a sibling directory whose name merely starts with the cache's is not "in the cache"
// - seedMount: a relative or unnormalised cache path still resolves

import { describe, expect, it } from "vitest";

import { CACHE_DIR, SEED_DIR, seedMount } from "./layout.js";

describe("seedMount", () => {
  const cache = "/home/dev/.sandboxer/cache";

  it("names a cached artifact inside the cache mount, and asks for no mount", () => {
    expect(seedMount(`${cache}/seed-acme-3f2a1b.sql.zst`, cache)).toEqual({
      inside: `${CACHE_DIR}/seed-acme-3f2a1b.sql.zst`,
    });
  });

  // The case that never worked: a `database.seed_from.file` deliberately kept
  // outside every repo, whose directory is the only thing locating it. Taking
  // the basename pointed the container at the cache, where it had never been.
  it("mounts a declared file at its own path, keeping the name", () => {
    expect(seedMount("/home/dev/.sandboxer/seeds/acme-base.sql.zst", cache)).toEqual({
      inside: `${SEED_DIR}/acme-base.sql.zst`,
      bind: "/home/dev/.sandboxer/seeds/acme-base.sql.zst",
    });
  });

  // The container chooses zstd, gzip or cat by extension rather than by sniffing,
  // so a fixed mount path with no extension would have to guess.
  it.each([".sql.zst", ".sql.gz", ".sql"])("keeps a %s extension", (extension) => {
    expect(seedMount(`/elsewhere/dump${extension}`, cache).inside).toBe(`${SEED_DIR}/dump${extension}`);
  });

  // A string prefix would call this cached and then mount nothing, which is the
  // exact failure this function exists to make impossible.
  it("does not mistake a sibling directory for the cache", () => {
    expect(seedMount("/home/dev/.sandboxer/cache-old/dump.sql.zst", cache)).toMatchObject({
      inside: `${SEED_DIR}/dump.sql.zst`,
    });
  });

  it("compares resolved paths, not the strings it was handed", () => {
    expect(seedMount(`${cache}/../cache/dump.sql.zst`, `${cache}/`)).toEqual({
      inside: `${CACHE_DIR}/dump.sql.zst`,
    });
  });
});
