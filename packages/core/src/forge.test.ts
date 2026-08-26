// Tests for reading pull requests out of GitHub through the gh CLI:
// - repoSlugFromUrl: https with and without .git, scp-style ssh, ssh:// — and undefined for GitLab, a
//   self-hosted forge, junk, an empty string and a slug with a shell metacharacter or a leading dash
// - parsePullRequests: recorded gh output including a draft and a deleted (null) author
// - parsePullRequests: null, {}, [], unparseable text, and one malformed entry among good ones
// - listPullRequests: [] when gh is missing (127/ENOENT), when it exits non-zero (logged out), and
//   when its output does not parse — never a throw
// - listPullRequests: [] for a non-GitHub or unsafe origin, with the runner never invoked at all
// - the argument array gh receives: no shell metacharacters, the expected --repo/--state/--json flags,
//   and a limit that is bounded and numeric
// - mergedBranches: asks for --state merged and returns head branch names
// - ghAvailable: true only when gh answers `auth status` cleanly
// - parseRemoteRepos: recorded gh output as one object per line, and as a whole JSON array
// - parseRemoteRepos: blank lines, junk, a half-written last line, and entries missing a name or a url
// - listRemoteRepos: newest-updated first, whatever order gh answered in
// - listRemoteRepos: the cap keeps the newest and reports that it truncated; the flags are constants
// - listRemoteRepos: [] for a missing gh, a logged-out gh, no network and unparseable output
// - matchesOrigin / alreadyAdded: ssh and https spellings of one repo, case, and a different repo

import { describe, expect, it } from "vitest";

import type { ExecResult, Runner } from "./docker.js";
import {
  alreadyAdded,
  ghAvailable,
  listPullRequests,
  listRemoteRepos,
  matchesOrigin,
  mergedBranches,
  parsePullRequests,
  parseRemoteRepos,
  repoSlugFromUrl,
  type RemoteRepo,
} from "./forge.js";
import type { Project } from "./workspace.js";

const project = (origin: string): Project => ({
  name: "acme",
  repo: "/srv/acme",
  worktrees: "/srv/acme/.worktrees",
  base: "main",
  origin,
});

/** Records every invocation so the argument array itself can be asserted on. */
function stubRunner(reply: Partial<ExecResult> & { throws?: unknown }): {
  run: Runner;
  calls: Array<[string, string[]]>;
} {
  const calls: Array<[string, string[]]> = [];
  const run: Runner = async (bin, args) => {
    calls.push([bin, args]);
    if (reply.throws !== undefined) throw reply.throws;
    return { code: reply.code ?? 0, stdout: reply.stdout ?? "", stderr: reply.stderr ?? "" };
  };
  return { run, calls };
}

/** A spawn that never happened, the way node reports a binary that is not there. */
function enoent(): NodeJS.ErrnoException {
  const error = new Error("spawn gh ENOENT") as NodeJS.ErrnoException;
  error.code = "ENOENT";
  return error;
}

/** Recorded `gh pr list --json …` output: an ordinary PR, a draft, and one whose author was deleted. */
const RECORDED = JSON.stringify([
  {
    number: 128,
    title: "Cache the resolved plan between reloads",
    headRefName: "feat/plan-cache",
    baseRefName: "main",
    isDraft: false,
    author: { id: "MDQ6VXNlcjE=", is_bot: false, login: "arden", name: "Arden Vale" },
    updatedAt: "2026-08-21T09:14:02Z",
    url: "https://github.com/acme/web/pull/128",
  },
  {
    number: 131,
    title: "WIP: split the router out of the access layer",
    headRefName: "feat/router-split",
    baseRefName: "main",
    isDraft: true,
    author: { id: "MDQ6VXNlcjI=", is_bot: false, login: "priya", name: "Priya Raman" },
    updatedAt: "2026-08-24T16:40:11Z",
    url: "https://github.com/acme/web/pull/131",
  },
  {
    number: 96,
    title: "Bump the base image to node 22",
    headRefName: "chore/node-22",
    baseRefName: "main",
    isDraft: false,
    author: null,
    updatedAt: "2026-07-02T11:00:00Z",
    url: "https://github.com/acme/web/pull/96",
  },
]);

