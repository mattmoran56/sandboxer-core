// Tests for the workspace: the directory of projects a machine can start sandboxes for.
// - projectNameFromUrl: https with and without .git, the scp form, a trailing slash, sanitising
// - a url beginning "-" is refused, including the --upload-pack= form that would execute a command
// - a project name containing ".." or a separator is refused by findProject and by cloneProject
// - listProjects: a missing workspace is empty, not an error
// - listProjects: a directory without repo.git is not a project; results are sorted by name
// - cloneProject against a real local repository: repo path, base branch, origin url, wt directory
// - cloneProject refuses an existing project directory, and cleans up after a clone that fails
// - findProject: a real project, and undefined for a name nothing was cloned under
// - projectIdentities: both names of every project — the directory, and the project: some config declares
// - fetchProject leaves local branches alone while advancing refs/remotes/origin/* — the test that
//   protects the choice of --bare plus an explicit refspec over --mirror
//
// git is run for real against mkdtemp directories rather than mocked: the whole point of the
// clone/fetch code is which refs git itself decides to move, which a stub cannot tell us.

import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { nodeRunner } from "./docker.js";
import {
  cloneProject,
  fetchProject,
  findProject,
  listProjects,
  projectIdentities,
  projectNameFromUrl,
} from "./workspace.js";

/** Shelling out to git is slow enough that the default 5s timeout flakes on a cold cache. */
const SLOW = 60_000;

const temporary: string[] = [];

async function scratch(prefix: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), `sandboxer-${prefix}-`));
  temporary.push(dir);
  return dir;
}

afterEach(async () => {
  while (temporary.length > 0) {
    const dir = temporary.pop();
    if (dir) await rm(dir, { recursive: true, force: true });
  }
});

/**
 * Runs git in `cwd` and returns its trimmed stdout, throwing on failure.
 *
 * The identity and signing settings are forced on every call because these tests
 * make commits, and a developer machine with `commit.gpgsign=true` or no
 * user.email configured would otherwise fail here for reasons that have nothing
 * to do with the code under test.
 */
async function g(cwd: string, ...args: string[]): Promise<string> {
  const result = await nodeRunner("git", [
    "-C",
    cwd,
    "-c",
    "user.name=sandboxer test",
    "-c",
    "user.email=test@example.test",
    "-c",
    "commit.gpgsign=false",
    ...args,
  ]);
  if (result.code !== 0) {
    throw new Error(`git ${args.join(" ")} exited ${result.code}: ${result.stderr || result.stdout}`);
  }
  return result.stdout.trim();
}

/** A real repository with one commit on `main`, to clone from. */
async function sourceRepo(name = "acme-api"): Promise<string> {
  const parent = await scratch("src");
  const src = join(parent, name);
  await mkdir(src, { recursive: true });
  await nodeRunner("git", ["-c", "init.defaultBranch=main", "init", src]);
  await writeFile(join(src, "README.md"), "one\n");
  await g(src, "add", "-A");
  await g(src, "commit", "-m", "first");
  return src;
}

async function workspaceEnv(): Promise<{ workspace: string; env: NodeJS.ProcessEnv }> {
  const workspace = await scratch("ws");
  return { workspace, env: { ...process.env, SANDBOXER_WORKSPACE: workspace } };
}

describe("projectNameFromUrl", () => {
  it.each([
    ["https with .git", "https://host.test/owner/repo.git", "repo"],
    ["https without .git", "https://host.test/owner/repo", "repo"],
    ["the scp form", "git@host.test:owner/repo.git", "repo"],
    ["the scp form without .git", "git@host.test:owner/repo", "repo"],
    ["a trailing slash", "https://host.test/owner/repo/", "repo"],
    ["a trailing slash and .git", "https://host.test/owner/repo.git/", "repo"],
    ["a local path", "/srv/repos/demo-worker.git", "demo-worker"],
  ])("%s", (_name, url, want) => {
    expect(projectNameFromUrl(url)).toBe(want);
  });

  it("sanitises the segment into the slug alphabet", () => {
    expect(projectNameFromUrl("https://host.test/owner/Acme_API.git")).toBe("acme-api");
  });

  it.each([
    ["a bare dash", "-"],
    ["an option", "--bare"],
    // git clone reads this as an option and runs the command, so an array argument is not enough.
    ["upload-pack, which would execute a command", "--upload-pack=touch /tmp/pwned"],
  ])("refuses %s", (_name, url) => {
    expect(() => projectNameFromUrl(url)).toThrow(/starts with "-"/);
  });

  it("refuses an empty url", () => {
    expect(() => projectNameFromUrl("   ")).toThrow(/required/);
  });
});

