/**
 * What GitHub can tell us: a project's pull requests, and the repositories the
 * user could add a project from.
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
 * a pull-request column and a "repositories you could add" list from this, and
 * "there is no forge here" is an ordinary state for a machine to be in — not an
 * error worth losing the page over.
 *
 * Not throwing is not the same as saying nothing. `listRemoteRepos` reports why
 * a listing was empty through its `log`, because the empty list it returns is
 * the same list a machine with no repositories would get, and an operator needs
 * to be able to tell those two apart without a debugger.
 *
 * `createPullIndex` extends that posture in the one direction the rules above do
 * not cover, and it is worth naming because the two failure shapes are not the
 * same shape. Everything else here answers a *list*, and an empty list is a
 * survivable lie. The index answers a question about **one** branch — is there a
 * pull request on it, and what became of it — and there the missing answer has
 * to stay missing: `null` means "no pull request, or nobody could tell us", and
 * it must never be flattened into `closed`. A closed pull request is a red mark
 * on a page saying somebody rejected this work, and a machine without `gh` on it
 * has not rejected anything.
 *
 * The index also owns the two costs a per-branch question brings that a
 * per-project one did not:
 *
 * - **One `gh` for a project, not one per worktree.** A machine with thirty
 *   worktrees asks about a repository, once, and joins by branch.
 * - **A deadline.** A subprocess that hangs — a proxy that accepts and never
 *   answers is the way this really happens — must not hold up the sidebar, so
 *   the wait is bounded and a bounded-out call is simply another "no answer".
 */

import { nodeRunner, type ExecResult, type Runner } from "./docker.js";
import type { Project } from "./workspace.js";

/**
 * What became of a pull request, as one value.
 *
 * Four states, because that is what somebody looking at a branch wants to know,
 * and **draft is not a fifth**. GitHub reports two independent things — a state
 * of `OPEN`, `CLOSED` or `MERGED`, and an `isDraft` flag — and `isDraft` is a
 * modifier that only means anything while the pull request is open. So the two
 * compose in one direction and only one: an open pull request is `draft` when it
 * is marked as one and `open` when it is not, and a closed or merged one is
 * `closed` or `merged` whatever the flag says. A pull request that was a draft
 * when it was merged is `merged`; nobody wants to be told it is still a sketch.
 *
 * `draft` is kept rather than folded into `open` because it is the one state a
 * reader acts on differently: an open pull request is waiting for them, and a
 * draft is waiting for its author.
 */
export type PullState = "draft" | "open" | "closed" | "merged";

export interface PullRequest {
  number: number;
  title: string;
  /** The head ref — the branch you would make a worktree for. */
  branch: string;
  base: string;
  /**
   * Whether GitHub marks this pull request a draft, as reported.
   *
   * Kept beside `state` rather than replaced by it because the two answer
   * different questions: this is the raw flag, and `state` is what to *show*. A
   * merged pull request that was opened as a draft has `draft: true` here and
   * `state: "merged"` there, and both are true statements.
   */
  draft: boolean;
  /** Open, draft, closed or merged — `draft` composed onto the state above. */
  state: PullState;
  author: string;
  /** ISO 8601, as the forge reported it. */
  updated: string;
  url: string;
}

/** One repository the signed-in account can reach, as a candidate to clone. */
export interface RemoteRepo {
  /** "owner/repo". */
  fullName: string;
  /** "public", "private" or "internal", as GitHub reported it. */
  visibility: string;
  fork: boolean;
  /** ISO 8601, as the forge reported it. */
  updated: string;
  /** The https clone URL, ready to hand to cloneProject. */
  url: string;
}

