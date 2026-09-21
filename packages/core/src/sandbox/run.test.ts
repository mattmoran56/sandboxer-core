// Tests for the docker run arguments and the build commands:
// - runArgs: the container name, the shared network, every label, and the worktree bind mount
// - runArgs: one volume per purpose, the data mount per driver, storage only when declared
// - runArgs: the seed cache is read-only, the secrets file is layered under the generated environment
// - runArgs: a seed that is not in the cache is mounted as one read-only file, and its directory is not
// - runArgs: the machine-wide Go caches are mounted for a Go project and absent for one without the toolchain
// - runArgs: the machine-wide Claude volume is mounted and CLAUDE_CONFIG_DIR points inside it
// - runArgs: the host's login is one file mounted read-write over the volume, never the directory, and absent without one
// - runArgs: the git mounts land at the identical path inside and out, read-write, and none is /workspace
// - runArgs: a session's runtime takes /workspace from the work volume, and then asks for no git mounts at all
// - runArgs: the commit identity is passed as author *and* committer, and omitted when there is none
// - runArgs: GH_TOKEN only when one was resolved, so opting out leaves no credential in the container
// - runArgs: no argument is ever a shell string, and a value with a space survives as one argument
// - memoryFor / toBytes: the largest declared limit wins, because the cgroup total is what the kernel enforces
// - renderBuild: placeholder substitution, a missing placeholder, and a value that would become shell syntax
// - backendBuild / frontendBuild: the workdir, the output path and the served directory

import { describe, expect, it } from "vitest";

import { resolveConfig } from "../config/load.js";
import type { ResolvedConfig } from "../config/types.js";
import { labelsFor } from "./labels.js";
import { BuildError, backendBuild, frontendBuild, lockHash, memoryFor, renderBuild, runArgs, toBytes } from "./run.js";

function configOf(extra: Record<string, unknown>): ResolvedConfig {
  return resolveConfig({ project: "acme", sandboxr: ">=0.1.0", access: { apps: "private" }, ...extra }, "/repo/sandboxr.yaml");
}

const mysqlConfig = configOf({
  database: { driver: "mysql", seed_from: { fixtures: "f.sql" }, migrate: { command: "m" } },
  backends: [{ name: "api", port: 8001, label: "api", build: "go build -o {out} ./{name}", workdir: "services" }],
  frontends: {
    root: "packages",
    defaults: { build: "npx vite build", out: "dist" },
    apps: [
      { label: "app", package: "web" },
      { label: "www", package: "marketing", memory: "6g" },
    ],
  },
  storage: { driver: "minio", buckets: ["uploads"] },
});

const labels = labelsFor({
  project: "acme",
  slug: "tkt-1",
  branch: "feat/a b",
  commit: "abc",
  dirty: false,
  worktree: "/repos/tkt-1",
  driver: "mysql",
  access: "private",
});

const base = {
  config: mysqlConfig,
  slug: "tkt-1",
  worktree: "/repos/tkt-1",
  labels,
  envFile: "/home/.sandboxr/build/acme/tkt-1.env",
  planFile: "/home/.sandboxr/build/acme/tkt-1.plan.json",
  cacheDir: "/home/.sandboxr/cache",
  logDir: "/home/.sandboxr/logs/acme/tkt-1",
};

