// Tests for the container labels that hold all of a sandbox's state:
// - LABELS: every key from contracts §3.4 is present and namespaced
// - labelsFor: booleans as strings, an unresolvable branch or commit recorded as ?, an ISO timestamp
// - labelsFor: a ttl passed through as given, and defaulted to `never` when there is none
// - labelsFor: every sandbox is a runtime, and a session label only when it is in one
// - labelArgs: rendered as --label pairs, one argument each
// - sandboxFromLabels: a full round-trip, missing fields defaulted, a container that is not ours refused
// - sandboxFromLabels: a container predating the ttl label reads as `never`, never as already expired
// - sandboxFromLabels: a container with no kind reads as a runtime, and no session as ""
// - deriveState: stopped, starting, running, degraded, and that a failed migration outranks a successful marker

import { describe, expect, it } from "vitest";

import { resolveConfig } from "../config/load.js";
import { LABELS, deriveState, labelArgs, labelsFor, labelsFromConfig, sandboxFromLabels } from "./labels.js";

const input = {
  project: "acme",
  slug: "tkt-1",
  branch: "feat/thing",
  commit: "abc1234",
  dirty: false,
  worktree: "/repos/tkt-1",
  driver: "mysql",
  access: "public" as const,
  created: new Date("2026-08-25T09:00:00Z"),
};

describe("LABELS", () => {
  it("covers every label the contract lists", () => {
    expect(Object.keys(LABELS).sort()).toEqual([
      "access",
      "branch",
      "commit",
      "created",
      "dirty",
      "driver",
      "env",
      "kind",
      "project",
      "session",
      "slug",
      "ttl",
      "worktree",
    ]);
  });

  it("namespaces every key", () => {
    for (const key of Object.values(LABELS)) expect(key.startsWith("sandboxr.")).toBe(true);
  });
});

describe("labelsFor", () => {
  it("renders every field as a string", () => {
    const labels = labelsFor(input);
    expect(labels[LABELS.slug]).toBe("tkt-1");
    expect(labels[LABELS.dirty]).toBe("false");
    expect(labels[LABELS.created]).toBe("2026-08-25T09:00:00.000Z");
    expect(labels[LABELS.access]).toBe("public");
  });

  // Every sandbox this labels is a runtime — a worktree-backed one is what
  // §12.10 maps onto the noun — and the session label is *absent* rather than
  // empty for one that belongs to no session, because an empty string is a
  // value something will one day compare against.
  it("stamps the kind, and a session only when there is one", () => {
    expect(labelsFor(input)[LABELS.kind]).toBe("runtime");
    expect(LABELS.session in labelsFor(input)).toBe(false);
    expect(LABELS.session in labelsFor({ ...input, session: "" })).toBe(false);
    expect(labelsFor({ ...input, session: "eng-3941" })[LABELS.session]).toBe("eng-3941");
  });

  // Absent means never: a sandbox nobody gave a lifetime to is not one the
  // clock gets to decide about.
  it("defaults a missing ttl to never, and passes one through as given", () => {
    expect(labelsFor(input)[LABELS.ttl]).toBe("never");
    expect(labelsFor({ ...input, ttl: "8h" })[LABELS.ttl]).toBe("8h");
    expect(labelsFor({ ...input, ttl: "" })[LABELS.ttl]).toBe("never");
  });

  it("marks a dirty worktree", () => {
    expect(labelsFor({ ...input, dirty: true })[LABELS.dirty]).toBe("true");
  });

  // A missing label and an unknown branch would otherwise read the same, and
  // only one of them is a bug.
  it.each(["branch", "commit"] as const)("records an unresolvable %s as ?", (field) => {
    const labels = labelsFor({ ...input, [field]: "" });
    expect(labels[LABELS[field]]).toBe("?");
  });

  it("takes the project, driver and access mode from the config", () => {
    const config = resolveConfig(
      {
        project: "acme",
        sandboxr: ">=0.1.0",
        access: { apps: "private" },
        database: { driver: "sqlite", seed_from: { fixtures: "f.sql" }, migrate: { command: "m" } },
      },
      "/repo/sandboxr.yaml",
    );
    const labels = labelsFromConfig(config, {
      slug: "tkt-1",
      branch: "main",
      commit: "abc",
      dirty: false,
      worktree: "/w",
    });
    expect(labels[LABELS.project]).toBe("acme");
    expect(labels[LABELS.driver]).toBe("sqlite");
    expect(labels[LABELS.access]).toBe("private");
  });
});

