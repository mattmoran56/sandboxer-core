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
  const available = (source: SeedSource): boolean => {
    if (!allowed.has(source as "fixtures" | "file" | "local")) return false;
    if (source === "local") return options.localAvailable !== false;
    if (source === "file") return options.fileAvailable !== false;
    return true;
  };

  const order: SeedSource[] = options.prefer ? [options.prefer] : ["local", "file", "fixtures"];
  for (const source of order) {
    if (!available(source)) continue;
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
  if (seed.local || seed.file) {
    throw new SeedError(
      `${config.project}: no permissible seed source. Public apps may only be seeded from fixtures or an ` +
        "anonymised dump (contracts §5.3); set access.apps to private, or add database.seed_from.fixtures",
    );
  }
  return { source: "none" };
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
