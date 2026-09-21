/**
 * The sandbox lifecycle: up, down, list, status, reload, gc, prune.
 *
 * Everything here reads and writes only the labels in contracts §3.4, so `list`
 * and `gc` are functions of `docker ps` and there is no state on the host that
 * can disagree with what is running.
 */

import { existsSync } from "node:fs";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import {
  ROUTER_CONTAINER,
  domainOf,
  ensureBaseImage,
  listFrontends,
  portSuffix,
  routerPorts,
  routerScheme,
  sandboxRouteLabels,
} from "../access/index.js";
import { allowsRealCredentials } from "../config/access.js";
import { loadConfig, slugCeilingFor } from "../config/load.js";
import { CONFIG_FILENAME, CONFIG_FILENAMES, workspaceWorktree } from "../config/locate.js";
import { decideGithub, loadMachineConfig, resolveTtl, sharedFiles } from "../config/machine.js";
import { resolveDeps } from "../config/deps.js";
import { planFor, writePlan } from "../config/plan.js";
import type { ResolvedConfig } from "../config/types.js";
import { docker as defaultDocker, type Docker, type ImageRow } from "../docker.js";
import { driverContext, getDriver } from "../drivers/index.js";
import { chooseSeed } from "../drivers/seed.js";
import { describeSeedChoice, mysqlSettings } from "../drivers/mysql.js";
import type { SeedArtifact } from "../drivers/types.js";
import { hostGhToken } from "../forge.js";
import { gitFacts, gitMounts, hostGitIdentity } from "../git.js";
import { findProject, projectDirectories } from "../workspace.js";
import { addWorktree } from "../worktree.js";
import { slugFor } from "../worktree-slug.js";
import { sandboxActivity, type SandboxActivityOptions } from "./activity.js";
import type { ProvidedWorkspace } from "./provided.js";
import { parseTtl, planExpiry, type ExpiryCandidate, type ExpiryPlan } from "./expiry.js";
import { isKeptAlive, removeKeep } from "./keep.js";
import { ensureProjectImage } from "../image.js";
import { NETWORK, containerName, urlFor, volumeName } from "../naming.js";
import { directoriesOf, paths } from "../paths.js";
import { containerEnv, renderEnvFile, urlsFor } from "./env.js";
import { envDigest, readProjectSecrets } from "../secrets.js";
import { planGc } from "./gc.js";
import { planPrune, type PruneResult } from "./prune.js";
import { LABELS, SANDBOX_FILTER, deriveState, labelsFromConfig, sandboxFromLabels } from "./labels.js";
import { BUILT_MANIFEST, MIGRATE_STATE, WITH_ENV, WWW_DIR, seedMount } from "./layout.js";
import { DEFAULT_IMAGE, backendBuild, frontendBuild, lockHash, runArgs } from "./run.js";
import type {
  DownOptions,
  DownReport,
  ExpireOptions,
  GcOptions,
  GcPlan,
  ListOptions,
  CommonOptions,
  PruneOptions,
  ReloadOptions,
  ReloadResult,
  Sandbox,
  SandboxStatus,
  ServiceHealth,
  StatusOptions,
  UpOptions,
  UpResult,
} from "./types.js";

export class SandboxError extends Error {
  override readonly name = "SandboxError";
}

const noop = (): void => {};

/**
 * The project's config, refused in the workspace's own terms when it is missing.
 *
 * Two things this does that a bare `loadConfig` cannot. It names **the workspace
 * the caller resolved**, because `manifests` is a directory somewhere in `/tmp`
 * that the person reading the message has never seen and cannot look in. And it
 * stops the walk-up there: `loadConfig` searches every parent to the filesystem
 * root, which for a temporary directory means it could find somebody else's
 * `sandboxr.yaml` and run this checkout as that project.
 *
 * §5.6's project-level fallback is deliberately not offered here. It exists
 * because an uncommitted config in one worktree does not exist in any other, and
 * a provided workspace is not a worktree of anything the host can see — so a
 * project that does not describe itself is refused rather than run against a
 * file its authors cannot see.
 */
async function loadProvidedConfig(
  from: string,
  provided: ProvidedWorkspace | undefined,
  env: NodeJS.ProcessEnv,
): Promise<ResolvedConfig> {
  if (provided && !CONFIG_FILENAMES.some((name) => existsSync(join(provided.manifests, name)))) {
    throw new SandboxError(
      `${provided.workspace} has no ${CONFIG_FILENAME}, so there is no project to run there.\n` +
        "  A sandbox is a running copy of a project, and a project describes itself in a " +
        `${CONFIG_FILENAME} at its repo root.`,
    );
  }
  return loadConfig(from, { env });
}

/**
 * Starts a sandbox: for one worktree, or on a `/workspace` somebody else
 * resolved.
 *
 * **One function and not two**, and that is the whole design. A sandbox on a
 * provided workspace is a sandbox: the same slug shape, the same container name,
 * the same four volumes, the same hostnames, the same plan, the same driver, the
 * same clock, the same actions. Two entry points would be two opinions about all
 * of that, and the second one to change would be the one nobody remembered.
 *
 * What a caller supplying a workspace changes is exactly the fields of
 * `ProvidedWorkspace`, each of them a `provided ?` below: where the slug comes
 * from, what `/workspace` is and how it is mounted, and that the host has no
 * checkout of its own to read the project or its git facts out of.
 *
 * **Whoever resolves a workspace disposes of it.** `up` used to stage a
 * session's checkout itself, in a wrapper around this function whose `finally`
 * removed the copy. The staging moved out with the knowledge of what a session
 * is, and the dispose discipline went with it — `startRuntime` in
 * The sessions package's `session/runtime.ts` is where it lives now, which is where it
 * belongs.
 *
 * The order matters: the seed artifact is produced on the host *before* the
 * container starts, because a sandbox restores from the host cache rather than
 * carrying data in its image — which is what stops the image needing a rebuild
 * every time the source database changes.
 */
