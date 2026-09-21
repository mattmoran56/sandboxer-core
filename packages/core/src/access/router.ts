/**
 * The shared router: one Traefik container in front of every sandbox on the
 * machine.
 *
 * It reconciles from Docker labels, so starting or stopping a sandbox never
 * regenerates a config file and never triggers a reload — the sandbox's own
 * `docker run` carries everything the router needs to know about it. That is the
 * property contracts §3.4 is describing when it says state lives only in labels.
 *
 * One router per sandbox, not one per app. Inside the container Caddy already
 * splits by hostname, serves the status surface on every one of them, and
 * answers a name it does not know with a 404 that says so. Duplicating that
 * split out here would mean two places to add a label to, and the outer one
 * would answer "no such host" for an app the inner one could have explained.
 */

import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

import type { Docker } from "../docker.js";
import { HOST_COMPONENT, HOST_SEPARATOR, NETWORK } from "../naming.js";
import { paths } from "../paths.js";
import type { Certificate } from "./tls.js";

/** The router's container name. One per machine, like the network. */
export const ROUTER_CONTAINER = "sandboxr-router";

/** Pinned: a router that silently changes major version changes its rule syntax. */
export const ROUTER_IMAGE = "traefik:v3.6";

/** The forward-auth middleware a private project's hostnames go through. */
export const AUTH_MIDDLEWARE = "sandboxr-auth@file";

export class RouterError extends Error {
  override readonly name = "RouterError";
}

/** Where the router reads its own files, inside its container. */
const CONF = "/etc/traefik/traefik.yml";
const DYNAMIC = "/etc/traefik/dynamic";
export const TLS_DIR = "/etc/traefik/tls";

/**
 * The host ports the router publishes on.
 *
 * 80 and 443 by default, because a hostname with a port in it is not really a
 * hostname. They are overridable because they are the one thing on the machine
 * sandboxr cannot assume it owns: another local development router, or anything
 * else already bound there, makes 80 unavailable and `docker run` fails with
 * "address already in use" rather than anything that names the fix.
 */
export interface RouterPorts {
  http: number;
  https: number;
}

export function routerPorts(env: NodeJS.ProcessEnv = process.env): RouterPorts {
  const read = (value: string | undefined, fallback: number): number => {
    const parsed = Number(value);
    return Number.isInteger(parsed) && parsed > 0 && parsed < 65536 ? parsed : fallback;
  };
  return {
    http: read(env.SANDBOXR_HTTP_PORT, 80),
    https: read(env.SANDBOXR_HTTPS_PORT, 443),
  };
}

/**
 * The `:port` a URL needs, or nothing.
 *
 * Empty for the scheme's own default, because `https://x:443` is the same URL
 * written worse.
 */
export function portSuffix(scheme: "http" | "https", ports: RouterPorts): string {
  const port = scheme === "https" ? ports.https : ports.http;
  const standard = scheme === "https" ? 443 : 80;
  return port === standard ? "" : `:${port}`;
}

export interface RouterFiles {
  /** The static configuration, on the host. */
  config: string;
  /** The directory of dynamic configuration, on the host. */
  dynamic: string;
}