describe("repoSlugFromUrl", () => {
  it.each([
    ["https with .git", "https://github.com/acme/web.git", "acme/web"],
    ["https without .git", "https://github.com/acme/web", "acme/web"],
    ["scp-style ssh", "git@github.com:acme/web.git", "acme/web"],
    ["scp-style ssh without .git", "git@github.com:acme/web", "acme/web"],
    ["ssh:// url", "ssh://git@github.com/acme/web.git", "acme/web"],
    ["a trailing slash", "https://github.com/acme/web/", "acme/web"],
    ["dots and dashes in the names", "https://github.com/acme-co/web.next.git", "acme-co/web.next"],
  ])("reads %s", (_name, url, want) => {
    expect(repoSlugFromUrl(url)).toBe(want);
  });

  // A project on another forge is an ordinary project, not a broken one: it must
  // stop here rather than reach gh, which would prompt or time out to say the
  // same thing.
  it.each([
    ["gitlab", "https://gitlab.com/acme/web.git"],
    ["gitlab over ssh", "git@gitlab.com:acme/web.git"],
    ["a self-hosted forge", "https://git.acme.internal/acme/web.git"],
    ["a lookalike host", "https://github.com.evil.example/acme/web.git"],
    ["a local path", "/srv/acme/web"],
    ["junk", "not a url at all"],
    ["empty", ""],
    ["a bare host", "https://github.com/"],
    ["too many path segments", "https://github.com/acme/web/tree/main"],
    ["a leading dash on the owner", "https://github.com/-oProxyCommand/web"],
    ["a shell metacharacter", "https://github.com/acme/web;id"],
    ["a backtick", "https://github.com/acme/`id`"],
  ])("returns undefined for %s", (_name, url) => {
    expect(repoSlugFromUrl(url)).toBeUndefined();
  });
});

describe("parsePullRequests", () => {
  it("maps recorded gh output onto the mapping the dashboard reads", () => {
    const pulls = parsePullRequests(RECORDED);
    expect(pulls).toHaveLength(3);
    expect(pulls[0]).toEqual({
      number: 128,
      title: "Cache the resolved plan between reloads",
      branch: "feat/plan-cache",
      base: "main",
      draft: false,
      author: "arden",
      updated: "2026-08-21T09:14:02Z",
      url: "https://github.com/acme/web/pull/128",
    });
    expect(pulls[1]?.draft).toBe(true);
  });

  // A pull request opened by an account that has since been deleted has a null
  // author, which is common on an old repo and must not drop the row.
  it("keeps a pull request whose author was deleted", () => {
    const deleted = parsePullRequests(RECORDED)[2];
    expect(deleted?.number).toBe(96);
    expect(deleted?.author).toBe("?");
  });

  it.each([
    ["null", "null"],
    ["an object", "{}"],
    ["an empty array", "[]"],
    ["unparseable text", "gh: command not found"],
    ["empty", ""],
    ["an error object gh printed as json", '{"message":"Bad credentials"}'],
  ])("returns [] for %s", (_name, json) => {
    expect(parsePullRequests(json)).toEqual([]);
  });

  it("skips an entry it cannot read and keeps its neighbours", () => {
    const mixed = JSON.stringify([
      JSON.parse(RECORDED)[0],
      { number: "128", headRefName: "feat/string-number" },
      { number: 5 },
      null,
      "a string",
      { number: 7, headRefName: "" },
      JSON.parse(RECORDED)[1],
    ]);
    expect(parsePullRequests(mixed).map((pull) => pull.number)).toEqual([128, 131]);
  });

  it("fills in fields gh did not send rather than failing on them", () => {
    const sparse = JSON.stringify([{ number: 3, headRefName: "feat/sparse", extraFieldGhAdded: true }]);
    expect(parsePullRequests(sparse)).toEqual([
      { number: 3, title: "", branch: "feat/sparse", base: "", draft: false, author: "?", updated: "", url: "" },
    ]);
  });
});

