/**
 * The `docker run` argument list for one sandbox, and the build commands for
 * what runs inside it.
 *
 * Kept as pure functions over an input record so the whole shape of a sandbox —
 * every mount, every label, every limit — can be asserted in a test without a
 * daemon. Arguments are always an array: a slug, a branch or a path can never
 * become shell syntax.
 */

import { createHash } from "node:crypto";

import type { BackendService, FrontendApp, ResolvedConfig } from "../config/types.js";
import {
  CLAUDE_VOLUME,
  GOCACHE_VOLUME,
  GOMOD_VOLUME,
  NETWORK,
  containerName,
  depsVolumeName,
  volumeName,
} from "../naming.js";
import { labelArgs } from "./labels.js";
import {
  BIN_DIR,
  BLOB_DIR,
  CACHE_DIR,
  CLAUDE_DIR,
  CREDENTIALS_FILE,
  DATA_DIR,
  GOCACHE_DIR,
  GOMOD_DIR,
  LOG_DIR,
  PLAN_FILE,
  SECRETS_FILE,
  WORKSPACE,
  WWW_DIR,
  binaryPath,
  siteDir,
} from "./layout.js";

/** The image a sandbox runs. The container package builds it. */
export const DEFAULT_IMAGE = "sandboxr/base:latest";

/** The entrypoint inside that image. */
export const ENTRYPOINT = "/opt/sandboxr/scripts/entrypoint.sh";

export interface RunInput {
  config: ResolvedConfig;
  slug: string;
  worktree: string;
  labels: Record<string, string>;
  /** The generated per-sandbox environment file, on the host. */
  envFile: string;
  /** The project's secrets file, when one exists and may be used. */
  secretsFile?: string | undefined;
  /** The plan, on the host. The container's only view of the project. */
  planFile: string;
  /** The host seed cache, mounted read-only. */
  cacheDir: string;
  /**
   * A seed artifact that is *not* in that cache, and so needs a mount of its own.
   *
   * `seedMount` in ./layout.ts decides this and names the path inside; the same
   * call fills in the plan, so the container cannot be told to open a file
   * nothing mounted. See contracts §6.2 for why a declared `file:` is mounted
   * rather than copied into the cache.
   */
  seedFile?: { host: string; inside: string } | undefined;
  /** The per-sandbox log directory on the host, so logs outlive the container. */
  logDir: string;
  /** Hash of the project's lockfile, which keys the shared dependency volume. */
  depsHash?: string | undefined;
  /** The dependency tree, when it was found on disk rather than declared. */
  deps?: { root: string } | undefined;
  image?: string | undefined;
  memory?: string | undefined;
  /** Optional runtimes to start, passed to the entrypoint. */
  with?: string[] | undefined;
  /**
   * Host directories bind-mounted at the identical path inside, so that git
   * works: a linked worktree's `.git` is a file naming its repository by
   * absolute path. Resolved by `gitMounts` in ../git.ts, which is where the
   * whole reasoning lives.
   */
  gitMounts?: string[] | undefined;
  /**
   * Who a commit made inside the sandbox is by. A sandbox has no `~/.gitconfig`
   * and git refuses to commit without this — see `hostGitIdentity`.
   */
  gitIdentity?: { name?: string | undefined; email?: string | undefined } | undefined;
  /**
   * The machine's GitHub token, when `config.yaml` says this project may have it.
   *
   * Absent unless the operator opted in (see `resolveGithub`), and passed as a
   * *value* for the reason access/dashboard.ts records: on macOS `gh` keeps the
   * token in the login keychain, so there is no file that could be mounted.
   */
  ghToken?: string | undefined;
  /**
   * The host's Claude Code login, as a path on the host.
   *
   * Absent unless that file exists, which on macOS it never does. Resolved by
   * `hostClaudeCredentials` in ../agent/credentials.ts, which is where the whole
   * reasoning lives.
   */
  claudeCredentials?: string | undefined;
  /**
   * The labels the shared router reconciles from.
   *
   * Passed in rather than derived here because they depend on the domain and on
   * whether the router terminates TLS, neither of which is a fact about the
   * sandbox. Absent means the sandbox runs unreachable, which is what a test
   * wants and never what a person does.
   */
  routerLabels?: Record<string, string> | undefined;
}

