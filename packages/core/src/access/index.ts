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
import { directoriesOf, legacyHomeNotice, paths } from "../paths.js";
import { TOOL_VERSION } from "../tool-version.js";
import { hostGhToken } from "../forge.js";
import { hostGitIdentity } from "../git.js";
import { DEFAULT_FRONTEND_CONTAINER, DEFAULT_FRONTEND_PORT, listFrontends } from "./frontend.js";
import { writeHostEnv } from "./host-env.js";
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
export * from "./frontend.js";
export * from "./host-env.js";
export * from "./tls.js";

/** The generic base image every sandbox runs from. */
export const BASE_IMAGE = "sandboxer/base";

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
   * Whether to start the router. Default on.
   *
   * Off is "prepare this machine but run nothing", which is what a compose
   * deployment wants: everything else here — the directories, the images, the
   * certificate, the router's own configuration files and `host.env` — is a
   * *prerequisite* of bringing that deployment up, and no compose file can build
   * an image or ask mkcert for a certificate. Left on, `init` would start a
   * container under the name compose then wants, and the up fails with
   * "container name is already in use" rather than with anything that names the
   * cause.
   *
   * **Reachable through this option and not through the `sandboxer` command.**
   * The engine ships no compose file, so the only caller is an embedder that
   * does, and a flag on the engine's CLI whose whole justification is a file the
   * engine does not have is a flag that reads as broken.
   */
  start?: boolean | undefined;
  /**
   * Extra keys for `host.env`, for facts only the embedder can name.
   *
   * That division with its third clause: compose owns the shape, core owns the
   * values, and the embedder owns its own values. Written after the engine's,
   * sorted, through the same quoting and the same newline refusal.
   */
  hostEnvExtra?: Record<string, string> | undefined;
  /** The port the router forwards the bare domain to. Default 8080. */
  frontendPort?: number | undefined;
  /**
   * The container the forward-auth middleware asks (§7.2).
   *
   * Named here because `init` writes the router's configuration before any
   * front end exists to be listed — the engine starts none of its own.
   */
  frontendContainer?: string | undefined;
}

export interface AccessReport {
  domain: string;
  scheme: "http" | "https";
  ports: RouterPorts;
  certificate?: Certificate | undefined;
  baseImage: string;
  /**
   * Where a front end must listen, and what the router will send it (§7.2).
   *
   * `init` prepares the bare domain and does not fill it. This is the whole of
   * what a control plane needs to know to be the thing on it.
   */
  frontend: { port: number; domain: string; tls: boolean };
  /** Things that work now but would work better after one more command. */
  notes: string[];
}

export function domainOf(env: NodeJS.ProcessEnv = process.env): string {
  return env.SANDBOXER_DOMAIN && env.SANDBOXER_DOMAIN !== "" ? env.SANDBOXER_DOMAIN : DEFAULT_DOMAIN;
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
 * The tag used to be `sandboxer/base:<TOOL_VERSION>` alone, which meant an image
 * was reused until the version number moved — so editing anything under
 * `container/` left every machine running the image built before the edit, and
 * `--rebuild` was the only way to find out.
 *
 * That was survivable while the scripts only ever *added* behaviour. It stopped
 * being survivable when the project's credentials became a mounted file: a host
 * on the new code mounts `/sandboxer/secrets.env`, and an image built before the
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
  // still says which sandboxer an image belongs to at a glance.
  return `${BASE_IMAGE}:${TOOL_VERSION}-${hash.digest("hex").slice(0, 12)}`;
}

/**
 * The directories under `container/` the base image build actually reads.
 *
 * `base/Dockerfile` is the build file and `base/s6/` and `scripts/` are the only
 * two things it copies in — `COPY scripts/` and `COPY base/s6/`, and nothing
 * else. Everything under those two is an input; everything outside them is not.
 *
 * **This is an allowlist and it used to be a deny-list**, and the difference is
 * the whole of why it changed. The deny-list named `project/`, `examples/` and
 * `workstation/`, and every directory that arrived under `container/` after it
 * was written silently joined the base image's digest — so editing a file that
 * cannot affect the base forced a rebuild of it, several minutes and several
 * gigabytes on the next `init`, for nothing. `workstation/` had to be noticed
 * that way; the dashboard's, the orchestrator's and the agent layer's would
 * each have had to be noticed the same way. An allowlist has the opposite failure: a new input
 * the base really does read is *not* hashed until it is named here, which shows
 * up as an image that did not rebuild — annoying, and fixed by editing one line,
 * rather than as a rebuild nobody can explain.
 *
 * It matters more than tidiness now the repository has been split.
 * `container/base/` and `container/scripts/` are the engine's and came with it;
 * the agent layer, the dashboard, the orchestrator and the workstation are a
 * product's and stayed behind. A deny-list in the engine would have to name
 * directories that are not in its own tree. This one names only what it owns.
 */