describe("labelArgs", () => {
  it("renders one --label per pair, as separate arguments", () => {
    expect(labelArgs({ "sandboxr.slug": "tkt-1", "sandboxr.branch": "feat/a b" })).toEqual([
      "--label",
      "sandboxr.slug=tkt-1",
      "--label",
      "sandboxr.branch=feat/a b",
    ]);
  });
});

describe("sandboxFromLabels", () => {
  it("round-trips everything labelsFor wrote", () => {
    const sandbox = sandboxFromLabels(labelsFor(input), "sandboxr-acme-tkt-1", "running");
    expect(sandbox).toEqual({
      project: "acme",
      slug: "tkt-1",
      branch: "feat/thing",
      commit: "abc1234",
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
    });
  });

  // A container with no `sandboxr.kind` is a pre-session sandbox, which §12.3
  // says reads as a runtime — and an unknown word must fall back rather than be
  // passed through as something nothing downstream handles.
  it("reads a container with no kind as a runtime, and no session as none", () => {
    const bare = sandboxFromLabels({ [LABELS.slug]: "tkt-1", [LABELS.project]: "acme" }, "c", "running");
    expect(bare?.kind).toBe("runtime");
    expect(bare?.session).toBe("");
    expect(sandboxFromLabels({ [LABELS.slug]: "s", [LABELS.kind]: "future" }, "c", "running")?.kind).toBe("runtime");
    const ws = sandboxFromLabels(
      { [LABELS.slug]: "s", [LABELS.kind]: "workstation", [LABELS.session]: "eng-3941" },
      "c",
      "running",
    );
    expect(ws?.kind).toBe("workstation");
    expect(ws?.session).toBe("eng-3941");
  });

  // An unlabelled sandbox must never look already expired: the expiry planner
  // reads `never` as "no expiry set" and leaves it alone, whereas an empty
  // string would be a ttl it could not parse on a container it might stop.
  it("reads a container predating the ttl label as never", () => {
    expect(sandboxFromLabels({ [LABELS.slug]: "tkt-1" }, "c", "stopped")?.ttl).toBe("never");
  });

  // A stray container on the same daemon must never appear in the list.
  it("refuses a container with no slug label", () => {
    expect(sandboxFromLabels({ "com.example": "x" }, "postgres", "running")).toBeUndefined();
  });

  it("defaults the fields an older sandbox may not carry", () => {
    const sandbox = sandboxFromLabels({ [LABELS.slug]: "tkt-1" }, "c", "stopped");
    expect(sandbox).toMatchObject({ branch: "?", commit: "?", driver: "none", access: "public", dirty: false });
  });

  it("treats anything but the literal private as public", () => {
    expect(sandboxFromLabels({ [LABELS.slug]: "s", [LABELS.access]: "PUBLIC" }, "c", "running")?.access).toBe("public");
    expect(sandboxFromLabels({ [LABELS.slug]: "s", [LABELS.access]: "private" }, "c", "running")?.access).toBe(
      "private",
    );
  });

  it("rebuilds the container name when docker did not give one", () => {
    const sandbox = sandboxFromLabels({ [LABELS.slug]: "tkt-1", [LABELS.project]: "acme" }, "", "stopped");
    expect(sandbox?.container).toBe("sandboxr-acme-tkt-1");
  });
});

describe("deriveState", () => {
  it.each([
    ["a container that is not running", { containerState: "exited" }, "stopped"],
    ["one that was never started", { containerState: "created" }, "stopped"],
    ["running, with nothing said yet", { containerState: "running" }, "starting"],
    ["running, migrations done", { containerState: "running", migrateOk: true }, "running"],
    ["running, migrations failed", { containerState: "running", migrateFailed: true }, "degraded"],
    // A failed migration is the more important fact: it is why someone opened
    // the sandbox.
    [
      "both markers present",
      { containerState: "running", migrateOk: true, migrateFailed: true },
      "degraded",
    ],
  ] as const)("%s is %s", (_name, markers, want) => {
    expect(deriveState(markers)).toBe(want);
  });
});