describe("runArgs", () => {
  const args = runArgs(base);

  it("names the container and joins the one shared network", () => {
    expect(args.slice(0, 6)).toEqual(["run", "-d", "--name", "sandboxr-acme-tkt-1", "--network", "sandboxr"]);
  });

  it("carries every label", () => {
    for (const [key, value] of Object.entries(labels)) {
      const index = args.indexOf(`${key}=${value}`);
      expect(index).toBeGreaterThan(-1);
      expect(args[index - 1]).toBe("--label");
    }
  });

  // A branch name can contain a space, and an argument array is what keeps it
  // one argument rather than two.
  it("keeps a value containing a space as a single argument", () => {
    expect(args).toContain("sandboxr.branch=feat/a b");
  });

  it("bind-mounts the worktree, so a saved file is immediately live inside", () => {
    expect(args).toContain("/repos/tkt-1:/workspace");
  });

  describe("the mounts git needs", () => {
    const withGit = runArgs({ ...base, gitMounts: ["/repos/tkt-1", "/repos/acme.git"] });

    // Identical path inside and out, because a linked worktree's `.git` names
    // its repository by absolute path and nothing rewrites that on the way in.
    it("puts each one at the path the host calls it", () => {
      expect(withGit).toContain("/repos/tkt-1:/repos/tkt-1");
      expect(withGit).toContain("/repos/acme.git:/repos/acme.git");
    });

    // Read-write is the deliberate half: `git commit` writes objects and refs
    // into the repository, so `:ro` would break only at the commit.
    it("mounts them read-write", () => {
      expect(withGit.join(" ")).not.toContain("/repos/acme.git:/repos/acme.git:ro");
    });

    it("adds nothing at all when git needs nothing", () => {
      expect(runArgs({ ...base, gitMounts: [] }).join(" ")).not.toContain("/repos/acme.git");
    });

    // Docker refuses the whole `run` over two mounts at one destination, so a
    // host checkout that happens to live at /workspace must not be added twice.
    it("skips a path that is already the workspace destination", () => {
      const collision = runArgs({ ...base, worktree: "/workspace", gitMounts: ["/workspace", "/repos/acme.git"] });
      expect(collision.filter((arg) => arg === "/workspace:/workspace")).toHaveLength(1);
    });
  });

  describe("a session's runtime", () => {
    // `/workspace` from the work volume instead of the host (contracts §12.5).
    // The mounts themselves are `runtimeWorkspaceArgs`' and are asserted in
    // ../session/runtime.test.ts; what matters here is what they replace.
    const mounts = [
      "-v",
      "sandboxr-work-eng-3941:/work",
      "--mount",
      "type=volume,source=sandboxr-work-eng-3941,target=/workspace,volume-subpath=acme/feat-thing",
    ];
    const runtime = runArgs({ ...base, workspaceMounts: mounts, gitMounts: ["/repos/tkt-1", "/repos/acme.git"] });

    it("takes /workspace from the volume rather than binding a host path", () => {
      expect(runtime).toContain("type=volume,source=sandboxr-work-eng-3941,target=/workspace,volume-subpath=acme/feat-thing");
      expect(runtime).toContain("sandboxr-work-eng-3941:/work");
      expect(runtime).not.toContain("/repos/tkt-1:/workspace");
    });

    // The simplification, asserted: a clone on a work volume is self-contained,
    // so none of `gitMounts` applies to it — even when a caller passes some.
    it("mounts nothing at an identical host path for git's benefit", () => {
      expect(runtime).not.toContain("/repos/acme.git:/repos/acme.git");
      expect(runtime).not.toContain("/repos/tkt-1:/repos/tkt-1");
    });
  });

  describe("committing from inside", () => {
    const identified = runArgs({ ...base, gitIdentity: { name: "Ada L", email: "ada@example.com" } });

    // Both pairs: git fails on whichever is missing, so setting only the author
    // buys an identical second error about the committer.
    it("sets the author and the committer", () => {
      expect(identified).toContain("GIT_AUTHOR_NAME=Ada L");
      expect(identified).toContain("GIT_COMMITTER_NAME=Ada L");
      expect(identified).toContain("GIT_AUTHOR_EMAIL=ada@example.com");
      expect(identified).toContain("GIT_COMMITTER_EMAIL=ada@example.com");
    });

    it("says nothing when the machine has no identity", () => {
      expect(runArgs({ ...base, gitIdentity: {} }).join(" ")).not.toContain("GIT_AUTHOR");
      expect(args.join(" ")).not.toContain("GIT_AUTHOR");
    });
  });

  describe("the GitHub token", () => {
    it("is passed as a value, because on macOS there is no file to mount", () => {
      expect(runArgs({ ...base, ghToken: "gho_example" })).toContain("GH_TOKEN=gho_example");
    });

    // The opt-out has to be a genuine absence, not an empty string: `gh` reads
    // an empty GH_TOKEN as a credential and reports itself broken rather than
    // logged out.
    it("is absent entirely when the machine did not opt this project in", () => {
      expect(args.join(" ")).not.toContain("GH_TOKEN");
    });
  });

  it.each([
    ["binaries", "sandboxr-bin-acme-tkt-1:/var/lib/sandboxr/bin"],
    ["built sites", "sandboxr-www-acme-tkt-1:/srv/www"],
    ["the database", "sandboxr-data-acme-tkt-1:/var/lib/sandboxr/data"],
    ["object storage", "sandboxr-blob-acme-tkt-1:/var/lib/sandboxr/blob"],
  ])("gives the sandbox its own volume for %s", (_name, mount) => {
    expect(args).toContain(mount);
  });

  // One volume either way, so `down` removes the database whichever driver it is.
  it("mounts a file-backed database on the same data volume", () => {
    const fileArgs = runArgs({
      ...base,
      config: configOf({
        database: { driver: "sqlite", seed_from: { fixtures: "f.sql" }, migrate: { command: "m" } },
      }),
    });
    expect(fileArgs).toContain("sandboxr-data-acme-tkt-1:/var/lib/sandboxr/data");
  });

  // The container reads the plan and never sandboxr.yaml, and a container that
  // could rewrite the plan could change what it claims to be running.
  it("mounts the plan read-only", () => {
    expect(args).toContain(`${base.planFile}:/sandboxr/plan.json:ro`);
  });

  it("mounts the log directory from the host, so logs outlive the container", () => {
    expect(args).toContain(`${base.logDir}:/var/log/sandboxr`);
  });

  it("mounts no database volume for a project with no database", () => {
    const bare = runArgs({ ...base, config: configOf({ database: { driver: "none" } }) });
    expect(bare.join(" ")).not.toContain("sandboxr-data-");
  });

  it("mounts no storage volume unless storage is declared", () => {
    const bare = runArgs({ ...base, config: configOf({ database: { driver: "none" } }) });
    expect(bare.join(" ")).not.toContain("sandboxr-blob-");
  });

  // A sandbox restores from the cache and never writes to it.
  it("mounts the seed cache read-only", () => {
    expect(args).toContain("/home/.sandboxr/cache:/sandboxr/cache:ro");
  });

  // A declared `database.seed_from.file` may be anywhere, so the cache mount
  // does not reach it. Without this the plan named a file that was not in the
  // container at all, and the sandbox quietly started from an empty database.
  describe("a seed that is not in the cache", () => {
    const declared = runArgs({
      ...base,
      seedFile: { host: "/home/dev/.sandboxr/seeds/acme-base.sql.zst", inside: "/sandboxr/seed/acme-base.sql.zst" },
    });

    it("mounts that one file, read-only, at the path the plan names", () => {
      expect(declared).toContain("/home/dev/.sandboxr/seeds/acme-base.sql.zst:/sandboxr/seed/acme-base.sql.zst:ro");
    });

    // The directory around it is not mounted: `file:` may point into somewhere
    // the user keeps other things, and mounting the parent buys nothing.
    it("does not mount the directory it came from", () => {
      expect(declared.join(" ")).not.toContain("/home/dev/.sandboxr/seeds:");
    });

    it("mounts nothing extra when the artifact is in the cache", () => {
      expect(args.join(" ")).not.toContain("/sandboxr/seed");
    });
  });

  // Unmounted, both of these live in the container's writable layer. `up`
  // replaces the container, so every start re-downloaded the module graph and
  // recompiled every dependency — and stayed just as slow on the second start,
  // which is what made it read as "sandboxes are slow" rather than as a cache
  // being thrown away.
  describe("Go's caches", () => {
    const go = runArgs({ ...base, config: configOf({ toolchain: { go: "1.25" } }) });

    it("mounts both on machine-wide volumes, at the paths the image sets GOCACHE and GOPATH to", () => {
      expect(go).toContain("sandboxr-gocache:/go/cache");
      expect(go).toContain("sandboxr-gomod:/go/pkg/mod");
    });

    it("shares them across projects, so the second project on a machine compiles less", () => {
      const other = runArgs({ ...base, slug: "tkt-2", config: configOf({ project: "other", toolchain: { go: "1.25" } }) });
      expect(other).toContain("sandboxr-gocache:/go/cache");
      expect(other).toContain("sandboxr-gomod:/go/pkg/mod");
    });

    // Two mounts nothing would ever read, on a sandbox that has no Go in it.
    it("adds neither when the project declares no Go toolchain", () => {
      expect(args.join(" ")).not.toContain("sandboxr-gocache");
      expect(args.join(" ")).not.toContain("sandboxr-gomod");
    });
  });

  // Deliberately not named after the project or the slug: an MCP server is
  // authorised once per machine, and a per-sandbox volume would mean once per
  // worktree instead.
  it("mounts one machine-wide Claude volume, shared by every sandbox", () => {
    expect(args).toContain("sandboxr-claude:/root/.claude");

    const other = runArgs({ ...base, slug: "tkt-2", config: configOf({ project: "other" }) });
    expect(other).toContain("sandboxr-claude:/root/.claude");
  });

  // Mounting the directory alone persists the session history and loses the
  // login, because the OAuth account and the personal MCP servers live in
  // `~/.claude.json`, a file *beside* the directory. This variable is what puts
  // that file on the volume too.
  it("points CLAUDE_CONFIG_DIR at the volume, so ~/.claude.json lands inside it", () => {
    const index = args.indexOf("CLAUDE_CONFIG_DIR=/root/.claude");
    expect(index).toBeGreaterThan(-1);
    expect(args[index - 1]).toBe("-e");
    // Before the image, or docker reads it as an argument to the entrypoint.
    expect(index).toBeLessThan(args.indexOf("--entrypoint"));
  });

  // `config.yaml`'s `share:` (contracts §4.3). The Claude login is the row every
  // machine has, and the one this feature was generalised out of, so it is what
  // these cases are written with.
  describe("the machine's shared files", () => {
    const withShared = runArgs({
      ...base,
      shared: [
        { host: "/Users/ada/.claude/.credentials.json", into: "/root/.claude/.credentials.json" },
        { host: "/Users/ada/.npmrc", into: "/root/.npmrc" },
      ],
    });

    it("mounts each one over whatever the container had there", () => {
      expect(withShared).toContain("/Users/ada/.claude/.credentials.json:/root/.claude/.credentials.json");
      expect(withShared).toContain("/Users/ada/.npmrc:/root/.npmrc");
    });

    // The whole security argument for this feature, learned from the one row
    // every machine has. Binding `~/.claude` itself would give every sandbox
    // write access to the host's settings.json, which can define hooks —
    // commands the host's own Claude Code then executes.
    it("never mounts the directory around a file", () => {
      expect(withShared).not.toContain("/Users/ada/.claude:/root/.claude");
      expect(withShared.filter((arg) => arg.startsWith("/Users/ada/.claude:"))).toHaveLength(0);
    });

    // A refresh token rotates and is single-use, so the sandbox has to be able
    // to write the rotated one back. `:ro` would work until the first refresh.
    it("mounts them read-write", () => {
      expect(withShared.join(" ")).not.toContain(".credentials.json:/root/.claude/.credentials.json:ro");
    });

    // A machine with no `share:` row shares nothing. That is the upgrade note
    // §4.3 makes: before this key existed the Claude credential was mounted
    // unconditionally, and a machine upgraded without a row loses that login in
    // every sandbox at once.
    it("adds nothing at all when the machine shares nothing", () => {
      expect(args.join(" ")).not.toContain("/root/.claude/.credentials.json");
      expect(args).toContain("sandboxr-claude:/root/.claude");
    });
  });

  // The directory holding the lockfile is not always the directory holding the
  // packages, so the volume lands at the root the project declares.
  it("shares one dependency volume per lockfile hash, at the declared root", () => {
    const withDeps = runArgs({
      ...base,
      config: configOf({ database: { driver: "none" }, deps: { root: "web" } }),
      depsHash: "abc123",
    });
    expect(withDeps).toContain("sandboxr-deps-abc123:/workspace/web/node_modules");

    const atRoot = runArgs({
      ...base,
      config: configOf({ database: { driver: "none" }, deps: { root: "." } }),
      depsHash: "abc123",
    });
    expect(atRoot).toContain("sandboxr-deps-abc123:/workspace/node_modules");
  });

  it("mounts no dependency volume for a project that declares no node tree", () => {
    expect(runArgs({ ...base, depsHash: "abc123" }).join(" ")).not.toContain("sandboxr-deps-");
  });

  // Mounted, never a second `--env-file`. An env-file is read once by `docker
  // run`, so an edited credential could not reach a running sandbox at all —
  // which is the whole reason this is a mount. See the note in run.ts.
  it("mounts the secrets file read-only rather than passing it as an env-file", () => {
    const withSecrets = runArgs({ ...base, secretsFile: "/home/.sandboxr/secrets/acme.env" });
    expect(withSecrets).toContain("/home/.sandboxr/secrets/acme.env:/sandboxr/secrets.env:ro");
    expect(withSecrets.filter((argument) => argument === "--env-file")).toEqual(["--env-file"]);
    expect(withSecrets[withSecrets.indexOf("--env-file") + 1]).toBe(base.envFile);
  });

  it("mounts nothing when the project has no secrets file", () => {
    expect(runArgs(base).join(" ")).not.toContain("/sandboxr/secrets.env");
  });

  it("passes optional runtimes to the entrypoint", () => {
    expect(runArgs({ ...base, with: ["cms"] })).toContain("SANDBOXR_WITH=cms");
  });

  it("ends with the entrypoint and the image", () => {
    expect(args.at(-3)).toBe("--entrypoint");
    expect(args.at(-2)).toBe("/opt/sandboxr/scripts/entrypoint.sh");
    expect(args.at(-1)).toBe("sandboxr/base:latest");
  });

  it("takes an image override", () => {
    expect(runArgs({ ...base, image: "sandboxr/base:dev" }).at(-1)).toBe("sandboxr/base:dev");
  });

  it("never produces an argument that is a shell command line", () => {
    for (const arg of args) expect(arg).not.toMatch(/\s&&\s|\s\|\s|;/);
  });
});

