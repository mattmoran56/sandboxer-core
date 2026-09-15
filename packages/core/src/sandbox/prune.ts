/**
 * Deciding what disk can be handed back.
 *
 * Where `gc` reaps *sandboxes* — a container whose worktree has gone, and the
 * volumes that go with it — this is the whole-machine report: orphaned volumes,
 * the project images a newer build has replaced, and, when asked, Docker's build
 * cache. It is the only one of the two that puts a number against each of them.
 *
 * Superseded images are **not** this command's alone any more. `gc` reaps them
 * too, and both go through one `supersededImages`, which moved to ./gc.ts to sit
 * beside the volume doctrine it copies. Leaving them to a command that has to be
 * asked twice is how roughly six gigabytes a project a rebuild accumulated until
 * a machine ran out of disk. What is left here that `gc` does not do is the
 * report — sizes, a total, and the build cache, which sandboxr is not the only
 * writer of.
 *
 * A pure function of what `docker system df` reports, for the same reason the
 * collector is: the plan has to be printable and checkable before anything is
 * deleted, and an image here can be twenty minutes of rebuilding.
 */

import type { BuildCacheRow, ImageRow, VolumeRow } from "../docker.js";
import { orphanVolumes, supersededImages } from "./gc.js";
import type { PrunableImage, Sandbox } from "./types.js";

export type { PrunableImage } from "./types.js";

export interface PrunableVolume {
  name: string;
  /** Bytes docker says the volume holds. */
  size: number;
}

export interface PruneInput {
  /** Every sandbox on the machine. Their volumes and images are never orphans. */
  sandboxes: Sandbox[];
  volumes: VolumeRow[];
  images: ImageRow[];
  buildCache: BuildCacheRow[];
  /** Volumes a live container has mounted, which are never orphans. */
  mountedVolumes?: Set<string> | undefined;
  /**
   * Whether the build cache may actually be removed.
   *
   * Off unless asked, and the plan reports the cache either way. The cache is
   * Docker's rather than sandboxr's — other projects on the same daemon built
   * into it too — so taking it as part of routine housekeeping would delete work
   * sandboxr never created. Its size still belongs in the report: on a machine
   * that has run out of room it is usually the largest number on the page, and
   * leaving it out would make the report look like the whole answer.
   */
  includeBuildCache?: boolean | undefined;
}

export interface PrunePlan {
  volumes: PrunableVolume[];
  images: PrunableImage[];
  /**
   * Docker's build cache: how much of it would come back, and whether this run
   * may take it.
   *
   * `records` counts everything a prune would delete; `size` counts only the
   * bytes an image is not also holding, which is the smaller of the two figures
   * and the only one that becomes free disk. Docker's own `system df` draws the
   * line in the same place, so the two agree on screen.
   */
  buildCache: { records: number; size: number; inScope: boolean };
  /** Bytes the volumes and images together would free. */
  freed: number;
}

export interface PruneResult extends PrunePlan {
  /** True when the plan was carried out rather than only reported. */
  applied: boolean;
  /**
   * What was actually removed.
   *
   * Kept separate from the plan rather than folded into it: docker can refuse
   * an item between planning and removing — a container started against an
   * image in the meantime — and a report that quietly claimed the plan was the
   * outcome would be wrong exactly when it mattered.
   */
  removed: { volumes: string[]; images: string[]; buildCacheBytes: number };
}

/**
 * What can go, and why.
 *
 * Deliberately conservative in four places, each of which has a cost attached to
 * being wrong: a session's work volume is never touched, whatever its session is
 * doing (contracts §12.8 — `orphanVolumes` is where that is enforced, and losing
 * one is losing somebody's uncommitted work); the shared volumes are never
 * touched either (`sandboxr-claude` holds a credential); the newest image of
 * every project stays so the next `up` is a start rather than a build; and an
 * image whose creation time docker did not report is left alone rather than
 * guessed at.
 *
 * The first of those is inherited rather than repeated. Volumes come from one
 * `orphanVolumes` for the same reason superseded images come from one
 * `supersededImages`: two commands that could disagree about what is rubbish
 * would disagree exactly once, in the direction that deletes something.
 */
export function planPrune(input: PruneInput): PrunePlan {
  const orphans = new Set(
    orphanVolumes({
      volumes: input.volumes.map((volume) => volume.name),
      survivors: input.sandboxes,
      mountedVolumes: input.mountedVolumes,
    }),
  );
  const volumes = input.volumes
    .filter((volume) => orphans.has(volume.name))
    .map((volume) => ({ name: volume.name, size: volume.size }))
    .sort((a, b) => a.name.localeCompare(b.name));

  const images = supersededImages(input.images);

  const unused = input.buildCache.filter((record) => !record.inUse);
  const buildCache = {
    records: unused.length,
    size: unused.filter((record) => !record.shared).reduce((total, record) => total + record.size, 0),
    inScope: input.includeBuildCache === true,
  };

  const freed =
    volumes.reduce((total, volume) => total + volume.size, 0) +
    images.reduce((total, image) => total + image.size, 0);

  return { volumes, images, buildCache, freed };
}

const UNITS = ["B", "kB", "MB", "GB", "TB"] as const;

/**
 * Bytes as docker spells them, so a plan reads like `docker system df`.
 *
 * Decimal rather than binary units, because that is what the numbers here are
 * compared against: a figure printed as `5.7 GiB` beside docker's own `6.01GB`
 * for the same image invites the reader to conclude one of them is wrong.
 */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 B";
  let value = bytes;
  let unit = 0;
  while (value >= 1000 && unit < UNITS.length - 1) {
    value /= 1000;
    unit += 1;
  }
  return `${unit === 0 ? Math.round(value) : value.toFixed(value < 10 ? 1 : 0)} ${UNITS[unit]}`;
}