export async function up(options: UpOptions = {}): Promise<UpResult> {
  const env = options.env ?? process.env;
  const log = options.log ?? noop;
  const docker = options.docker ?? defaultDocker;
  const p = paths(env);

  // A worktree path, or a project and branch to find one for.
  //
  // The dashboard has no working directory that means anything — it runs in a
  // container whose cwd is the installation — so without this it could only ever
  // start a sandbox for whatever `process.cwd()` happened to be. Resolving here
  // rather than in the caller keeps one answer to "which worktree is this",
  // shared by the CLI and the dashboard.
  //
  // **A provided workspace resolves none of that.** Its project is read out of
  // the manifests the caller staged, no worktree was cut for it, and the host
  // has no checkout of its code at all.
  const provided = options.workspace;
  const worktree = provided?.manifests ?? options.worktree ?? (await resolveWorktree(options, log));

  // `env` matters here: it is what says where the workspace is, and so whether
  // this worktree may fall back to its project's own `sandboxr.yaml`.
  //
  // §5.6's project-level fallback is deliberately *not* extended to a provided
  // workspace. It exists because an uncommitted `sandboxr.yaml` in one worktree
  // does not exist in any other, and a provided workspace is not a worktree of
  // anything the host can see — so a project that does not describe itself is
  // refused here, naming the workspace, rather than being run against a file its
  // authors cannot see.
  const config = options.config ?? (await loadProvidedConfig(worktree ?? process.cwd(), provided, env));
  const facts = provided?.facts ?? (await gitFacts(worktree ?? config.root));
  // What `/workspace` is: the tree the config governs, not the directory the
  // config file sits in. Usually the same thing — a project describes itself at
  // its own repo root — but a project kept in a subdirectory of a larger
  // repository would otherwise be mounted with every path in its plan resolving
  // one directory too high, and every one of those failures reads as a broken
  // plan. A project-level config in the workspace is the other way round: the
  // file is above the worktree, and `root` is still the worktree.
  const projectRoot = config.root;
  // What the sandbox records as its workspace, and what the `/workspace` mount
  // resolves to. For a provided workspace both are the name the caller gave: the
  // host has no directory to name, and recording the manifests copy would put a
  // temporary path on a label that outlives it.
  const workspace = provided?.workspace ?? projectRoot;
  // A provided workspace brings its own slug, because `slugFor` below is
  // worktree machinery: it reads a directory name, a branch, and the collision
  // token §4.2.3 writes down when two worktrees derive the same name. A caller
  // with no checkout on the host has none of those.
  //
  // `slugFor` and not `deriveSlug`: a worktree whose derived slug collided with
  // a sibling's was given one of its own when it was cut, and that is written
  // down rather than derivable. Deriving here while the dashboard read the
  // record would put the container `up` starts under a different name from the
  // one every page shows.
  const slug = provided
    ? provided.slug
    : await slugFor({
        explicit: options.slug,
        worktree: facts.worktree,
        branch: facts.branch,
        // The ceiling is this project's, not the tool's: the slug shares one DNS
        // label with the longest hostname label and the project name (contracts
        // §3.1). `resolveConfig` has already refused a config whose budget is
        // unusable, so this can only be a workable number by the time it is
        // read — and the same ceiling binds a provided slug (§3.1).
        // It reaches the collision token too — `addWorktree` sizes
        // `<base>-<token>` against the same number, so a given slug cannot be
        // the one thing that overflows the label.
        max: slugCeilingFor(config),
        env,
      });
  const domain = domainOf(env);
  const scheme = routerScheme(env);
  const ports = routerPorts(env);
  const suffix = portSuffix(scheme, ports);
  const container = containerName(config.project, slug);

  if (!(await docker.available())) {
    throw new SandboxError("Docker is not running. Start it and try again.");
  }

  const secretsFile = p.secretsFile(config.project);
  const fileExists = existsSync(secretsFile);
  // Read here rather than beside the label below, because the same read answers
  // three questions and the file is the one thing in this function that a person
  // may be editing while it runs. One read, one answer.
  const secrets = fileExists ? await readProjectSecrets(config.project, { env }) : new Map<string, string>();
  // Whether it *holds* anything, not whether it is there. A file with a header
  // and no values carries no credentials, and keying the refusal below on mere
  // existence made an empty one enough to stop a public project starting — with
  // a message naming "the real credentials" in a file that had none.
  const hasSecrets = secrets.size > 0;
  // A public sandbox gets dummy credentials unless the config opts in: anyone
  // who can drive a public app can otherwise make it send real email and spend
  // real credit. A refusal rather than a warning, with both ways out named.
  if (hasSecrets && !allowsRealCredentials(config)) {
    throw new SandboxError(
      `${config.project} serves public apps, so it may not carry the real credentials in ${secretsFile}.\n` +
        "  Either set access.credentials to real (and accept that), or set access.apps to private.",
    );
  }

  for (const dir of directoriesOf(p)) await mkdir(dir, { recursive: true });
  await docker.ensureNetwork(NETWORK);

  // Warned rather than refused: a sandbox that is up but unreachable is still
  // worth having, and the fix is one command rather than a reason to stop.
  if (!(await docker.containerRunning(ROUTER_CONTAINER))) {
    log("The shared router is not running, so this sandbox will have no hostname. Run: sandboxr init");
  }

  const driver = getDriver(config.database.driver);
  const ctx = driverContext(config, { slug, worktree: projectRoot, env, docker, log, now: undefined });
  const choice = chooseSeed(config, {
    prefer: options.seed,
    localAvailable: config.database.seedFrom?.local
      ? await docker.containerRunning(config.database.seedFrom.local.container)
      : false,
    fileAvailable: undefined,
  });
  log(`Seeding: ${describeSeedChoice(choice)}`);
  const seed: SeedArtifact = await driver.prepareSeed(ctx);

  const envFile = p.envFile(config.project, slug);
  await mkdir(dirname(envFile), { recursive: true });
  const settings = mysqlSettings(env, config.project, config.database.version);
  await writeFile(
    envFile,
    renderEnvFile(
      containerEnv({
        config,
        slug,
        domain,
        database: { user: settings.user, password: settings.password },
        with: options.with,
        seed: seed.source,
        scheme,
        publicPort: suffix.slice(1),
      }),
      `generated for ${config.project}/${slug} — regenerated on every start`,
    ),
  );

  // The plan is the container's only view of the project: nothing inside reads
  // sandboxr.yaml, so everything project-specific is resolved here first.
  const deps = await resolveDeps(config, projectRoot);
  // Where the container will find the artifact, and what has to be mounted for
  // it to be there — one answer, used by both the plan below and `runArgs`
  // further down. Two derivations of this is how a declared `file:` came to be
  // named in the plan as a cache entry that was never mounted.
  const mount = seed.path ? seedMount(seed.path, p.cache) : undefined;
  const planFile = join(p.build, config.project, `${slug}.plan.json`);
  await writePlan(
    planFor(config, {
      seed: mount ? { path: mount.inside, anonymised: seedIsAnonymised(config, seed) } : undefined,
      deps,
    }),
    planFile,
  );

  const logDir = p.logsFor(config.project, slug);
  await mkdir(logDir, { recursive: true });

  if (await docker.containerExists(container)) {
    if (options.replace === false) throw new SandboxError(`a sandbox called ${slug} already exists`);
    log(`Replacing the existing ${slug} sandbox`);
    await docker.rm(container, { force: true });
  }

  // The machine's own settings, read once: they decide both the idle limit and
  // whether this project's sandboxes may carry this machine's GitHub token. A
  // malformed config file throws from here rather than being papered over — see
  // the note at the top of ../config/machine.ts.
  const machine = await loadMachineConfig(env);

  // **Both of this project's names, because `config.yaml` may be keyed on
  // either** (§4.3). The declared `project:` used to be the only key tried, and
  // an operator whose workspace directory is `acme-monorepo` — the name the
  // dashboard shows and every URL carries — had no way to learn that the entry
  // they had written matched nothing. It did not fail; it silently resolved
  // every project to the machine-wide default, and the first symptom was an
  // agent unable to push, hours later.
  //
  // `directories` settles the one collision this opens up: a key that is some
  // other project's directory name. See `projectEntry`.
  const workspaceHere = workspaceWorktree(projectRoot, env);
  const projectKey = {
    project: config.project,
    directory: workspaceHere?.project,
    directories: await projectDirectories({ env }),
  };

  // The idle limit, resolved once here so the CLI and the dashboard cannot
  // disagree about it: `--ttl` beats the project's entry in
  // `~/.sandboxr/config.yaml`, which beats that file's top-level `ttl`, which
  // beats `SANDBOXR_TTL_HOURS`, which beats the built-in twelve hours.
  const wanted = resolveTtl({
    explicit: options.ttl,
    ...projectKey,
    config: machine,
    env,
  });
  // An unreadable ttl is refused by name rather than silently becoming a
  // default span. `parseTtl` returns undefined for anything it cannot read, and
  // quietly substituting a lifetime nobody asked for is the one mistake here
  // that destroys work.
  const ttl = parseTtl(wanted);
  if (ttl === undefined) {
    throw new SandboxError(`Cannot read "${wanted}" as a lifetime. Try 12h, 30m, 7d, a number of seconds, or never.`);
  }

  const labels = {
    ...labelsFromConfig(config, {
      slug,
      branch: facts.branch,
      commit: facts.commit,
      dirty: facts.dirty,
      worktree: workspace,
      ttl: ttl === "never" ? "never" : String(ttl),
      // Both halves of the environment, so that either one changing marks this
      // sandbox as started before it: the credentials it carries, and the project's
      // own names for what the sandbox computes. A rotated key and a renamed
      // `VITE_*` are the same problem to whoever has to press the button.
      env: envDigest(secrets, config.env),
    }),
    // Over the engine's rather than under, so an embedder correcting one of them
    // is doing so visibly. `sandboxr.session` arrives this way (§3.4) — it is an
    // opaque group id, and the engine has nothing to compute it from.
    ...(provided?.labels ?? {}),
  };

  // The project's own image layer: the base image carries no toolchain and no
  // database engine, so a project whose plan names `npx` needs this before its
  // first service can start.
  const image =
    env.SANDBOXR_IMAGE ??
    (
      await ensureProjectImage({
        config,
        worktree: projectRoot,
        docker,
        env,
        log,
        // The layer this project's image is built on. An embedder that ships a
        // base of its own — one with its agent's toolchain in it, say — names it
        // here; the engine's own base is the default and is what every sandbox
        // started from the CLI gets.
        baseImage: options.baseImage ?? (await ensureBaseImage({ docker, env, log })),
      })
    ).tag;

  // What git inside the container needs from the host, and who it commits as.
  // Both are read here rather than in runArgs, which is a pure function over an
  // input record precisely so every mount can be asserted without a daemon.
  //
  // **A provided workspace gets neither of the two mounts and asks for none.**
  // They exist because a linked worktree's `.git` is a file naming an absolute
  // host path; a workspace somebody else resolved is its own business, and the
  // engine has no checkout to read to find out what is in it. Jef's clone on a
  // work volume is self-contained — its `.git` is a real directory inside
  // `/workspace` and git works with no help at all — and the whole argument is
  // at the top of the sessions package's `session/runtime.ts`.
  const gitPaths = provided ? [] : await gitMounts(projectRoot);
  const gitIdentity = await hostGitIdentity(env);
  // The machine's shared files (contracts §4.3), already filtered: a row whose
  // source is missing or zero-byte is dropped, because Docker answers a missing
  // bind source by creating a directory at that path on the host. The whole
  // argument is on `sharedFiles` in ../config/machine.ts.
  //
  // Empty on a machine whose `config.yaml` has no `share:` row, which is every
  // machine that has not been through an `init` since this key existed.
  const shared = sharedFiles(machine, env);
  if (gitPaths.length === 0 && !provided) {
    // Said once, at the only moment somebody can act on it. A sandbox on a
    // directory that is not the top of a checkout is perfectly runnable — it
    // just has no working git, and discovering that from `fatal: not a git
    // repository` three commands into an agent session is the failure this
    // whole mechanism exists to remove.
    log("This tree is not the top of a git checkout, so git will not work inside the sandbox.");
  }

  // The GitHub token, only if this machine opted this project in (§4.3). Not
  // resolved at all otherwise: `hostGhToken` shells out to `gh` on a machine
  // that may not have it, and a credential nobody asked for should not even be
  // read into this process.
  const github = decideGithub({ ...projectKey, config: machine });
  const ghToken = github.mode === "token" ? await hostGhToken(env) : undefined;
  if (github.mode === "none") {
    // **Said here because here is the last moment it is cheap to act on.** The
    // token being off has no symptom until `git push`, which is hours later and
    // inside an agent session: the repository is bind-mounted read-write and the
    // identity crosses as `GIT_AUTHOR_*`/`GIT_COMMITTER_*` (§7.1), so `git
    // commit` works perfectly and nothing suggests anything is missing.
    //
    // Both causes, because there are two and a message naming one misleads. A
    // session that has the token still cannot push until it is allowed to: `git
    // push` and `gh` are deliberately absent from `DEFAULT_ALLOWED_TOOLS` in
    // the sessions package's `agent/launch.ts`, which allows `git add` and
    // `git commit` and stops there.
    //
    // The key is quoted with the *directory* name where there is one, because
    // that is the name the operator can see without opening a file — and writing
    // the other one is the mistake this whole message exists to pre-empt.
    const key = projectKey.directory ?? config.project;
    log(`${config.project} has no GitHub token: git commit works in this sandbox, gh and git push do not.`);
    log(
      `  Set projects.${key}.github: token in ${p.configFile}` +
        ", and allow the session git push and gh — neither is in its default allowlist.",
    );
  }
  // Not a refusal, unlike the seed and secret rules in ../config/access.ts, and
  // the difference is worth being clear about. Those exist because *anyone who
  // can reach a public app* can make it spend the credential; nothing serves
  // GH_TOKEN over http, so reading it needs code execution in the container.
  // But a public sandbox is a dev build of an unfinished branch on an open
  // hostname, and code execution is not a far-fetched thing to find in one — so
  // an operator who opted this project in is told, on the run where it applies,
  // that those two decisions have met.
  if (ghToken && config.access.apps === "public") {
    log(`${config.project}'s apps are public and it carries this machine's GitHub token.`);
  }

  const from = provided?.from ?? `${facts.branch}@${facts.commit}`;
  log(`Starting ${slug} from ${from}${facts.dirty ? " (dirty)" : ""}`);
  await docker.ok(
    runArgs({
      config,
      slug,
      worktree: workspace,
      labels,
      envFile,
      // `fileExists`, not `hasSecrets`: an empty file is harmless to mount, and
      // mounting whatever is there is what lets a later edit reach the sandbox
      // on a restart. A file that does not exist at `up` cannot be mounted at
      // all — Docker answers a missing bind source by creating a directory.
      secretsFile: fileExists ? secretsFile : undefined,
      planFile,
      cacheDir: p.cache,
      seedFile: mount?.bind ? { host: mount.bind, inside: mount.inside } : undefined,
      logDir,
      depsHash: deps ? await depsHashFor(projectRoot, deps) : undefined,
      image,
      with: options.with,
      gitMounts: gitPaths,
      // Present only for a provided workspace, and when it is present it
      // replaces the worktree bind and `gitMounts` outright.
      workspaceMounts: provided?.mounts,
      gitIdentity,
      ghToken,
      shared,
      volumes: options.volumes,
      containerEnv: options.containerEnv,
      routerLabels: sandboxRouteLabels({
        container,
        slug,
        project: config.project,
        domain,
        tls: scheme === "https",
        access: config.access.apps,
      }),
    }),
  );

  let migrationFailure: string | undefined;
  if (!options.detach) {
    await waitForContainer(docker, container, options.timeoutSeconds ?? 180);
    try {
      // A failed migration does not stop the sandbox: the failure is recorded,
      // the state becomes degraded, and the services boot anyway — inspecting a
      // failed migration is one of the reasons the sandbox exists.
      await driver.provision(ctx, seed);
    } catch (error) {
      migrationFailure = (error as Error).message;
      log(`Provisioning did not complete: ${migrationFailure}`);
      log("  The sandbox is up so you can look at it.");
    }
  }

  const sandbox = await read(docker, container);
  // The driver records a failed migration as a marker inside the container, so
  // the state read back here is the same one `list` and the dashboard see.
  if (sandbox?.state === "degraded") {
    migrationFailure ??= "migrations failed — the sandbox is up so you can inspect it";
    log("Sandbox is up, but its migrations FAILED.");
  }
  return {
    sandbox:
      sandbox ??
      ({
        ...sandboxFromLabels(labels, container, "starting"),
        state: "starting",
      } as Sandbox),
    urls: urlsFor(config, slug, domain, scheme, suffix),
    migrationFailure,
    seed: { source: seed.source, description: describeSeedChoice(choice) },
  };
}