describe("memoryFor", () => {
  // The cgroup total is what the kernel enforces, so the largest thing the
  // project says it needs is what the sandbox has to be given.
  it("takes the largest declared limit", () => {
    expect(memoryFor(mysqlConfig)).toBe("6g");
  });

  it("falls back to the floor when nothing declares a limit", () => {
    expect(memoryFor(configOf({ database: { driver: "none" } }))).toBe("4g");
  });

  it("keeps the floor when every declared limit is smaller", () => {
    const small = configOf({
      database: { driver: "none" },
      frontends: { apps: [{ label: "a", package: "a", build: "b", out: "dist", memory: "512m" }] },
    });
    expect(memoryFor(small)).toBe("4g");
  });
});

describe("toBytes", () => {
  it.each([
    ["6g", 6 * 1_073_741_824],
    ["512m", 512 * 1_048_576],
    ["1024k", 1_048_576],
    ["1024", 1024],
    ["nonsense", 0],
  ])("reads %s", (limit, want) => {
    expect(toBytes(limit)).toBe(want);
  });
});

describe("renderBuild", () => {
  it("substitutes both placeholders", () => {
    expect(renderBuild("go build -o {out} ./{name}", { name: "api", out: "/var/lib/sandboxr/bin/api" })).toBe(
      "go build -o /var/lib/sandboxr/bin/api ./api",
    );
  });

  it("leaves a command with no placeholders alone", () => {
    expect(renderBuild("npx vite build", { name: "web" })).toBe("npx vite build");
  });

  it("refuses a placeholder it has no value for", () => {
    expect(() => renderBuild("build {out}", { name: "api" })).toThrow(BuildError);
  });

  // The command goes to a shell, so a value with a space or a semicolon would
  // be two commands rather than one argument.
  it.each(["a b", "a;rm -rf /", "$(id)", "a`b`"])("refuses %s as a substitution", (value) => {
    expect(() => renderBuild("build ./{name}", { name: value })).toThrow(BuildError);
  });
});

