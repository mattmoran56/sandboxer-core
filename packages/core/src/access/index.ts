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
import { DASHBOARD_CONTAINER, DASHBOARD_PORT, startDashboard, stopDashboard } from "./dashboard.js";
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
  sandboxCertificateNames,
  writeCertificateEntry,
  type Certificate,
} from "./tls.js";

export * from "./router.js";
export * from "./dashboard.js";
export * from "./tls.js";

/** The generic base image every sandbox runs from. */
export const BASE_IMAGE = "sandboxr/base";

/** The dashboard image: Node plus a Docker client. Built by `init`, like the base. */
export const DASHBOARD_IMAGE_NAME = "sandboxr/dashboard";

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
 * The whole of `container/` except the two directories that are not inputs to
 * it: `project/` is the per-project layer's template, which has a digest of its
 * own, and `examples/` is test fixtures. Including either would rebuild the base
 * image for a change that cannot affect it.
 */
async function inputsOf(context: string): Promise<string[]> {
  const skip = new Set(["project", "examples"]);
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

  // --- the certificate ---------------------------------------------------------
  //
  // The base one only: it carries the domain and one wildcard under it, which is
  // the dashboard. A sandbox is three labels deep and no wildcard reaches it, so
  // each one gets its own certificate when it starts.
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
  await startRouter({ env, docker, cert, files, bind: options.bind, ports, log });

  // --- the dashboard -----------------------------------------------------------
  const password = env.SANDBOXR_PASSWORD;
  if (!password) {
    notes.push(
      "No SANDBOXR_PASSWORD is set, so the dashboard will admit nobody.\n" +
        "  Set one and run `sandboxr init` again.",
    );
  }
  await startDashboard({ docker, domain, tls: cert !== undefined, password, env, log, image: dashboardImage });

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
 * Issues the certificate one sandbox needs, and tells the router about it.
 *
 * Called when a sandbox starts, because the hostnames it covers are a fact about
 * that sandbox's plan. Traefik watches the directory, so no reload is needed.
 * A no-op when the router is not serving TLS.
 */
export async function ensureSandboxCertificate(input: {
  project: string;
  slug: string;
  labels: readonly string[];
  env?: NodeJS.ProcessEnv | undefined;
  log?: ((line: string) => void) | undefined;
}): Promise<Certificate | undefined> {
  const env = input.env ?? process.env;
  if (routerScheme(env) !== "https") return undefined;

  const domain = domainOf(env);
  const name = `${input.project}-${input.slug}`;
  const hosts = sandboxCertificateNames({ slug: input.slug, project: input.project, domain, labels: input.labels });
  const cert = await issueCertificate(name, hosts, { env });
  if (!cert) {
    input.log?.(`Could not issue a certificate for ${input.slug} — its hostnames will not validate.`);
    return undefined;
  }
  await writeCertificateEntry(join(paths(env).state, "dynamic"), cert, TLS_DIR);
  return cert;
}

/** Removes a sandbox's certificate and the router's entry for it. */
export async function discardSandboxCertificate(
  project: string,
  slug: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<void> {
  const name = `${project}-${slug}`;
  await discardCertificateEntry(join(paths(env).state, "dynamic"), name);
  await discardCertificate(name, env);
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