/** Removes a sandbox, and by default everything it owned. */
export async function down(project: string, slug: string, options: DownOptions = {}): Promise<DownReport> {
  const docker = options.docker ?? defaultDocker;
  const log = options.log ?? noop;
  const env = options.env ?? process.env;
  const container = containerName(project, slug);
  const removed: string[] = [];

  if (!(await docker.containerExists(container))) {
    log(`No sandbox called ${slug}`);
    return { removed };
  }
  await docker.rm(container, { force: true });
  removed.push(container);
  // No certificate to discard: since hostnames were flattened to one DNS label
  // the machine's `*.<domain>` covers every sandbox, so `up` issues nothing per
  // sandbox and `down` has nothing per sandbox to take away.
  // Above the `keep` early return on purpose: `--keep` preserves a sandbox's
  // data, but the container is gone either way and a keep-alive marker for a
  // container that no longer exists means nothing. It is tidiness rather than
  // correctness — the marker records which instance it was written for, so a
  // leftover one fails closed — but leaving it would make `docker rm` and
  // `sandboxr down` differ for no reason.
  await removeKeep(project, slug, env);

  if (options.keep) {
    log(`Removed ${slug}, kept its volumes`);
    return { removed };
  }
  // Everything the sandbox owned goes with it. This is the payoff for keeping
  // the database inside the container rather than in a shared server: there is
  // no schema left behind to find later.
  for (const purpose of ["data", "blob", "bin", "www"] as const) {
    const volume = volumeName(purpose, project, slug);
    if (await docker.volumeRm(volume)) removed.push(volume);
  }

  // …and the files on the host that are named after it (contracts §4). They are
  // *generated*, every one of them: the plan and the environment are rewritten
  // by the next `up`, and the log directory is a bind mount the container fills.
  // Left behind they are a leak with no route back — nothing but this call knows
  // the slug, and once the worktree is gone nothing can derive it again — which
  // is how `~/.sandboxr/build` and `~/.sandboxr/logs` fill up with the names of
  // sandboxes that stopped existing months ago.
  //
  // Under `--keep` none of it goes, and that is the same line the volumes are on:
  // `--keep` means the container went and its data stayed.
  const p = paths(env);
  for (const file of [
    join(p.build, project, `${slug}.plan.json`),
    p.envFile(project, slug),
    // The attach heartbeat, whose absence is what "nobody is holding a socket on
    // this" means. Removing it is tidiness rather than correctness — a stale one
    // only ever contributes an old timestamp to `max(startedAt, lastActive)`
    // (§4.2.2) — but a file naming a container that no longer exists is exactly
    // what the next reader takes for a mechanism.
    p.attachFile(project, slug),
    p.logsFor(project, slug),
  ]) {
    try {
      // Asked before the removal so the report names what really went. `rm
      // --force` cannot tell us: it succeeds on a path that was never there,
      // and a teardown claiming to have removed four files that did not exist
      // is a report nobody can check anything against.
      const there = existsSync(file);
      await rm(file, { recursive: true, force: true });
      if (there) removed.push(file);
    } catch (error) {
      // Reported and not thrown. A log directory the host will not let us remove
      // — root-owned by something inside the container, a full disk — must not
      // turn a sandbox that is genuinely gone into a failed teardown.
      log(`Could not remove ${file}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  // Two files are deliberately not in that list, and both for one reason: they
  // are keyed on the *worktree*, which outlives every sandbox cut from it. The
  // display name (§4.2.1) would undo a rename the next time somebody deleted
  // and restarted a sandbox; the recorded slug (§4.2.3) is worse — it is what
  // this very slug was read from, so taking it here would hand the next `up` a
  // freshly derived name and leave everything above under the old one.
  // `deleteWorktree` removes both, because that is the operation the worktree
  // does not survive.
  log(`Removed ${slug} and its data`);
  return { removed };
}

/** Every sandbox on this machine, read from container labels. */
export async function list(options: ListOptions = {}): Promise<Sandbox[]> {
  const docker = options.docker ?? defaultDocker;
  const filters = [SANDBOX_FILTER];
  if (options.project) filters.push(`label=${LABELS.project}=${options.project}`);
  // A group of sandboxes, joined on the opaque `sandboxr.session` label the
  // caller stamped (contracts §3.4). `SANDBOX_FILTER` stays in front of it, so a
  // container carrying the group label and no `sandboxr.slug` — a workstation,
  // say — cannot arrive here and be read as a sandbox of the project it has
  // none of. The engine never looks inside the value.
  if (options.session) filters.push(`label=${LABELS.session}=${options.session}`);

  const rows = await docker.ps(filters, { all: true });
  const sandboxes: Sandbox[] = [];
  for (const row of rows) {
    const running = row.state === "running";
    // The markers only exist inside a running container, and asking a stopped
    // one costs an exec that always fails.
    const markers = running ? await readMarkers(docker, row.name) : {};
    const sandbox = sandboxFromLabels(row.labels, row.name, deriveState({ containerState: row.state, ...markers }));
    if (sandbox) sandboxes.push(sandbox);
  }
  return sandboxes.sort((a, b) => (a.project + a.slug).localeCompare(b.project + b.slug));
}

/** One sandbox in detail, including which of its services answer. */
export async function status(project: string, slug: string, options: StatusOptions = {}): Promise<SandboxStatus> {
  const docker = options.docker ?? defaultDocker;
  const env = options.env ?? process.env;
  const container = containerName(project, slug);

  const sandbox = await read(docker, container);
  if (!sandbox) throw new SandboxError(`no sandbox called ${slug} in project ${project}`);

  const config = options.config ?? (sandbox.worktree ? await tryLoad(sandbox.worktree, options.env) : undefined);
  const domain = domainOf(env);
  const markers = sandbox.state === "stopped" ? {} : await readMarkers(docker, container);

  const services: ServiceHealth[] = [];
  for (const backend of config?.backends ?? []) {
    services.push({
      name: backend.name,
      label: backend.label,
      port: backend.port,
      up: sandbox.state === "stopped" ? false : await probe(docker, container, backend.port, backend.health),
      // `urlFor` rather than a template, because this had spelled the hostname
      // by hand and so had a second opinion about its shape — which is exactly
      // what flattening it to one label broke.
      url:
        urlFor({ slug, label: backend.label, project, domain, scheme: routerScheme(env) }) +
        portSuffix(routerScheme(env), routerPorts(env)),
    });
  }

  return {
    ...sandbox,
    urls: config ? urlsFor(config, slug, domain, routerScheme(env), portSuffix(routerScheme(env), routerPorts(env))) : {},
    services,
    migrations: markers.migrateFailed ? "failed" : markers.migrateOk ? "ok" : "pending",
    built: sandbox.state === "stopped" ? [] : await builtApps(docker, container),
    // Only ever asked of a worktree sandbox. A runtime's workspace is a path
    // inside a work volume, and Jef's §9.5 rules that nothing on the host may
    // answer what is in one: `existsSync` of `/work/<repo>/<branch>` is false on
    // every machine, and reporting that as GONE would tell somebody their code
    // had disappeared when it is exactly where they left it.
    worktreeMissing: sandbox.session === "" && sandbox.worktree !== "" && !existsSync(sandbox.worktree),
  };
}

/**
 * Rebuilds something inside a running sandbox and restarts it.
 *
 * The build cache is a volume, so this is incremental and quick — the loop is
 * edit, reload, refresh. Nothing is rebuilt at start-up: a sandbox must come up
 * in seconds, and an app that has not been built yet answers with a page saying
 * which command to run.
 */
export async function reload(project: string, slug: string, options: ReloadOptions): Promise<ReloadResult> {
  const docker = options.docker ?? defaultDocker;
  const log = options.log ?? noop;
  const container = containerName(project, slug);

  const sandbox = await read(docker, container);
  if (!sandbox || sandbox.state === "stopped") throw new SandboxError(`sandbox ${slug} is not running`);

  const config = options.config ?? (await loadConfig(sandbox.worktree || process.cwd(), { env: options.env }));
  const built: string[] = [];
  const failed: string[] = [];
  let output = "";

  if (options.kind === "migrate") {
    const driver = getDriver(config.database.driver);
    const ctx = driverContext(config, { slug, worktree: sandbox.worktree, docker, log, env: options.env });
    const result = await driver.migrate(ctx);
    return { kind: "migrate", built: result.ok ? result.applied : [], failed: result.ok ? [] : [result.failed ?? "?"], output: result.output };
  }

  if (options.kind === "backend") {
    const targets = config.backends.filter(
      (backend) => !options.target || options.target === "all" || options.target === backend.name,
    );
    if (targets.length === 0) throw new SandboxError(`no backend called ${options.target}`);
    for (const backend of targets) {
      const build = backendBuild(backend);
      log(`Rebuilding ${backend.name}`);
      // `WITH_ENV` because this is the project's own build command: it reads the
      // project's variable names, which the plan's `env:` map only creates when
      // the container's shell library has been sourced. A `docker exec` sees
      // none of that on its own — see the constant. It mattered less while the
      // secrets file was a `--env-file`, which at least reached a bare exec;
      // now nothing does.
      const result = await docker.exec(container, [WITH_ENV, "sh", "-lc", build.command], { workdir: build.workdir });
      output += result.stdout + result.stderr;
      if (result.code === 0) {
        built.push(backend.name);
        // The running process is left alone when a build fails, so a broken
        // branch does not also take the sandbox's services down.
        await docker.exec(container, ["sh", "-lc", `sandboxr-restart ${backend.name} || true`]);
      } else {
        failed.push(backend.name);
        log(`${backend.name} failed to build — the running process was left alone`);
      }
    }
    return { kind: "backend", built, failed, output };
  }

  const apps = await frontendTargets(docker, container, config, options.target);
  if (apps.length === 0) throw new SandboxError(`nothing to build for "${options.target ?? "all"}"`);
  for (const app of apps) {
    if (app.kind === "server") {
      log(`${app.label} is a long-running server, so it is restarted rather than built`);
      const result = await docker.exec(container, ["sh", "-lc", `sandboxr-restart ${app.label} || true`]);
      output += result.stdout + result.stderr;
      built.push(app.label);
      continue;
    }
    const build = frontendBuild(config, app);
    log(`Building ${app.label} (types are not checked here; CI does that)`);
    // `WITH_ENV` for the same reason as the backend build above, and it bites
    // harder here: a front-end bakes its configuration into the bundle, so a
    // build without the project's environment produces an app that loads and
    // then talks to nothing.
    const result = await docker.exec(
      container,
      [WITH_ENV, "sh", "-lc", `${build.command} && mkdir -p ${build.served} && cp -a ${build.output}/. ${build.served}/`],
      { workdir: build.workdir },
    );
    output += result.stdout + result.stderr;
    if (result.code === 0) {
      built.push(app.label);
    } else {
      failed.push(app.label);
      // A build killed for memory reports nothing but an exit code, which reads
      // as a broken build rather than a full one. Naming the cause saves the
      // guess.
      if (/137|Killed/.test(output)) {
        log(`${app.label} was killed — that is the kernel taking it for memory, not a code error.`);
        log(`  Give the sandbox more: set \`memory\` on that app in sandboxr.yaml and start it again.`);
      }
    }
  }
  return { kind: "frontend", built, failed, output };
}


