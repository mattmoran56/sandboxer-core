/**
 * The access layer: the shared router, its certificate, and the dashboard.
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

import { mkdir } from "node:fs/promises";

import { docker as defaultDocker, type Docker } from "../docker.js";
import { containerDir } from "../install.js";
import { DEFAULT_DOMAIN, NETWORK } from "../naming.js";
import { directoriesOf, paths } from "../paths.js";
import { TOOL_VERSION } from "../tool-version.js";
import { DASHBOARD_CONTAINER, DASHBOARD_PORT, startDashboard, stopDashboard } from "./dashboard.js";
import { ROUTER_CONTAINER, startRouter, stopRouter, writeRouterConfig } from "./router.js";
import { caTrusted, ensureCertificate, mkcertAvailable, writeTlsConfig, type Certificate } from "./tls.js";

export * from "./router.js";
export * from "./dashboard.js";
export * from "./tls.js";

/** The generic base image every sandbox runs from. */
export const BASE_IMAGE = "sandboxr/base";

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
}

export interface AccessReport {
  domain: string;
  scheme: "http" | "https";
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
  const tag = `${BASE_IMAGE}:${TOOL_VERSION}`;

  if (!options.rebuild && (await options.docker.imageExists(tag))) {
    log(`Base image ${tag} is current`);
    return tag;
  }

  const context = containerDir(env);
  log(`Building ${tag} (a few minutes the first time)`);
  await options.docker.ok(
    ["build", "-f", `${context}/base/Dockerfile`, "-t", tag, "-t", `${BASE_IMAGE}:latest`, context],
    { timeoutMs: 30 * 60_000 },
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
  const notes: string[] = [];

  if (!(await docker.available())) {
    throw new Error("Docker is not running. Start it and try again.");
  }

  for (const dir of directoriesOf(p)) await mkdir(dir, { recursive: true });
  await docker.ensureNetwork(NETWORK);

  const baseImage = await ensureBaseImage({ docker, env, rebuild: options.rebuild, log });

  // --- the certificate ---------------------------------------------------------
  let cert: Certificate | undefined;
  if (options.tls !== false) {
    if (!(await mkcertAvailable())) {
      notes.push("mkcert is not installed, so the router serves plain http. `brew install mkcert` to change that.");
    } else {
      const trusted = await caTrusted({ env });
      if (!trusted && options.tls !== true) {
        notes.push(
          "mkcert's root is not in this machine's trust store, so the router serves plain http.\n" +
            "  Run `mkcert -install` (it asks for your password once) and then `sandboxr init` again.",
        );
      } else {
        cert = await ensureCertificate(domain, { env });
        if (!cert) notes.push("mkcert could not issue a certificate, so the router serves plain http.");
        else if (!cert.trusted) {
          notes.push("The certificate is issued but its root is not trusted — run `mkcert -install`.");
        }
      }
    }
  }

  // --- the router --------------------------------------------------------------
  const files = await writeRouterConfig({ env, cert, dashboardPort: DASHBOARD_PORT });
  if (cert) await writeTlsConfig(files.dynamic, cert, "/etc/traefik/tls");
  await startRouter({ env, docker, cert, files, bind: options.bind, log });

  // --- the dashboard -----------------------------------------------------------
  const password = env.SANDBOXR_PASSWORD;
  if (!password) {
    notes.push(
      "No SANDBOXR_PASSWORD is set, so the dashboard will admit nobody.\n" +
        "  Set one and run `sandboxr init` again.",
    );
  }
  await startDashboard({ docker, domain, tls: cert !== undefined, password, env, log });

  const scheme = cert ? "https" : "http";
  return {
    domain,
    scheme,
    dashboardUrl: `${scheme}://${domain}`,
    certificate: cert,
    baseImage,
    notes,
  };
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
  const { existsSync } = await import("node:fs");
  const { join } = await import("node:path");

  const certFile = join(p.tls, `${domain}.pem`);
  const certificatePresent = existsSync(certFile);

  return {
    domain,
    routerRunning: await docker.containerRunning(ROUTER_CONTAINER),
    dashboardRunning: await docker.containerRunning(DASHBOARD_CONTAINER),
    scheme: existsSync(join(p.state, "dynamic", "tls.yml")) ? "https" : "http",
    certificatePresent,
    certificateTrusted: certificatePresent ? await caTrusted({ env }) : false,
    baseImagePresent:
      (await docker.imageExists(`${BASE_IMAGE}:${TOOL_VERSION}`)) ||
      (await docker.imageExists(`${BASE_IMAGE}:latest`)),
  };
}