const BASE_INPUTS = ["base", "scripts"] as const;

/** Every file the base image build reads. */
async function inputsOf(context: string): Promise<string[]> {
  const found: string[] = [];

  const walk = async (dir: string): Promise<void> => {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) await walk(path);
      else if (entry.isFile()) found.push(path);
    }
  };

  for (const dir of BASE_INPUTS) await walk(join(context, dir));
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
 * Sets the machine up: directories, network, base image, certificate, router,
 * `host.env`.
 *
 * **It prepares the bare domain and does not fill it** (contracts §7.2). The
 * engine serves no control plane — `sandboxer` is a command-line tool — so
 * nothing answers `https://<domain>` after this unless an embedder puts a front
 * end there. `AccessReport.frontend` is where one must listen. `jef init` is
 * Jef's verb: it calls this, builds the dashboard, workstation and orchestrator
 * images, and starts the dashboard and the orchestrator on that port.
 *
 * Idempotent. Running it again is how you change the domain or pick TLS up
 * after installing mkcert's root.
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

  // Asked *before* the directories are made, because making them creates the
  // new home, and the notice is defined as "the old home is here and the new one
  // is not". Asked afterwards it was always undefined — the first wiring did
  // exactly that, and the sentence this exists to say was never said.
  //
  // Said by `init` and by nothing else, because `init` is the verb somebody runs
  // straight after an upgrade and the only one that can be trusted to be read.
  // Every other command would repeat it until it became noise.
  const legacy = legacyHomeNotice(env);

  for (const dir of directoriesOf(p)) await mkdir(dir, { recursive: true });
  await docker.ensureNetwork(NETWORK);

  // The machine's own settings file, written commented-out-and-explained the
  // first time and never touched again. It is announced because a config file
  // nobody knows exists is a config file nobody edits — and the setting in it
  // decides when this machine stops containers.
  const configFile = await writeMachineConfigExample(env);
  if (configFile) notes.push(`Wrote ${configFile}. Edit it to change how long a sandbox may sit unused.`);

  if (legacy) notes.push(legacy);

  // The one image `init` builds. It is the prerequisite of the next thing
  // anybody does — the first `up` fails without it — which is the test for
  // belonging here. The dashboard's, the workstation's and the orchestrator's
  // are a *product's* images and are built by `jef init`; the engine has no
  // opinion about what a control plane is made of.
  const baseImage = await ensureBaseImage({ docker, env, rebuild: options.rebuild, log });

  // --- the certificate ---------------------------------------------------------
  //
  // One certificate for the machine: the domain, for whatever a product puts
  // on it, and one wildcard under it, which since contracts §3.2 flattened a
  // sandbox hostname into a single label is every sandbox as well. This used to
  // be "the base one only", with a second certificate issued per sandbox on
  // `up`, because a TLS wildcard covers exactly one label and a sandbox was
  // three deep.
  let cert: Certificate | undefined;
  if (options.tls !== false) {
    if (!(await mkcertAvailable())) {
      notes.push("mkcert is not installed, so the router serves plain http. `brew install mkcert` to change that.");
    } else if (!(await caTrusted({ env })) && options.tls !== true) {
      notes.push(
        "mkcert's root is not in this machine's trust store, so the router serves plain http.\n" +
          "  Run `mkcert -install` (it asks for your password once) and then `sandboxer init` again.",
      );
    } else {
      cert = await issueCertificate(domain, baseCertificateNames(domain), { env });
      if (!cert) notes.push("mkcert could not issue a certificate, so the router serves plain http.");
      else if (!cert.trusted) notes.push("The certificate is issued but its root is not trusted — run `mkcert -install`.");
    }
  }

  // --- the router --------------------------------------------------------------
  const frontendPort = options.frontendPort ?? DEFAULT_FRONTEND_PORT;
  const files = await writeRouterConfig({
    env,
    cert,
    // The front end an embedder will start. The engine starts none of its own
    // (contracts §7.2); this names the address the middleware has to carry
    // before one exists to be listed.
    frontendContainer: options.frontendContainer ?? DEFAULT_FRONTEND_CONTAINER,
    frontendPort,
    ports,
  });
  if (cert) await writeCertificateEntry(files.dynamic, cert, TLS_DIR, { isDefault: true });
  // Removed rather than left behind: this file is what `routerScheme` reads, so
  // a stale one from a previous run would have every command print URLs on a
  // scheme nothing is listening on.
  else await rm(join(files.dynamic, `cert-${domain}.yml`), { force: true });
  await sweepSandboxCertificates(files.dynamic, domain, env, log);

  // --- what only the host can look up ------------------------------------------
  //
  // Resolved here because here is the last moment anything can reach the login
  // keychain, the host's gitconfig or the host's filesystem — see
  // access/host-env.ts. A lookup left until a container is up is a lookup that
  // answers nothing, and both the front end's `docker run` and
  // `docker compose up` read the file this writes.
  const ghToken = await hostGhToken(env);
  const gitIdentity = await hostGitIdentity(env);
  await writeHostEnv({
    env,
    facts: { ghToken, gitIdentity },
    // Whatever the caller had to look up here and the engine has no name for
    // (Jef's §8). `jef init` passes two: a path on the host filesystem its
    // dashboard container cannot see, and a setup token under the name the tool
    // that reads it expects.
    extra: options.hostEnvExtra ?? {},
  });

  // --- the router ---------------------------------------------------------------
  if (options.start === false) {
    notes.push(
      `Nothing was started. ${p.hostEnvFile} and the router's configuration are ready.`,
    );
  } else {
    await startRouter({ env, docker, cert, files, bind: options.bind, ports, log });
  }

  const scheme = cert ? "https" : "http";
  // Said once, because a bare domain nobody is serving looks like a broken
  // install rather than a finished one. `sandboxer` is a command-line tool: it
  // prepares the domain, and whether anything answers on it is an embedder's
  // decision (contracts §7.2).
  if ((await listFrontends(docker)).length === 0) {
    notes.push(
      `Nothing is serving ${scheme}://${domain}${portSuffix(scheme, ports)} — sandboxer is a command-line tool.\n` +
        `  A control plane that wants the bare domain listens on ${frontendPort} and carries the\n` +
        "  `sandboxer.frontend` label. Sandboxes are reachable either way.",
    );
  }

  return {
    domain,
    scheme,
    ports,
    certificate: cert,
    baseImage,
    frontend: { port: frontendPort, domain, tls: cert !== undefined },
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

  // Whatever is on the bare domain, found by its label rather than by a name the
  // engine would have to know (contracts §7.2). A machine with no front end has
  // none of these and the loop does nothing.
  for (const container of await listFrontends(docker)) {
    await docker.raw(["rm", "-f", container]);
    removed.push(container);
    log(`Removed ${container}`);
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
  /**
   * Every container claiming the bare domain, by name (contracts §7.2).
   *
   * A list rather than a boolean, and read from the label rather than from a
   * name the engine would have to know. **Empty is not a fault**: the engine
   * serves no control plane, so a machine with nothing here is a machine that
   * has not been given one. Whoever reports this has to say that rather than
   * calling it a failed check.
   */
  frontends: string[];
  /** The scheme the router is actually configured for, read from its own state. */
  scheme: "http" | "https";
  ports: RouterPorts;
  /** The bare domain, whether or not anything is serving it. */
  url: string;
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
    frontends: await listFrontends(docker),
    scheme,
    ports,
    url: `${scheme}://${domain}${portSuffix(scheme, ports)}`,
    certificatePresent,
    certificateTrusted: certificatePresent ? await caTrusted({ env }) : false,
    baseImagePresent:
      (await docker.imageExists(`${BASE_IMAGE}:${TOOL_VERSION}`)) ||
      (await docker.imageExists(`${BASE_IMAGE}:latest`)),
  };
}