describe("backendBuild", () => {
  it("builds to the sandbox's binary directory, in the declared workdir", () => {
    const backend = mysqlConfig.backends[0];
    expect(backend).toBeDefined();
    expect(backendBuild(backend as NonNullable<typeof backend>)).toEqual({
      command: "go build -o /var/lib/sandboxr/bin/api ./api",
      workdir: "/workspace/services",
      output: "/var/lib/sandboxr/bin/api",
    });
  });
});

describe("frontendBuild", () => {
  it("runs in the package directory and copies the output to where it is served", () => {
    const app = mysqlConfig.frontends[0];
    expect(app).toBeDefined();
    expect(frontendBuild(mysqlConfig, app as NonNullable<typeof app>)).toEqual({
      command: "npx vite build",
      workdir: "/workspace/packages/web",
      output: "/workspace/packages/web/dist",
      served: "/srv/www/app",
    });
  });

  it("handles a package at the repo root", () => {
    const rootConfig = configOf({
      database: { driver: "none" },
      frontends: { apps: [{ label: "app", package: ".", build: "b", out: "dist" }] },
    });
    const app = rootConfig.frontends[0];
    expect(frontendBuild(rootConfig, app as NonNullable<typeof app>).workdir).toBe("/workspace");
  });
});

describe("lockHash", () => {
  it("is stable and short", () => {
    expect(lockHash("contents")).toBe(lockHash("contents"));
    expect(lockHash("contents")).toHaveLength(16);
  });

  // A branch that changes its dependencies has to get its own volume, or a
  // build there compiles against the wrong tree.
  it("moves when the lockfile moves", () => {
    expect(lockHash("a")).not.toBe(lockHash("b"));
  });
});