describe("name validation", () => {
  it.each([["../escape"], [".."], ["owner/repo"], ["owner\\repo"], [""]])(
    "findProject refuses %j",
    async (name) => {
      const { env } = await workspaceEnv();
      await expect(findProject(name, { env })).rejects.toThrow(/escape the workspace|required/);
    },
    SLOW,
  );

  it(
    "cloneProject refuses an explicit name that escapes the workspace",
    async () => {
      const { env } = await workspaceEnv();
      const src = await sourceRepo();
      await expect(cloneProject(src, { env, name: "../escape" })).rejects.toThrow(/escape the workspace/);
    },
    SLOW,
  );

  it(
    "cloneProject refuses a url git would read as an option",
    async () => {
      const { env } = await workspaceEnv();
      await expect(cloneProject("--upload-pack=touch /tmp/pwned", { env })).rejects.toThrow(/starts with "-"/);
    },
    SLOW,
  );
});

describe("listProjects", () => {
  it("is empty when the workspace does not exist", async () => {
    const parent = await scratch("missing");
    const env = { ...process.env, SANDBOXER_WORKSPACE: join(parent, "never-created") };
    expect(await listProjects({ env })).toEqual([]);
  });

  it("skips a directory that holds no repo.git", async () => {
    const { workspace, env } = await workspaceEnv();
    await mkdir(join(workspace, "not-a-project", "wt"), { recursive: true });
    await writeFile(join(workspace, "loose-file"), "");
    expect(await listProjects({ env })).toEqual([]);
  });

  it(
    "lists cloned projects by name",
    async () => {
      const { env } = await workspaceEnv();
      const first = await sourceRepo("zeta-service");
      const second = await sourceRepo("alpha-service");
      await cloneProject(first, { env });
      await cloneProject(second, { env });

      expect((await listProjects({ env })).map((p) => p.name)).toEqual(["alpha-service", "zeta-service"]);
    },
    SLOW,
  );
});

describe("cloneProject", () => {
  it(
    "records the paths, the base branch and the origin",
    async () => {
      const { workspace, env } = await workspaceEnv();
      const src = await sourceRepo("demo-worker");

      const project = await cloneProject(src, { env });

      expect(project.name).toBe("demo-worker");
      expect(project.repo).toBe(join(workspace, "demo-worker", "repo.git"));
      expect(project.worktrees).toBe(join(workspace, "demo-worker", "wt"));
      expect(project.base).toBe("main");
      expect(project.origin).toBe(src);

      // The refspec is what makes a later fetch do anything at all.
      expect(await g(project.repo, "config", "remote.origin.fetch")).toBe("+refs/heads/*:refs/remotes/origin/*");
      expect(await g(project.repo, "rev-parse", "refs/remotes/origin/main")).toBe(await g(src, "rev-parse", "HEAD"));
    },
    SLOW,
  );

  it(
    "honours an explicit name",
    async () => {
      const { env } = await workspaceEnv();
      const src = await sourceRepo("demo-worker");
      const project = await cloneProject(src, { env, name: "renamed" });
      expect(project.name).toBe("renamed");
      expect(await findProject("renamed", { env })).toEqual(project);
    },
    SLOW,
  );

  it(
    "refuses a project directory that already exists",
    async () => {
      const { env } = await workspaceEnv();
      const src = await sourceRepo("demo-worker");
      await cloneProject(src, { env });
      await expect(cloneProject(src, { env })).rejects.toThrow(/already exists/);
    },
    SLOW,
  );

  it(
    "leaves nothing behind when the clone fails",
    async () => {
      const { workspace, env } = await workspaceEnv();
      const nowhere = join(workspace, "..", "no-such-repo.git");

      await expect(cloneProject(nowhere, { env, name: "broken" })).rejects.toThrow(/git clone/);

      // A half-created directory would be reported as a real project by listProjects.
      expect(await listProjects({ env })).toEqual([]);
      expect(await findProject("broken", { env })).toBeUndefined();
    },
    SLOW,
  );
});

describe("findProject", () => {
  it(
    "answers undefined for a name nothing was cloned under",
    async () => {
      const { env } = await workspaceEnv();
      expect(await findProject("absent", { env })).toBeUndefined();
    },
    SLOW,
  );
});

