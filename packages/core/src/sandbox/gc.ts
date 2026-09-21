/**
 * Deciding what to reap.
 *
 * A pure function of what `docker ps`, `docker volume ls` and `docker system df`
 * report, plus two questions about each worktree. Separated from the removal so
 * the plan can be printed, tested and — with `--dry-run` — inspected before
 * anything is deleted.
 */

import type { ImageRow } from "../docker.js";
import {
  IMAGE_NAMESPACE,
  PROTECTED_IMAGES,
  SHARED_VOLUMES,
  isWorkVolume,
  volumeName,
  volumePrefix,
  type VolumePurpose,
} from "../naming.js";
import { depsVolumeName } from "../naming.js";
import type { GcPlan, PrunableImage, Sandbox } from "./types.js";

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
  /**
   * Every image the daemon is storing, as `docker system df -v` reports it.
   *
   * Injected rather than read here, for the same reason `mountedVolumes` is: the
   * plan has to be assertable without a daemon, and what it decides about an
   * image is worth several gigabytes either way.
   *
   * **Absent means no image is reaped** — not "the machine has no images". The
   * only evidence that an image is superseded is a listing holding the one that
   * replaced it, so with no listing there is nothing to conclude, exactly as with
   * a dependency volume and a missing mount list below.
   */
  images?: ImageRow[] | undefined;
  /**
   * Repositories the *caller* declares are its own, never to be reclaimed.
   *
   * Unioned with `PROTECTED_IMAGES`, never replacing it, and it exists so that
   * an embedder can add to the never-reclaimed list without the engine having to
   * know the embedder's names. Jef passes `jef/base`, out of a list of its own,
   * and the engine keeps it on the caller's word rather than on a string spelt
   * in here.
   *
   * It is a promise and not the only thing keeping `jef/base` today: it is also
   * outside the `sandboxr/` namespace, which `supersededImages` already refuses
   * to look past. That is a fact about the name Jef happened to choose, and a
   * product that tagged its own image under `sandboxr/` — as Jef's dashboard,
   * workstation and orchestrator all do — would have nothing but this.
   */
  protectImages?: readonly string[] | undefined;
  /**
   * Volumes the *caller* declares are its own, never to be reclaimed.
   *
   * The volume half of `protectImages`, and it exists for a sharper reason.
   * `SHARED_VOLUMES` names the engine's two Go caches and nothing else, because
   * the engine cannot keep a list of names it does not mint — so a machine-wide
   * volume an embedder mounts into every sandbox (see `RunInput.volumes`) has to
   * be declared here or it is a volume with no sandbox behind it.
   *
   * Jef passes the agent's credential store, out of a list of its own. A shared
   * store is exactly the
   * shape that looks reclaimable and is not: every sandbox that mounts it may be
   * stopped at once, which is a machine at rest rather than a volume nobody
   * wants, and what goes with it is every login on the machine.
   *
   * As with images, it is a promise rather than the only thing: `orphanVolumes`
   * proposes only names of the shape the engine itself mints, so a name in
   * somebody else's shape is already out of scope. The promise is what makes
   * that true on purpose rather than by luck about a spelling.
   */
  protectVolumes?: readonly string[] | undefined;
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

  return {
    reap,
    volumes: orphanVolumes({ ...input, survivors: keep, protect: input.protectVolumes }),
    images: input.images ? supersededImages(input.images, input.protectImages) : [],
    keep,
  };
}

/**
 * Whether a volume name is one the engine mints.
 *
 * `volumeName` produces `sandboxr-<purpose>-<project>-<slug>` and
 * `depsVolumeName` produces `sandboxr-deps-<hash>`; those are the only two
 * shapes `up` ever creates. The name is not split back into its parts — both a
 * project and a slug may contain dashes — only recognised by its purpose.
 */
function mintedHere(volume: string): boolean {
  if (volume.startsWith(depsVolumeName(""))) return true;
  return PURPOSES.some((purpose) => volume.startsWith(volumePrefix(purpose)));
}

/**
 * Volumes no surviving sandbox owns.
 *
 * Worked out by asking which volumes the survivors *would* have rather than by
 * parsing names: both a project name and a slug may contain dashes, so a name
 * cannot be split back into its parts unambiguously — and a wrong split here
 * deletes someone's database.
 */
