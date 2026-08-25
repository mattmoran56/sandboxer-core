// Tests for slug, hostname and docker-name derivation:
// - sanitizeSlug: lowercasing, illegal-character folding, dash collapsing, trimming, empty input
// - sanitizeSlug: the length ceiling, its off-by-one, hash stability, and two long shared-prefix names not colliding
// - deriveSlug: the full order of preference, ticket detection in directory and branch, detached HEAD, no input at all
// - hostFor / urlFor: hostname shape, the default domain, an overridden domain, empty components
// - containerName / volumeName / depsVolumeName: the shapes fixed by contracts §3.3
// - parseContainerName: round-trip with and without a known project, and the shapes it refuses to guess at
// - lockName: identifier folding, determinism, and the 64-character GET_LOCK ceiling

import { describe, expect, it } from "vitest";

import {
  DEFAULT_DOMAIN,
  NamingError,
  SLUG_MAX,
  containerName,
  depsVolumeName,
  deriveSlug,
  hostFor,
  lockName,
  parseContainerName,
  sanitizeSlug,
  urlFor,
  volumeName,
} from "./naming.js";

describe("sanitizeSlug", () => {
  const cases: Array<[name: string, input: string, want: string]> = [
    ["lowercases", "TKT-1234", "tkt-1234"],
    ["leaves a clean slug alone", "tkt-1234", "tkt-1234"],
    ["keeps digits", "1234", "1234"],
    ["folds a slash", "feat/foo", "feat-foo"],
    ["folds an underscore", "foo_bar", "foo-bar"],
    ["folds dots", "v1.2.3", "v1-2-3"],
    ["folds spaces", "my branch", "my-branch"],
    ["folds mixed junk", "feat/foo_Bar", "feat-foo-bar"],
    ["collapses runs", "a///b", "a-b"],
    ["trims leading dashes", "///abc", "abc"],
    ["trims trailing dashes", "abc///", "abc"],
    ["trims both", "--abc--", "abc"],
    ["folds non-ascii", "brânch", "br-nch"],
  ];

  it.each(cases)("%s", (_name, input, want) => {
    expect(sanitizeSlug(input)).toBe(want);
  });

  it("rejects a name that is nothing but junk", () => {
    expect(() => sanitizeSlug("///")).toThrow(NamingError);
    expect(() => sanitizeSlug("")).toThrow(NamingError);
  });

  describe("the length ceiling", () => {
    const long = "feat/some-extremely-long-branch-name-that-will-not-fit-anywhere";

    it("caps an over-long name at the ceiling", () => {
      expect(sanitizeSlug(long)).toHaveLength(SLUG_MAX);
    });

    it("keeps a readable prefix", () => {
      expect(sanitizeSlug(long)).toMatch(/^feat-some-extremely-l/);
    });

    it("ends in an eight-character hash", () => {
      expect(sanitizeSlug(long)).toMatch(/-[0-9a-f]{8}$/);
    });

    // An off-by-one here would rewrite slugs that were already legal, which
    // changes container names between releases and orphans their volumes.
    it("leaves a name exactly at the ceiling untouched", () => {
      const atMax = "a".repeat(SLUG_MAX);
      expect(sanitizeSlug(atMax)).toBe(atMax);
    });

    it("hashes a name one character over", () => {
      const overMax = "a".repeat(SLUG_MAX + 1);
      const slug = sanitizeSlug(overMax);
      expect(slug).toHaveLength(SLUG_MAX);
      expect(slug).not.toBe(overMax);
    });

    it("is deterministic", () => {
      expect(sanitizeSlug(long)).toBe(sanitizeSlug(long));
    });

    // The whole reason for hashing rather than truncating.
    it("keeps two long names sharing a prefix apart", () => {
      const a = sanitizeSlug("feature/really-long-shared-prefix-alpha-variant-one");
      const b = sanitizeSlug("feature/really-long-shared-prefix-alpha-variant-two");
      expect(a).not.toBe(b);
      expect(a.slice(0, 22)).toBe(b.slice(0, 22));
    });

    // The hash is over the raw input, so two names that fold to the same
    // sanitised prefix still differ.
    it("hashes the raw input, not the folded one", () => {
      expect(sanitizeSlug(`feat/${"x".repeat(40)}`)).not.toBe(sanitizeSlug(`feat-${"x".repeat(40)}`));
    });

    it("never joins the prefix and the hash with a double dash", () => {
      // Character 23 of the folded name is a dash, so an untrimmed prefix would
      // produce `...-` + `-hash`.
      const slug = sanitizeSlug("aaaaaaaaaaaaaaaaaaaaaa/bbbbbbbbbbbbbbbbbbbbbb");
      expect(slug).not.toContain("--");
      expect(slug.length).toBeLessThanOrEqual(SLUG_MAX);
    });
  });
});

