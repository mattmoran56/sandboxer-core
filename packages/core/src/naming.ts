/**
 * Slugs, hostnames and docker object names.
 *
 * The single source of the naming scheme: the CLI, the router config, the
 * dashboard and every driver derive their names from here, so a name can only
 * be spelled one way. See docs/architecture/contracts.md §3.
 */

import { createHash } from "node:crypto";

/**
 * Length ceiling for a slug.
 *
 * A slug ends up inside a database advisory lock name, and MySQL's GET_LOCK
 * truncates names at 64 characters. Two long branch names often share a prefix,
 * so a truncated slug would let two sandboxes collide on one lock. This ceiling
 * is load-bearing: raising it means re-checking the lock-name budget of every
 * driver.
 */
export const SLUG_MAX = 31;

/** Characters kept from the prefix when a slug has to be hashed. */
const SLUG_PREFIX_MAX = 22;

/** Length of the SHA-256 prefix appended to an over-long slug. */
const SLUG_HASH_LEN = 8;

/**
 * A ticket-style id: a letter run, a dash, digits. Matched anywhere, any case.
 *
 * Deliberately generic. Teams prefix their tickets differently, and a slug is
 * only readable if the pattern matches the convention actually in use, so a
 * caller can pass its own instead of this default.
 */
export const DEFAULT_TICKET_PATTERN = /[a-z]+-[0-9]+/i;

/** Hostname labels and docker name components share this alphabet. */
const SAFE = /[^a-z0-9-]+/g;

export const DEFAULT_DOMAIN = "sbx.lcl";

export class NamingError extends Error {
  override readonly name = "NamingError";
}

/**
 * Reduces an arbitrary branch or directory name to the `[a-z0-9-]` alphabet
 * that is simultaneously legal in a container name, a hostname label and — once
 * dashes are folded to underscores — a database identifier.
 *
 * Over the ceiling the result is a readable prefix plus a hash of the *raw*
 * input, never a plain truncation, so two long names sharing a prefix stay
 * distinct.
 */
export function sanitizeSlug(raw: string): string {
  const folded = raw
    .toLowerCase()
    .replace(SAFE, "-")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "");

  if (folded === "") {
    throw new NamingError(`slug "${raw}" is empty after sanitising`);
  }
  if (folded.length <= SLUG_MAX) return folded;

  const hash = createHash("sha256").update(raw).digest("hex").slice(0, SLUG_HASH_LEN);
  // The prefix is trimmed of trailing dashes so the join never produces `--`,
  // which is legal but reads as a typo in a hostname.
  const prefix = folded.slice(0, SLUG_PREFIX_MAX).replace(/-+$/, "");
  return `${prefix}-${hash}`;
}

export interface DeriveSlugInput {
  /** An explicit slug, which always wins. */
  explicit?: string | undefined;
  /** The worktree directory name (its basename, not the whole path). */
  worktreeDir?: string | undefined;
  /** The branch the worktree is on, or undefined when it is detached. */
  branch?: string | undefined;
  /** Overrides the ticket-id pattern for a team that spells them differently. */
  ticketPattern?: RegExp | undefined;
}

/**
 * Resolves the slug for one sandbox, in the order of preference fixed by
 * contracts §3.1: an explicit argument, a ticket id in the worktree directory
 * name, the same pattern in the branch, the branch itself, then the directory.
 *
 * A ticket id beats the rest of the name because it is what makes a slug
 * readable: `tkt-4821` rather than `feat-tkt-4821-rework-the-thing`.
 */
