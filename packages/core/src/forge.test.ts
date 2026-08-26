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

import { describe, expect, it } from "vitest";

import type { ExecResult, Runner } from "./docker.js";
import { ghAvailable, listPullRequests, mergedBranches, parsePullRequests, repoSlugFromUrl } from "./forge.js";
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
