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
 *
 * `slugCeiling` may lower it for one project and may never raise it — see there.
 */
export const SLUG_MAX = 31;

/** Length of the SHA-256 prefix appended to an over-long slug. */
const SLUG_HASH_LEN = 8;

/** What the hashed form costs: the separator plus the hash itself. */
const SLUG_HASH_COST = SLUG_HASH_LEN + 1;

/**
 * The hard ceiling on one DNS label, from RFC 1035.
 *
 * It matters here because contracts §3.2 puts the slug, the hostname label and
 * the project name inside a *single* label — see `hostFor` for why — so all
 * three share these 63 characters.
 */
export const DNS_LABEL_MAX = 63;

/**
 * The separator between the three components of a flattened sandbox hostname.
 *
 * Two hyphens, and what makes two hyphens unambiguous rather than merely
 * unlikely is that no component may contain one: `sanitizeSlug` collapses runs
 * of `-`, and the config schema refuses a `project:` or a `label:` holding `--`.
 * Splitting on it therefore yields exactly three parts, or the host is not one
 * of ours.
 */
export const HOST_SEPARATOR = "--";

/**
 * One component of a flattened hostname, as a regular-expression source.
 *
 * Single hyphens only, so this cannot read `a--b` as one component — which is
 * what keeps the router's rules and the dashboard's forwarded-host parse
 * agreeing with `hostFor` about where a hostname divides. A source string rather
 * than a RegExp because one of the two consumers is Go's regexp engine inside
 * Traefik and the other is JavaScript's; what is written here is the syntax both
 * read the same way.
 */
export const HOST_COMPONENT = "[a-z0-9]+(?:-[a-z0-9]+)*";

const HOST_COMPONENT_RE = new RegExp(`^${HOST_COMPONENT}$`);

/**
 * The smallest slug ceiling worth running with.
 *
 * Below 10 the hashed form does not fit at all — `-` plus 8 hex characters —
 * and below 12 it leaves under three characters of readable prefix, so every
 * branch name of any length collapses to a hash and the slug stops naming
 * anything. A project that cannot clear this is refused when its config is read
 * rather than one invalid hostname at a time on `up`.
 */
export const SLUG_MIN = 12;

/**
 * The slug ceiling for one project: `min(31, 63 - longest label - project - 4)`.
 *
 * **The `min` is the whole rule and it only ever points one way.** 31 is the
 * lock-name budget on `SLUG_MAX` above, and it is a maximum: a slug that fits a
 * hostname but collides with another sandbox on an advisory lock is the failure
 * that ceiling exists to prevent, and when it happens it looks like a hung
 * migration rather than like a naming problem. The subtraction is the DNS-label
 * budget — the flattened hostname spends `len(slug) + 2 + len(label) + 2 +
 * len(project)` of its 63 characters, so what is left is the slug's share. It
 * may lower the ceiling and never raise it: a project whose arithmetic allows 40
 * still gets 31.
 */
export function slugCeiling(project: string, labels: readonly string[]): number {
  const longest = labels.reduce((max, label) => Math.max(max, label.length), 0);
  const budget = DNS_LABEL_MAX - longest - project.length - 2 * HOST_SEPARATOR.length;
  return Math.min(SLUG_MAX, budget);
}

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

