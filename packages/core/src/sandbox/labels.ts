/**
 * Container labels: the only place a sandbox's state is kept (contracts §3.4).
 *
 * There is no manifest file and no database of sandboxes, so `list` and `gc` are
 * pure functions of `docker ps` and nothing can drift out of sync. The cost of
 * that is real and worth naming: a running container's labels are immutable, so
 * a sandbox whose worktree has since moved on still reports the commit it
 * started from. Reporting that honestly beats keeping a second copy of the truth
 * on the host.
 */

import type { ResolvedConfig } from "../config/types.js";
import { containerName } from "../naming.js";
import type { Sandbox, SandboxState } from "./types.js";

export const LABELS = {
  project: "sandboxr.project",
  slug: "sandboxr.slug",
  branch: "sandboxr.branch",
  commit: "sandboxr.commit",
  dirty: "sandboxr.dirty",
  worktree: "sandboxr.worktree",
  driver: "sandboxr.driver",
  created: "sandboxr.created",
  access: "sandboxr.access",
  ttl: "sandboxr.ttl",
  env: "sandboxr.env",
} as const;

/**
 * There is deliberately no `sandboxr.expires` label.
 *
 * A deadline label is the obvious design and it is wrong. Labels hold durable
 * state (contracts §3.4): `sandboxr.created` is stamped once when the container
 * is created and never moves, so `created + ttl` is a fixed instant. The moment
 * the reaper stops an expired sandbox that instant is already in the past — so
 * pressing Restart would hand the next pass a sandbox that is still expired and
 * stop it again, and the button would look broken.
 *
 * The ttl is therefore stored as a *duration* and the deadline is derived from
 * the container's current start time, which docker updates on every restart.
 * See `expiry.ts`.
 */

/** The filter that finds every sandbox, whatever project it belongs to. */
export const SANDBOX_FILTER = `label=${LABELS.slug}`;

export interface LabelInput {
  project: string;
  slug: string;
  branch: string;
  commit: string;
  dirty: boolean;
  worktree: string;
  driver: string;
  access: "public" | "private";
  created?: Date | undefined;
  /** Seconds the sandbox may run for, or the word `never`. */
  ttl?: string | undefined;
  /**
   * A digest of the environment this sandbox was started with — the project's
   * secrets file and the plan's `env` map together (`envDigest` in
   * ../secrets.ts).
   *
   * Here rather than in a file beside the container for the reason §3.4 gives
   * for every other label: the container is the record. Comparing it against
   * today's digest is how the dashboard can say a sandbox was started before a
   * credential was rotated, and an absent label reads as *unknown*, not as
   * stale — every sandbox running before this existed has none.
   */
  env?: string | undefined;
}

export function labelsFor(input: LabelInput): Record<string, string> {
  return {
    [LABELS.project]: input.project,
    [LABELS.slug]: input.slug,
    // A branch name that cannot be resolved is recorded as `?` rather than
    // omitted: a missing label and an unknown branch would otherwise read the
    // same, and only one of them is a bug.
    [LABELS.branch]: input.branch === "" ? "?" : input.branch,
    [LABELS.commit]: input.commit === "" ? "?" : input.commit,
    [LABELS.dirty]: input.dirty ? "true" : "false",
    [LABELS.worktree]: input.worktree,
    [LABELS.driver]: input.driver,
    [LABELS.created]: (input.created ?? new Date()).toISOString(),
    [LABELS.access]: input.access,
    // Absent means never: a sandbox nobody gave a lifetime to is not one the
    // clock gets to decide about.
    [LABELS.ttl]: input.ttl === undefined || input.ttl === "" ? "never" : input.ttl,
    // Written even when it is the digest of nothing, because "this sandbox
    // started with no credentials and none are set" and "this sandbox is from
    // before sandboxr stamped this" are different facts and only one of them
    // means the dashboard has to keep quiet.
    [LABELS.env]: input.env ?? "",
  };
}

export function labelsFromConfig(
  config: ResolvedConfig,
  input: Omit<LabelInput, "project" | "driver" | "access">,
): Record<string, string> {
  return labelsFor({
    ...input,
    project: config.project,
    driver: config.database.driver,
    access: config.access.apps,
  });
}

/** Renders labels as `docker run` arguments. */
export function labelArgs(labels: Record<string, string>): string[] {
  return Object.entries(labels).flatMap(([key, value]) => ["--label", `${key}=${value}`]);
}

/**
 * Rebuilds a sandbox from its container's labels.
 *
 * Returns undefined for a container that is not one of ours — anything without
 * a slug label — rather than inventing fields, so a stray container on the same
 * daemon can never appear in the list.
 */
export function sandboxFromLabels(
  labels: Record<string, string>,
  container: string,
  state: SandboxState,
): Sandbox | undefined {
  const slug = labels[LABELS.slug];
  if (!slug) return undefined;

  const project = labels[LABELS.project] ?? "";
  return {
    project,
    slug,
    branch: labels[LABELS.branch] ?? "?",
    commit: labels[LABELS.commit] ?? "?",
    dirty: labels[LABELS.dirty] === "true",
    worktree: labels[LABELS.worktree] ?? "",
    driver: labels[LABELS.driver] ?? "none",
    access: labels[LABELS.access] === "private" ? "private" : "public",
    created: labels[LABELS.created] ?? "",
    // Empty means unknown, and a caller must read it that way rather than as
    // "no environment": a sandbox started before this label existed has none,
    // and reporting that as a mismatch would light up every long-running
    // sandbox on the machine as needing a restart it does not need.
    env: labels[LABELS.env] ?? "",
    // A container started before this label existed has no ttl, and must read
    // as `never` rather than as an empty string: anything the expiry planner
    // cannot parse has to fail closed, and an unlabelled sandbox that came out
    // as "already expired" would be stopped the first time the reaper ran.
    ttl: labels[LABELS.ttl] ?? "never",
    state,
    container: container === "" && project !== "" ? containerName(project, slug) : container,
  };
}

export interface StateInput {
  /** What docker reports: running, exited, created, restarting… */
  containerState: string;
  migrateFailed?: boolean | undefined;
  migrateOk?: boolean | undefined;
}

/**
 * Turns docker's state and the container's own markers into one word.
 *
 * `degraded` is a first-class outcome, not an error: a failed migration must not
 * stop the sandbox, because inspecting a failed migration is one of the reasons
 * the sandbox exists. Anything running that has not yet said either way is
 * `starting`, which is what a sandbox spends its first seconds as.
 */
export function deriveState(input: StateInput): SandboxState {
  if (input.containerState !== "running") return "stopped";
  if (input.migrateFailed) return "degraded";
  if (input.migrateOk) return "running";
  return "starting";
}
