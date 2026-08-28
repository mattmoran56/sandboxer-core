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

export type SandboxState = "stopped" | "starting" | "running" | "degraded";

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

export interface ListOptions extends CommonOptions {
  /** Only sandboxes of one project. */
  project?: string | undefined;
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
   * The inverse of `gc`'s `--dry-run`, and deliberately so: what this removes is
   * an image that costs a toolchain rebuild to get back, so the safe answer has
   * to be the one you get by not passing anything.
   */
  apply?: boolean | undefined;
  /** Include Docker's build cache, which sandboxr is not the only writer of. */
  buildCache?: boolean | undefined;
}

export interface GcPlan {
  /** Sandboxes to remove, with the reason each was chosen. */
  reap: Array<{ sandbox: Sandbox; reason: string }>;
  /** Volumes no live sandbox owns. */
  volumes: string[];
  keep: Sandbox[];
}

export interface UpResult {
  sandbox: Sandbox;
  urls: Record<string, string>;
  /** Present when the sandbox came up but its migrations did not. */
  migrationFailure?: string | undefined;
  seed: { source: SeedSource; description: string };
}