/**
 * Turns a project and a branch into a worktree on disk, creating it if needed.
 *
 * Returns undefined when the caller named neither, so `up` falls back to the
 * current directory exactly as it always has — the CLI's behaviour is untouched
 * by this whole path.
 *
 * Find-or-create rather than create: pressing Start twice for the same branch
 * has to be the same sandbox, not a second one beside it.
 */
async function resolveWorktree(
  options: UpOptions,
  log: (line: string) => void,
): Promise<string | undefined> {
  if (!options.project) return undefined;

  const project = await findProject(options.project, { env: options.env });
  if (!project) {
    throw new SandboxError(
      `No project called ${options.project} in the workspace.\n` +
        "  Clone one first: sandboxr project clone <url>",
    );
  }
  if (!options.branch) {
    throw new SandboxError(`${options.project}: which branch? Pass a branch to start a sandbox for.`);
  }

  log(`Resolving the worktree for ${options.branch}`);
  const worktree = await addWorktree({
    project,
    branch: options.branch,
    ...(options.base === undefined ? {} : { base: options.base }),
    log,
    // The same environment the slug is read back through further down. Without
    // it a collision recorded under `process.env`'s home would be invisible to
    // an `up` pointed at another one, and the two would disagree about the name.
    ...(options.env === undefined ? {} : { env: options.env }),
  });
  log(`Worktree ${worktree.path}`);
  return worktree.path;
}

