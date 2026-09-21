// Tests for the reaping plan:
// - planGc: a sandbox whose worktree is gone is reaped; one whose worktree is there is kept
// - planGc: a merged branch is reaped when the caller supplies the list, and not otherwise
// - planGc: a sandbox with no recorded worktree is never reaped for that reason
// - orphanVolumes: volumes of a reaped sandbox are orphans, volumes of a survivor are not
// - orphanVolumes: the shared volumes are never orphans, and a mounted volume is never an orphan
// - orphanVolumes: reaping every sandbox still leaves a volume the caller reserved, and any name the engine did not mint
// - orphanVolumes: a dependency volume is left alone unless a mount list proves it unused
// - orphanVolumes: nothing outside the sandboxr prefix is ever considered
// - orphanVolumes: a work volume is never an orphan — not with no container, not
//   with every sandbox on the machine reaped, not with an empty mount list, and
//   not when its own session's runtime is being reaped beside it (Jef's §9.8)
// - supersededImages: an older image of a project is offered, and named by what replaced it
// - supersededImages: the newest image of every project survives, so the next `up` is a start
// - supersededImages: an image any container references is left alone, running or stopped
// - supersededImages: sandboxr/base and sandboxr/dashboard are never superseded
// - supersededImages: a repository the CALLER reserves is never superseded either,
//   which is how an embedder adds to the never-reclaimed list without the engine
//   having to know the embedder's names
// - supersededImages: an image outside the sandboxr namespace is not ours to remove
// - supersededImages: a dangling image is left to `docker image prune`
// - supersededImages: an image docker gave no creation time for is left alone
// - planGc: no image listing means no image is reaped, which is not "there are none"

import { describe, expect, it } from "vitest";

import { BASE_IMAGE } from "../access/index.js";
import type { ImageRow } from "../docker.js";
import { planGc, supersededImages } from "./gc.js";
import type { Sandbox } from "./types.js";

/**
 * A name the engine reserves and never builds — see `PROTECTED_IMAGES`.
 *
 * Spelled here rather than imported: the image belongs to the product now, and
 * the engine cannot import the product. The *reservation* is the engine's.
 */