export const DEFAULT_DOMAIN = "sbx.localhost";

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
export function sanitizeSlug(raw: string, max: number = SLUG_MAX): string {
  // Clamped rather than trusted: `SLUG_MAX` is the lock-name budget, and a
  // caller passing a DNS budget that happens to be larger must not raise it.
  const ceiling = Math.min(max, SLUG_MAX);
  if (ceiling < SLUG_MIN) {
    throw new NamingError(`slug ceiling of ${ceiling} is below the minimum of ${SLUG_MIN}`);
  }
  const folded = raw
    .toLowerCase()
    .replace(SAFE, "-")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "");

  if (folded === "") {
    throw new NamingError(`slug "${raw}" is empty after sanitising`);
  }
  if (folded.length <= ceiling) return folded;

  const hash = createHash("sha256").update(raw).digest("hex").slice(0, SLUG_HASH_LEN);
  // The prefix is trimmed of trailing dashes for two reasons now. It always read
  // as a typo in a hostname; since the hostname became one flat label it would
  // also be a *second* separator inside a component, and the parse back out has
  // no reading for that.
  //
  // The prefix is measured against the ceiling rather than a fixed 22, so the
  // hash keeps all 8 of its characters when a project's DNS budget lowers the
  // ceiling. Shortening the hash instead would quietly weaken the collision
  // protection this whole branch exists for.
  const prefix = folded.slice(0, ceiling - SLUG_HASH_COST).replace(/-+$/, "");
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
  /**
   * The project's slug ceiling, from `slugCeiling`. Absent means `SLUG_MAX`.
   *
   * Passed rather than looked up because it is a property of the project's
   * config, and two derivations of one worktree's slug that disagreed about it
   * would put a name on the dashboard that is not the one `up` uses.
   */
  max?: number | undefined;
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
  const max = input.max ?? SLUG_MAX;

  if (explicit && explicit.trim() !== "") return sanitizeSlug(explicit, max);

  const dirTicket = worktreeDir?.match(ticket);
  if (dirTicket) return sanitizeSlug(dirTicket[0], max);

  const branchTicket = branch?.match(ticket);
  if (branchTicket) return sanitizeSlug(branchTicket[0], max);

  // "HEAD" is what git reports for a detached worktree, which is the shape you
  // get for a branch already checked out somewhere else. It names nothing.
  if (branch && branch !== "HEAD") return sanitizeSlug(branch, max);

  if (worktreeDir) return sanitizeSlug(worktreeDir, max);

  throw new NamingError("cannot derive a slug: no explicit name, worktree or branch");
}

export interface HostParts {
  slug: string;
  label: string;
  project: string;
  domain?: string | undefined;
  /**
   * The scheme a URL is built with.
   *
   * Not always https: the router only terminates TLS when a trusted certificate
   * exists on the machine, and printing an https URL for a router that is not
   * serving it sends the reader to a connection refused.
   */
  scheme?: "http" | "https" | undefined;
}

/**
 * Builds one sandbox hostname: `<slug>--<label>--<project>.<domain>`.
 *
 * **One DNS label above the domain, because a TLS wildcard covers exactly one.**
 * A DNS wildcard does match deeper — RFC 4592's closest-encloser rule — so the
 * older `<slug>.<label>.<project>.<domain>` resolved perfectly well. But
 * `*.*.example.com` is not a valid certificate name, so nothing wildcard could
 * cover a sandbox and every sandbox needed a certificate of its own, issued on
 * `up` and discarded on `down`. Flattened, the single `*.<domain>` already on the
 * base certificate covers every sandbox there will ever be.
 *
 * The three components share the 63 characters of that one label, which is what
 * `slugCeiling` subtracts from. Over-length throws rather than truncating: a
 * hostname silently cut to 63 characters resolves to nothing, and "the app does
 * not load" names none of its cause.
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
    // A component holding the separator makes the hostname unreadable in the
    // literal sense: the router and the dashboard both split on `--` to recover
    // the project, and four parts have no reading.
    if (value.includes(HOST_SEPARATOR)) {
      throw new NamingError(`hostFor: ${field} "${value}" contains the "${HOST_SEPARATOR}" separator`);
    }
  }
  const label = [parts.slug, parts.label, parts.project].join(HOST_SEPARATOR);
  if (label.length > DNS_LABEL_MAX) {
    throw new NamingError(
      `hostname label "${label}" is ${label.length} characters, over the ${DNS_LABEL_MAX}-character DNS limit`,
    );
  }
  return `${label}.${domain}`;
}

/**
 * Recovers `{ slug, label, project }` from a sandbox hostname, or undefined.
 *
 * The reverse of `hostFor`, and it lives beside it so the two cannot drift apart
 * about where a hostname divides. Undefined for the dashboard's own bare domain,
 * for a host under some other domain, and for anything whose single label does
 * not divide into exactly three `--`-separated components — which is what makes
 * `<domain>.evil.example` a refusal rather than a near miss.
 */
