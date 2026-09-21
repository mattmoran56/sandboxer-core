/**
 * The access layer: the shared router, its certificates, and the dashboard.
 *
 * This is what makes a sandbox reachable at all. Everything else in this package
 * produces a container; without the pieces here, that container has an internal
 * router listening on port 80 that nothing on the machine can address.
 *
 * Three decisions are worth stating here, because they are what keeps the setup
 * to one command:
 *
 * 1. **The domain ends in `.localhost`.** Every current browser and macOS's own
 *    resolver answer any name under it with the loopback address, per RFC 6761,
 *    so there is no resolver file to install, no `/etc/hosts` line, no DNS
 *    container, and nothing that needs an administrator password. The
 *    alternatives all cost something: a made-up TLD needs `/etc/resolver` and
 *    therefore `sudo`, and a wildcard resolver such as sslip.io needs the
 *    internet to be up to reach a sandbox on your own machine.
 * 2. **TLS is used when it is already trusted, and skipped when it is not.**
 *    Installing mkcert's root is the one step that needs an administrator
 *    password, so it is never done implicitly: `init` checks, and either serves
 *    https or serves http and prints the single command that upgrades it.
 * 3. **Nothing is published beyond loopback.** The router binds 127.0.0.1, so a
 *    "public" sandbox is public to this machine's browsers, not to the network.
 */

import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, readdir, rm } from "node:fs/promises";
import { join, relative } from "node:path";

import { writeMachineConfigExample } from "../config/machine.js";
import { archBuildArgs, docker as defaultDocker, type Docker } from "../docker.js";
import { containerDir } from "../install.js";
import { DEFAULT_DOMAIN, NETWORK } from "../naming.js";
import { directoriesOf, paths } from "../paths.js";
import { TOOL_VERSION } from "../tool-version.js";
import { hostClaudeCredentials } from "../agent/credentials.js";
import { hostGitIdentity } from "../git.js";
import { DASHBOARD_CONTAINER, DASHBOARD_PORT, hostGhToken, startDashboard, stopDashboard } from "./dashboard.js";
import { writeHostEnv } from "./host-env.js";
import { ORCHESTRATOR_CONTAINER, ORCHESTRATOR_IMAGE_NAME, startOrchestrator, stopOrchestrator } from "./orchestrator.js";
import {
  ROUTER_CONTAINER,
  TLS_DIR,
  portSuffix,
  routerPorts,
  startRouter,
  stopRouter,
  writeRouterConfig,
  type RouterPorts,
} from "./router.js";
import {
  baseCertificateNames,
  caTrusted,
  discardCertificate,
  discardCertificateEntry,
  issueCertificate,
  mkcertAvailable,
  writeCertificateEntry,
  type Certificate,
} from "./tls.js";

export * from "./router.js";
export * from "./dashboard.js";
export * from "./host-env.js";
export * from "./tls.js";

/** The generic base image every sandbox runs from. */
export const BASE_IMAGE = "sandboxr/base";

/** The dashboard image: Node plus a Docker client. Built by `init`, like the base. */
export const DASHBOARD_IMAGE_NAME = "sandboxr/dashboard";

/**
 * The workstation image: a session's agent and the tools it works with
 * (contracts §12.3).
 *
 * The exact complement of the base image, which is why it is a third image
 * rather than a variant of either of the other two. Base exists to *run a
 * project* — Caddy, MinIO, s6, and a deliberate absence of any Node runtime; a
 * workstation is a Node runtime and no services whatsoever, so the two share no
 * layer worth sharing. And the dashboard's image ships a Docker client on
 * purpose, which is precisely the image this one must never come to resemble.
 */
export const WORKSTATION_IMAGE_NAME = "sandboxr/workstation";

export interface InitOptions {
  env?: NodeJS.ProcessEnv | undefined;
  docker?: Docker | undefined;
  log?: ((line: string) => void) | undefined;
  /** Force TLS on or off. Absent means "on if it is already trusted". */
  tls?: boolean | undefined;
  /** Rebuild the base image even when one is already there. */
  rebuild?: boolean | undefined;
  /** Bind address for the router's published ports. */
  bind?: string | undefined;
  ports?: Partial<RouterPorts> | undefined;
  /**
   * Whether to start the router, the dashboard and the orchestrator. Default on.
   *
   * Off is "prepare this machine but run nothing", which is what the compose
   * deployment wants: everything here except those three — the directories, the
   * images, the certificate, the router's own configuration files and
   * `host.env` — is a *prerequisite* of `docker compose up`, and no compose file
   * can build an image or ask mkcert for a certificate. Left on, `init` would
   * start containers under the names compose then wants, and the up fails with
   * "container name is already in use" rather than with anything that names the
   * cause.
   */
  start?: boolean | undefined;
}

