/**
 * The two hard requirements on a public sandbox (contracts §5.3).
 *
 * Public apps are the default and the point — someone who finds a sandbox sees
 * a preview of unreleased work. What makes that safe is that a public sandbox
 * cannot be backed by real records and cannot hold real credentials. Both are
 * refusals rather than warnings, so they live in one place that every entry
 * point consults.
 */

import type { ResolvedConfig } from "./types.js";

export interface AccessViolation {
  /** Dotted config path, so a message can name the field to change. */
  field: string;
  reason: string;
  /** What the author can do about it. */
  fix: string;
}

/**
 * Which seed sources a sandbox may use.
 *
 * A public sandbox has exactly one permissible class of seed: fixtures, or a
 * dump the author has marked anonymised. A private one may fork live data,
 * which is the whole reason `access: private` exists.
 */
export function permittedSeeds(config: ResolvedConfig): Array<"fixtures" | "file" | "local"> {
  const seed = config.database.seedFrom;
  if (!seed) return [];

  const permitted: Array<"fixtures" | "file" | "local"> = [];
  if (seed.fixtures) permitted.push("fixtures");

  const publicApps = config.access.apps === "public";
  if (seed.file && (!publicApps || seed.anonymised === true)) permitted.push("file");
  if (seed.local && !publicApps) permitted.push("local");
  return permitted;
}

/**
 * The violations that can be decided from the config alone.
 *
 * A config listing several seed sources is not a violation as long as one of
 * them is permissible: which source a run uses depends on the machine — a
 * laptop forks the container the developer already runs, a server restores a
 * dump — so the choice is made when a sandbox starts, and refused there if the
 * chosen source is not allowed.
 */
export function publicAccessViolations(config: ResolvedConfig): AccessViolation[] {
  if (config.access.apps !== "public") return [];
  if (config.database.driver === "none") return [];

  const seed = config.database.seedFrom;
  if (!seed || permittedSeeds(config).length > 0) return [];

  const violations: AccessViolation[] = [];
  if (seed.local) {
    violations.push({
      field: "database.seed_from.local",
      reason:
        "a public sandbox cannot be seeded by forking a live database — a public URL over real records is a data leak",
      fix: "add database.seed_from.fixtures, mark a dump `anonymised: true`, or set access.apps to private",
    });
  }
  if (seed.file && seed.anonymised !== true) {
    violations.push({
      field: "database.seed_from.file",
      reason: "a public sandbox may only restore a dump that is explicitly marked anonymised",
      fix: "add `anonymised: true` beside the file if it is anonymised, or set access.apps to private",
    });
  }
  return violations;
}

/**
 * Whether real third-party credentials may reach this sandbox.
 *
 * Anyone who can drive a public app can make it send real email and spend real
 * LLM credit, so public apps get dummies unless the config opts in.
 */
export function allowsRealCredentials(config: ResolvedConfig): boolean {
  return config.access.apps === "private" || config.access.credentials === "real";
}
