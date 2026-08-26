/**
 * What GitHub can tell us about a project's branches.
 *
 * Asked by way of the `gh` CLI, through the same injectable `Runner` seam as
 * git and docker, for two reasons:
 *
 * - **No new dependency.** core depends on `yaml` and `zod` and nothing else,
 *   which is what lets it be imported in-process by both the CLI and the
 *   dashboard without dragging a forge SDK, its transitive HTTP stack and its
 *   auth model along with it. `gh` already holds the user's credentials; a
 *   library would mean inventing somewhere to keep a token.
 * - **Arguments are arrays, never shell strings.** Branch names, repo slugs and
 *   PR titles come from a forge, i.e. from strangers, and the dashboard renders
 *   them. There is deliberately no code path here where one becomes shell
 *   syntax.
 *
 * **Nothing in this file throws.** A machine with no `gh`, a `gh` that is not
 * logged in, a repo hosted somewhere that is not GitHub, a dropped network or
 * output that does not parse all answer with an empty list. The dashboard draws
 * a pull-request column from this, and "there is no forge here" is an ordinary
 * state for a project to be in — not an error worth losing the page over.
 */

import { nodeRunner, type ExecResult, type Runner } from "./docker.js";
import type { Project } from "./workspace.js";

export interface PullRequest {
  number: number;
  title: string;
  /** The head ref — the branch you would make a worktree for. */
  branch: string;
  base: string;
  draft: boolean;
  author: string;
  /** ISO 8601, as the forge reported it. */
  updated: string;
  url: string;
}

export interface ForgeOptions {
  run?: Runner | undefined;
  state?: "open" | "merged" | "all" | undefined;
  /** How many pull requests to ask for. Clamped to `MAX_LIMIT`. */
  limit?: number | undefined;
}

/** What a deleted GitHub account, or an unreadable field, becomes. */
const UNKNOWN = "?";

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;

/**
 * A repo slug that is safe to hand a subprocess.
 *
 * `--repo` reaches an argv entry, and while an array argument cannot become
 * shell syntax it can still become a *flag*: a value beginning with `-` is read
 * by gh as an option rather than a repository. Anything outside what GitHub
 * actually allows in an owner or a repo name is refused rather than escaped.
 */
const SLUG = /^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/;

/** The fields the mapping below needs, in gh's own names. */
const FIELDS = "number,title,headRefName,baseRefName,isDraft,author,updatedAt,url";

/**
 * Reads `owner/repo` out of a clone URL, for GitHub and only GitHub.
 *
 * A project may perfectly well live on GitLab, on a self-hosted forge, or be a
 * local clone with no origin at all. Those return undefined and stop the call
 * before it happens, because `gh pr list --repo gitlab.com/acme/web` does not
 * fail quietly — it prompts, or spends a network timeout, to reach the same
 * empty answer we already knew.
 */
export function repoSlugFromUrl(url: string): string | undefined {
  const trimmed = url.trim();
  if (trimmed === "") return undefined;

  // scp-style ssh (git@github.com:owner/repo.git) is not a URL and WHATWG's
  // parser reads it as a `git:` scheme with the whole rest as its path, so it
  // has to be matched before anything tries to parse it.
  const scp = /^(?:[^@\s]+@)?([^:/\s]+):(.+)$/.exec(trimmed);
  if (scp && !trimmed.includes("://")) {
    return slugFor(scp[1] ?? "", scp[2] ?? "");
  }

  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return undefined;
  }
  return slugFor(parsed.hostname, parsed.pathname);
}

function slugFor(host: string, path: string): string | undefined {
  const hostname = host.toLowerCase().replace(/^www\./, "");
  if (hostname !== "github.com" && hostname !== "ssh.github.com") return undefined;

  const parts = path
    .replace(/\.git$/, "")
    .split("/")
    .filter((part) => part !== "");
  if (parts.length !== 2) return undefined;

  const slug = `${parts[0]}/${parts[1]}`;
  return isSafeSlug(slug) ? slug : undefined;
}

/**
 * Whether a slug may be handed to gh as the value of `--repo`.
 *
 * The character class alone is not enough: it permits a dash anywhere, so an
 * owner named `-x` would produce `-x/repo`, and argv-safe or not, gh reads a
 * value starting with a dash as another option rather than as a repository.
 */
function isSafeSlug(slug: string): boolean {
  return SLUG.test(slug) && !slug.startsWith("-");
}

/**
 * Maps gh's JSON onto `PullRequest`, tolerating anything.
 *
 * Exported and pure so the mapping can be tested against recorded output
 * without a gh on the machine. gh's `--json` shape is a contract we do not
 * control and it has grown fields before, so an entry that cannot be read is
 * dropped and its neighbours are kept — one odd PR must not blank the column.
 */