export function parseHost(host: string, domain: string): { slug: string; label: string; project: string } | undefined {
  const bare = host.toLowerCase();
  const suffix = `.${domain.toLowerCase()}`;
  if (!bare.endsWith(suffix)) return undefined;

  const flat = bare.slice(0, -suffix.length);
  if (flat === "" || flat.includes(".")) return undefined;

  const parts = flat.split(HOST_SEPARATOR);
  if (parts.length !== 3) return undefined;
  if (!parts.every((part) => HOST_COMPONENT_RE.test(part))) return undefined;

  return { slug: parts[0] as string, label: parts[1] as string, project: parts[2] as string };
}

export function urlFor(parts: HostParts): string {
  return `${parts.scheme ?? "https"}://${hostFor(parts)}`;
}

export function containerName(project: string, slug: string): string {
  return `sandboxr-${project}-${slug}`;
}

/**
 * The ceiling on a session id (Jef's §9.2).
 *
 * `SLUG_MAX` and not a project's `slugCeiling`, and the difference is the whole
 * point: a session may hold repositories of projects that do not exist yet when
 * it is created, so there is no project whose ceiling could be computed at that
 * moment. It does not need one — a session id names a container and a volume,
 * neither of which is a DNS label, so only the lock-name budget binds. This is
 * §3.1's reasoning for a worktree's *directory* name, applied to the one
 * identifier a session has.
 *
 * A runtime's slug is the thing that does spend the hostname budget, and it is
 * put through `slugCeiling` like every other slug — see Jef's §9.2.
 */
export const SESSION_ID_MAX = SLUG_MAX;

/** The workstation container for one session, from Jef's §9.2. */
export function workstationName(session: string): string {
  return `sandboxr-ws-${session}`;
}

/**
 * The reserved volume prefix, from contracts §3.3.
 *
 * **A name under this prefix is never reclaimed by the engine.** The prefix is
 * reserved for the embedder: everything the collector owns is a name it can
 * reconstruct from a sandbox, and a name it cannot is one only the embedder
 * knows what is inside. Jef's work volumes live here (its §9.2) — one per session,
 * mounted at `/work` — and a work volume with no running container is the
 * ordinary state of a stopped session somebody comes back to next week.
 */
export const WORK_VOLUME_PREFIX = "sandboxr-work-";

export function workVolumeName(session: string): string {
  // Guarded rather than trusting the caller, because an empty session id would
  // produce the bare prefix — a name `isWorkVolume` recognises, belonging to no
  // session, which `gc` would then refuse to reclaim for ever.
  if (session.trim() === "") throw new Error("a session id is required to name a work volume");
  return `${WORK_VOLUME_PREFIX}${session}`;
}

/**
 * Whether a volume name is under the reserved prefix.
 *
 * Asked by `orphanVolumes`, and the answer is always "leave it alone". It is a
 * prefix test rather than a lookup against the sessions that exist on purpose: a
 * work volume whose session record has been lost is *more* dangerous to remove
 * than one whose has not, because nothing else on the machine can say what is in
 * it. Reclamation is the one direction where an unrecognised name must read as
 * "something holds it" — §3.4's rule, applied where it costs the most.
 *
 * It lives here, beside the prefix it tests, rather than with the session code
 * that mints these names: the promise not to reclaim one is the engine's, and it
 * has to hold whether or not anything that knows what a session is is installed.
 */
export function isWorkVolume(volume: string): boolean {
  return volume.startsWith(WORK_VOLUME_PREFIX) && volume.length > WORK_VOLUME_PREFIX.length;
}

/** The per-sandbox volume purposes, from contracts §3.3. */
export type VolumePurpose = "data" | "blob" | "bin" | "www";