describe("fetchProject", () => {
  /**
   * This is the test that justifies `--bare` plus an explicit
   * `+refs/heads/*:+refs/remotes/origin/*` over `--mirror`.
   *
   * A mirror clone fetches `+refs/*:refs/*`, so this fetch would force
   * `refs/heads/main` back to whatever the source says and the commit made
   * locally would become unreachable — a worktree checked out on that branch
   * would silently lose work. Swap the implementation to `--mirror` and this
   * assertion fails; that is the whole point of it.
   */
  it(
    "does not move a local branch that has commits the remote has never seen",
    async () => {
      const { env } = await workspaceEnv();
      const src = await sourceRepo("demo-worker");
      const project = await cloneProject(src, { env });

      // A commit that exists only in the mirror, made without a worktree.
      const tree = await g(project.repo, "rev-parse", "HEAD^{tree}");
      const parent = await g(project.repo, "rev-parse", "HEAD");
      const localOnly = await g(project.repo, "commit-tree", tree, "-p", parent, "-m", "work done in a sandbox");
      await g(project.repo, "update-ref", `refs/heads/${project.base}`, localOnly);

      // Meanwhile the remote moves on, so the fetch has real work to do.
      await writeFile(join(src, "README.md"), "two\n");
      await g(src, "add", "-A");
      await g(src, "commit", "-m", "second");
      const remoteHead = await g(src, "rev-parse", "HEAD");

      await fetchProject(project);

      expect(await g(project.repo, "rev-parse", `refs/heads/${project.base}`)).toBe(localOnly);
      expect(await g(project.repo, "rev-parse", `refs/remotes/origin/${project.base}`)).toBe(remoteHead);
    },
    SLOW,
  );

  it(
    "picks up a branch created on the remote after the clone",
    async () => {
      const { env } = await workspaceEnv();
      const src = await sourceRepo("demo-worker");
      const project = await cloneProject(src, { env });

      await g(src, "checkout", "-b", "feature/login");
      await writeFile(join(src, "login.txt"), "x\n");
      await g(src, "add", "-A");
      await g(src, "commit", "-m", "login");

      await fetchProject(project);

      expect(await g(project.repo, "rev-parse", "refs/remotes/origin/feature/login")).toBe(
        await g(src, "rev-parse", "HEAD"),
      );
    },
    SLOW,
  );

  it(
    "reports a fetch that fails rather than succeeding quietly",
    async () => {
      const { env } = await workspaceEnv();
      const src = await sourceRepo("demo-worker");
      const project = await cloneProject(src, { env });

      await rm(src, { recursive: true, force: true });

      await expect(fetchProject(project)).rejects.toThrow(/git fetch origin/);
    },
    SLOW,
  );
});

describe("projectIdentities", () => {
  // The pair `config.yaml` may be keyed on (§4.3). Answering with directory
  // names alone would report a correct entry — one keyed on a project's declared
  // name — as matching nothing, which is worse than the silence it replaces.
  it("reports the directory alone when nothing declares a name", async () => {
    const workspace = await scratch("identities");
    await mkdir(join(workspace, "demo-managed", "repo.git"), { recursive: true });

    expect(await projectIdentities({ env: { SANDBOXER_WORKSPACE: workspace } })).toEqual([
      { directory: "demo-managed" },
    ]);
  });

  it("takes the project-level config's declared name", async () => {
    const workspace = await scratch("identities");
    await mkdir(join(workspace, "acme-monorepo", "repo.git"), { recursive: true });
    await writeFile(join(workspace, "acme-monorepo", "sandboxer.yaml"), "project: acme\n");

    expect(await projectIdentities({ env: { SANDBOXER_WORKSPACE: workspace } })).toEqual([
      { directory: "acme-monorepo", project: "acme" },
    ]);
  });

  it("falls back to a worktree's own config", async () => {
    const workspace = await scratch("identities");
    const worktree = join(workspace, "acme-monorepo", "wt", "main");
    await mkdir(join(workspace, "acme-monorepo", "repo.git"), { recursive: true });
    await mkdir(worktree, { recursive: true });
    await writeFile(join(worktree, "sandboxer.yaml"), "project: acme\ndatabase: { driver: mysql }\n");

    expect(await projectIdentities({ env: { SANDBOXER_WORKSPACE: workspace } })).toEqual([
      { directory: "acme-monorepo", project: "acme" },
    ]);
  });

  // A config that cannot be resolved for some other reason still tells the truth
  // about what its project is called, and this read is only ever about the name.
  it("survives a config it cannot parse", async () => {
    const workspace = await scratch("identities");
    await mkdir(join(workspace, "acme", "repo.git"), { recursive: true });
    await writeFile(join(workspace, "acme", "sandboxer.yaml"), "project: [\n");

    expect(await projectIdentities({ env: { SANDBOXER_WORKSPACE: workspace } })).toEqual([
      { directory: "acme" },
    ]);
  });
});