describe("listPullRequests", () => {
  it("returns the pull requests gh reported", async () => {
    const { run } = stubRunner({ code: 0, stdout: RECORDED });
    const pulls = await listPullRequests(project("git@github.com:acme/web.git"), { run });
    expect(pulls.map((pull) => pull.branch)).toEqual(["feat/plan-cache", "feat/router-split", "chore/node-22"]);
  });

  it("asks gh for exactly the repo and fields it needs, as an argument array", async () => {
    const { run, calls } = stubRunner({ code: 0, stdout: RECORDED });
    await listPullRequests(project("https://github.com/acme/web.git"), { run });

    expect(calls).toHaveLength(1);
    const [bin, args] = calls[0]!;
    expect(bin).toBe("gh");
    expect(Array.isArray(args)).toBe(true);
    expect(args.slice(0, 2)).toEqual(["pr", "list"]);
    expect(args[args.indexOf("--repo") + 1]).toBe("acme/web");
    expect(args[args.indexOf("--state") + 1]).toBe("open");
    expect(args[args.indexOf("--json") + 1]).toBe(
      "number,title,headRefName,baseRefName,isDraft,author,updatedAt,url",
    );

    // Nothing here may become shell syntax: these are argv entries, and the day
    // one of them is joined into a string is the day a branch name runs.
    for (const arg of args) {
      expect(typeof arg).toBe("string");
      expect(arg).not.toMatch(/[;&|`$<>(){}'"\\\n]/);
    }
  });

  it.each([
    ["the default", undefined, "50"],
    ["a caller's limit", 10, "10"],
    ["an absurd limit, clamped", 100_000, "200"],
    ["zero, raised to something gh accepts", 0, "1"],
    ["a fraction, truncated", 12.9, "12"],
    ["nonsense", Number.NaN, "50"],
  ])("passes %s as a bounded number", async (_name, limit, want) => {
    const { run, calls } = stubRunner({ code: 0, stdout: "[]" });
    await listPullRequests(project("https://github.com/acme/web"), { run, limit });
    const args = calls[0]![1];
    expect(args[args.indexOf("--limit") + 1]).toBe(want);
  });

  // Every one of these is an ordinary machine, not a broken one. The dashboard
  // draws a pull-request column from this call and must still render.
  it("returns [] when gh is not installed", async () => {
    const { run } = stubRunner({ code: 127, stderr: "gh: command not found" });
    await expect(listPullRequests(project("https://github.com/acme/web"), { run })).resolves.toEqual([]);
  });

  it("returns [] when the runner itself fails to spawn gh", async () => {
    const { run } = stubRunner({ throws: enoent() });
    await expect(listPullRequests(project("https://github.com/acme/web"), { run })).resolves.toEqual([]);
  });

  it("returns [] when gh is not authenticated", async () => {
    const { run } = stubRunner({ code: 4, stderr: "gh: To get started with GitHub CLI, please run: gh auth login" });
    await expect(listPullRequests(project("https://github.com/acme/web"), { run })).resolves.toEqual([]);
  });

  it("returns [] when the network is gone", async () => {
    const { run } = stubRunner({ code: 1, stderr: "dial tcp: lookup api.github.com: no such host" });
    await expect(listPullRequests(project("https://github.com/acme/web"), { run })).resolves.toEqual([]);
  });

  it("returns [] when gh exits cleanly with output that does not parse", async () => {
    const { run } = stubRunner({ code: 0, stdout: "<html>504 Gateway Timeout</html>" });
    await expect(listPullRequests(project("https://github.com/acme/web"), { run })).resolves.toEqual([]);
  });

  it.each([
    ["gitlab", "https://gitlab.com/acme/web.git"],
    ["a self-hosted forge", "git@git.acme.internal:acme/web.git"],
    ["no origin at all", ""],
    ["a slug with a shell metacharacter", "https://github.com/acme/web;id"],
    ["a slug with a leading dash", "https://github.com/-oProxyCommand=id/web"],
  ])("never invokes gh for %s", async (_name, origin) => {
    const { run, calls } = stubRunner({ code: 0, stdout: RECORDED });
    await expect(listPullRequests(project(origin), { run })).resolves.toEqual([]);
    expect(calls).toEqual([]);
  });
});

describe("mergedBranches", () => {
  it("asks for merged pull requests and answers with head branch names", async () => {
    const { run, calls } = stubRunner({ code: 0, stdout: RECORDED });
    const branches = await mergedBranches(project("https://github.com/acme/web.git"), { run });

    expect(branches).toEqual(["feat/plan-cache", "feat/router-split", "chore/node-22"]);
    const args = calls[0]![1];
    expect(args[args.indexOf("--state") + 1]).toBe("merged");
  });

  it("returns [] rather than throwing when there is no forge", async () => {
    const { run } = stubRunner({ code: 127, stderr: "gh: command not found" });
    await expect(mergedBranches(project("https://github.com/acme/web"), { run })).resolves.toEqual([]);
  });
});

describe("ghAvailable", () => {
  it("is true when gh answers cleanly", async () => {
    const { run, calls } = stubRunner({ code: 0, stdout: "Logged in to github.com account arden" });
    await expect(ghAvailable(run)).resolves.toBe(true);
    expect(calls[0]).toEqual(["gh", ["auth", "status"]]);
  });

  // An installed but logged-out gh answers `pr list` with a prompt-shaped
  // message, so "is gh on the PATH" is not the question worth asking.
  it("is false when gh is installed but logged out", async () => {
    const { run } = stubRunner({ code: 1, stderr: "You are not logged into any GitHub hosts." });
    await expect(ghAvailable(run)).resolves.toBe(false);
  });

  it("is false when gh cannot be spawned", async () => {
    const { run } = stubRunner({ throws: enoent() });
    await expect(ghAvailable(run)).resolves.toBe(false);
  });
});

/**
 * Recorded `gh api --paginate /user/repos --jq '.[] | {…}'` output.
 *
 * One JSON object per line, which is what gh really produces: `--jq` is applied
 * per page and there is no enclosing array. Deliberately not in updated order —
 * the API's own sort is a hint, not a promise, and the ordering is core's job.
 */
const REPOS = [
  '{"fork":false,"fullName":"acme/web","updated":"2026-08-20T11:02:00Z","url":"https://github.com/acme/web.git","visibility":"private"}',
  '{"fork":true,"fullName":"acme/forked-tool","updated":"2026-08-26T14:09:13Z","url":"https://github.com/acme/forked-tool.git","visibility":"public"}',
  '{"fork":false,"fullName":"demo/site","updated":"2026-01-04T08:00:00Z","url":"https://github.com/demo/site.git","visibility":"internal"}',
].join("\n");

const repo = (overrides: Partial<RemoteRepo> = {}): RemoteRepo => ({
  fullName: "acme/web",
  visibility: "private",
  fork: false,
  updated: "2026-08-20T11:02:00Z",
  url: "https://github.com/acme/web.git",
  ...overrides,
});

describe("parseRemoteRepos", () => {
  it("maps one JSON object per line, as --paginate --jq produces them", () => {
    const repos = parseRemoteRepos(REPOS);
    expect(repos).toHaveLength(3);
    expect(repos[0]).toEqual({
      fullName: "acme/web",
      visibility: "private",
      fork: false,
      updated: "2026-08-20T11:02:00Z",
      url: "https://github.com/acme/web.git",
    });
    expect(repos[1]?.fork).toBe(true);
    expect(repos[2]?.visibility).toBe("internal");
  });

  // A caller — or a future gh — handing over one array must not read as nothing.
  it("reads a whole JSON array too", () => {
    const array = JSON.stringify(REPOS.split("\n").map((line) => JSON.parse(line)));
    expect(parseRemoteRepos(array).map((entry) => entry.fullName)).toEqual([
      "acme/web",
      "acme/forked-tool",
      "demo/site",
    ]);
  });

  // A page that arrived truncated must cost its own line and nothing else: the
  // repositories already read are still a usable list.
  it("keeps the lines that parse and drops the ones that do not", () => {
    const text = ["", REPOS.split("\n")[0]!, "  ", "<html>504 Gateway Timeout</html>", '{"fullName":"acme/'].join("\n");
    expect(parseRemoteRepos(text).map((entry) => entry.fullName)).toEqual(["acme/web"]);
  });

  it.each([
    ["null", "null"],
    ["an object that is not a list", '{"message":"Bad credentials"}'],
    ["an empty array", "[]"],
    ["nothing at all", ""],
  ])("returns [] for %s", (_name, text) => {
    expect(parseRemoteRepos(text)).toEqual([]);
  });

  it.each([
    ["no name", '{"url":"https://github.com/acme/web.git"}'],
    ["no url", '{"fullName":"acme/web"}'],
    ["a name that is not a slug", '{"fullName":"acme","url":"https://github.com/acme.git"}'],
    ["a leading dash on the owner", '{"fullName":"-oProxyCommand/web","url":"https://github.com/x/y.git"}'],
    ["a shell metacharacter in the name", '{"fullName":"acme/web;id","url":"https://github.com/acme/web.git"}'],
  ])("drops an entry with %s", (_name, line) => {
    expect(parseRemoteRepos([line, REPOS.split("\n")[0]!].join("\n")).map((entry) => entry.fullName)).toEqual([
      "acme/web",
    ]);
  });

  it("falls back rather than dropping an entry whose visibility or date is missing", () => {
    const [entry] = parseRemoteRepos('{"fullName":"acme/web","url":"https://github.com/acme/web.git"}');
    expect(entry).toEqual({
      fullName: "acme/web",
      visibility: "?",
      fork: false,
      updated: "",
      url: "https://github.com/acme/web.git",
    });
  });
});

describe("listRemoteRepos", () => {
  it("answers newest-updated first, whatever order gh replied in", async () => {
    const { run } = stubRunner({ code: 0, stdout: REPOS });
    const repos = await listRemoteRepos({ run });
    expect(repos.map((entry) => entry.fullName)).toEqual(["acme/forked-tool", "acme/web", "demo/site"]);
  });

  // Every argument is a constant, and stays one whatever the caller asked for:
  // the `--jq` value is a program, and the day a caller's string reaches it is
  // the day this stops being a read.
  it("asks gh for JSON through a fixed path and a fixed jq program", async () => {
    const { run, calls } = stubRunner({ code: 0, stdout: REPOS });
    await listRemoteRepos({ run, limit: 7 });

    expect(calls).toHaveLength(1);
    const [bin, args] = calls[0]!;
    expect(bin).toBe("gh");
    expect(args).toEqual([
      "api",
      "--paginate",
      "/user/repos?per_page=100&sort=updated&direction=desc",
      "--jq",
      ".[] | {fullName: .full_name, visibility: .visibility, fork: .fork, updated: .updated_at, url: .clone_url}",
    ]);
    // Not `@tsv`: a tab in any field would shift every column after it.
    expect(args.join(" ")).not.toContain("@tsv");
  });

  // The cap is applied after the sort, so an account with thousands of
  // repositories still gets the ones it has touched — not an arbitrary slice.
  it("keeps the newest when the cap truncates, and says that it did", async () => {
    const lines: string[] = [];
    const { run } = stubRunner({ code: 0, stdout: REPOS });
    const repos = await listRemoteRepos({ run, limit: 2, log: (line) => lines.push(line) });

    expect(repos.map((entry) => entry.fullName)).toEqual(["acme/forked-tool", "acme/web"]);
    expect(lines).toEqual(["showing the 2 most recently updated of 3 repositories"]);
  });

  it("says nothing when the cap did not truncate", async () => {
    const lines: string[] = [];
    const { run } = stubRunner({ code: 0, stdout: REPOS });
    await listRemoteRepos({ run, log: (line) => lines.push(line) });
    expect(lines).toEqual([]);
  });

  it.each([
    ["zero, raised to one", 0, 1],
    ["a fraction, truncated", 2.9, 2],
    ["nonsense, the default", Number.NaN, 3],
  ])("bounds %s", async (_name, limit, want) => {
    const { run } = stubRunner({ code: 0, stdout: REPOS });
    await expect(listRemoteRepos({ run, limit })).resolves.toHaveLength(want);
  });

  // A machine with no gh has no repositories to offer. That is an ordinary
  // machine, and the page that lists them must still render.
  it.each([
    ["gh is not installed", { code: 127, stderr: "gh: command not found" }],
    ["gh is not authenticated", { code: 4, stderr: "gh auth login" }],
    ["the network is gone", { code: 1, stderr: "lookup api.github.com: no such host" }],
    ["the token cannot list repositories", { code: 1, stderr: "HTTP 403: Resource not accessible" }],
    ["the output does not parse", { code: 0, stdout: "<html>504 Gateway Timeout</html>" }],
  ])("returns [] when %s", async (_name, reply) => {
    await expect(listRemoteRepos({ run: stubRunner(reply).run })).resolves.toEqual([]);
  });

  it("returns [] when the runner itself fails to spawn gh", async () => {
    const { run } = stubRunner({ throws: enoent() });
    await expect(listRemoteRepos({ run })).resolves.toEqual([]);
  });
});

describe("matchesOrigin", () => {
  // The whole point of the join: the two sides spell the same repository
  // differently, and comparing the strings would offer to clone one twice.
  it.each([
    ["an ssh origin", "git@github.com:acme/web.git"],
    ["an https origin with .git", "https://github.com/acme/web.git"],
    ["an https origin without .git", "https://github.com/acme/web"],
    ["an ssh:// origin", "ssh://git@github.com/acme/web.git"],
    ["different capitalisation", "https://github.com/Acme/Web.git"],
  ])("matches %s to the listed repository", (_name, origin) => {
    expect(matchesOrigin(project(origin), repo())).toBe(true);
  });

  it.each([
    ["a different repository", "https://github.com/acme/api.git"],
    ["a different owner", "https://github.com/other/web.git"],
    ["another forge", "https://gitlab.com/acme/web.git"],
    ["no origin at all", ""],
  ])("does not match %s", (_name, origin) => {
    expect(matchesOrigin(project(origin), repo())).toBe(false);
  });

  it("falls back to the reported name when the clone url is not a GitHub url", () => {
    expect(matchesOrigin(project("git@github.com:acme/web.git"), repo({ url: "https://example.test/tarball" }))).toBe(
      true,
    );
  });
});

describe("alreadyAdded", () => {
  it("is true when any project in the workspace points at the repository", () => {
    const projects = [project("https://github.com/demo/site.git"), project("git@github.com:acme/web.git")];
    expect(alreadyAdded(repo(), projects)).toBe(true);
  });

  it("is false for an empty workspace", () => {
    expect(alreadyAdded(repo(), [])).toBe(false);
  });
});