/**
 * Hashes a lockfile's contents.
 *
 * The dependency volume is named after this, so every sandbox whose lockfile
 * matches shares one install and a branch that changes its dependencies
 * transparently gets its own — which is the only way a rebuild after a
 * dependency change is correct rather than merely fast.
 */
export function lockHash(contents: string): string {
  return createHash("sha256").update(contents).digest("hex").slice(0, 16);
}

export function runArgs(input: RunInput): string[] {
  const { config, slug } = input;
  const name = containerName(config.project, slug);

  const args = ["run", "-d", "--name", name, "--network", NETWORK, ...labelArgs(input.labels)];

  // The router reconciles from these labels as containers come and go, so
  // starting a sandbox never regenerates router config or triggers a reload.
  args.push(...labelArgs(input.routerLabels ?? {}));

  args.push("--env-file", input.envFile);

  if (input.with && input.with.length > 0) args.push("-e", `SANDBOXR_WITH=${input.with.join(",")}`);

  args.push("--memory", input.memory ?? memoryFor(config));

  // The worktree is bind-mounted, so saving a file on the host puts it in the
  // container immediately — and an agent editing inside the container writes to
  // the worktree, so its changes show up in `git status`.
  args.push("-v", `${input.worktree}:${WORKSPACE}`);
  // …and again at its own path, alongside the repository it was cut from, so
  // that git works at all. Read-write, and that is the deliberate part: `git
  // commit` writes objects and refs into the *repository*, so a read-only mount
  // would leave status and log working and fail only at the commit, with a
  // permission error from inside git — a newer and more confusing break than the
  // one this fixes. The cost is that every sandbox of a project shares one
  // object store and one set of refs with the host: a sandbox can move a branch
  // another worktree has checked out, and a `git gc` inside one repacks what all
  // of them read. See `gitMounts` in ../git.ts for the rest.
  //
  // `path !== WORKSPACE` because a host checkout that happens to live at
  // `/workspace` would otherwise be mounted twice at one destination, and Docker
  // refuses the whole `run` over it rather than ignoring the second.
  for (const path of input.gitMounts ?? []) {
    if (path !== WORKSPACE) args.push("-v", `${path}:${path}`);
  }
  // Read-only: the plan is the host's statement of what this project is, and a
  // container that could rewrite it could change what it claims to be running.
  args.push("-v", `${input.planFile}:${PLAN_FILE}:ro`);
  // The project's credentials, mounted rather than passed as a second
  // `--env-file`. This used to be an env-file layered *under* the generated one,
  // and Docker settled which won. It cost more than it bought: `--env-file` is
  // read once at `docker run`, so an edited credential could not reach a running
  // sandbox at all — `restart` and `stop`/`start` keep the environment the
  // container was created with, and only recreating it picked up a new value.
  // Mounted, `env.sh` re-reads it every time it is sourced, so a restart applies
  // a rotated key and a rebuild applies a changed build-time variable.
  //
  // What now settles a collision is `secrets.ts`'s `RESERVED_ENV_NAMES`, which
  // refuses the names the sandbox derives for itself — the file is read *first*
  // inside the container, so nothing else would stop an imported `DB_HOST` from
  // pointing a disposable copy at a real database.
  if (input.secretsFile) args.push("-v", `${input.secretsFile}:${SECRETS_FILE}:ro`);
  args.push("-v", `${volumeName("bin", config.project, slug)}:${BIN_DIR}`);
  args.push("-v", `${volumeName("www", config.project, slug)}:${WWW_DIR}`);
  // One volume, two shapes: a server keeps its data directory here and a
  // file-backed driver keeps the sandbox's private copy of the file here, so
  // `down` removes the database either way.
  if (config.database.driver !== "none") {
    args.push("-v", `${volumeName("data", config.project, slug)}:${DATA_DIR}`);
  }
  if (config.storage.driver !== "none") {
    args.push("-v", `${volumeName("blob", config.project, slug)}:${BLOB_DIR}`);
  }
  // Mounted at the dependency root the project declares, because the directory
  // holding the lockfile is not always the directory holding the packages.
  const deps = config.deps ?? input.deps;
  if (input.depsHash && deps) {
    const root = deps.root === "." ? WORKSPACE : `${WORKSPACE}/${deps.root}`;
    args.push("-v", `${depsVolumeName(input.depsHash)}:${root}/node_modules`);
  }
  // Go's two caches, shared by every sandbox on the machine (contracts §3.3).
  // Only for a project that declares the toolchain: a sandbox with no Go in it
  // would otherwise carry two mounts nothing ever reads.
  if (config.toolchain.go) {
    args.push("-v", `${GOCACHE_VOLUME}:${GOCACHE_DIR}`);
    args.push("-v", `${GOMOD_VOLUME}:${GOMOD_DIR}`);
  }
  args.push("-v", `${input.cacheDir}:${CACHE_DIR}:ro`);
  // The single file and not its directory: `file:` may point into a directory
  // the user keeps other things in, and mounting the parent would hand all of
  // them to the sandbox to buy nothing. Read-only for the reason the cache is —
  // a sandbox restores from a seed and never writes to one.
  if (input.seedFile) args.push("-v", `${input.seedFile.host}:${input.seedFile.inside}:ro`);
  args.push("-v", `${input.logDir}:${LOG_DIR}`);
  // Not a per-sandbox volume: an MCP server is authorised once per machine with
  // `claude mcp login`, and the whole point is that the next worktree does not
  // have to do it again. See CLAUDE_VOLUME for what every sandbox sharing one
  // credential store costs, and CLAUDE_DIR for why the environment variable
  // below is not optional.
  args.push("-v", `${CLAUDE_VOLUME}:${CLAUDE_DIR}`);
  args.push("-e", `CLAUDE_CONFIG_DIR=${CLAUDE_DIR}`);
  // The host's login, one file, mounted over the volume's copy of it.
  //
  // **The single file and not the directory**, and that is the security boundary
  // rather than tidiness: binding all of `~/.claude` would give every sandbox
  // write access to the host's settings.json, which can define hooks — commands
  // the host's own Claude Code then executes. A sandbox writing one is a
  // container-to-host escalation delivered by a convenience feature, and the
  // same mount would hand it the person's history, plans and project state too.
  //
  // **Read-write, deliberately.** An OAuth refresh token rotates and is
  // single-use, so a *copy* dies the first time either side refreshes; sharing
  // the one file means the refresh a sandbox performs updates the host's login
  // and every other sandbox's at once. Read-only would work exactly until that
  // first refresh and then fail the same way copying did.
  //
  // Ordered after the volume because Docker applies mounts by path depth, not by
  // argument order — but written after it anyway, so reading this list top to
  // bottom describes what the container actually gets.
  if (input.claudeCredentials) args.push("-v", `${input.claudeCredentials}:${CREDENTIALS_FILE}`);

  // The commit identity, as four variables rather than a mounted gitconfig.
  //
  // Author *and* committer, because git needs both and fails on whichever is
  // missing: setting only the author pair gets you past the first error into an
  // identical second one about the committer.
  //
  // These are `-e` rather than exported by the entrypoint on purpose. `docker
  // exec` does not inherit what the entrypoint exported — it gets the
  // container's environment — and every git command that matters here arrives
  // through an exec: the terminal, and an agent session.
  const identity = input.gitIdentity;
  if (identity?.name) args.push("-e", `GIT_AUTHOR_NAME=${identity.name}`, "-e", `GIT_COMMITTER_NAME=${identity.name}`);
  if (identity?.email) {
    args.push("-e", `GIT_AUTHOR_EMAIL=${identity.email}`, "-e", `GIT_COMMITTER_EMAIL=${identity.email}`);
  }
  // The token, only when the machine opted this project in. `gh` reads GH_TOKEN
  // on its own, and the base image points git's https credential helper at `gh
  // auth git-credential`, so this one variable is what makes both the CLI and
  // `git push` work.
  if (input.ghToken) args.push("-e", `GH_TOKEN=${input.ghToken}`);

  args.push("--entrypoint", ENTRYPOINT, input.image ?? DEFAULT_IMAGE);
  return args;
}