export function volumeName(purpose: VolumePurpose, project: string, slug: string): string {
  return `${volumePrefix(purpose)}${project}-${slug}`;
}

/**
 * The prefix every per-sandbox volume of one purpose shares.
 *
 * Spelt once and beside the name it prefixes, because `orphanVolumes` has to
 * recognise a volume the engine minted without being able to split the name back
 * into a project and a slug — both may contain dashes — and a second spelling of
 * this is how something the engine did not mint would come to look like one it
 * did.
 */
export function volumePrefix(purpose: VolumePurpose): string {
  return `sandboxr-${purpose}-`;
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

/** Every image sandboxr builds lives under this repository namespace. */
export const IMAGE_NAMESPACE = "sandboxr/";

/**
 * The repository a project's image layer is tagged in.
 *
 * The tag itself is a content hash rather than a slug (see `imageTag`), because
 * every sandbox of a project shares one image and what identifies it is what
 * went into the build, not which branch asked for it first.
 */
export function imageRepository(project: string): string {
  return `${IMAGE_NAMESPACE}${project}`;
}

/**
 * Repositories under `sandboxr/` that are the machine's own images rather than
 * any project's layer, and are therefore never reclaimed as superseded.
 *
 * **These are reserved names, and only the first is the engine's own.** The
 * engine builds `sandboxr/base`; the other three are a product's — Jef's
 * dashboard, workstation and orchestrator — and are named here for the same
 * reason `WORK_VOLUME_PREFIX` is (§3.3): reclamation is the one direction where
 * an unrecognised name must read as "something holds it", and the engine
 * promises never to reap one whether or not the thing that built it is
 * installed.
 *
 * All four are tagged by tool version rather than by content, so the "an older
 * tag means a newer one replaced it" rule the collector applies to project
 * images does not hold for them. Losing any of them costs a rebuild measured in
 * minutes, and losing the base costs it on the next `up` rather than now, which
 * is the worst moment to discover it.
 *
 * The workstation image (Jef's §9.3) is on the list on the same terms. Losing it
 * costs the rebuild at the moment somebody asks for a session, which is the one
 * moment the delay is least welcome.
 *
 * **The orchestrator was missing from this list and that was a real hole**, not a
 * tidiness point. `supersededImages` groups by repository and keeps only the
 * newest, so the orchestrator's `:<tool version>` and `:latest` were two tags of
 * one repository with one of them older — leaving it eligible for reaping by a
 * routine `gc`. Both tags point at the same image id today, so the cost was a
 * dangling tag rather than a lost image; that is luck about how it happens to be
 * tagged, and not a reason to leave it out of a list whose whole job is to say
 * which images are the machine's own.
 */
export const PROTECTED_IMAGES = [
  "sandboxr/base",
  "sandboxr/dashboard",
  "sandboxr/workstation",
  "sandboxr/orchestrator",
] as const;

/**
 * Go's build cache and module cache, shared by every sandbox on the machine.
 *
 * Both are content-addressed — the module cache on `module@version`, the build
 * cache on a hash of each compilation's inputs — so two sandboxes read the same
 * entry only when the thing being cached was identical anyway. That is what
 * makes one pair of volumes for the whole machine correct rather than merely
 * cheap, and it is why these are named here beside the sandbox-owned volumes
 * rather than derived per sandbox.
 */
export const GOCACHE_VOLUME = "sandboxr-gocache";
export const GOMOD_VOLUME = "sandboxr-gomod";

/**
 * Volumes shared by every sandbox on the machine, from contracts §3.3.
 *
 * The engine's own, and only those. An embedder that mounts a volume of its own
 * into every sandbox reserves it by passing `protectVolumes` (see `GcInput`),
 * because the engine cannot be asked to keep a list of names it does not mint.
 */
export const SHARED_VOLUMES = [GOCACHE_VOLUME, GOMOD_VOLUME] as const;

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