describe("deriveSlug", () => {
  const cases: Array<[name: string, input: Parameters<typeof deriveSlug>[0], want: string]> = [
    ["an explicit name wins", { explicit: "tkt-9999", worktreeDir: "tkt-1", branch: "tkt-2" }, "tkt-9999"],
    ["an explicit name is still sanitised", { explicit: "TKT-9999" }, "tkt-9999"],
    ["a ticket in the directory name", { worktreeDir: "tkt-4821", branch: "staging" }, "tkt-4821"],
    ["a ticket anywhere in the directory name", { worktreeDir: "wip-tkt-4821-thing" }, "tkt-4821"],
    ["a ticket in the branch", { worktreeDir: "scratch", branch: "feat/TKT-4821-thing" }, "tkt-4821"],
    ["the directory's ticket beats the branch's", { worktreeDir: "tkt-1", branch: "tkt-2" }, "tkt-1"],
    ["the branch when nothing carries a ticket", { worktreeDir: "scratch", branch: "feat/foo" }, "feat-foo"],
    ["the directory when there is no branch", { worktreeDir: "my-tree" }, "my-tree"],
    ["the directory when the worktree is detached", { worktreeDir: "my-tree", branch: "HEAD" }, "my-tree"],
    ["a ticket-less numeric branch", { branch: "release/2026.08" }, "release-2026-08"],
  ];

  it.each(cases)("%s", (_name, input, want) => {
    expect(deriveSlug(input)).toBe(want);
  });

  it("ignores an explicit name that is only whitespace", () => {
    expect(deriveSlug({ explicit: "  ", worktreeDir: "tkt-7" })).toBe("tkt-7");
  });

  it("throws when there is nothing to derive from", () => {
    expect(() => deriveSlug({})).toThrow(NamingError);
  });

  // Teams spell their ticket ids differently, so the pattern is an input
  // rather than a fact about one team's convention.
  it("takes a ticket pattern of its own", () => {
    expect(deriveSlug({ branch: "feature/2026-Q3-42-thing", ticketPattern: /[0-9]{4}-Q[0-9]-[0-9]+/ })).toBe(
      "2026-q3-42",
    );
  });

  it("falls back to the branch when a custom pattern matches nothing", () => {
    expect(deriveSlug({ branch: "feat/tkt-99", ticketPattern: /never/ })).toBe("feat-tkt-99");
  });

  // A branch and a worktree of that branch have to land on the same slug, or
  // one branch would get two sandboxes.
  it("agrees between a branch and a worktree named after it", () => {
    const fromBranch = deriveSlug({ branch: "feat/tkt-4821-thing" });
    const fromDir = deriveSlug({ worktreeDir: "tkt-4821" });
    expect(fromBranch).toBe(fromDir);
  });
});

describe("hostFor", () => {
  it("builds slug.label.project.domain", () => {
    expect(hostFor({ slug: "tkt-4821", label: "app", project: "acme" })).toBe(
      `tkt-4821.app.acme.${DEFAULT_DOMAIN}`,
    );
  });

  it("uses the domain it is given", () => {
    expect(hostFor({ slug: "s", label: "api", project: "p", domain: "sbx.dev" })).toBe("s.api.p.sbx.dev");
  });

  it("keeps a dashed label intact", () => {
    expect(hostFor({ slug: "s", label: "hiring-api", project: "p", domain: "d" })).toBe("s.hiring-api.p.d");
  });

  it("prefixes https for a url", () => {
    expect(urlFor({ slug: "s", label: "app", project: "p", domain: "d" })).toBe("https://s.app.p.d");
  });

  it.each(["slug", "label", "project"] as const)("refuses an empty %s", (field) => {
    const parts = { slug: "s", label: "l", project: "p", domain: "d" };
    expect(() => hostFor({ ...parts, [field]: "" })).toThrow(NamingError);
  });
});

describe("docker names", () => {
  it("names a container", () => {
    expect(containerName("acme", "tkt-4821")).toBe("sandboxr-acme-tkt-4821");
  });

  it.each(["data", "blob", "bin", "www"] as const)("names the %s volume", (purpose) => {
    expect(volumeName(purpose, "p", "s")).toBe(`sandboxr-${purpose}-p-s`);
  });

  it("keys the shared dependency volume on a hash", () => {
    expect(depsVolumeName("abc123")).toBe("sandboxr-deps-abc123");
  });

  it("round-trips a container name when the project is known", () => {
    const name = containerName("acme-shop", "feat-a-b");
    expect(parseContainerName(name, "acme-shop")).toEqual({ project: "acme-shop", slug: "feat-a-b" });
  });

  it("splits at the first dash when the project is unknown", () => {
    expect(parseContainerName("sandboxr-p-tkt-1")).toEqual({ project: "p", slug: "tkt-1" });
  });

  it.each([
    ["something else entirely", "postgres"],
    ["the prefix alone", "sandboxr-"],
    ["a project with no slug", "sandboxr-project-"],
    ["a slug with no project", "sandboxr--slug"],
    ["a different project than the one asked for", "sandboxr-other-slug"],
  ])("refuses to guess at %s", (_name, input) => {
    expect(parseContainerName(input, input === "sandboxr-other-slug" ? "mine" : undefined)).toBeUndefined();
  });
});

describe("lockName", () => {
  it("folds to a legal identifier", () => {
    expect(lockName("acme-shop", "tkt-1")).toBe("sandboxr_migrate_acme_shop_tkt_1");
  });

  it("is deterministic", () => {
    expect(lockName("p", "s")).toBe(lockName("p", "s"));
  });

  // This is what the slug ceiling exists to guarantee: GET_LOCK truncates past
  // 64 characters, and two names that truncate alike are one lock.
  it("fits inside GET_LOCK's ceiling for a maximum-length slug", () => {
    const slug = sanitizeSlug("feature/" + "x".repeat(80));
    expect(slug).toHaveLength(SLUG_MAX);
    expect(lockName("acme", slug).length).toBeLessThanOrEqual(64);
  });

  it("refuses rather than silently colliding when the project name is too long", () => {
    expect(() => lockName("a-project-name-nobody-would-choose", "x".repeat(SLUG_MAX))).toThrow(NamingError);
  });
});