const DASHBOARD_IMAGE_NAME = "sandboxr/dashboard";

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
    "sandboxr-jef-agent",
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

  /**
   * A volume an embedder mounts into every sandbox, when every sandbox is reaped.
   *
   * The failure this guards against is silent and expensive. Jef's is a coding
   * agent's credential store, which holds every MCP server authorised on the
   * machine: reaping it signs the person out of all of them at once, and nothing
   * about deleting a sandbox would explain why. It is also exactly the shape
   * that looks reclaimable — shared by every sandbox, and therefore referenced
   * by none of them the moment they are all stopped.
   *
   * Two things keep it, and the test asserts both separately because the weaker
   * one is the one that holds when nobody remembered to say anything. The name
   * here is deliberately under `sandboxr-`, where a name-prefix test alone would
   * not save it.
   */
  it("keeps a volume the caller reserved, even when every sandbox is reaped", () => {
    const plan = planGc({
      sandboxes: [sandbox({ slug: "tkt-1" }), sandbox({ slug: "tkt-2" })],
      volumes,
      worktreeExists: gone,
      mountedVolumes: new Set(),
      protectVolumes: ["sandboxr-jef-agent"],
    });
    expect(plan.keep).toEqual([]);
    expect(plan.volumes).not.toContain("sandboxr-jef-agent");
  });

  // And the weaker guarantee, which holds with no `protectVolumes` at all: the
  // engine proposes only names of the two shapes it mints — `sandboxr-<purpose>-…`
  // and `sandboxr-deps-…` — so a name in somebody else's shape is out of scope
  // before any list is consulted. `protectVolumes` is what makes that a promise
  // rather than luck about a spelling.
  it("proposes only a name it minted itself", () => {
    const plan = planGc({
      sandboxes: [sandbox({ slug: "tkt-1" }), sandbox({ slug: "tkt-2" })],
      volumes,
      worktreeExists: gone,
      mountedVolumes: new Set(),
    });
    expect(plan.volumes).not.toContain("sandboxr-jef-agent");
    expect(plan.volumes).toContain("sandboxr-data-acme-tkt-1");
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

// Jef's §9.8, fourth reclamation rule, and the one with the worst failure
// behind it: a work volume holds a session's clones and every uncommitted change
// in them, and there is no second copy anywhere. Every case below is a shape in
// which the rest of this file's reasoning says "reap it".
describe("a work volume is never reclaimed", () => {
  const work = "sandboxr-work-eng-3941";

  it("is not an orphan when no container references it", () => {
    // The ordinary state of a stopped session, and the exact case the orphan
    // rule was written to catch for every other kind of volume.
    const plan = planGc({ sandboxes: [], volumes: [work], worktreeExists: alive, mountedVolumes: new Set() });
    expect(plan.volumes).toEqual([]);
  });

  it("is not an orphan with no mount list at all", () => {
    expect(planGc({ sandboxes: [], volumes: [work], worktreeExists: alive }).volumes).toEqual([]);
  });

  it("survives every sandbox on the machine being reaped", () => {
    const plan = planGc({
      sandboxes: [sandbox({ slug: "tkt-1" }), sandbox({ slug: "tkt-2" })],
      volumes: [work, "sandboxr-data-acme-tkt-1", "sandboxr-data-acme-tkt-2"],
      worktreeExists: gone,
      mountedVolumes: new Set(),
    });
    expect(plan.keep).toEqual([]);
    expect(plan.volumes).toEqual(["sandboxr-data-acme-tkt-1", "sandboxr-data-acme-tkt-2"]);
  });

  it("survives its own session's runtime being reaped beside it", () => {
    // Deleting a runtime takes that runtime's data and never the work volume:
    // the code in it is what every other runtime of the session is running from.
    const plan = planGc({
      sandboxes: [sandbox({ slug: "eng-3941-web" })],
      volumes: [work, "sandboxr-data-acme-eng-3941-web"],
      worktreeExists: gone,
      mountedVolumes: new Set(),
    });
    expect(plan.volumes).toEqual(["sandboxr-data-acme-eng-3941-web"]);
  });

  it("keeps every session's volume, not just one", () => {
    const plan = planGc({
      sandboxes: [],
      volumes: [work, "sandboxr-work-doc-only", "sandboxr-work-a"],
      worktreeExists: alive,
      mountedVolumes: new Set(),
    });
    expect(plan.volumes).toEqual([]);
  });
});

function image(overrides: Partial<ImageRow> & { repository: string; tag: string }): ImageRow {
  return {
    id: overrides.tag,
    created: new Date("2026-08-01T00:00:00.000Z"),
    size: 6_000_000_000,
    uniqueSize: 5_340_000_000,
    containers: 0,
    ...overrides,
  };
}

const older = image({ repository: "sandboxr/acme", tag: "40ed880f9db8" });
const newer = image({
  repository: "sandboxr/acme",
  tag: "48273eacdece",
  created: new Date("2026-08-27T00:00:00.000Z"),
});

// Five of these at six gigabytes each is what filled a Docker VM, and the
// symptom was a database that would not initialise. The rule is deliberately the
// same one `prune` uses — it is literally this function — so the two commands
// cannot come to different conclusions about an image worth that much.
describe("superseded images", () => {
  it("offers the older image of a project, and names what replaced it", () => {
    const offered = supersededImages([older, newer]);
    expect(offered).toHaveLength(1);
    expect(offered[0]?.reference).toBe("sandboxr/acme:40ed880f9db8");
    expect(offered[0]?.reason).toContain("48273eacdece");
    // The unique size, not the reported one: the two images share the whole base
    // layer, so the total would promise back disk that removal cannot deliver.
    expect(offered[0]?.size).toBe(5_340_000_000);
  });

  // The image is what makes the next `up` a start rather than a toolchain build,
  // so a project whose sandboxes are all down still keeps one.
  it("keeps the newest image of a project even when nothing is using it", () => {
    expect(supersededImages([newer])).toEqual([]);
  });

  // The whole cost of being wrong here lands on somebody else: a stopped sandbox
  // still holds its image and is meant to start again.
  it("leaves an old image any container still references", () => {
    expect(supersededImages([{ ...older, containers: 1 }, newer])).toEqual([]);
  });

  it("never supersedes the machine's own images", () => {
    const offered = supersededImages([
      image({ repository: BASE_IMAGE, tag: "latest" }),
      image({ repository: BASE_IMAGE, tag: "0.1.0", created: new Date("2026-08-27T00:00:00.000Z") }),
      image({ repository: DASHBOARD_IMAGE_NAME, tag: "latest" }),
      image({ repository: DASHBOARD_IMAGE_NAME, tag: "0.1.0", created: new Date("2026-08-27T00:00:00.000Z") }),
    ]);
    expect(offered).toEqual([]);
  });

  /**
   * The embedder's half of the never-reclaimed list (contracts §3.3).
   *
   * The engine reserves its own names in `PROTECTED_IMAGES`; a product hands its
   * own in, and the engine keeps them on the caller's word. Asserted with a
   * repository inside the `sandboxr/` namespace deliberately: Jef's real extra
   * name, `jef/base`, is outside it and would be kept by the namespace test
   * whatever this list said, so a test using it could not tell the mechanism from
   * the coincidence. Jef's dashboard, workstation and orchestrator images *are*
   * under `sandboxr/`, and this is what they would rely on.
   */
  it("never supersedes a repository the caller reserved", () => {
    const rows = [
      image({ repository: "sandboxr/embedder", tag: "0.1.0" }),
      image({ repository: "sandboxr/embedder", tag: "latest", created: new Date("2026-08-27T00:00:00.000Z") }),
    ];
    expect(supersededImages(rows)).toHaveLength(1);
    expect(supersededImages(rows, ["sandboxr/embedder"])).toEqual([]);
  });

  // The caller's list is added to the engine's, never substituted for it: a
  // product that passed only its own names must not make the base image reapable.
  it("adds to the engine's reservations rather than replacing them", () => {
    const offered = supersededImages(
      [
        image({ repository: BASE_IMAGE, tag: "latest" }),
        image({ repository: BASE_IMAGE, tag: "0.1.0", created: new Date("2026-08-27T00:00:00.000Z") }),
      ],
      ["jef/base"],
    );
    expect(offered).toEqual([]);
  });

  it("leaves images that are not ours alone", () => {
    const offered = supersededImages([
      image({ repository: "mysql", tag: "8.4" }),
      image({ repository: "mysql", tag: "latest", created: new Date("2026-08-27T00:00:00.000Z") }),
    ]);
    expect(offered).toEqual([]);
  });

  // A dangling layer may belong to a build running right now, and no name
  // sandboxr gave it addresses it. `docker image prune` owns that set.
  it("leaves a dangling image to docker's own prune", () => {
    expect(supersededImages([image({ repository: "sandboxr/acme", tag: "<none>" }), newer])).toEqual([]);
    expect(supersededImages([image({ repository: "<none>", tag: "<none>" }), newer])).toEqual([]);
  });

  // Undefined is docker declining to answer, and "I do not know when this was
  // built" must never sort an image to the front of the queue for deletion.
  it("leaves an image with no creation time alone", () => {
    expect(supersededImages([{ ...older, created: undefined }, newer])).toEqual([]);
  });
});

describe("planGc images", () => {
  const input = { sandboxes: [], volumes: [], worktreeExists: alive };

  it("reaps a superseded image when it is given the listing", () => {
    expect(planGc({ ...input, images: [older, newer] }).images.map((entry) => entry.reference)).toEqual([
      "sandboxr/acme:40ed880f9db8",
    ]);
  });

  // The same doctrine as a dependency volume with no mount list: the evidence
  // that an image is superseded is a listing holding the one that replaced it,
  // so with no listing there is nothing to conclude. `gc` reaches here whenever
  // `docker system df` would not answer, and reaping on a guess would take an
  // image somebody's next `up` was going to start from.
  it("offers nothing at all when no image listing was supplied", () => {
    expect(planGc(input).images).toEqual([]);
  });
});