export interface AccessReport {
  domain: string;
  scheme: "http" | "https";
  ports: RouterPorts;
  dashboardUrl: string;
  certificate?: Certificate | undefined;
  baseImage: string;
  /** Things that work now but would work better after one more command. */
  notes: string[];
}

export function domainOf(env: NodeJS.ProcessEnv = process.env): string {
  return env.SANDBOXR_DOMAIN && env.SANDBOXR_DOMAIN !== "" ? env.SANDBOXR_DOMAIN : DEFAULT_DOMAIN;
}

/**
 * The scheme the router is actually serving, read from what `init` wrote.
 *
 * Read from the router's own state rather than from whether mkcert is installed:
 * the two can disagree — mkcert installed *after* the last `init` is the common
 * case — and a URL printed for a scheme nothing is listening on sends the reader
 * to a connection refused.
 */
export function routerScheme(env: NodeJS.ProcessEnv = process.env): "http" | "https" {
  return existsSync(join(paths(env).state, "dynamic", `cert-${domainOf(env)}.yml`)) ? "https" : "http";
}

/** The origin a sandbox hostname is reached on, port included when it is not the default. */
export function originFor(host: string, env: NodeJS.ProcessEnv = process.env): string {
  const scheme = routerScheme(env);
  return `${scheme}://${host}${portSuffix(scheme, routerPorts(env))}`;
}

/**
 * A digest of everything that goes *into* the base image.
 *
 * The tag used to be `sandboxr/base:<TOOL_VERSION>` alone, which meant an image
 * was reused until the version number moved — so editing anything under
 * `container/` left every machine running the image built before the edit, and
 * `--rebuild` was the only way to find out.
 *
 * That was survivable while the scripts only ever *added* behaviour. It stopped
 * being survivable when the project's credentials became a mounted file: a host
 * on the new code mounts `/sandboxr/secrets.env`, and an image built before the
 * reader existed simply ignores it. Nothing errors — every credential quietly
 * stops arriving, and an application that falls back to a default when its key
 * is missing carries on talking to whatever that default names.
 *
 * So the base is content-addressed on its inputs, exactly as the project layer
 * is (`imageTag` in ../image.ts): rebuilt when one of them changes and reused
 * otherwise.
 */
export async function baseImageTag(env: NodeJS.ProcessEnv = process.env): Promise<string> {
  const context = containerDir(env);
  const hash = createHash("sha256").update(TOOL_VERSION);

  // Sorted, so the digest is a function of the contents and not of the order the
  // filesystem happened to hand them back in.
  for (const file of (await inputsOf(context)).sort()) {
    hash.update("\0").update(relative(context, file)).update("\0");
    hash.update(await readFile(file));
  }
  // The version stays in the tag as well as in the digest, so `docker images`
  // still says which sandboxr an image belongs to at a glance.
  return `${BASE_IMAGE}:${TOOL_VERSION}-${hash.digest("hex").slice(0, 12)}`;
}

/**
 * Every file the base image build reads.
 *
 * The whole of `container/` except the directories that are not inputs to it:
 * `project/` is the per-project layer's template, which has a digest of its own;
 * `examples/` is test fixtures; and `workstation/` builds a separate image
 * (§12.3) that shares not one layer with this one. Including any of them would
 * rebuild the base image for a change that cannot affect it — several minutes
 * and several gigabytes, on the next `init`, for nothing.
 *
 * `workstation/` is the one that had to be noticed rather than decided. It
 * arrived under `container/` after this function was written, so it silently
 * joined the base image's digest and would have forced exactly that rebuild the
 * first time anybody edited the agent's Dockerfile.
 */
async function inputsOf(context: string): Promise<string[]> {
  const skip = new Set(["project", "examples", "workstation"]);
  const found: string[] = [];

  const walk = async (dir: string, top: boolean): Promise<void> => {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      if (top && skip.has(entry.name)) continue;
      const path = join(dir, entry.name);
      if (entry.isDirectory()) await walk(path, false);
      else if (entry.isFile()) found.push(path);
    }
  };

  await walk(context, true);
  return found;
}

