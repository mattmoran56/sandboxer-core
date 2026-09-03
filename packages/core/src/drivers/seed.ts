/**
 * Choosing a seed source, and the content-addressed cache every driver writes
 * its artifact into.
 *
 * The cache key is a fingerprint of the *content* of the source, not a
 * timestamp: an unchanged source is not re-dumped, and a changed one cannot be
 * served from a stale entry. A time-to-live bounds how stale an entry can get
 * anyway, because a fingerprint is necessarily cheaper than the thing it
 * describes and so cannot notice everything.
 */

import { mkdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import { permittedSeeds } from "../config/access.js";
import type { ResolvedConfig } from "../config/types.js";
import type { SeedArtifact, SeedSource } from "./types.js";

export class SeedError extends Error {
  override readonly name = "SeedError";
}

/** Hours after which a cache entry is re-taken even if the fingerprint matches. */
export const DEFAULT_TTL_HOURS = 24;

export interface SeedChoice {
  source: SeedSource;
  /** The container to fork, for `local`. */
  container?: string | undefined;
  /** The database inside it, for `local`. */
  database?: string | undefined;
  /** The host path, for `file`. */
  file?: string | undefined;
  /** The fixtures script, applied after migrations whichever source is used. */
  fixtures?: string | undefined;
}

export interface ChooseSeedOptions {
  /** Forces one source, for a caller that knows better than the preference order. */
  prefer?: SeedSource | undefined;
  /** Whether the machine can reach the source container at all. */
  localAvailable?: boolean | undefined;
  /** Whether the dump file named by the config exists here. */
  fileAvailable?: boolean | undefined;
}

/**
 * Picks the seed source for one run.
 *
 * A config legitimately lists several: a laptop forks the container the
 * developer already runs, a server restores a dump, and neither is available on
 * the other machine. The preference order is freshness first — a live fork is
 * the most useful data there is — and access control filters that list before
 * anything is chosen, so a public sandbox simply has fewer options rather than
 * a separate code path.
 */
export function chooseSeed(config: ResolvedConfig, options: ChooseSeedOptions = {}): SeedChoice {
  const seed = config.database.seedFrom;
  if (config.database.driver === "none" || !seed) return { source: "none" };

  const allowed = new Set(permittedSeeds(config));

  // **Two independent tests, and the refusal below has to be able to tell them
  // apart.** `permitted` is policy — what §5.3 allows this sandbox to be seeded
  // from. `reachable` is this machine — whether the container is up and the
  // dump is on this disk. They were one boolean once, and so every refusal read
  // as an access refusal: a *private* project whose only source was
  // `local.container: taxonomy_db` was told "public apps may only be seeded
  // from fixtures or an anonymised dump; set access.apps to private". It
  // already was private. The container had simply exited, and the only advice
  // in the message — make the sandbox public — was the one change that would
  // have made things worse.
  const permitted = (source: SeedSource): boolean => allowed.has(source as "fixtures" | "file" | "local");
  const reachable = (source: SeedSource): boolean => {
    if (source === "local") return options.localAvailable !== false;
    if (source === "file") return options.fileAvailable !== false;
    return true;
  };

  const order: SeedSource[] = options.prefer ? [options.prefer] : ["local", "file", "fixtures"];
  for (const source of order) {
    if (!permitted(source) || !reachable(source)) continue;
    if (source === "local" && seed.local) {
      return {
        source: "local",
        container: seed.local.container,
        database: seed.local.database,
        fixtures: seed.fixtures,
      };
    }
    if (source === "file" && seed.file) return { source: "file", file: seed.file, fixtures: seed.fixtures };
    if (source === "fixtures" && seed.fixtures) return { source: "fixtures", fixtures: seed.fixtures };
  }

  // Nothing usable. When the config *does* name a source, saying which rule
  // excluded it is the difference between a fixable message and a shrug.
  if (options.prefer) {
    throw new SeedError(
      `${config.project}: seed source "${options.prefer}" is not usable here — ` +
        `permitted sources are ${[...allowed].join(", ") || "none"}`,
    );
  }

  // One clause per source the config actually names, and never the wrong one.
  // A source excluded by policy keeps the §5.3 wording, which is correct there;
  // a source that policy allows and the machine cannot reach names the thing —
  // the container, or the path — so the reader knows what to start or fetch.
  // Both kinds are reported when both apply: picking one would put the reader
  // back where the folded boolean left them.
  const clauses: string[] = [];
  let blocked = false;
  for (const [source, missing] of namedSources(seed)) {
    if (!permitted(source)) {
      blocked = true;
      clauses.push(
        `database.seed_from.${source} is not permitted: public apps may only be seeded from fixtures ` +
          "or an anonymised dump (contracts §5.3)",
      );
    } else if (!reachable(source)) {
      clauses.push(`database.seed_from.${source} is permitted here but not available: ${missing}`);
    }
  }
  if (clauses.length > 0) {
    const fix = blocked
      ? "Set access.apps to private, or add database.seed_from.fixtures"
      : "Make one of them available here, or add database.seed_from.fixtures";
    throw new SeedError(`${config.project}: no usable seed source. ${clauses.join(". ")}. ${fix}`);
  }
  return { source: "none" };
}

/**
 * The sources a config names, each with the sentence that describes it being
 * missing from this machine.
 *
 * `fixtures` is deliberately absent: it is a path inside the repository the
 * sandbox is cut from, so it is never permitted-but-unreachable, and a config
 * that declares it never reaches the refusal above at all.
 */
function namedSources(seed: NonNullable<ResolvedConfig["database"]["seedFrom"]>): Array<[SeedSource, string]> {
  const named: Array<[SeedSource, string]> = [];
  if (seed.local) named.push(["local", `the container "${seed.local.container}" is not running`]);
  if (seed.file) named.push(["file", `the dump "${seed.file}" was not found here`]);
  return named;
}

export interface CacheEntry<M = Record<string, string | number>> {
  path: string;
  metaPath: string;
  key: string;
  meta?: (M & { createdAt: string }) | undefined;
}

/**
 * Names a cache entry.
 *
 * The project is in the name so two projects' seeds cannot collide, and the
 * fingerprint is in the name so an entry is immutable: a changed source writes
 * a new file rather than overwriting one that something may be restoring from.
 */
export function cacheEntry(home: string, project: string, key: string, extension: string): CacheEntry {
  const base = join(home, "cache", `seed-${project}-${key}`);
  return { path: `${base}${extension}`, metaPath: `${base}.meta.json`, key };
}

export async function readCacheMeta(entry: CacheEntry): Promise<(Record<string, string | number> & { createdAt: string }) | undefined> {
  try {
    const parsed = JSON.parse(await readFile(entry.metaPath, "utf8")) as Record<string, string | number> & {
      createdAt: string;
    };
    return typeof parsed.createdAt === "string" ? parsed : undefined;
  } catch {
    return undefined;
  }
}

export async function writeCacheMeta(entry: CacheEntry, meta: Record<string, string | number>): Promise<void> {
  await mkdir(dirname(entry.metaPath), { recursive: true });
  await writeFile(entry.metaPath, `${JSON.stringify({ ...meta, createdAt: new Date().toISOString() }, null, 2)}\n`);
}

/** Age of a cache entry in hours, or Infinity when there is nothing to age. */
export function ageHours(createdAt: string | undefined, now: Date): number {
  if (!createdAt) return Number.POSITIVE_INFINITY;
  const created = Date.parse(createdAt);
  if (Number.isNaN(created)) return Number.POSITIVE_INFINITY;
  return (now.getTime() - created) / 3_600_000;
}

export interface FreshnessInput {
  exists: boolean;
  createdAt?: string | undefined;
  ttlHours?: number | undefined;
  now: Date;
  force?: boolean | undefined;
}

/**
 * Whether a cache entry can be used as-is.
 *
 * Kept separate from the IO so the policy — content key, then age, then an
 * explicit override — can be read and tested in one place.
 */
export function isFresh(input: FreshnessInput): boolean {
  if (input.force) return false;
  if (!input.exists) return false;
  return ageHours(input.createdAt, input.now) < (input.ttlHours ?? DEFAULT_TTL_HOURS);
}

export async function fileExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

export async function fileBytes(path: string): Promise<number | undefined> {
  try {
    return (await stat(path)).size;
  } catch {
    return undefined;
  }
}

/**
 * The name an in-progress artifact is written under.
 *
 * Renamed into place only on success, so an interrupted dump can never be
 * mistaken for a complete cache entry by the next run.
 */
export function partialPath(path: string): string {
  return `${path}.partial`;
}

export async function commitPartial(path: string): Promise<void> {
  await rename(partialPath(path), path);
}

/** Renders a byte count for a human, for the one line a dump prints. */
export function formatBytes(bytes: number): string {
  if (bytes >= 1_073_741_824) return `${(bytes / 1_073_741_824).toFixed(1)} GB`;
  if (bytes >= 1_048_576) return `${Math.round(bytes / 1_048_576)} MB`;
  if (bytes >= 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${bytes} B`;
}