/**
 * The memory limit for the whole sandbox.
 *
 * The largest limit any one runtime asks for wins, because the cgroup total is
 * what the kernel enforces: a front-end build that needs 6 GB is killed part-way
 * through under a 4 GB cap, and reports nothing but an exit code that reads as a
 * broken build rather than a full one.
 */
export function memoryFor(config: ResolvedConfig, floor = "4g"): string {
  const limits = [...config.backends, ...config.frontends]
    .map((runtime) => runtime.memory)
    .filter((limit): limit is string => typeof limit === "string");
  return [floor, ...limits].reduce((largest, limit) => (toBytes(limit) > toBytes(largest) ? limit : largest), floor);
}

export function toBytes(limit: string): number {
  const match = /^([0-9]+)([bkmg])?$/i.exec(limit.trim());
  if (!match) return 0;
  const value = Number(match[1]);
  switch ((match[2] ?? "b").toLowerCase()) {
    case "g":
      return value * 1_073_741_824;
    case "m":
      return value * 1_048_576;
    case "k":
      return value * 1024;
    default:
      return value;
  }
}

/** Values a build template may be given. Anything else is refused. */
const SAFE_SUBSTITUTION = /^[A-Za-z0-9._/@-]+$/;

export class BuildError extends Error {
  override readonly name = "BuildError";
}