/**
 * Builds the generic base image if it is not already here.
 *
 * Part of `init` rather than a separate command because the first `up` on a new
 * machine would otherwise fail on a missing image, and "build this yourself" is
 * not an answer a setup step should give.
 */
export async function ensureBaseImage(options: {
  docker: Docker;
  env?: NodeJS.ProcessEnv | undefined;
  rebuild?: boolean | undefined;
  log?: ((line: string) => void) | undefined;
}): Promise<string> {
  const env = options.env ?? process.env;
  const log = options.log ?? (() => undefined);
  const tag = await baseImageTag(env);

  if (!options.rebuild && (await options.docker.imageExists(tag))) return tag;

  const context = containerDir(env);
  log(`Building ${tag} (a few minutes the first time)`);
  await options.docker.ok(
    // ...archBuildArgs() for the same reason as the project layer: TARGETARCH is
    // a BuildKit built-in, and nothing guarantees the builder here is BuildKit.
    [
      "build",
      "-f",
      `${context}/base/Dockerfile`,
      "-t",
      tag,
      "-t",
      `${BASE_IMAGE}:latest`,
      ...archBuildArgs(),
      context,
    ],
    { timeoutMs: 30 * 60_000 },
  );
  log(`Built ${tag}`);
  return tag;
}

/**
 * Builds the dashboard image if it is not already here.
 *
 * Separate from the base image because the two have opposite needs: a sandbox
 * runs a project and must never be able to reach the daemon, while the
 * dashboard does nothing else. Keeping the Docker client out of the base is
 * what stops a sandboxed project — or an agent inside one — driving Docker.
 */
/**
 * Whether this machine wants the orchestrator at all.
 *
 * The same variable the dashboard reads to decide whether to run the engine, so
 * there is one switch rather than two that can disagree — a machine with the
 * panel on and no agent container would offer an instruction box that could
 * never be answered.
 */
export const orchestratorWanted = (env: NodeJS.ProcessEnv = process.env): boolean =>
  (env.SANDBOXR_ORCHESTRATOR ?? "").trim() !== "" && env.SANDBOXR_ORCHESTRATOR !== "0";

/**
 * Builds the orchestrator image, which is the dashboard's with Claude Code on it.
 *
 * `base` is passed as a build argument rather than hard-coded in the Dockerfile
 * so the two images cannot drift: whatever tag the dashboard was just built or
 * found at is the tag this is built from, in the same run.
 */
export async function ensureOrchestratorImage(options: {
  docker: Docker;
  base: string;
  env?: NodeJS.ProcessEnv | undefined;
  rebuild?: boolean | undefined;
  log?: ((line: string) => void) | undefined;
}): Promise<string> {
  const env = options.env ?? process.env;
  const log = options.log ?? (() => undefined);
  const tag = `${ORCHESTRATOR_IMAGE_NAME}:${TOOL_VERSION}`;

  if (!options.rebuild && (await options.docker.imageExists(tag))) return tag;

  const context = containerDir(env);
  log(`Building ${tag}`);
  await options.docker.ok(
    [
      "build",
      "-f",
      `${context}/orchestrator/Dockerfile`,
      "--build-arg",
      `BASE=${options.base}`,
      "-t",
      tag,
      "-t",
      `${ORCHESTRATOR_IMAGE_NAME}:latest`,
      ...archBuildArgs(),
      context,
    ],
    { timeoutMs: 15 * 60_000 },
  );
  log(`Built ${tag}`);
  return tag;
}

/**
 * Builds the workstation image if it is not already here.
 *
 * Tagged by tool version rather than content-addressed like the base, which is
 * the dashboard's arrangement and the right one here for the same reason: the
 * image is one of the machine's own, so `PROTECTED_IMAGES` keeps every tag of it
 * and "an older tag means a newer one replaced it" does not hold.
 *
 * **Not built by `init`.** Every other image on that list is a prerequisite of
 * the next thing somebody does — the first `up` fails without a base — and a
 * workstation is not: a machine that never creates a session never needs one,
 * and this image carries a full `claude` install. So it is built the first time
 * a session is created, which is `ensureProjectImage`'s bargain rather than
 * `ensureBaseImage`'s, and the one line of log below is the whole of the warning
 * a person gets. Revisit when a session is the ordinary way to start work.
 */
