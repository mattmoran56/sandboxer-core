// Tests for the reaping plan:
// - planGc: a sandbox whose worktree is gone is reaped; one whose worktree is there is kept
// - planGc: a merged branch is reaped when the caller supplies the list, and not otherwise
// - planGc: a sandbox with no recorded worktree is never reaped for that reason
// - orphanVolumes: volumes of a reaped sandbox are orphans, volumes of a survivor are not
// - orphanVolumes: the shared volumes are never orphans, and a mounted volume is never an orphan
// - orphanVolumes: reaping every sandbox on the machine still leaves the Claude credential volume
// - orphanVolumes: a dependency volume is left alone unless a mount list proves it unused
// - orphanVolumes: nothing outside the sandboxr prefix is ever considered

import { describe, expect, it } from "vitest";

import { planGc } from "./gc.js";
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
    state: "running",
    container: "sandboxr-acme-tkt-1",
    ...overrides,
  };
}

const alive = () => true;
const gone = () => false;

describe("planGc", () => {
  it("reaps a sandbox whose worktree is gone, and says so", () => {
    const plan = planGc({ sandboxes: [sandbox()], volumes: [], worktreeExists: gone });
    expect(plan.reap).toHaveLength(1);
    expect(plan.reap[0]?.reason).toContain("/repos/tkt-1");
    expect(plan.keep).toEqual([]);
  });

  it("keeps a sandbox whose worktree is still there", () => {
    const plan = planGc({ sandboxes: [sandbox()], volumes: [], worktreeExists: alive });
    expect(plan.reap).toEqual([]);
    expect(plan.keep).toHaveLength(1);
  });

  it("reaps a merged branch only when asked", () => {
    const input = { sandboxes: [sandbox()], volumes: [], worktreeExists: alive };
    expect(planGc(input).reap).toEqual([]);
    const merged = planGc({ ...input, mergedBranches: new Set(["feat/thing"]) });
    expect(merged.reap[0]?.reason).toContain("merged");
  });

  // A sandbox whose branch could not be resolved has no worktree recorded, and
  // "the path is empty" is not evidence the worktree is gone.
  it("never reaps a sandbox with no recorded worktree", () => {
    const plan = planGc({ sandboxes: [sandbox({ worktree: "" })], volumes: [], worktreeExists: gone });
    expect(plan.reap).toEqual([]);
  });

  it("takes each sandbox on its own merits", () => {
    const plan = planGc({
      sandboxes: [sandbox({ slug: "a", worktree: "/repos/a" }), sandbox({ slug: "b", worktree: "/repos/b" })],
      volumes: [],
      worktreeExists: (path) => path === "/repos/b",
    });
    expect(plan.reap.map((entry) => entry.sandbox.slug)).toEqual(["a"]);
    expect(plan.keep.map((entry) => entry.slug)).toEqual(["b"]);
  });
});

describe("orphan volumes", () => {
  const volumes = [
    "sandboxr-data-acme-tkt-1",
    "sandboxr-www-acme-tkt-1",
    "sandboxr-bin-acme-tkt-1",
    "sandboxr-blob-acme-tkt-1",
    "sandboxr-data-acme-tkt-2",
    "sandboxr-gocache",
    "sandboxr-claude",
    "postgres-data",
  ];

  it("counts a reaped sandbox's volumes as orphans", () => {
    const plan = planGc({ sandboxes: [sandbox({ slug: "tkt-1" })], volumes, worktreeExists: gone });
    expect(plan.volumes).toContain("sandboxr-data-acme-tkt-1");
    expect(plan.volumes).toContain("sandboxr-data-acme-tkt-2");
  });

  it("never counts a survivor's volumes as orphans", () => {
    const plan = planGc({ sandboxes: [sandbox({ slug: "tkt-1" })], volumes, worktreeExists: alive });
    expect(plan.volumes).not.toContain("sandboxr-data-acme-tkt-1");
    expect(plan.volumes).not.toContain("sandboxr-www-acme-tkt-1");
    expect(plan.volumes).toContain("sandboxr-data-acme-tkt-2");
  });

  it("leaves the shared volumes alone", () => {
    const plan = planGc({ sandboxes: [], volumes, worktreeExists: alive });
    expect(plan.volumes).not.toContain("sandboxr-gocache");
  });

  // The failure this guards against is silent and expensive: the Claude volume
  // holds every MCP credential authorised on the machine, so reaping it logs the
  // person out of every server at once, and nothing about deleting a sandbox
  // would explain why.
  it("keeps the Claude credential volume even when every sandbox is reaped", () => {
    const plan = planGc({
      sandboxes: [sandbox({ slug: "tkt-1" }), sandbox({ slug: "tkt-2" })],
      volumes,
      worktreeExists: gone,
      mountedVolumes: new Set(),
    });
    expect(plan.keep).toEqual([]);
    expect(plan.volumes).not.toContain("sandboxr-claude");
  });

  it("ignores anything that is not ours", () => {
    const plan = planGc({ sandboxes: [], volumes, worktreeExists: alive });
    expect(plan.volumes).not.toContain("postgres-data");
  });

  it("never removes a volume something has mounted", () => {
    const plan = planGc({
      sandboxes: [],
      volumes: ["sandboxr-data-acme-tkt-9"],
      worktreeExists: alive,
      mountedVolumes: new Set(["sandboxr-data-acme-tkt-9"]),
    });
    expect(plan.volumes).toEqual([]);
  });

  // A dependency volume is keyed on a lockfile rather than on a sandbox, so
  // without a mount list there is no way to tell a shared one from a dead one.
  it("leaves a dependency volume alone until a mount list proves it unused", () => {
    const withoutMounts = planGc({ sandboxes: [], volumes: ["sandboxr-deps-abc123"], worktreeExists: alive });
    expect(withoutMounts.volumes).toEqual([]);

    const withMounts = planGc({
      sandboxes: [],
      volumes: ["sandboxr-deps-abc123"],
      worktreeExists: alive,
      mountedVolumes: new Set(),
    });
    expect(withMounts.volumes).toEqual(["sandboxr-deps-abc123"]);
  });
});