export interface RemoteReposOptions {
  run?: Runner | undefined;
  /** How many repositories to keep, newest-updated first. Clamped to `MAX_REPO_LIMIT`. */
  limit?: number | undefined;
  /**
   * Told why the list is short, and why it is empty.
   *
   * Both, not just the cap: an empty list is this file's answer to every
   * failure, and the causes want different actions — a machine with no `gh` is
   * nothing like one whose token has expired, and "no repositories" on a page
   * cannot tell them apart. Diagnosing that once meant a shell inside the
   * dashboard's container, which is the work this callback exists to save.
   *
   * The line quotes gh, so it can name a path or an account. It belongs in a log
   * an operator reads, and never in anything served to a browser.
   */
  log?: ((line: string) => void) | undefined;
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
 * How many repositories a listing keeps, and the ceiling on asking for more.
 *
 * An account that belongs to a large organisation can reach thousands, and
 * `--paginate` will happily fetch every one of them — so what a caller gets back
 * is bounded here whatever the forge answered. The cap is applied *after* the
 * sort, so the 200 kept are the 200 most recently touched rather than whichever
 * 200 the API happened to hand over first.
 */
const DEFAULT_REPO_LIMIT = 200;
const MAX_REPO_LIMIT = 1000;

/**
 * The repositories the signed-in account can reach.
 *
 * `sort=updated` is asked for even though the sort is redone locally: it decides
 * which repositories are on the *first* page, so a truncated listing is still
 * the newest ones rather than an arbitrary slice.
 *
 * Fixed string, and it must stay one — nothing user-supplied belongs in an
 * argument array that carries a `--jq` program.
 */
const REPOS_PATH = "/user/repos?per_page=100&sort=updated&direction=desc";

/**
 * The projection, as jq, producing **one JSON object per line**.
 *
 * Deliberately not the `@tsv` a person would type at a shell. A tab-separated
 * pipeline is a parsing hazard in a program: a field could contain a tab and
 * every column after it would shift by one, silently. JSON escapes both the tab
 * and the newline, so a line is always exactly one record.
 */
const REPOS_JQ =
  ".[] | {fullName: .full_name, visibility: .visibility, fork: .fork, updated: .updated_at, url: .clone_url}";

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
const FIELDS = "number,title,headRefName,baseRefName,isDraft,state,author,updatedAt,url";

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

  const draft = record["isDraft"] === true;
  return {
    number,
    title: text(record["title"], ""),
    branch,
    base: text(record["baseRefName"], ""),
    draft,
    state: pullState(record["state"], draft),
    author: text(login, UNKNOWN),
    updated: text(record["updatedAt"], ""),
    url: text(record["url"], ""),
  };
}

/**
 * Composes gh's `state` and `isDraft` into the one value a reader is shown.
 *
 * Unknown and missing states read as open rather than as closed, and that
 * asymmetry is deliberate: this file's whole posture is that a missing answer
 * must never become an accusation, and `closed` is the only one of the four that
 * says somebody decided against this work. A gh too old to know the `state`
 * field never reaches here at all — it rejects the `--json` list outright, which
 * is a non-zero exit and therefore no answer, rather than a wrong one.
 */
function pullState(raw: unknown, draft: boolean): PullState {
  const state = typeof raw === "string" ? raw.toUpperCase() : "";
  if (state === "MERGED") return "merged";
  if (state === "CLOSED") return "closed";
  return draft ? "draft" : "open";
}

function text(value: unknown, fallback: string): string {
  return typeof value === "string" && value !== "" ? value : fallback;
}

/**
 * Maps the repository projection onto `RemoteRepo`, tolerating anything.
 *
 * Exported and pure for parsePullRequests' reason: the mapping is the part worth
 * testing and it should be testable on a machine with no gh on it.
 *
 * Two shapes are accepted because gh produces both. `--jq '.[] | {…}'` emits one
 * object per line, and with `--paginate` it emits the lines of every page in
 * turn — there is no enclosing array to parse. A caller (or a future gh) handing
 * over a whole JSON array is read too, rather than being a silent empty list.
 */
export function parseRemoteRepos(text: string): RemoteRepo[] {
  const repos: RemoteRepo[] = [];

  const collect = (value: unknown): void => {
    if (Array.isArray(value)) {
      for (const entry of value) collect(entry);
      return;
    }
    const repo = toRemoteRepo(value);
    if (repo) repos.push(repo);
  };

  const whole = parseJson(text);
  if (Array.isArray(whole)) {
    collect(whole);
    return repos;
  }

  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (trimmed === "") continue;
    collect(parseJson(trimmed));
  }
  return repos;
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