export async function ensureWorkstationImage(options: {
  docker: Docker;
  env?: NodeJS.ProcessEnv | undefined;
  rebuild?: boolean | undefined;
  log?: ((line: string) => void) | undefined;
}): Promise<string> {
  const env = options.env ?? process.env;
  const log = options.log ?? (() => undefined);
  const tag = `${WORKSTATION_IMAGE_NAME}:${TOOL_VERSION}`;

  if (!options.rebuild && (await options.docker.imageExists(tag))) return tag;

  const context = containerDir(env);
  log(`Building ${tag} (a few minutes the first time)`);
  await options.docker.ok(
    [
      "build",
      "-f",
      `${context}/workstation/Dockerfile`,
      "-t",
      tag,
      "-t",
      `${WORKSTATION_IMAGE_NAME}:latest`,
      // Not optional, for the reason every build here passes it: `TARGETARCH` is
      // a BuildKit built-in the legacy builder never sets, and this Dockerfile
      // puts the resolved architecture straight into a download URL — so an
      // unresolved one is a 404 that reads as a broken mirror rather than as
      // anything mentioning architecture.
      ...archBuildArgs(),
      context,
    ],
    { timeoutMs: 20 * 60_000 },
  );
  log(`Built ${tag}`);
  return tag;
}

export async function ensureDashboardImage(options: {
  docker: Docker;
  env?: NodeJS.ProcessEnv | undefined;
  rebuild?: boolean | undefined;
  log?: ((line: string) => void) | undefined;
}): Promise<string> {
  const env = options.env ?? process.env;
  const log = options.log ?? (() => undefined);
  const tag = `${DASHBOARD_IMAGE_NAME}:${TOOL_VERSION}`;

  if (!options.rebuild && (await options.docker.imageExists(tag))) return tag;

  const context = containerDir(env);
  log(`Building ${tag}`);
  await options.docker.ok(
    [
      "build",
      "-f",
      `${context}/dashboard/Dockerfile`,
      "-t",
      tag,
      "-t",
      `${DASHBOARD_IMAGE_NAME}:latest`,
      ...archBuildArgs(),
      context,
    ],
    { timeoutMs: 10 * 60_000 },
  );
  log(`Built ${tag}`);
  return tag;
}

/**
 * Sets the machine up: network, base image, certificate, router, dashboard.
 *
 * Idempotent. Running it again is how you change the domain, rotate the
 * password, or pick TLS up after installing mkcert's root.
 */