/**
 * Stops a sandbox, leaving everything else alone.
 *
 * Deliberately not `down`. A stopped container keeps its labels, so the sandbox
 * still appears in `list` and can be started again; and it keeps its volumes, so
 * its database survives and coming back costs a start rather than a re-seed.
 * `down` removes the container, and with it every label — the sandbox would
 * vanish from the dashboard with nothing left to press.
 */
export async function stopSandbox(project: string, slug: string, options: CommonOptions = {}): Promise<boolean> {
  const docker = options.docker ?? defaultDocker;
  const log = options.log ?? noop;
  const container = containerName(project, slug);

  if (!(await docker.containerRunning(container))) {
    log(`${slug} is not running`);
    return false;
  }
  await docker.stop(container);
  log(`Stopped ${slug}`);
  return true;
}

/** Starts a stopped sandbox again. */
export async function startSandbox(project: string, slug: string, options: CommonOptions = {}): Promise<boolean> {
  const docker = options.docker ?? defaultDocker;
  const log = options.log ?? noop;
  const container = containerName(project, slug);

  if (!(await docker.containerExists(container))) {
    log(`No sandbox called ${slug}`);
    return false;
  }
  if (await docker.containerRunning(container)) {
    log(`${slug} is already running`);
    return true;
  }
  await docker.start(container);
  log(`Started ${slug} — its services take a few seconds to answer`);
  return true;
}

