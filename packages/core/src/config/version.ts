/**
 * The `sandboxer:` version constraint.
 *
 * A project pins the minimum tool version it needs, so a config using a field
 * an older sandboxer does not understand fails with a sentence about versions
 * rather than a confusing schema error. Implemented here rather than pulled in
 * as a dependency because the accepted grammar is small and fixed, and a
 * mismatch has to produce a message we control.
 */

export interface SemVer {
  major: number;
  minor: number;
  patch: number;
  prerelease: string;
}

export class VersionError extends Error {
  override readonly name = "VersionError";
}

const VERSION = /^v?(\d+)(?:\.(\d+))?(?:\.(\d+))?(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/;

export function parseVersion(input: string): SemVer {
  const m = VERSION.exec(input.trim());
  if (!m) throw new VersionError(`"${input}" is not a version`);
  return {
    major: Number(m[1]),
    minor: Number(m[2] ?? 0),
    patch: Number(m[3] ?? 0),
    prerelease: m[4] ?? "",
  };
}

/** Orders two versions. A prerelease sorts below the release it precedes. */
export function compareVersions(a: SemVer, b: SemVer): number {
  for (const part of ["major", "minor", "patch"] as const) {
    if (a[part] !== b[part]) return a[part] < b[part] ? -1 : 1;
  }
  if (a.prerelease === b.prerelease) return 0;
  if (a.prerelease === "") return 1;
  if (b.prerelease === "") return -1;
  return a.prerelease < b.prerelease ? -1 : 1;
}

const COMPARATORS = [">=", "<=", ">", "<", "^", "~", "="] as const;
type Comparator = (typeof COMPARATORS)[number];

interface Term {
  op: Comparator;
  version: SemVer;
}

function parseTerm(raw: string): Term {
  const found = COMPARATORS.find((op) => raw.startsWith(op));
  const op: Comparator = found ?? "=";
  const version = parseVersion(raw.slice(found ? found.length : 0));
  return { op, version };
}

/** Upper bound of a caret or tilde range: the next version that breaks it. */
function upperBound(op: "^" | "~", v: SemVer): SemVer {
  if (op === "~") return { major: v.major, minor: v.minor + 1, patch: 0, prerelease: "" };
  // `^0.x` treats the minor as the breaking digit, which is the convention
  // every registry uses and the one a pre-1.0 tool needs.
  if (v.major === 0) return { major: 0, minor: v.minor + 1, patch: 0, prerelease: "" };
  return { major: v.major + 1, minor: 0, patch: 0, prerelease: "" };
}

function termHolds(actual: SemVer, term: Term): boolean {
  const cmp = compareVersions(actual, term.version);
  switch (term.op) {
    case ">=":
      return cmp >= 0;
    case "<=":
      return cmp <= 0;
    case ">":
      return cmp > 0;
    case "<":
      return cmp < 0;
    case "=":
      return cmp === 0;
    case "^":
    case "~":
      return cmp >= 0 && compareVersions(actual, upperBound(term.op, term.version)) < 0;
  }
}

/**
 * Tests a version against a constraint.
 *
 * Terms separated by a space or a comma are all required; `||` separates
 * alternatives. `*` and an empty constraint accept anything, which is how a
 * project says it does not care.
 */
export function satisfies(version: string, constraint: string): boolean {
  const actual = parseVersion(version);
  const trimmed = constraint.trim();
  if (trimmed === "" || trimmed === "*") return true;

  return trimmed.split("||").some((alternative) => {
    const terms = alternative
      .split(/[\s,]+/)
      .map((part) => part.trim())
      .filter((part) => part !== "");
    if (terms.length === 0) return true;
    return terms.every((term) => termHolds(actual, parseTerm(term)));
  });
}