export async function initAccess(options: InitOptions = {}): Promise<AccessReport> {
  const env = options.env ?? process.env;
  const docker = options.docker ?? defaultDocker;
  const log = options.log ?? (() => undefined);
  const p = paths(env);
  const domain = domainOf(env);
  const ports = { ...routerPorts(env), ...options.ports };
  const notes: string[] = [];

  if (!(await docker.available())) {
    throw new Error("Docker is not running. Start it and try again.");
  }

  for (const dir of directoriesOf(p)) await mkdir(dir, { recursive: true });
  await docker.ensureNetwork(NETWORK);

  // The machine's own settings file, written commented-out-and-explained the
  // first time and never touched again. It is announced because a config file
  // nobody knows exists is a config file nobody edits — and the setting in it
  // decides when this machine stops containers.
  const configFile = await writeMachineConfigExample(env);
  if (configFile) notes.push(`Wrote ${configFile}. Edit it to change how long a sandbox may sit unused.`);

  const baseImage = await ensureBaseImage({ docker, env, rebuild: options.rebuild, log });
  const dashboardImage = await ensureDashboardImage({ docker, env, rebuild: options.rebuild, log });
  // The workstation's image, and it is built **here** rather than by the first
  // `createSession` (contracts §3.3). It used to be built there, on the argument
  // that a machine which never makes a session never needs several hundred
  // megabytes of `claude` — and that argument carried its own expiry date, which
  // has passed: a session is now the thing the dashboard is organised around, so
  // "the first time a session is created" is "the first time somebody presses
  // New session", and the build landed in a request that answers one JSON body
  // and has nowhere to stream a build log to. Several silent minutes on a click.
  //
  // This does not make the create *correct* — `createSession` still calls
  // `ensureWorkstationImage` and must keep doing so, because the tag carries the
  // tool version, so an upgrade invalidates it and a machine can reach a create
  // without the tag being there. It makes the create *fast*, which is a
  // different property and the one that was missing.
  await ensureWorkstationImage({ docker, env, rebuild: options.rebuild, log });
  // The orchestrator's image is the dashboard's plus Claude Code, so it is built
  // from it and therefore after it. Only when the feature is switched on: it is a
  // few hundred megabytes, and a machine that has not asked for an agent should
  // not be made to download one.
  const orchestratorImage = orchestratorWanted(env)
    ? await ensureOrchestratorImage({ docker, env, rebuild: options.rebuild, base: dashboardImage, log })
    : undefined;

  // --- the certificate ---------------------------------------------------------
  //
  // One certificate for the machine: the domain, for the dashboard, and one
  // wildcard under it, which since contracts §3.2 flattened a sandbox hostname
  // into a single label is every sandbox as well. This used to be "the base one
  // only", with a second certificate issued per sandbox on `up`, because a TLS
  // wildcard covers exactly one label and a sandbox was three deep.
  let cert: Certificate | undefined;
  if (options.tls !== false) {
    if (!(await mkcertAvailable())) {
      notes.push("mkcert is not installed, so the router serves plain http. `brew install mkcert` to change that.");
    } else if (!(await caTrusted({ env })) && options.tls !== true) {
      notes.push(
        "mkcert's root is not in this machine's trust store, so the router serves plain http.\n" +
          "  Run `mkcert -install` (it asks for your password once) and then `sandboxr init` again.",
      );
    } else {
      cert = await issueCertificate(domain, baseCertificateNames(domain), { env });
      if (!cert) notes.push("mkcert could not issue a certificate, so the router serves plain http.");
      else if (!cert.trusted) notes.push("The certificate is issued but its root is not trusted — run `mkcert -install`.");
    }
  }

  // --- the router --------------------------------------------------------------
  const files = await writeRouterConfig({ env, cert, dashboardPort: DASHBOARD_PORT, ports });
  if (cert) await writeCertificateEntry(files.dynamic, cert, TLS_DIR, { isDefault: true });
  // Removed rather than left behind: this file is what `routerScheme` reads, so
  // a stale one from a previous run would have every command print URLs on a
  // scheme nothing is listening on.
  else await rm(join(files.dynamic, `cert-${domain}.yml`), { force: true });
  await sweepSandboxCertificates(files.dynamic, domain, env, log);

  // --- what only the host can look up ------------------------------------------
  //
  // Resolved here rather than inside `startDashboard`, which is where it used to
  // happen alone, because it is now read twice: once by the `docker run` below,
  // and once out of `host.env` by `docker compose up`. This is the last moment
  // anything can reach the login keychain, the host's gitconfig or the host's
  // filesystem — see access/host-env.ts — so a lookup left until the container is
  // up is a lookup that answers nothing.
  const ghToken = await hostGhToken(env);
  const gitIdentity = await hostGitIdentity(env);
  const claudeCredentials = hostClaudeCredentials(env);
  await writeHostEnv({
    env,
    facts: {
      ghToken,
      gitIdentity,
      claudeCredentials,
      claudeToken: env.SANDBOXR_CLAUDE_TOKEN ?? env.CLAUDE_CODE_OAUTH_TOKEN,
    },
  });

  // --- the dashboard -----------------------------------------------------------
  const password = env.SANDBOXR_PASSWORD;
  if (!password) {
    notes.push(
      "No SANDBOXR_PASSWORD is set, so the dashboard will admit nobody.\n" +
        "  Set one and run `sandboxr init` again.",
    );
  }

  if (options.start === false) {
    notes.push(
      `Nothing was started. ${p.hostEnvFile} and the router's configuration are ready for\n` +
        "  `docker compose up -d` — see docs/guides/compose.md.",
    );
  } else {
    await startRouter({ env, docker, cert, files, bind: options.bind, ports, log });
    await startDashboard({
      docker,
      domain,
      tls: cert !== undefined,
      password,
      env,
      log,
      image: dashboardImage,
      ...(ghToken ? { ghToken } : {}),
      gitIdentity,
      ...(claudeCredentials ? { claudeCredentials } : {}),
    });
    // The machine's agent, beside the dashboard rather than inside it — see
    // access/orchestrator.ts for why the credential cannot live in the web server.
    if (orchestratorImage) {
      await startOrchestrator({ docker, env, image: orchestratorImage, log });
    } else {
      await stopOrchestrator(docker).catch(() => undefined);
    }
  }

  const scheme = cert ? "https" : "http";
  return {
    domain,
    scheme,
    ports,
    dashboardUrl: `${scheme}://${domain}${portSuffix(scheme, ports)}`,
    certificate: cert,
    baseImage,
    notes,
  };
}