/**
 * Stops every sandbox that has sat unused past its limit.
 *
 * The clock runs from the later of the container's current start time and the
 * last time anybody used it — not from `sandboxr.created`, see the note on the
 * ttl label in ./labels.ts. So restarting a sandbox buys it a full lifetime, and
 * so does using it: a request to one of its apps, opening it through a front end
 * on the bare domain, or a terminal or a live agent run held on it.
 * ./activity.ts is where each of those signals is read and why.
 *
 * **It takes no `extra` map, and that is the whole reason the attach marker
 * covers a live run** (contracts §3.4). This is the entry point a cron job
 * calls, and a cron job has nobody to hand it the embedder's half of the
 * evidence. What stops it reaping a sandbox mid-run is the heartbeat, which is
 * the engine's own signal and is read here whoever wrote it.
 */
export async function expire(options: ExpireOptions = {}): Promise<ExpiryPlan> {
  const docker = options.docker ?? defaultDocker;
  const log = options.log ?? noop;
  const env = options.env ?? process.env;

  const sandboxes = await list({
    docker,
    env,
    ...(options.project === undefined ? {} : { project: options.project }),
  });

  const active = await activityFor(sandboxes, {
    docker,
    // The home the attach markers live under, so `sandboxr expire` reads the
    // same held-socket and live-run heartbeats the dashboard's reaper does
    // rather than a subset.
    env,
    // Which containers on the bare domain are front ends (contracts §7.2).
    // Without it their own lines read as traffic to a sandbox of that name, and
    // — worse — their request paths, which are the only record of somebody
    // opening a sandbox in a browser, are not read at all.
    frontends: await listFrontends(docker),
    ...(options.now === undefined ? {} : { now: options.now }),
  });

  const candidates: ExpiryCandidate[] = await Promise.all(
    sandboxes.map(async (sandbox) => ({
      sandbox,
      // Only asked of a running container: a stopped one is never stopped
      // again, and the inspect would be a call that can only fail.
      startedAt: sandbox.state === "stopped" ? undefined : await docker.startedAt(sandbox.container),
      lastActive: active.get(sandbox.container),
      keptAlive: await isKeptAlive(sandbox, env),
    })),
  );

  const plan = planExpiry({ candidates, now: options.now ?? new Date() });
  if (options.dryRun) return plan;

  for (const { sandbox, reason } of plan.stop) {
    log(`Stopping ${sandbox.slug} — ${reason}`);
    await stopSandbox(sandbox.project, sandbox.slug, { docker, env, log: noop });
  }
  if (plan.stop.length === 0) log("Nothing to expire");
  return plan;
}