/** Escapes a string for use as a literal inside a Go regular expression. */
export function regexLiteral(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * The rule that sends every one of a sandbox's hostnames to it.
 *
 * A regular expression rather than one `Host()` per label, because the set of
 * labels is a fact about the plan and this is a fact about the sandbox: adding a
 * front-end to a project must not require the router to be told about it. The
 * slug and project are fixed, and the label in the middle is whatever the plan
 * says — which the container itself is the right thing to resolve.
 *
 * All three now live in one DNS label (contracts §3.2), so the pattern matches
 * inside a label rather than across dots. The middle is `HOST_COMPONENT` and not
 * `[a-z0-9-]+`, and the difference is load-bearing: the looser class would match
 * a label containing `--`, and this rule and the handshake rule below would then
 * disagree with `hostFor` about where `<slug>--<label>--<project>` divides.
 */
export function sandboxRule(slug: string, project: string, domain: string): string {
  const sep = regexLiteral(HOST_SEPARATOR);
  return `HostRegexp(\`^${regexLiteral(slug)}${sep}${HOST_COMPONENT}${sep}${regexLiteral(project)}\\.${regexLiteral(domain)}$\`)`;
}

/**
 * The one path the dashboard answers on a *sandbox* hostname: the private-app
 * login handshake.
 *
 * A reserved prefix under every sandbox hostname on the machine, in the shape
 * `/.well-known/` established — which is why it is a name no project would pick
 * for a route of its own. A front end answering it repeats this literal as a
 * constant of its own — core does not import the thing serving the bare domain,
 * and after the repository split it could not — so the two ends of this contract
 * are two constants that have to agree, exactly as `/auth/verify` already is.
 */
export const HANDSHAKE_PATH = "/.sandboxr/auth";

/** The handshake router's name. One per machine, on the dashboard's container. */
export const HANDSHAKE_ROUTER = "sandboxr-handshake";

/**
 * The priority the handshake rule carries.
 *
 * Traefik orders routers by priority and defaults it to the *length of the rule*,
 * which would decide this by accident: the handshake rule's host pattern is
 * generic where a sandbox's names its slug and project, so which of the two is
 * the longer string depends on how long somebody's branch name is. An explicit
 * value makes the reserved prefix win every time, and high enough to stay ahead
 * of any rule a future sandbox label adds.
 */
export const HANDSHAKE_PRIORITY = 10_000;

export interface RouteLabelInput {
  /** Router and service name. Must be unique across the machine. */
  name: string;
  rule: string;
  /** The port *inside* the target container. */
  port: number;
  tls: boolean;
  middlewares?: string[] | undefined;
  /**
   * An existing service to send this router to, instead of declaring one. Set
   * when a container needs a second router — Traefik links a lone router to a
   * lone service on its own, but two routers are ambiguous unless each says.
   */
  service?: string | undefined;
  /** Explicit ordering. Absent, Traefik falls back to the rule's length. */
  priority?: number | undefined;
}

/** The Docker labels that make the router serve one container. */
export function routeLabels(input: RouteLabelInput): Record<string, string> {
  const { name } = input;
  const labels: Record<string, string> = {
    "traefik.enable": "true",
    [`traefik.http.routers.${name}.rule`]: input.rule,
    [`traefik.http.routers.${name}.entrypoints`]: input.tls ? "websecure" : "web",
    [`traefik.http.routers.${name}.service`]: input.service ?? name,
  };
  if (!input.service) {
    labels[`traefik.http.services.${name}.loadbalancer.server.port`] = String(input.port);
  }
  if (input.tls) labels[`traefik.http.routers.${name}.tls`] = "true";
  if (input.priority !== undefined) labels[`traefik.http.routers.${name}.priority`] = String(input.priority);
  if (input.middlewares?.length) {
    labels[`traefik.http.routers.${name}.middlewares`] = input.middlewares.join(",");
  }
  return labels;
}

/**
 * The rule that puts the handshake path on **every** sandbox hostname.
 *
 * One rule for the machine, not one per sandbox, because it has to be there
 * before the sandbox it is for: the browser arrives at a private app, is sent
 * round through the dashboard, and comes back to this path — and a rule
 * reconciled from the sandbox's own labels would work for private projects only,
 * which is a difference nothing else in the routing has and one more thing to
 * get wrong when a project's access changes.
 *
 * Public projects therefore also route this prefix to the dashboard, where it
 * answers exactly as it does anywhere else: it needs a ticket, and a ticket is
 * only ever issued for a hostname the session's grant covers. What it costs a
 * public project is the prefix itself, which is why the prefix is reserved.
 *
 * The host pattern names nothing: one label above the domain, divided by `--`
 * into exactly three components, is a sandbox — and the dashboard's own bare
 * domain has no label at all, so this cannot shadow the control plane. It used
 * to count *three* labels above the domain, which was the same statement before
 * contracts §3.2 flattened a sandbox hostname into one.
 */
export function handshakeRule(domain: string): string {
  const sep = regexLiteral(HOST_SEPARATOR);
  const flat = [HOST_COMPONENT, HOST_COMPONENT, HOST_COMPONENT].join(sep);
  const host = `HostRegexp(\`^${flat}\\.${regexLiteral(domain)}$\`)`;
  return `${host} && PathPrefix(\`${HANDSHAKE_PATH}\`)`;
}

/** Every label a sandbox container needs for the router to serve it. */
export function sandboxRouteLabels(input: {
  container: string;
  slug: string;
  project: string;
  domain: string;
  tls: boolean;
  /** `private` apps go through forward-auth; `public` ones do not. */
  access: "public" | "private";
}): Record<string, string> {
  return routeLabels({
    name: input.container,
    rule: sandboxRule(input.slug, input.project, input.domain),
    port: 80,
    tls: input.tls,
    middlewares: input.access === "private" ? [AUTH_MIDDLEWARE] : undefined,
  });
}

/**
 * Writes the router's own configuration.
 *
 * The Docker provider is `exposedByDefault: false` on purpose: this router sits
 * on a network shared with every sandbox, and a default of "expose everything"
 * would publish a container to the internet-facing entry point the moment it
 * joined, whether or not anything meant it to.
 */
export async function writeRouterConfig(options: {
  env?: NodeJS.ProcessEnv | undefined;
  cert?: Certificate | undefined;
  /** The container the bare domain's front end runs in (contracts §7.2). */
  frontendContainer: string;
  /** The port it listens on inside that container. */
  frontendPort: number;
  ports?: RouterPorts | undefined;
}): Promise<RouterFiles> {
  const p = paths(options.env ?? process.env);
  const dynamic = join(p.state, "dynamic");
  await mkdir(dynamic, { recursive: true });

  const ports = options.ports ?? routerPorts(options.env ?? process.env);
  const tls = options.cert !== undefined;
  const config = join(p.state, "traefik.yml");
  await writeFile(
    config,
    [
      "# Generated by sandboxr init. Edits are lost on the next run.",
      "entryPoints:",
      "  web:",
      '    address: ":80"',
      // Only when there is a certificate: redirecting to a scheme nothing serves
      // would take the whole machine off the air rather than upgrading it.
      ...(tls
        ? [
            "    http:",
            "      redirections:",
            "        entryPoint:",
            // `to` takes an entry point name *or* a bare `:port`, and the port
            // form is the only one that carries a non-standard host port into
            // the redirect: the entry point itself listens on 443 inside the
            // container whatever the host publishes it as, so naming it would
            // send the browser to a port nothing answers on.
            `          to: ${ports.https === 443 ? "websecure" : `":${ports.https}"`}`,
            "          scheme: https",
          ]
        : []),
      ...(tls ? ["  websecure:", '    address: ":443"'] : []),
      "providers:",
      "  docker:",
      "    endpoint: unix:///var/run/docker.sock",
      "    exposedByDefault: false",
      `    network: ${NETWORK}`,
      "    watch: true",
      "  file:",
      `    directory: ${DYNAMIC}`,
      "    watch: true",
      "log:",
      "  level: INFO",
      "accessLog: {}",
      "api:",
      "  dashboard: false",
      "",
    ].join("\n"),
  );

  // The forward-auth middleware a private project's app hostnames go through.
  // It points at the **front end** by container name, which resolves on the
  // shared network — one mechanism for sessions, used twice (contracts §7).
  //
  // Named by the caller rather than looked up, because this file is written by
  // `init` and a front end need not exist yet: the engine starts none (§7.2), so
  // there is nothing to list at the moment the address has to be decided.
  await writeFile(
    join(dynamic, "middlewares.yml"),
    [
      "# Generated by sandboxr init. Edits are lost on the next run.",
      "http:",
      "  middlewares:",
      "    sandboxr-auth:",
      "      forwardAuth:",
      `        address: "http://${options.frontendContainer}:${options.frontendPort}/auth/verify"`,
      "        trustForwardHeader: true",
      "",
    ].join("\n"),
  );

  return { config, dynamic };
}

export interface RouterOptions {
  env?: NodeJS.ProcessEnv | undefined;
  docker: Docker;
  cert?: Certificate | undefined;
  files: RouterFiles;
  /** Bind address for the published ports. Loopback unless someone asks otherwise. */
  bind?: string | undefined;
  ports?: RouterPorts | undefined;
  log?: ((line: string) => void) | undefined;
}

/** The `docker run` argument list for the router. Pure, so a test can read it. */
export function routerArgs(options: {
  files: RouterFiles;
  tlsDir?: string | undefined;
  cert?: Certificate | undefined;
  bind: string;
  ports?: RouterPorts | undefined;
  image?: string | undefined;
}): string[] {
  const ports = options.ports ?? { http: 80, https: 443 };
  const args = [
    "run",
    "-d",
    "--name",
    ROUTER_CONTAINER,
    "--network",
    NETWORK,
    "--restart",
    "unless-stopped",
    "--label",
    "sandboxr.role=router",
    "-p",
    `${options.bind}:${ports.http}:80`,
  ];
  if (options.cert) args.push("-p", `${options.bind}:${ports.https}:443`);

  args.push(
    "-v",
    "/var/run/docker.sock:/var/run/docker.sock:ro",
    "-v",
    `${options.files.config}:${CONF}:ro`,
    "-v",
    `${options.files.dynamic}:${DYNAMIC}:ro`,
  );
  if (options.cert && options.tlsDir) args.push("-v", `${options.tlsDir}:${TLS_DIR}:ro`);

  args.push(options.image ?? ROUTER_IMAGE, `--configFile=${CONF}`);
  return args;
}

/**
 * Starts the router, replacing any earlier one.
 *
 * Replaced rather than reused: its configuration is bind-mounted, and a change
 * to which ports it publishes or whether it terminates TLS cannot be picked up
 * by a running container.
 */
export async function startRouter(options: RouterOptions): Promise<void> {
  const { docker } = options;
  const log = options.log ?? (() => undefined);
  const p = paths(options.env ?? process.env);

  await docker.ensureNetwork(NETWORK);
  if (await docker.containerExists(ROUTER_CONTAINER)) {
    await docker.rm(ROUTER_CONTAINER, { force: true });
  }
  const ports = options.ports ?? routerPorts(options.env ?? process.env);
  const bind = options.bind ?? "127.0.0.1";
  const result = await docker.raw(
    routerArgs({
      files: options.files,
      tlsDir: p.tls,
      cert: options.cert,
      bind,
      ports,
      image: (options.env ?? process.env).SANDBOXR_ROUTER_IMAGE,
    }),
  );
  if (result.code !== 0) {
    // Docker's own message for a taken port names the address and nothing else.
    // The fix is a flag on this command, and it is worth saying so here rather
    // than leaving it to be found.
    const taken = /address already in use|port is already allocated/i.test(result.stderr + result.stdout);
    throw new RouterError(
      taken
        ? `Something is already listening on ${bind}:${ports.http}` +
          (options.cert ? ` or ${bind}:${ports.https}` : "") +
          ".\n" +
          "  Stop it, or give sandboxr other ports:\n" +
          "    sandboxr init --http-port 8080 --https-port 8443"
        : (result.stderr || result.stdout).trim(),
    );
  }
  log(`Router listening on ${bind}:${ports.http}${options.cert ? ` and :${ports.https}` : ""}`);
}

export async function stopRouter(docker: Docker): Promise<boolean> {
  if (!(await docker.containerExists(ROUTER_CONTAINER))) return false;
  await docker.rm(ROUTER_CONTAINER, { force: true });
  return true;
}