/**
 * Removes the per-sandbox certificates an installation from before flattening
 * left behind.
 *
 * There is exactly one certificate now — `cert-<domain>.yml` — so every other
 * `cert-*.yml` in the dynamic directory was issued by a version that gave each
 * sandbox its own, and it names hostnames that no longer exist. Left alone they
 * are only untidy rather than harmful: Traefik would keep loading certificates
 * for names nothing resolves to. They are swept anyway, because a directory
 * whose contents nothing in the codebase writes is the sort of thing that gets
 * read as a mechanism by the next person to look.
 *
 * Swept from `init` rather than from an upgrade step because `init` is the one
 * command that owns the router's files, and it is what has to run after an
 * upgrade in any case.
 */
async function sweepSandboxCertificates(
  dynamicDir: string,
  domain: string,
  env: NodeJS.ProcessEnv,
  log: (line: string) => void,
): Promise<void> {
  const entries = await readdir(dynamicDir).catch((): string[] => []);
  for (const entry of entries) {
    if (!entry.startsWith("cert-") || !entry.endsWith(".yml")) continue;
    const name = entry.slice("cert-".length, -".yml".length);
    if (name === domain) continue;
    await discardCertificateEntry(dynamicDir, name);
    await discardCertificate(name, env);
    log(`Removed the per-sandbox certificate ${name}; the wildcard on ${domain} covers it now.`);
  }
}

export interface TeardownOptions {
  env?: NodeJS.ProcessEnv | undefined;
  docker?: Docker | undefined;
  log?: ((line: string) => void) | undefined;
  /** Also remove the shared network. Refused while a sandbox is still on it. */
  network?: boolean | undefined;
}

/**
 * Stops the access layer. Sandboxes are deliberately left alone: `teardown` is
 * for the machine's shared plumbing, and `down` is for a sandbox.
 */
export async function teardownAccess(options: TeardownOptions = {}): Promise<{ removed: string[] }> {
  const docker = options.docker ?? defaultDocker;
  const log = options.log ?? (() => undefined);
  const removed: string[] = [];

  await stopOrchestrator(docker).catch(() => undefined);
  if (await stopDashboard(docker)) {
    removed.push(DASHBOARD_CONTAINER);
    log(`Removed ${DASHBOARD_CONTAINER}`);
  }
  if (await stopRouter(docker)) {
    removed.push(ROUTER_CONTAINER);
    log(`Removed ${ROUTER_CONTAINER}`);
  }
  if (options.network) {
    const result = await docker.raw(["network", "rm", NETWORK]);
    if (result.code === 0) {
      removed.push(NETWORK);
      log(`Removed the ${NETWORK} network`);
    } else {
      log(`The ${NETWORK} network is still in use by a sandbox, so it was kept`);
    }
  }
  return { removed };
}

export interface AccessStatus {
  domain: string;
  routerRunning: boolean;
  dashboardRunning: boolean;
  /** The scheme the router is actually configured for, read from its own state. */
  scheme: "http" | "https";
  ports: RouterPorts;
  dashboardUrl: string;
  certificatePresent: boolean;
  certificateTrusted: boolean;
  baseImagePresent: boolean;
}

/** What `doctor` reports about the access layer. */
export async function accessStatus(options: { env?: NodeJS.ProcessEnv; docker?: Docker } = {}): Promise<AccessStatus> {
  const env = options.env ?? process.env;
  const docker = options.docker ?? defaultDocker;
  const domain = domainOf(env);
  const p = paths(env);
  const scheme = routerScheme(env);
  const ports = routerPorts(env);

  const certificatePresent = existsSync(join(p.tls, `${domain}.pem`));

  return {
    domain,
    routerRunning: await docker.containerRunning(ROUTER_CONTAINER),
    dashboardRunning: await docker.containerRunning(DASHBOARD_CONTAINER),
    scheme,
    ports,
    dashboardUrl: `${scheme}://${domain}${portSuffix(scheme, ports)}`,
    certificatePresent,
    certificateTrusted: certificatePresent ? await caTrusted({ env }) : false,
    baseImagePresent:
      (await docker.imageExists(`${BASE_IMAGE}:${TOOL_VERSION}`)) ||
      (await docker.imageExists(`${BASE_IMAGE}:latest`)),
  };
}