/**
 * Fills in a build command's placeholders.
 *
 * `{name}` and `{out}` are the only two, and both substituted values are checked
 * against a conservative alphabet first. The command itself comes from the
 * project's config and is handed to a shell, so a value with a space or a
 * semicolon in it would be two commands rather than one argument.
 */
export function renderBuild(template: string, values: { name?: string; out?: string }): string {
  return template.replace(/\{(name|out)\}/g, (_match, key: "name" | "out") => {
    const value = values[key];
    if (value === undefined) throw new BuildError(`build command uses {${key}}, which is not available here`);
    if (!SAFE_SUBSTITUTION.test(value)) throw new BuildError(`"${value}" is not a usable {${key}}`);
    return value;
  });
}

/** The command that builds one backend, and where its binary lands. */
export function backendBuild(backend: BackendService): { command: string; workdir: string; output: string } {
  const output = binaryPath(backend.name);
  return {
    command: renderBuild(backend.build ?? "", { name: backend.name, out: output }),
    workdir: backend.workdir ? `${WORKSPACE}/${backend.workdir}` : WORKSPACE,
    output,
  };
}

/**
 * The command that builds one static front-end, and where the site lands.
 *
 * The build runs in the package directory and the output is copied to the served
 * directory afterwards, rather than the build being told to write there: a build
 * tool's output path is its own business, and several refuse to write outside
 * their package.
 */
export function frontendBuild(
  config: ResolvedConfig,
  app: FrontendApp,
): { command: string; workdir: string; output: string; served: string } {
  const packageDir = [WORKSPACE, config.frontendRoot, app.package]
    .filter((part) => part !== "" && part !== ".")
    .join("/");
  return {
    command: renderBuild(app.build ?? "", { name: app.package, out: app.out ?? "dist" }),
    workdir: packageDir,
    output: `${packageDir}/${app.out ?? "dist"}`,
    served: siteDir(app.label),
  };
}
