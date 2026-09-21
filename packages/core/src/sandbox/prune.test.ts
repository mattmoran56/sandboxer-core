// Tests for the reclamation plan:
// - planPrune: an orphaned per-sandbox volume is offered, a live sandbox's volume is not
// - planPrune: the shared volumes are never offered, the Claude credential volume least of all
// - planPrune: a session's work volume is never offered, whatever its size (contracts §12.8)
// - planPrune: an older project image is superseded by the newest one of the same project
// - planPrune: the newest image of every project survives, so the next `up` is a start
// - planPrune: an image a container still holds is left alone, even when it is old
// - planPrune: sandboxr/base and sandboxr/dashboard are never superseded
// - planPrune: an image outside the sandboxr namespace is not ours to remove
// - planPrune: an untagged image is left to `docker image prune`
// - planPrune: sizes are the unique ones, so the total is what removal would really free
// - planPrune: the build cache is reported either way, and only in scope when asked for
// - planPrune: cache an image also holds counts as a deleted record but not as reclaimed bytes
// - formatBytes: docker's decimal units, and the shapes at the boundaries

import { describe, expect, it } from "vitest";

import { BASE_IMAGE } from "../access/index.js";

/**
 * Names the engine reserves and never builds — see `PROTECTED_IMAGES`.
 *
 * Spelled here rather than imported, because they live in the product now and
 * the engine cannot import the product. The reservation is the engine's; what is
 * behind each name is not its business.
 */
const DASHBOARD_IMAGE_NAME = "sandboxr/dashboard";
const WORKSTATION_IMAGE_NAME = "sandboxr/workstation";
const ORCHESTRATOR_IMAGE_NAME = "sandboxr/orchestrator";
import type { BuildCacheRow, ImageRow, VolumeRow } from "../docker.js";
import { PROTECTED_IMAGES } from "../naming.js";
import { formatBytes, planPrune } from "./prune.js";
import type { Sandbox } from "./types.js";

function sandbox(overrides: Partial<Sandbox> = {}): Sandbox {
  return {
    project: "acme",
    slug: "tkt-1",
    branch: "feat/thing",
    commit: "abc",
    dirty: false,
    worktree: "/repos/tkt-1",
    driver: "mysql",
    access: "public",
    created: "2026-08-25T09:00:00.000Z",
    ttl: "never",
    env: "",
    kind: "runtime",
    session: "",
    state: "running",
    container: "sandboxr-acme-tkt-1",
    ...overrides,
  };
}

function volume(name: string, size = 1_000_000): VolumeRow {
  return { name, size, links: 0 };
}

function image(overrides: Partial<ImageRow> & { repository: string; tag: string }): ImageRow {
  return {
    id: overrides.tag,
    created: new Date("2026-08-01T00:00:00.000Z"),
    size: 6_000_000_000,
    uniqueSize: 1_000_000_000,
    containers: 0,
    ...overrides,
  };
}

const empty = { sandboxes: [], volumes: [], images: [], buildCache: [] };

describe("planPrune volumes", () => {
  it("offers a volume no sandbox owns", () => {
    const plan = planPrune({
      ...empty,
      volumes: [volume("sandboxr-data-acme-tkt-9", 412_000_000)],
      mountedVolumes: new Set(),
    });
    expect(plan.volumes).toEqual([{ name: "sandboxr-data-acme-tkt-9", size: 412_000_000 }]);
    expect(plan.freed).toBe(412_000_000);
  });

  it("never offers a live sandbox's volume", () => {
    const plan = planPrune({
      ...empty,
      sandboxes: [sandbox()],
      volumes: [volume("sandboxr-data-acme-tkt-1"), volume("sandboxr-www-acme-tkt-1")],
      mountedVolumes: new Set(),
    });
    expect(plan.volumes).toEqual([]);
  });

  // The same guarantee gc.test.ts pins, restated here because prune is a second
  // caller of the same decision: this volume holds every MCP credential on the
  // machine, and taking it signs the machine out of every server at once.
  it("never offers a shared volume", () => {
    const plan = planPrune({
      ...empty,
      volumes: [volume("sandboxr-claude"), volume("sandboxr-gocache"), volume("sandboxr-gomod")],
      mountedVolumes: new Set(),
    });
    expect(plan.volumes).toEqual([]);
  });

  // Restated here for the same reason, and with a stronger one behind it: the
  // credential volume is recoverable by signing in again, and a work volume is
  // not recoverable at all (contracts §12.8). Prune is the command that puts a
  // number beside each item, so a work volume appearing with several gigabytes
  // against it is precisely how somebody would be talked into applying it.
  it("never offers a session's work volume, however large it is", () => {
    const plan = planPrune({
      ...empty,
      volumes: [volume("sandboxr-work-eng-3941", 9_000_000_000), volume("sandboxr-data-acme-tkt-9", 1_000)],
      mountedVolumes: new Set(),
    });
    expect(plan.volumes).toEqual([{ name: "sandboxr-data-acme-tkt-9", size: 1_000 }]);
    expect(plan.freed).toBe(1_000);
  });
});