export function deriveSlug(input: DeriveSlugInput): string {
  const { explicit, worktreeDir, branch } = input;
  const ticket = input.ticketPattern ?? DEFAULT_TICKET_PATTERN;

  if (explicit && explicit.trim() !== "") return sanitizeSlug(explicit);

  const dirTicket = worktreeDir?.match(ticket);
  if (dirTicket) return sanitizeSlug(dirTicket[0]);

  const branchTicket = branch?.match(ticket);
  if (branchTicket) return sanitizeSlug(branchTicket[0]);

  // "HEAD" is what git reports for a detached worktree, which is the shape you
  // get for a branch already checked out somewhere else. It names nothing.
  if (branch && branch !== "HEAD") return sanitizeSlug(branch);

  if (worktreeDir) return sanitizeSlug(worktreeDir);

  throw new NamingError("cannot derive a slug: no explicit name, worktree or branch");
}

export interface HostParts {
  slug: string;
  label: string;
  project: string;
  domain?: string | undefined;
}

/**
 * Builds one sandbox hostname: `<slug>.<label>.<project>.<domain>`.
 *
 * The dashboard lives on the bare domain and never on a per-sandbox hostname,
 * so there is deliberately no helper for that here.
 */
export function hostFor(parts: HostParts): string {
  const domain = parts.domain ?? DEFAULT_DOMAIN;
  for (const [field, value] of [
    ["slug", parts.slug],
    ["label", parts.label],
    ["project", parts.project],
  ] as const) {
    if (value === "") throw new NamingError(`hostFor: ${field} is empty`);
  }
  return `${parts.slug}.${parts.label}.${parts.project}.${domain}`;
}

export function urlFor(parts: HostParts): string {
  return `https://${hostFor(parts)}`;
}

export function containerName(project: string, slug: string): string {
  return `sandboxr-${project}-${slug}`;
}

/** The per-sandbox volume purposes, from contracts §3.3. */
export type VolumePurpose = "data" | "blob" | "bin" | "www";

export function volumeName(purpose: VolumePurpose, project: string, slug: string): string {
  return `sandboxr-${purpose}-${project}-${slug}`;
}

/**
 * The shared dependency volume, keyed on a lockfile hash.
 *
 * Every sandbox whose lockfile matches shares one install, and a branch that
 * changes its dependencies transparently gets its own.
 */
export function depsVolumeName(lockHash: string): string {
  return `sandboxr-deps-${lockHash}`;
}

/** Volumes shared by every sandbox on the machine, from contracts §3.3. */
export const SHARED_VOLUMES = ["sandboxr-gocache", "sandboxr-gomod"] as const;

/** The one shared docker network, from contracts §3.3. */
export const NETWORK = "sandboxr";

/**
 * Recovers `{ project, slug }` from a container name.
 *
 * `list` reads its state from labels rather than from names, so this exists for
 * the reverse direction only — reaping a volume whose container is gone. A
 * project name cannot contain a dash-delimited ambiguity because the labels are
 * authoritative; the parse below is deliberately conservative and returns
 * undefined rather than guessing.
 */
export function parseContainerName(
  name: string,
  knownProject?: string,
): { project: string; slug: string } | undefined {
  if (!name.startsWith("sandboxr-")) return undefined;
  const rest = name.slice("sandboxr-".length);
  if (knownProject) {
    if (!rest.startsWith(`${knownProject}-`)) return undefined;
    return { project: knownProject, slug: rest.slice(knownProject.length + 1) };
  }
  const dash = rest.indexOf("-");
  if (dash <= 0 || dash === rest.length - 1) return undefined;
  return { project: rest.slice(0, dash), slug: rest.slice(dash + 1) };
}

/**
 * The advisory-lock name a driver uses for one sandbox's migrations.
 *
 * Kept here rather than in the driver because the slug ceiling exists to bound
 * exactly this string: MySQL's GET_LOCK silently truncates past 64 characters,
 * and two names that truncate to the same thing are one lock.
 */
export function lockName(project: string, slug: string): string {
  const name = `sandboxr_migrate_${project}_${slug}`.replace(/[^A-Za-z0-9_]/g, "_");
  if (name.length > 64) {
    throw new NamingError(
      `lock name for ${project}/${slug} is ${name.length} characters, over MySQL's 64-character ceiling`,
    );
  }
  return name;
}