export function orphanVolumes(input: {
  volumes: string[];
  survivors: Sandbox[];
  mountedVolumes?: Set<string> | undefined;
  protect?: readonly string[] | undefined;
}): string[] {
  const owned = new Set<string>([...SHARED_VOLUMES, ...(input.protect ?? [])]);
  for (const sandbox of input.survivors) {
    for (const purpose of PURPOSES) owned.add(volumeName(purpose, sandbox.project, sandbox.slug));
  }
  for (const volume of input.mountedVolumes ?? []) owned.add(volume);

  return (
    input.volumes
      .filter((volume) => volume.startsWith("sandboxr-"))
      // **A name under the reserved prefix is never an orphan** (contracts
      // §3.3). Everything else in this function reads "no container references
      // it" as "nothing wants it", and for a name the engine did not mint that
      // reading is exactly backwards: only the embedder knows what is inside.
      //
      // The incident this rule came from is Jef's work volume (its §9.8). A session
      // whose workstation is stopped has no container at all — the ordinary
      // state of a session somebody comes back to next week — and what would go
      // is every clone and every uncommitted change in it. It is also invisible
      // to the mount list two lines down, which is built by inspecting the
      // *sandboxes*: a workstation carries no `sandboxr.slug`, so `list` never
      // sees it and nothing it holds ever reaches `mountedVolumes`.
      .filter((volume) => !isWorkVolume(volume))
      // **Only a name the engine itself mints is a candidate** — a per-sandbox
      // volume or a dependency volume. Everything else under the prefix belongs
      // to whoever mounted it, and "no container references it" means nothing
      // about a store that is shared by every sandbox on the machine and
      // therefore unreferenced the moment they are all stopped.
      //
      // Written as a shape test rather than as a longer keep-list because a
      // keep-list is a list the engine would have to be told about, and the day
      // it is not told is the day something is removed. `protect` above is the
      // embedder saying so out loud; this is what is true even when nobody did.
      .filter((volume) => mintedHere(volume))
      .filter((volume) => !owned.has(volume))
      // A dependency volume is keyed on a lockfile rather than on a sandbox, so
      // it is shared and only an unmounted one is an orphan. Without a mount list
      // there is no way to know, so it is left alone.
      .filter((volume) => !(volume.startsWith(depsVolumeName("")) && input.mountedVolumes === undefined))
      .sort()
  );
}

/**
 * Project images a newer build of the same project has replaced.
 *
 * The rule is "newest per repository survives", not "anything no container uses
 * is fair game", because a project whose sandboxes are all `down` still wants
 * its image: the tag is content-addressed, so the next `up` finds it and starts
 * in seconds rather than rebuilding a toolchain. What that leaves here is exactly
 * the accumulation the content hash causes — a base image rebuild or a tool
 * version bump changes the hash, and the image the old hash named is then
 * unreachable by any future `up`. That is why reaping one weighs no rebuild
 * against it: nothing will ever ask for that tag again.
 *
 * It is worth recording what made this urgent, because the symptom named none of
 * its cause. Roughly six gigabytes accumulates per project per rebuild and
 * nothing gave it back, so a machine reached a Docker VM at 100% with five
 * `sandboxr/<project>:<hash>` images holding about 31 GB between them. What that
 * looked like from inside a sandbox was a database that would not initialise.
 *
 * **The keep list is a union and never a filter**, exactly as `orphanVolumes` is.
 * An image survives if it is the newest of its repository, or its repository is
 * one of the machine's own, or the caller named it in `protect`, or it lies
 * outside the `sandboxr/` namespace, or any container references it, or docker
 * declined to say when it was created. Every one of those is a reason to keep,
 * and nothing here reads a missing answer as a licence to remove — a listing
 * that can hide something still in use is the staleness this whole design exists
 * to avoid.
 *
 * `protect` is the embedder's half of that union, and it is checked *before* the
 * namespace test rather than after: a product that tags its images under
 * `sandboxr/` — Jef's dashboard, workstation and orchestrator all do — gets the
 * same promise as one that chose a namespace of its own, without the engine
 * having to spell the product's names. See `GcInput.protectImages`.
 */
export function supersededImages(images: ImageRow[], protect: readonly string[] = []): PrunableImage[] {
  const reserved = new Set<string>([...PROTECTED_IMAGES, ...protect]);
  const byRepository = new Map<string, ImageRow[]>();
  for (const image of images) {
    if (reserved.has(image.repository)) continue;
    if (!image.repository.startsWith(IMAGE_NAMESPACE)) continue;
    // A dangling image is out of scope, and deliberately so rather than by
    // omission. It is an intermediate layer or a build whose tag has since moved
    // on; docker reports it as `<none>` — usually for the repository too, so the
    // namespace test above has already dropped it, and this is the second guard,
    // for the row shape where a repository outlives its tag. Nothing here can
    // tell such a layer apart from one a build running right now is producing,
    // and it is not addressable by any name sandboxr gave it. `docker image
    // prune` removes exactly this set and is the right tool for it.
    if (image.tag === "" || image.tag === "<none>") continue;
    if (image.created === undefined) continue;
    const group = byRepository.get(image.repository) ?? [];
    group.push(image);
    byRepository.set(image.repository, group);
  }

  const prunable: PrunableImage[] = [];
  for (const [repository, group] of byRepository) {
    const sorted = [...group].sort((a, b) => (b.created?.getTime() ?? 0) - (a.created?.getTime() ?? 0));
    const [newest, ...rest] = sorted;
    if (!newest) continue;
    for (const image of rest) {
      // A container still holding an old image is a stopped sandbox that can be
      // started again, and `docker image rm` would refuse anyway. Reporting it
      // as prunable would make the plan's total a number that never arrives.
      //
      // "How many containers" is a number docker sometimes declines to give, and
      // `parseDiskUsage` turns every such answer — `N/A`, a negative — into one
      // rather than zero, because zero is what licenses a deletion. The count is
      // also a snapshot taken before anything was reaped, so an image this very
      // run is about to free waits for the next one. Both are the conservative
      // direction, and it is the one to be wrong in.
      if (image.containers > 0) continue;
      prunable.push({
        reference: `${repository}:${image.tag}`,
        id: image.id,
        size: image.uniqueSize,
        reason: `${repository}:${newest.tag} replaced it`,
      });
    }
  }
  return prunable.sort((a, b) => b.size - a.size);
}