function toRemoteRepo(entry: unknown): RemoteRepo | undefined {
  if (typeof entry !== "object" || entry === null) return undefined;
  const record = entry as Record<string, unknown>;

  // The slug and the clone URL are the two fields everything downstream needs —
  // one names the row, the other is what `cloneProject` is handed — so an entry
  // missing either is not a repository this can offer. The slug is checked
  // against the same pattern `--repo` is, because it is the key the workspace
  // join and the dashboard row are both identified by.
  const fullName = record["fullName"];
  const url = record["url"];
  if (typeof fullName !== "string" || !isSafeSlug(fullName)) return undefined;
  if (typeof url !== "string" || url === "") return undefined;

  return {
    fullName,
    visibility: text(record["visibility"], UNKNOWN),
    fork: record["fork"] === true,
    updated: text(record["updated"], ""),
    url,
  };
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

/**
 * How long a project's pull requests are trusted, in milliseconds.
 *
 * The dashboard polls every thirty seconds and a pull request does not change
 * state anything like that often, so a poll is the wrong clock to hang a
 * subprocess off. Five minutes is the answer to "how stale may a branch icon
 * be", and it is the ceiling rather than the typical case: the value is refreshed
 * in the background as soon as it expires, so what a reader sees is at most five
 * minutes old and usually much less.
 */
export const PULL_INDEX_TTL_MS = 5 * 60_000;

/**
 * How long "no answer" is trusted, before asking again.
 *
 * Shorter than a real answer on purpose, and for both directions of the same
 * problem. A machine with no `gh` on it would otherwise re-spawn a doomed
 * subprocess per project on every poll; and a machine whose `gh` was merely
 * logged out at breakfast should show its pull requests again within a minute of
 * somebody logging in, not five.
 */
export const PULL_INDEX_RETRY_MS = 60_000;

/**
 * How long one `gh pr list` may take before it is abandoned.
 *
 * The whole point of this file is that a missing forge costs a column and never
 * a page, and a process that hangs breaks that promise more thoroughly than one
 * that fails: a corporate proxy that accepts the connection and never answers
 * leaves `gh` waiting on a socket with no timeout of its own, and the sidebar
 * waits with it. Five seconds is long enough for a cold API call over a slow
 * link and short enough that hitting it is not a broken page.
 */
const PULL_INDEX_TIMEOUT_MS = 5_000;

/**
 * How many pull requests the index reads, newest first.
 *
 * Larger than the listing default because this asks `--state all`, so closed and
 * merged pull requests share the window with open ones — on a busy repository a
 * window of fifty could be entirely closed. A branch whose pull request falls
 * outside the window has *no answer*, which draws nothing, rather than a wrong
 * one. The cases that matters for are old branches, and an old branch with a
 * live worktree on it is rare.
 */
const PULL_INDEX_LIMIT = 100;

export interface PullIndexOptions {
  run?: Runner | undefined;
  /** How many pull requests to read per project. Clamped to `MAX_LIMIT`. */
  limit?: number | undefined;
  /** How long one `gh` call may take. Defaults to `PULL_INDEX_TIMEOUT_MS`. */
  timeoutMs?: number | undefined;
  /** How long an answer is trusted. Defaults to `PULL_INDEX_TTL_MS`. */
  ttlMs?: number | undefined;
  /** How long "no answer" is trusted. Defaults to `PULL_INDEX_RETRY_MS`. */
  retryMs?: number | undefined;
  /**
   * The clock, so a test can age an entry without waiting for one.
   *
   * `Date.now` and not a monotonic source: the interval this measures is minutes
   * long and the consequence of a clock step is one extra `gh` call.
   */
  now?: (() => number) | undefined;
  /**
   * Told why a project has no pull request answers.
   *
   * `listRemoteRepos`' reason, and more sharply: here every failure and every
   * success with nothing in it both draw the same nothing, and an operator
   * cannot tell "this branch has no pull request" from "this machine cannot see
   * GitHub" by looking at the page. The line quotes gh, so it can name a path or
   * an account — an operator's log, never a browser.
   */
  log?: ((line: string) => void) | undefined;
}

/**
 * A project's pull requests, by head branch, cached and shared.
 *
 * The thing being avoided: a dashboard drawing thirty worktrees, asking each one
 * "what is your pull request", and running thirty `gh` subprocesses every thirty
 * seconds. The question is per branch and the *answer* is per repository, so the
 * repository is what is fetched and cached, and the branch is a map lookup.
 *
 * Held by the caller rather than in a module-level map, because a cache with no
 * owner has no lifetime: the dashboard wants one that lives as long as the
 * server, and the CLI wants one that dies with the command. Keyed on the
 * repository slug and not the project, so two workspace directories cloned from
 * one repository share the call.
 */
/**
 * The one field the index needs: where the project was cloned from.
 *
 * Narrower than `Project` on purpose. The dashboard's view of a project is not
 * core's `Project` — it has an origin and a name and no repository path — and
 * widening it to satisfy a type would be a worse trade than admitting that a
 * repository slug is all this reads. A whole `Project` still fits.
 */
export type ProjectOrigin = Pick<Project, "origin">;

export interface PullIndex {
  /**
   * Every branch of this project that has a pull request, or `null`.
   *
   * `null` is "nobody could tell us" — no `gh`, not logged in, not a GitHub
   * origin, a repository this token cannot see, or a call that ran out of time.
   * An **empty map** is a real answer meaning this repository has no pull
   * requests. Callers that only draw a mark may treat them the same; callers
   * that say anything to a person must not.
   */
  forProject(project: ProjectOrigin): Promise<ReadonlyMap<string, PullRequest> | null>;
  /**
   * The pull request on one branch, or `null` when there is none or no answer.
   *
   * The two collapse here on purpose — a branch icon has nothing to draw either
   * way — and `forProject` is where a caller that needs them apart goes.
   */
  forBranch(project: ProjectOrigin, branch: string): Promise<PullRequest | null>;
}

/**
 * How much a state counts for when one branch carries several pull requests.
 *
 * It happens more than it sounds like it does: a pull request is closed without
 * merging and a second is opened on the same branch, or a branch is reused after
 * its work merged. Whatever is still *live* is what somebody would act on, so it
 * wins; a merge beats an abandonment, because it says the work landed; and
 * `open` and `draft` are one rank, since both are live and the tie below —
 * highest number, i.e. most recently opened — is the honest way to pick.
 */
const STATE_RANK: Record<PullState, number> = { open: 3, draft: 3, merged: 2, closed: 1 };

function outranks(candidate: PullRequest, incumbent: PullRequest): boolean {
  const rank = STATE_RANK[candidate.state] - STATE_RANK[incumbent.state];
  return rank === 0 ? candidate.number > incumbent.number : rank > 0;
}

/**
 * Indexes pull requests by head branch, keeping the one that matters per branch.
 *
 * Exported and pure so the tie-break can be tested without a gh on the machine.
 */
export function indexByBranch(pulls: readonly PullRequest[]): Map<string, PullRequest> {
  const byBranch = new Map<string, PullRequest>();
  for (const pull of pulls) {
    const incumbent = byBranch.get(pull.branch);
    if (!incumbent || outranks(pull, incumbent)) byBranch.set(pull.branch, pull);
  }
  return byBranch;
}

interface PullEntry {
  pulls: ReadonlyMap<string, PullRequest> | null;
  /** When it was read, on `options.now`'s clock. */
  at: number;
}

/**
 * A cache over `gh pr list --state all`, one entry per repository.
 *
 * **Stale is served while fresh is fetched.** Only the very first question about
 * a repository waits for `gh`; from then on an expired entry is handed over
 * immediately and refreshed behind the caller. The alternative — every caller
 * that finds an expired entry waits — puts a subprocess in the path of a page
 * render once every TTL, which is the stall this whole design exists to avoid,
 * and it buys nothing: a mark that is five minutes and two seconds old is not
 * worse than one that is five minutes old.
 *
 * A cached "no answer" is a stale entry like any other and is served the same
 * way, on its own shorter clock. So a machine that has never had `gh` never
 * waits for one twice, and a machine where somebody has just run `gh auth login`
 * shows its pull requests on the poll after the retry rather than on the one
 * that noticed.
 *
 * Never throws, and never rejects a background refresh either — an unhandled
 * rejection in a server that is deliberately ignoring a forge outage would take
 * down the process the outage was not allowed to affect.
 */
export function createPullIndex(options: PullIndexOptions = {}): PullIndex {
  const now = options.now ?? Date.now;
  const ttlMs = options.ttlMs ?? PULL_INDEX_TTL_MS;
  const retryMs = options.retryMs ?? PULL_INDEX_RETRY_MS;
  const timeoutMs = options.timeoutMs ?? PULL_INDEX_TIMEOUT_MS;

  const entries = new Map<string, PullEntry>();
  // In-flight calls, so ten worktrees asking at once share one subprocess rather
  // than each starting their own before the first has finished.
  const inFlight = new Map<string, Promise<void>>();

  const fresh = (entry: PullEntry): boolean => now() - entry.at < (entry.pulls === null ? retryMs : ttlMs);

  const refresh = (key: string, slug: string): Promise<void> => {
    const running = inFlight.get(key);
    if (running) return running;

    const started = read(slug, { ...options, timeoutMs })
      .then((pulls) => {
        entries.set(key, { pulls, at: now() });
      })
      .finally(() => {
        inFlight.delete(key);
      });
    inFlight.set(key, started);
    return started;
  };

  const forProject = async (project: ProjectOrigin): Promise<ReadonlyMap<string, PullRequest> | null> => {
    const slug = repoSlugFromUrl(project.origin ?? "");
    // Checked again rather than trusted, for `listPullRequests`' reason: this is
    // the line between a string out of a config file and a subprocess.
    if (!slug || !isSafeSlug(slug)) return null;
    // GitHub is case-insensitive about owners and repositories, and a clone URL
    // typed by hand rarely matches the API's capitalisation — two spellings of
    // one repository must not become two subprocesses.
    const key = slug.toLowerCase();

    const cached = entries.get(key);
    if (cached && fresh(cached)) return cached.pulls;
    if (cached) {
      void refresh(key, slug).catch(() => undefined);
      return cached.pulls;
    }

    await refresh(key, slug).catch(() => undefined);
    return entries.get(key)?.pulls ?? null;
  };

  return {
    forProject,
    forBranch: async (project, branch) => {
      if (branch === "") return null;
      const pulls = await forProject(project);
      // An exact head-ref match and nothing cleverer. A detached worktree is
      // labelled with whichever local branch points at its HEAD (`branchOf` in
      // git.ts), so it finds that branch's pull request — the right answer, since
      // it is the same commit — and one that resolved to nothing is `?`, which
      // matches no branch.
      return pulls?.get(branch) ?? null;
    },
  };
}

/**
 * One repository's pull requests, in every state, or `null`.
 *
 * `--state all` rather than the listing's `open`, because the four states are
 * the whole point: a branch whose pull request merged and a branch that never
 * had one are the two things `--state open` cannot tell apart.
 */
async function read(
  slug: string,
  options: PullIndexOptions,
): Promise<ReadonlyMap<string, PullRequest> | null> {
  const args = [
    "pr",
    "list",
    "--repo",
    slug,
    "--state",
    "all",
    "--limit",
    String(clampLimit(options.limit ?? PULL_INDEX_LIMIT)),
    "--json",
    FIELDS,
  ];

  const result = await withDeadline(
    attempt(options.run ?? nodeRunner, args, options.timeoutMs),
    options.timeoutMs ?? PULL_INDEX_TIMEOUT_MS,
  );
  if (!result) {
    options.log?.(`${slug}: gh did not answer within the deadline, or could not be run`);
    return null;
  }
  if (result.code !== 0) {
    options.log?.(`${slug}: ${ghFailure(result)}`);
    return null;
  }

  const pulls = parsePullRequests(result.stdout);
  // Output that parsed to nothing is not the same as a repository with no pull
  // requests, and unlike the listings elsewhere in this file the difference is
  // not cosmetic: an empty map is an answer, and answers are what a per-branch
  // question is allowed to draw conclusions from. gh prints `[]` for a
  // repository with none, so anything else that yielded nothing — a proxy's HTML
  // error page is how this really happens — is no answer at all.
  if (pulls.length === 0 && result.stdout.trim() !== "[]") {
    options.log?.(`${slug}: gh answered with output that held no pull requests`);
    return null;
  }
  return indexByBranch(pulls);
}

/**
 * Every repository the signed-in account can reach, newest-updated first.
 *
 * This is what turns "adding a project" from pasting a URL into picking from a
 * list. It asks about the *account*, not about a project, so unlike everything
 * else here it has no `Project` to start from and no origin to check first.
 *
 * The sort happens here rather than at each caller so that the CLI and the
 * dashboard cannot disagree about the order, and so that the cap below keeps the
 * newest rather than an arbitrary slice.
 *
 * Never throws, for this file's usual reason: an account with no gh simply has
 * no repositories to offer, and "you cannot see a list" is a better page than a
 * stack trace. It does say why, through `log`, so that an empty list is a fact
 * an operator can act on rather than one they have to guess at.
 */
export async function listRemoteRepos(options: RemoteReposOptions = {}): Promise<RemoteRepo[]> {
  const limit = clampRepoLimit(options.limit);

  // Every argument is a constant. Keep it that way: `--jq` takes a program, and
  // there is no interpolation here for anything user-supplied to reach.
  const args = ["api", "--paginate", REPOS_PATH, "--jq", REPOS_JQ];

  const result = await attempt(options.run ?? nodeRunner, args);
  // 127 or ENOENT (no gh), 4 (not authenticated), 1 (no network, or a token
  // without the scope to list repositories) — all of them an empty list, and all
  // of them reported, because the empty list is the same shape either way.
  if (!result || result.code !== 0) {
    options.log?.(ghFailure(result));
    return [];
  }

  const repos = parseRemoteRepos(result.stdout);
  // Output that parsed to nothing is not the same as an account with no
  // repositories, and on the page it looks identical. gh exited 0 and said
  // something, and none of it was a repository — a proxy's HTML error page is how
  // this really happens.
  if (repos.length === 0 && result.stdout.trim() !== "") {
    options.log?.("gh answered with output that held no repositories");
  }
  repos.sort((a, b) => b.updated.localeCompare(a.updated) || a.fullName.localeCompare(b.fullName));

  if (repos.length > limit) {
    options.log?.(`showing the ${limit} most recently updated of ${repos.length} repositories`);
    return repos.slice(0, limit);
  }
  return repos;
}

/**
 * Whether a project in the workspace was cloned from this repository.
 *
 * The two sides spell the same repository differently — a project cloned over
 * ssh records `git@github.com:owner/repo.git`, while the listing gives
 * `https://github.com/owner/repo.git` — so comparing the strings would offer to
 * clone something that is already there. Both are put through the normaliser
 * `--repo` already uses, rather than a second one written for this, because two
 * normalisers is how the dashboard and the CLI come to disagree.
 *
 * Lives in core, and not in the dashboard's view model, for the same reason: the
 * CLI answers this question too.
 */
export function matchesOrigin(project: Project, repo: RemoteRepo): boolean {
  const origin = repoSlugFromUrl(project.origin ?? "");
  if (!origin) return false;
  const listed = repoSlugFromUrl(repo.url) ?? repo.fullName;
  // GitHub owner and repository names are case-insensitive, and a clone URL
  // typed by hand rarely matches the capitalisation the API reports.
  return origin.toLowerCase() === listed.toLowerCase();
}

/** Whether any project in the workspace already points at this repository. */
export function alreadyAdded(repo: RemoteRepo, projects: Project[]): boolean {
  return projects.some((project) => matchesOrigin(project, repo));
}

function clampRepoLimit(limit: number | undefined): number {
  if (typeof limit !== "number" || !Number.isFinite(limit)) return DEFAULT_REPO_LIMIT;
  return Math.min(MAX_REPO_LIMIT, Math.max(1, Math.trunc(limit)));
}

function clampLimit(limit: number | undefined): number {
  if (typeof limit !== "number" || !Number.isFinite(limit)) return DEFAULT_LIMIT;
  return Math.min(MAX_LIMIT, Math.max(1, Math.trunc(limit)));
}

/**
 * How much of gh's complaint is worth carrying, in characters.
 *
 * A failure is often followed by several paragraphs of advice — `gh auth login`
 * prints a whole block of it — and a log line that long is one nobody reads.
 */
const MAX_REASON = 200;

/**
 * Why a gh call answered with nothing, in one line.
 *
 * gh's own first line of stderr, rather than a table mapping exit codes to
 * sentences: `gh api` exits 1 for an expired token, a missing scope and a
 * dropped connection alike, so the code distinguishes far less than the message
 * does. "Requires authentication (HTTP 401)" is the whole diagnosis for the
 * failure that is hardest to guess at — a dashboard container whose mounted
 * `~/.config/gh` named an account and carried no credential, because on macOS
 * the token is in the login keychain and a keychain does not cross into a
 * container.
 */
function ghFailure(result: ExecResult | undefined): string {
  // A runner that rejected rather than exiting, which `attempt` swallowed.
  if (!result) return "gh could not be run at all";
  if (result.code === 127) return "there is no gh on this machine";

  const said = result.stderr
    .split("\n")
    .map((line) => line.trim())
    .find((line) => line !== "");
  // Nothing on stderr is what a gh that was never spawned looks like from here:
  // `nodeRunner` reports a failed spawn as an ordinary non-zero result, because
  // ENOENT arrives as a string error code rather than a number and so cannot be
  // told from an exit status.
  if (!said) return `gh exited ${result.code} silently, which is what a missing gh looks like`;
  return said.length > MAX_REASON ? `${said.slice(0, MAX_REASON)}…` : said;
}

/**
 * Runs gh and reports failure as a value.
 *
 * `nodeRunner` resolves a failed spawn rather than rejecting, but the runner is
 * a seam — a test double, or a future runner with a timeout — and a rejection
 * here would escape as a thrown error from a function documented never to
 * throw, which is exactly the way a missing forge would take a page down.
 */
async function attempt(run: Runner, args: string[], timeoutMs?: number): Promise<ExecResult | undefined> {
  try {
    // The runner's own timeout kills the child; `withDeadline` bounds the *wait*.
    // Both, because they fail differently: a runner that ignores the option — a
    // test double, or one written before it existed — would otherwise leave the
    // deadline racing a promise nothing ever settles, and a child that is killed
    // but whose stdout pipe is still held open by a grandchild settles the
    // runner late or never.
    return await run("gh", args, timeoutMs === undefined ? undefined : { timeoutMs });
  } catch {
    return undefined;
  }
}

/**
 * Waits for something, but not for ever.
 *
 * The timer is unref'd so a call still in flight cannot keep the process alive:
 * the CLI is a short-lived process that exits when its work is done, and a
 * five-second handle on the event loop would turn every command into a
 * five-second command.
 */
async function withDeadline<T>(work: Promise<T>, ms: number): Promise<T | undefined> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const expired = new Promise<undefined>((settle) => {
    timer = setTimeout(() => settle(undefined), ms);
    timer.unref?.();
  });
  try {
    return await Promise.race([work, expired]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