export function parsePullRequests(json: string): PullRequest[] {
  let raw: unknown;
  try {
    raw = JSON.parse(json);
  } catch {
    return [];
  }
  if (!Array.isArray(raw)) return [];

  const pulls: PullRequest[] = [];
  for (const entry of raw) {
    const pull = toPullRequest(entry);
    if (pull) pulls.push(pull);
  }
  return pulls;
}

function toPullRequest(entry: unknown): PullRequest | undefined {
  if (typeof entry !== "object" || entry === null) return undefined;
  const record = entry as Record<string, unknown>;

  const number = record["number"];
  const branch = record["headRefName"];
  // The number and the head ref are the two fields everything downstream keys
  // on — a worktree is made for the branch, and the row is identified by the
  // number — so an entry missing either is not a pull request we can use.
  if (typeof number !== "number" || !Number.isFinite(number)) return undefined;
  if (typeof branch !== "string" || branch === "") return undefined;

  // author is null for a pull request opened by an account that has since been
  // deleted, which is common enough on an old repo to be worth naming.
  const author = record["author"];
  const login = typeof author === "object" && author !== null ? (author as Record<string, unknown>)["login"] : undefined;

  return {
    number,
    title: text(record["title"], ""),
    branch,
    base: text(record["baseRefName"], ""),
    draft: record["isDraft"] === true,
    author: text(login, UNKNOWN),
    updated: text(record["updatedAt"], ""),
    url: text(record["url"], ""),
  };
}

function text(value: unknown, fallback: string): string {
  return typeof value === "string" && value !== "" ? value : fallback;
}

/** Whether a usable, authenticated `gh` is on this machine. */
export async function ghAvailable(run: Runner = nodeRunner): Promise<boolean> {
  // `auth status` rather than `--version`: an installed but logged-out gh
  // answers every `pr list` with an exit code and a prompt-shaped message, so
  // "gh exists" is not the question anything here wants answered.
  const result = await attempt(run, ["auth", "status"]);
  return result?.code === 0;
}

/**
 * The pull requests open on a project's repo, or none.
 *
 * `project.origin` is the clone URL; a project whose origin is not on GitHub
 * never reaches gh at all.
 */
export async function listPullRequests(project: Project, options: ForgeOptions = {}): Promise<PullRequest[]> {
  const slug = repoSlugFromUrl(project.origin ?? "");
  // Checked again rather than trusted: repoSlugFromUrl is exported, and this is
  // the line between a string that came out of a config file and a subprocess.
  if (!slug || !isSafeSlug(slug)) return [];

  const args = [
    "pr",
    "list",
    "--repo",
    slug,
    "--state",
    options.state ?? "open",
    "--limit",
    // A number, formatted here, so no caller's string can reach argv. gh reads
    // a huge --limit as "page until you are rate limited", which turns a
    // dashboard refresh into a minutes-long stall.
    String(clampLimit(options.limit)),
    "--json",
    FIELDS,
  ];

  const result = await attempt(options.run ?? nodeRunner, args);
  // Every failure looks the same from here on purpose: 127 or ENOENT (no gh),
  // 4 (not authenticated), 1 (no network, or a repo this token cannot see).
  // None of them is a reason to fail the caller.
  if (!result || result.code !== 0) return [];

  return parsePullRequests(result.stdout);
}

/**
 * The head branches of a project's merged pull requests.
 *
 * This exists to feed a seam that has been waiting for it. `GcOptions.merged
 * Branches` (packages/core/src/sandbox/types.ts) is honoured by `planGc`
 * (packages/core/src/sandbox/gc.ts), which reaps a sandbox with the reason
 * "<branch> is merged" — and until this function, nothing anywhere populated
 * it, so that branch of the plan could never be taken. This is the missing
 * producer, and a forge is the only thing that actually knows a branch's work
 * is finished: the local repo may never have fetched the merge, and a
 * squash-merged branch has no ancestry to prove it either way.
 */
export async function mergedBranches(
  project: Project,
  options: { run?: Runner | undefined; limit?: number | undefined } = {},
): Promise<string[]> {
  const pulls = await listPullRequests(project, { ...options, state: "merged" });
  return pulls.map((pull) => pull.branch);
}

function clampLimit(limit: number | undefined): number {
  if (typeof limit !== "number" || !Number.isFinite(limit)) return DEFAULT_LIMIT;
  return Math.min(MAX_LIMIT, Math.max(1, Math.trunc(limit)));
}

/**
 * Runs gh and reports failure as a value.
 *
 * `nodeRunner` resolves a failed spawn rather than rejecting, but the runner is
 * a seam — a test double, or a future runner with a timeout — and a rejection
 * here would escape as a thrown error from a function documented never to
 * throw, which is exactly the way a missing forge would take a page down.
 */
async function attempt(run: Runner, args: string[]): Promise<ExecResult | undefined> {
  try {
    return await run("gh", args);
  } catch {
    return undefined;
  }
}
