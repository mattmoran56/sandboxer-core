/**
 * Deciding what to reap.
 *
 * A pure function of what `docker ps` and `docker volume ls` report, plus two
 * questions about each worktree. Separated from the removal so the plan can be
 * printed, tested and — with `--dry-run` — inspected before anything is deleted.
 */

import { SHARED_VOLUMES, volumeName, type VolumePurpose } from "../naming.js";
import { depsVolumeName } from "../naming.js";
import type { GcPlan, Sandbox } from "./types.js";

const PURPOSES: VolumePurpose[] = ["data", "blob", "bin", "www"];

export interface GcInput {
  sandboxes: Sandbox[];
  volumes: string[];
  /**
   * Whether each sandbox's worktree is still on disk.
   *
   * Checked on the filesystem rather than with git's own worktree list, because
   * a worktree removed with a plain delete leaves a stale entry in git's admin
   * files that would keep it looking alive.
   */
  worktreeExists: (path: string) => boolean;
  /** Branches whose work is finished, so their sandboxes can go. */
  mergedBranches?: Set<string> | undefined;
  /** Volumes currently mounted by a live container, which are never orphans. */
  mountedVolumes?: Set<string> | undefined;
}

export function planGc(input: GcInput): GcPlan {
  const reap: GcPlan["reap"] = [];
  const keep: Sandbox[] = [];

  for (const sandbox of input.sandboxes) {
    if (sandbox.worktree !== "" && !input.worktreeExists(sandbox.worktree)) {
      reap.push({ sandbox, reason: `its worktree is gone (${sandbox.worktree})` });
      continue;
    }
    if (input.mergedBranches?.has(sandbox.branch)) {
      reap.push({ sandbox, reason: `${sandbox.branch} is merged` });
      continue;
    }
    keep.push(sandbox);
  }

  return { reap, volumes: orphanVolumes({ ...input, survivors: keep }), keep };
}

/**
 * Volumes no surviving sandbox owns.
 *
 * Worked out by asking which volumes the survivors *would* have rather than by
 * parsing names: both a project name and a slug may contain dashes, so a name
 * cannot be split back into its parts unambiguously — and a wrong split here
 * deletes someone's database.
 */
export function orphanVolumes(input: GcInput & { survivors: Sandbox[] }): string[] {
  const owned = new Set<string>(SHARED_VOLUMES);
  for (const sandbox of input.survivors) {
    for (const purpose of PURPOSES) owned.add(volumeName(purpose, sandbox.project, sandbox.slug));
  }
  for (const volume of input.mountedVolumes ?? []) owned.add(volume);

  return input.volumes
    .filter((volume) => volume.startsWith("sandboxr-"))
    .filter((volume) => !owned.has(volume))
    // A dependency volume is keyed on a lockfile rather than on a sandbox, so it
    // is shared and only an unmounted one is an orphan. Without a mount list
    // there is no way to know, so it is left alone.
    .filter((volume) => !(volume.startsWith(depsVolumeName("")) && input.mountedVolumes === undefined))
    .sort();
}
