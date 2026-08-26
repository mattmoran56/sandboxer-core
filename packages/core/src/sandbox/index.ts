/**
 * The sandbox lifecycle: up, down, list, status, reload, gc.
 *
 * Everything here reads and writes only the labels in contracts §3.4, so `list`
 * and `gc` are functions of `docker ps` and there is no state on the host that
 * can disagree with what is running.
 */

import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import {
  ROUTER_CONTAINER,
  discardSandboxCertificate,
  domainOf,
  ensureBaseImage,
  ensureSandboxCertificate,
  portSuffix,
  routerPorts,
  routerScheme,
  sandboxRouteLabels,
} from "../access/index.js";
import { allowsRealCredentials } from "../config/access.js";
import { loadConfig } from "../config/load.js";
import { resolveDeps } from "../config/deps.js";
import { planFor, writePlan } from "../config/plan.js";
import type { ResolvedConfig } from "../config/types.js";
import { docker as defaultDocker, type Docker } from "../docker.js";
import { driverContext, getDriver } from "../drivers/index.js";
import { chooseSeed } from "../drivers/seed.js";
import { describeSeedChoice, mysqlSettings } from "../drivers/mysql.js";
import type { SeedArtifact } from "../drivers/types.js";
import { gitFacts } from "../git.js";
import { ensureProjectImage } from "../image.js";
import { NETWORK, containerName, deriveSlug, volumeName } from "../naming.js";
import { directoriesOf, paths } from "../paths.js";
import { containerEnv, labelsOf, renderEnvFile, urlsFor } from "./env.js";
import { planGc } from "./gc.js";
import { LABELS, SANDBOX_FILTER, deriveState, labelsFromConfig, sandboxFromLabels } from "./labels.js";
import { BUILT_MANIFEST, MIGRATE_STATE, WWW_DIR } from "./layout.js";
import { backendBuild, frontendBuild, lockHash, runArgs } from "./run.js";
import type {
  DownOptions,
  GcOptions,
  GcPlan,
  ListOptions,
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
 * Starts a sandbox for one worktree.
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

  const config = options.config ?? (await loadConfig(options.worktree ?? process.cwd()));
  const facts = await gitFacts(options.worktree ?? config.root);
  // What `/workspace` is: the directory the config sits in, not the top of the
  // git worktree. Usually the same thing — a project describes itself at its own
  // repo root — but a project kept in a subdirectory of a larger repository
  // would otherwise be mounted with every path in its plan resolving one
  // directory too high, and every one of those failures reads as a broken plan.
  const projectRoot = config.root;
  const slug = deriveSlug({
    explicit: options.slug,
    worktreeDir: facts.directory,
    branch: facts.branch === "?" ? undefined : facts.branch,
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
  const hasSecrets = existsSync(secretsFile);
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
  const planFile = join(p.build, config.project, `${slug}.plan.json`);
  await writePlan(
    planFor(config, {
      seed: seed.path ? { path: seed.path, anonymised: seedIsAnonymised(config, seed) } : undefined,
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

  const labels = labelsFromConfig(config, {
    slug,
    branch: facts.branch,
    commit: facts.commit,
    dirty: facts.dirty,
    worktree: projectRoot,
  });

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
        baseImage: await ensureBaseImage({ docker, env, log }),
      })
    ).tag;

  // Issued before the container starts, so the router already holds a
  // certificate for these hostnames by the time anything asks for one. A
  // sandbox is three labels deep and no wildcard reaches it, so this is per
  // sandbox rather than once for the machine.
  await ensureSandboxCertificate({ project: config.project, slug, labels: labelsOf(config), env, log });

  log(`Starting ${slug} from ${facts.branch}@${facts.commit}${facts.dirty ? " (dirty)" : ""}`);
  await docker.ok(
    runArgs({
      config,
      slug,
      worktree: projectRoot,
      labels,
      envFile,
      secretsFile: hasSecrets ? secretsFile : undefined,
      planFile,
      cacheDir: p.cache,
      logDir,
      depsHash: deps ? await depsHashFor(projectRoot, deps) : undefined,
      image,
      with: options.with,
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
export async function down(project: string, slug: string, options: DownOptions = {}): Promise<void> {
  const docker = options.docker ?? defaultDocker;
  const log = options.log ?? noop;
  const container = containerName(project, slug);

  if (!(await docker.containerExists(container))) {
    log(`No sandbox called ${slug}`);
    return;
  }
  await docker.rm(container, { force: true });
  // The certificate names this sandbox's hostnames and nothing else's, so it
  // goes with it. Left behind, the router would keep offering a certificate for
  // a host that no longer answers.
  await discardSandboxCertificate(project, slug, options.env ?? process.env);

  if (options.keep) {
    log(`Removed ${slug}, kept its volumes`);
    return;
  }
  // Everything the sandbox owned goes with it. This is the payoff for keeping
  // the database inside the container rather than in a shared server: there is
  // no schema left behind to find later.
  for (const purpose of ["data", "blob", "bin", "www"] as const) {
    await docker.volumeRm(volumeName(purpose, project, slug));
  }
  log(`Removed ${slug} and its data`);
}

/** Every sandbox on this machine, read from container labels. */
export async function list(options: ListOptions = {}): Promise<Sandbox[]> {
  const docker = options.docker ?? defaultDocker;
  const filters = [SANDBOX_FILTER];
  if (options.project) filters.push(`label=${LABELS.project}=${options.project}`);

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

  const config = options.config ?? (sandbox.worktree ? await tryLoad(sandbox.worktree) : undefined);
  const domain = domainOf(env);
  const markers = sandbox.state === "stopped" ? {} : await readMarkers(docker, container);

  const services: ServiceHealth[] = [];
  for (const backend of config?.backends ?? []) {
    services.push({
      name: backend.name,
      label: backend.label,
      port: backend.port,
      up: sandbox.state === "stopped" ? false : await probe(docker, container, backend.port, backend.health),
      url:
        `${routerScheme(env)}://${slug}.${backend.label}.${project}.${domain}` +
        portSuffix(routerScheme(env), routerPorts(env)),
    });
  }

  return {
    ...sandbox,
    urls: config ? urlsFor(config, slug, domain, routerScheme(env), portSuffix(routerScheme(env), routerPorts(env))) : {},
    services,
    migrations: markers.migrateFailed ? "failed" : markers.migrateOk ? "ok" : "pending",
    built: sandbox.state === "stopped" ? [] : await builtApps(docker, container),
    worktreeMissing: sandbox.worktree !== "" && !existsSync(sandbox.worktree),
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

  const config = options.config ?? (await loadConfig(sandbox.worktree || process.cwd()));
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
      const result = await docker.exec(container, ["sh", "-lc", build.command], { workdir: build.workdir });
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
    const result = await docker.exec(
      container,
      ["sh", "-lc", `${build.command} && mkdir -p ${build.served} && cp -a ${build.output}/. ${build.served}/`],
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

/** Reaps sandboxes whose work is finished, and the volumes nothing owns. */
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
  if (freed > 0) log(`Removed ${freed} orphaned volume(s)`);
  if (plan.reap.length === 0 && freed === 0) log("Nothing to reap");
  return plan;
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

async function tryLoad(worktree: string): Promise<ResolvedConfig | undefined> {
  try {
    // Access enforcement is off: this is a read of a config to describe a
    // sandbox that is already running, not a decision to start one.
    return await loadConfig(worktree, { enforceAccess: false });
  } catch {
    return undefined;
  }
}

export { WWW_DIR };
export { planGc } from "./gc.js";
