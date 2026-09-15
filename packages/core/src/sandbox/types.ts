/**
 * The shapes the lifecycle deals in.
 *
 * `Sandbox` is exactly what the labels in contracts §3.4 carry, plus the two
 * things only docker can answer — the container's name and its state. Nothing
 * here is stored on the host: every field is read back from the container it
 * describes, so the list cannot disagree with what is running.
 */

import type { ResolvedConfig } from "../config/types.js";
import type { Docker } from "../docker.js";
import type { SeedSource } from "../drivers/types.js";
import type { RuntimeRequest } from "../session/runtime.js";

export type SandboxState = "stopped" | "starting" | "running" | "degraded";

/**
 * Which of a session's containers something is (contracts §12.3).
 *
 * Here rather than beside the runtime code because it is what a *label* says,
 * and `Sandbox` is the shape the labels come back as.
 */
export type SandboxKind = "workstation" | "runtime";

export interface Sandbox {
  project: string;
  slug: string;
  branch: string;
  commit: string;
  dirty: boolean;
  worktree: string;
  driver: string;
  access: "public" | "private";
  created: string;
  /**
   * How long the sandbox may run for: seconds as a string, or `never`.
   *
   * A duration rather than a deadline, because the deadline is measured from
   * the container's current start time — see the note in `labels.ts`.
   */
  ttl: string;
  /**
   * The digest of the environment the sandbox was started with, or `""` when
   * the container carries no such label.
   *
   * Empty is *unknown*, not "no environment". Compare it against `envDigest`
   * over the project's current secrets and plan `env` map to tell whether a
   * sandbox predates a change; treat empty as no answer, because every sandbox
   * started before this label existed has none.
   */
  env: string;
  /**
   * Which of a session's containers this is (contracts §12.3).
   *
   * A container with no `sandboxr.kind` label is a pre-session sandbox and reads
   * as `runtime`, so this is never empty and a caller never has to handle a
   * third value.
   */
  kind: SandboxKind;
  /**
   * The session this sandbox belongs to, or `""` for one that belongs to none.
   *
   * Empty is the ordinary answer for every worktree-backed sandbox, which is
   * every sandbox running today.
   */
  session: string;
  state: SandboxState;
  container: string;
}

export interface ServiceHealth {
  name: string;
  label: string;
  port: number;
  up: boolean;
  url: string;
}

export interface SandboxStatus extends Sandbox {
  /** Hostname per label, so a caller does not rebuild the naming scheme. */
  urls: Record<string, string>;
  services: ServiceHealth[];
  migrations: "ok" | "failed" | "pending";
  /** Static apps this sandbox has actually built. */
  built: string[];
  /** True when the worktree the sandbox was started from is gone from disk. */
  worktreeMissing: boolean;
}

export interface CommonOptions {
  docker?: Docker | undefined;
  env?: NodeJS.ProcessEnv | undefined;
  log?: ((line: string) => void) | undefined;
}

export interface UpOptions extends CommonOptions {
  /**
   * Start a **session's runtime** instead: a sandbox whose `/workspace` is a
   * checkout in the session's work volume (contracts §12.4).
   *
   * Every other option still means what it says — a runtime is a sandbox — with
   * two exceptions it makes no sense to combine with. `worktree`, `project` and
   * `branch` are about finding a checkout on the host, and a session has none;
   * `slug` is ignored, because a runtime's slug is a pure function of the
   * session and the runtime name (§12.2) and nothing may give it another.
   */
  runtime?: RuntimeRequest | undefined;
  /** The worktree to run. Defaults to the directory the config was found in. */
  worktree?: string | undefined;
  /**
   * A project in the workspace, resolved to a worktree when no path is given.
   *
   * This is what lets something with no working directory of its own — the
   * dashboard — start a sandbox. The CLI passes a path and never reaches it.
   */
  project?: string | undefined;
  /** The branch to run, found or created under the project's worktrees. */
  branch?: string | undefined;
  /** When set, `branch` is created off this ref rather than expected to exist. */
  base?: string | undefined;
  /** How long the sandbox may live: seconds, a span like `8h`, or `never`. */
  ttl?: string | undefined;
  /** An explicit slug, which beats every derivation. */
  slug?: string | undefined;
  config?: ResolvedConfig | undefined;
  /** Optional runtimes to start, by name or label. */
  with?: string[] | undefined;
  /** Force one seed source rather than taking the preferred available one. */
  seed?: SeedSource | undefined;
  /** Replace an existing container for this slug rather than refusing. */
  replace?: boolean | undefined;
  /** Skip the wait for the container to answer, for a caller that polls itself. */
  detach?: boolean | undefined;
  /** Seconds to wait for the sandbox to come up. */
  timeoutSeconds?: number | undefined;
}