describe("planPrune images", () => {
  const older = image({
    repository: "sandboxr/acme",
    tag: "40ed880f9db8",
    created: new Date("2026-08-01T00:00:00.000Z"),
    uniqueSize: 5_340_000_000,
  });
  const newer = image({
    repository: "sandboxr/acme",
    tag: "48273eacdece",
    created: new Date("2026-08-27T00:00:00.000Z"),
    uniqueSize: 5_340_000_000,
    containers: 1,
  });

  it("supersedes the older image of a project, naming what replaced it", () => {
    const plan = planPrune({ ...empty, images: [older, newer] });
    expect(plan.images).toHaveLength(1);
    expect(plan.images[0]?.reference).toBe("sandboxr/acme:40ed880f9db8");
    expect(plan.images[0]?.reason).toContain("48273eacdece");
  });

  // The image is what makes the next `up` a start rather than a toolchain
  // build, so a project with no sandbox running keeps one.
  it("keeps the newest image even when nothing is using it", () => {
    const plan = planPrune({ ...empty, images: [{ ...newer, containers: 0 }] });
    expect(plan.images).toEqual([]);
  });

  it("leaves an old image a container still holds", () => {
    const plan = planPrune({ ...empty, images: [{ ...older, containers: 1 }, newer] });
    expect(plan.images).toEqual([]);
  });

  it("never supersedes the machine's own images", () => {
    const plan = planPrune({
      ...empty,
      images: [
        image({ repository: BASE_IMAGE, tag: "0.1.0", created: new Date("2026-08-27T00:00:00.000Z") }),
        image({ repository: BASE_IMAGE, tag: "latest", created: new Date("2026-08-01T00:00:00.000Z") }),
        image({ repository: DASHBOARD_IMAGE_NAME, tag: "next", created: new Date("2026-08-01T00:00:00.000Z") }),
        image({ repository: DASHBOARD_IMAGE_NAME, tag: "0.1.0", created: new Date("2026-08-27T00:00:00.000Z") }),
      ],
    });
    expect(plan.images).toEqual([]);
  });

  // A rename would otherwise unprotect one silently, and the symptom would be a
  // base image removed from under the next `up`. Only the first is the engine's
  // own build; the other three are names it *reserves* on the embedder's behalf,
  // exactly as `WORK_VOLUME_PREFIX` reserves a volume prefix (contracts §3.3).
  it("protects exactly the four reserved repositories", () => {
    expect([...PROTECTED_IMAGES]).toEqual([
      BASE_IMAGE,
      DASHBOARD_IMAGE_NAME,
      WORKSTATION_IMAGE_NAME,
      ORCHESTRATOR_IMAGE_NAME,
    ]);
  });

  it("leaves images that are not ours alone", () => {
    const plan = planPrune({
      ...empty,
      images: [
        image({ repository: "mysql", tag: "8.4", created: new Date("2026-07-01T00:00:00.000Z") }),
        image({ repository: "mysql", tag: "latest", created: new Date("2026-08-27T00:00:00.000Z") }),
      ],
    });
    expect(plan.images).toEqual([]);
  });

  it("leaves an untagged image to docker's own prune", () => {
    const plan = planPrune({
      ...empty,
      images: [image({ repository: "sandboxr/acme", tag: "<none>" }), newer],
    });
    expect(plan.images).toEqual([]);
  });

  // Total size would count the shared base layer once per image and promise
  // back several gigabytes that removal cannot deliver.
  it("totals the unique sizes, not the reported ones", () => {
    const plan = planPrune({ ...empty, images: [older, newer] });
    expect(plan.freed).toBe(5_340_000_000);
  });

  it("puts the biggest saving first", () => {
    const plan = planPrune({
      ...empty,
      images: [
        image({ repository: "sandboxr/demo", tag: "old", uniqueSize: 452_000_000 }),
        image({
          repository: "sandboxr/demo",
          tag: "new",
          created: new Date("2026-08-27T00:00:00.000Z"),
        }),
        older,
        newer,
      ],
    });
    expect(plan.images.map((entry) => entry.reference)).toEqual([
      "sandboxr/acme:40ed880f9db8",
      "sandboxr/demo:old",
    ]);
  });
});

describe("planPrune build cache", () => {
  const cache: BuildCacheRow[] = [
    { id: "a", size: 1_000_000_000, inUse: false, shared: false },
    { id: "b", size: 500_000_000, inUse: true, shared: false },
    // Unused, but an image holds the same bytes: deleting the record frees
    // nothing, which is why docker leaves it out of its reclaimable figure.
    { id: "c", size: 9_000_000_000, inUse: false, shared: true },
  ];

  // The cache is Docker's: other projects on the same daemon built into it, so
  // routine housekeeping must not carry it away by default. It is still the
  // largest number on a full machine, so it is always reported.
  it("is reported but out of scope unless asked for", () => {
    expect(planPrune({ ...empty, buildCache: cache }).buildCache).toEqual({
      records: 2,
      size: 1_000_000_000,
      inScope: false,
    });
  });

  // Records and bytes are counted over different sets on purpose: everything
  // unused is deleted, but only what no image also holds becomes free disk. On
  // one machine that was 440 records against a fifth of their total size.
  it("counts the records a prune deletes, and the bytes it actually returns", () => {
    const plan = planPrune({ ...empty, buildCache: cache, includeBuildCache: true });
    expect(plan.buildCache).toEqual({ records: 2, size: 1_000_000_000, inScope: true });
  });

  // Its size is an upper bound rather than a promise, so it stays out of the
  // figure the plan quotes as what would come back.
  it("stays out of the freed total", () => {
    expect(planPrune({ ...empty, buildCache: cache, includeBuildCache: true }).freed).toBe(0);
  });
});

describe("formatBytes", () => {
  it("spells sizes the way docker does", () => {
    expect(formatBytes(0)).toBe("0 B");
    expect(formatBytes(512)).toBe("512 B");
    expect(formatBytes(412_000_000)).toBe("412 MB");
    expect(formatBytes(5_340_000_000)).toBe("5.3 GB");
    expect(formatBytes(1_000)).toBe("1.0 kB");
  });

  it("does not invent a size for a number it was not given", () => {
    expect(formatBytes(Number.NaN)).toBe("0 B");
    expect(formatBytes(-1)).toBe("0 B");
  });
});