/**
 * When each of these sandboxes was last used, read once for the whole set.
 *
 * A name kept over a thin call: the work is `sandboxActivity` in ./activity.ts,
 * which is where the argument about *which signals count as use* lives, and
 * this is the name the CLI and the server have both been calling it by.
 */
export async function activityFor(
  sandboxes: Sandbox[],
  options: SandboxActivityOptions = {},
): Promise<Map<string, Date>> {
  return sandboxActivity(sandboxes, options);
}

/**
 * Reaps sandboxes whose work is finished, the volumes nothing owns, and the
 * project images a newer build has replaced.
 *
 * The images are the reason this is not only a container command. A project's
 * image tag is a content hash, so a base rebuild or a tool version bump strands
 * the previous one at roughly six gigabytes — unreachable by any future `up`,
 * and until now reclaimed by nothing that ran routinely. Five of them filled a
 * Docker VM, and what that looked like from inside a sandbox was a database that
 * would not initialise.
 */
export async function gc(options: GcOptions = {}): Promise<GcPlan> {
  const docker = options.docker ?? defaultDocker;
  const log = options.log ?? noop;

  const sandboxes = await list({ docker, env: options.env });
  const plan = planGc({
    sandboxes,
    volumes: await docker.volumes("sandboxr-"),
    worktreeExists: (path) => existsSync(path),
    mergedBranches: options.mergedBranches ? new Set(options.mergedBranches) : undefined,
    mountedVolumes: await mountedVolumes(docker, sandboxes),
    images: await storedImages(docker),
    protectImages: options.protectImages,
    protectVolumes: options.protectVolumes,
  });

  if (options.dryRun) return plan;

  for (const { sandbox, reason } of plan.reap) {
    log(`Reaping ${sandbox.slug} — ${reason}`);
    await down(sandbox.project, sandbox.slug, { docker, log });
  }
  let freed = 0;
  for (const volume of plan.volumes) {
    if (await docker.volumeRm(volume)) freed += 1;
  }
  let images = 0;
  for (const image of plan.images) {
    // `imageRm` answering false is an outcome, not an error: docker refuses an
    // image a container took hold of between the listing and now, and that
    // refusal is the last guard behind the plan's own. Counting only what really
    // went keeps the line printed here true.
    if (await docker.imageRm(image.reference)) images += 1;
  }
  if (freed > 0) log(`Removed ${freed} orphaned volume(s)`);
  if (images > 0) log(`Removed ${images} superseded image(s)`);
  if (plan.reap.length === 0 && freed === 0 && images === 0) log("Nothing to reap");
  return plan;
}

/**
 * What the daemon is storing, or nothing when it would not say.
 *
 * `docker system df` is one walk of the storage driver and can fail on its own —
 * a daemon still starting, a storage driver mid-operation — where `docker ps`
 * succeeds. A throw here would turn "the image report is unavailable" into "gc
 * did not run", losing the container and volume reaping that has nothing to do
 * with images. Undefined instead means `planGc` offers no image at all, which is
 * the same answer it gives for a dependency volume with no mount list.
 */
async function storedImages(docker: Docker): Promise<ImageRow[] | undefined> {
  try {
    return (await docker.diskUsage()).images;
  } catch {
    return undefined;
  }
}

/**
 * Reclaims the disk that building sandboxes left behind, with a number against
 * each item.
 *
 * Reports by default and removes only with `apply`, which is the opposite way
 * round from `gc` and `expire`. The superseded images are no longer what that
 * guards — `gc` takes exactly the same ones, and losing one costs nothing,
 * because its tag names a build that no future `up` can ask for. What is left is
 * Docker's build cache, which sandboxr shares with every other project on the
 * daemon, and the report itself: a whole-machine reclaim is worth reading before
 * it runs.
 */