export interface DownOptions extends CommonOptions {
  /** Keep the volumes, so the database and uploads survive. */
  keep?: boolean | undefined;
}

/**
 * What a teardown actually removed.
 *
 * Named artefacts rather than a count, because the caller this exists for is
 * `deleteWorktree`, which reports its work item by item — a destructive
 * operation that answers "done" leaves the reader to check by hand whether the
 * container they were worried about is gone. A name here is a container name, a
 * volume name or an absolute path, and only ever one that really went: a volume
 * docker had already reclaimed, or a file the host refused to remove, is absent.
 */
export interface DownReport {
  removed: string[];
}

export interface ListOptions extends CommonOptions {
  /** Only sandboxes of one project. */
  project?: string | undefined;
  /**
   * Only the runtimes of one session (contracts §12.4).
   *
   * A runtime *is* a sandbox to everything downstream, so a session's runtimes
   * are listed here rather than by a second lister that would have to rebuild
   * the same states from the same labels. The join is the `sandboxr.session`
   * label and never a list the session keeps: §3.4's rule, which is what stops
   * a session becoming the manifest this codebase has no room for.
   */
  session?: string | undefined;
}

export interface StatusOptions extends CommonOptions {
  config?: ResolvedConfig | undefined;
}

export type ReloadKind = "backend" | "frontend" | "migrate";

export interface ReloadOptions extends CommonOptions {
  kind: ReloadKind;
  /**
   * What to rebuild: a backend name, a front-end label, `all` for everything a
   * build-everything request covers, or `built` for what this sandbox has
   * actually built already.
   */
  target?: string | undefined;
  config?: ResolvedConfig | undefined;
}

export interface ReloadResult {
  kind: ReloadKind;
  built: string[];
  failed: string[];
  output: string;
}

export interface ExpireOptions extends CommonOptions {
  /** Report what would be stopped without stopping it. */
  dryRun?: boolean | undefined;
  /** Only sandboxes of one project. */
  project?: string | undefined;
  /** The moment to judge against. Injectable so a test needs no clock. */
  now?: Date | undefined;
}

export interface GcOptions extends CommonOptions {
  /** Report what would be removed without removing it. */
  dryRun?: boolean | undefined;
  /** Branch names whose work is finished, so their sandboxes can be reaped. */
  mergedBranches?: string[] | undefined;
}

export interface PruneOptions extends CommonOptions {
  /**
   * Carry the plan out rather than only reporting it.
   *
   * The inverse of `gc`'s `--dry-run`, and still deliberately so, though not for
   * the reason it was. It used to be that only this command removed images; `gc`
   * takes the same superseded ones now, and none of those costs a rebuild — the
   * tag is a hash of a build no future `up` can ask for. What is left to guard is
   * what this reaches and `gc` does not: Docker's build cache, which every other
   * project on the daemon wrote into as well.
   */
  apply?: boolean | undefined;
  /** Include Docker's build cache, which sandboxr is not the only writer of. */
  buildCache?: boolean | undefined;
}

/**
 * One image a reclaiming command may remove, and why.
 *
 * Shared between `gc` and `prune` because both decide it with the same function
 * — `supersededImages` in ./gc.ts. Two implementations of "which image is
 * replaced" would be two answers to a question worth gigabytes.
 */
export interface PrunableImage {
  /** `repository:tag`, which is what `docker image rm` is given. */
  reference: string;
  id: string;
  /**
   * Bytes only this image holds.
   *
   * The *unique* size, never the total: a project image and the one it replaced
   * share the whole base layer, so quoting their totals would promise back the
   * base image twice over.
   */
  size: number;
  reason: string;
}

export interface GcPlan {
  /** Sandboxes to remove, with the reason each was chosen. */
  reap: Array<{ sandbox: Sandbox; reason: string }>;
  /** Volumes no live sandbox owns. */
  volumes: string[];
  /**
   * Project images a newer build has replaced.
   *
   * Empty when the caller supplied no image listing, which is not the same as
   * "there are none" — see `GcInput.images`.
   */
  images: PrunableImage[];
  keep: Sandbox[];
}

export interface UpResult {
  sandbox: Sandbox;
  urls: Record<string, string>;
  /** Present when the sandbox came up but its migrations did not. */
  migrationFailure?: string | undefined;
  seed: { source: SeedSource; description: string };
}