export async function prune(options: PruneOptions = {}): Promise<PruneResult> {
  const docker = options.docker ?? defaultDocker;
  const log = options.log ?? noop;

  const sandboxes = await list({ docker, env: options.env });
  const usage = await docker.diskUsage();
  const plan = planPrune({
    sandboxes,
    volumes: usage.volumes,
    images: usage.images,
    buildCache: usage.buildCache,
    mountedVolumes: await mountedVolumes(docker, sandboxes),
    includeBuildCache: options.buildCache,
    protectImages: options.protectImages,
    protectVolumes: options.protectVolumes,
  });

  const removed = { volumes: [] as string[], images: [] as string[], buildCacheBytes: 0 };
  if (!options.apply) return { ...plan, applied: false, removed };

  for (const volume of plan.volumes) {
    if (await docker.volumeRm(volume.name)) removed.volumes.push(volume.name);
  }
  for (const image of plan.images) {
    if (await docker.imageRm(image.reference)) removed.images.push(image.reference);
  }
  if (plan.buildCache.inScope) {
    log("Pruning the build cache");
    // `all`, not the default: without it docker keeps every unused-but-not-
    // dangling record, and the plan's figure — which is `docker system df`'s —
    // would name disk this call had no intention of returning.
    removed.buildCacheBytes = await docker.builderPrune({ all: true });
  }

  if (removed.volumes.length > 0) log(`Removed ${removed.volumes.length} orphaned volume(s)`);
  if (removed.images.length > 0) log(`Removed ${removed.images.length} superseded image(s)`);
  if (removed.volumes.length === 0 && removed.images.length === 0 && removed.buildCacheBytes === 0) {
    log("Nothing to reclaim");
  }
  return { ...plan, applied: true, removed };
}

/**
 * Whether the artifact about to be restored is one a public sandbox may use.
 *
 * A fixtures-only start has nothing real in it by construction; a dump is only
 * anonymised if the author said so. The flag reaches the container so it can say
 * what it restored rather than having to work it out.
 */
function seedIsAnonymised(config: ResolvedConfig, seed: SeedArtifact): boolean {
  if (seed.source === "fixtures" || seed.source === "none") return true;
  if (seed.source === "file") return config.database.seedFrom?.anonymised === true;
  return false;
}

async function read(docker: Docker, container: string): Promise<Sandbox | undefined> {
  const labels = await docker.labels(container);
  if (Object.keys(labels).length === 0) return undefined;
  const running = await docker.containerRunning(container);
  const markers = running ? await readMarkers(docker, container) : {};
  return sandboxFromLabels(labels, container, deriveState({ containerState: running ? "running" : "exited", ...markers }));
}

async function readMarkers(
  docker: Docker,
  container: string,
): Promise<{ migrateOk?: boolean; migrateFailed?: boolean }> {
  const result = await docker.exec(container, ["sh", "-lc", `cat ${MIGRATE_STATE} 2>/dev/null || true`]);
  // Absent means the run has not finished, which is `pending` rather than a
  // failure: a sandbox is readable while it is still coming up, and calling that
  // broken would paint every booting sandbox red.
  try {
    const state: unknown = JSON.parse(result.stdout);
    const verdict = (state as { state?: unknown })?.state;
    return { migrateFailed: verdict === "failed", migrateOk: verdict === "ok" };
  } catch {
    return { migrateFailed: false, migrateOk: false };
  }
}

async function probe(docker: Docker, container: string, port: number, health?: string): Promise<boolean> {
  const path = health ?? "/";
  const result = await docker.exec(container, [
    "sh",
    "-lc",
    `curl -fsS -m 3 http://127.0.0.1:${port}${path} >/dev/null`,
  ]);
  return result.code === 0;
}

/** What this sandbox has actually built, from its own record. */
async function builtApps(docker: Docker, container: string): Promise<string[]> {
  const result = await docker.exec(container, ["sh", "-lc", `cat ${BUILT_MANIFEST} 2>/dev/null || true`]);
  try {
    const parsed = JSON.parse(result.stdout) as Record<string, unknown>;
    return Object.keys(parsed).sort();
  } catch {
    // Nothing built yet, or a manifest half-written by a build in progress.
    return [];
  }
}

/**
 * Which front-ends a reload covers.
 *
 * `built` refreshes exactly what this sandbox has already built, which is what
 * "rebuild the front-ends" means once someone has built the expensive ones in
 * it. It never *starts* a first build of anything: that is an explicit act,
 * because the heaviest app in a project can cost minutes and gigabytes. With
 * nothing built yet it falls back to the build-everything set.
 */
async function frontendTargets(
  docker: Docker,
  container: string,
  config: ResolvedConfig,
  target: string | undefined,
) {
  if (target && target !== "all" && target !== "built") {
    return config.frontends.filter((app) => app.label === target || app.package === target);
  }
  if (target === "built") {
    const have = new Set(await builtApps(docker, container));
    const built = config.frontends.filter((app) => have.has(app.label));
    if (built.length > 0) return built;
  }
  return config.frontends.filter((app) => app.inBuildAll);
}

async function waitForContainer(docker: Docker, container: string, seconds: number): Promise<void> {
  for (let waited = 0; waited < seconds; waited += 1) {
    if (await docker.containerRunning(container)) {
      const ready = await docker.exec(container, ["sh", "-lc", "test -d /workspace"]);
      if (ready.code === 0) return;
    } else if (waited > 2) {
      throw new SandboxError(`${container} exited while starting — see: sandboxr logs ${container}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  throw new SandboxError(`${container} did not become ready in ${seconds}s`);
}

/**
 * Hashes the project's lockfile.
 *
 * The volume is named after this, so every sandbox whose lockfile matches shares
 * one install and a branch that changes its dependencies transparently gets its
 * own. Unreadable means no shared volume, which costs an install rather than
 * silently compiling against the wrong tree.
 */
async function depsHashFor(worktree: string, deps: { root: string; lockfile: string }): Promise<string | undefined> {
  const path = deps.root === "." ? join(worktree, deps.lockfile) : join(worktree, deps.root, deps.lockfile);
  try {
    return lockHash(await readFile(path, "utf8"));
  } catch {
    return undefined;
  }
}

async function mountedVolumes(docker: Docker, sandboxes: Sandbox[]): Promise<Set<string>> {
  const mounted = new Set<string>();
  for (const sandbox of sandboxes) {
    const inspected = (await docker.inspect(sandbox.container)) as
      | { Mounts?: Array<{ Name?: string }> }
      | undefined;
    for (const mount of inspected?.Mounts ?? []) if (mount.Name) mounted.add(mount.Name);
  }
  return mounted;
}

async function tryLoad(worktree: string, env?: NodeJS.ProcessEnv | undefined): Promise<ResolvedConfig | undefined> {
  try {
    // Access enforcement is off: this is a read of a config to describe a
    // sandbox that is already running, not a decision to start one.
    return await loadConfig(worktree, { enforceAccess: false, env });
  } catch {
    return undefined;
  }
}

export { WWW_DIR };
export { planGc } from "./gc.js";
export { formatBytes, planPrune } from "./prune.js";
