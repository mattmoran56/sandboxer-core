/**
 * The dashboard container: the control plane, on the bare domain.
 *
 * It runs in a container rather than as a loose host process for one reason —
 * lifecycle. `sandboxr init` has to be able to start it, `sandboxr teardown` to
 * stop it, and both have to survive a laptop reboot; a background process with a
 * pidfile is a worse version of what Docker already does. It is not an image of
 * its own: the dashboard is this installation's own build, bind-mounted in, so a
 * `npm run build` here is the whole of "deploy the dashboard".
 *
 * The mounts are the interesting part, and each one is load-bearing:
 *
 * - The Docker socket, because the dashboard's entire job is to drive Docker.
 * - The home directory, **read-only**, because a sandbox's worktree path is
 *   recorded in its container labels and the dashboard reads that project's
 *   `sandboxr.yaml` to render it. A path it cannot see is a sandbox it can list
 *   but not describe.
 * - `SANDBOXR_HOME`, read-write and nested inside the previous one, because the
 *   session signing secret lives there and has to survive a restart.
 */

import { homedir } from "node:os";
import { isAbsolute, relative } from "node:path";

import type { Docker } from "../docker.js";
import { NETWORK } from "../naming.js";
import { paths } from "../paths.js";
import { dashboardEntry, installRoot } from "../install.js";
import { routeLabels } from "./router.js";

export const DASHBOARD_CONTAINER = "sandboxr-dashboard";

/** Pinned to the major the workspace's `engines` field asks for. */
export const DASHBOARD_IMAGE = "node:22-bookworm-slim";

/** The port the dashboard listens on inside its container. */
export const DASHBOARD_PORT = 8080;

export interface DashboardInput {
  domain: string;
  tls: boolean;
  /** The control-plane password, or nothing — the dashboard boots either way. */
  password?: string | undefined;
  env?: NodeJS.ProcessEnv | undefined;
  image?: string | undefined;
}

/** Whether a path is inside a directory, without a filesystem call. */
function contains(parent: string, child: string): boolean {
  const rel = relative(parent, child);
  return rel !== "" && !rel.startsWith("..") && !isAbsolute(rel);
}

/**
 * The `docker run` argument list for the dashboard. Pure, so a test can read
 * every mount and every variable without a daemon.
 */
export function dashboardArgs(input: DashboardInput): string[] {
  const env = input.env ?? process.env;
  const p = paths(env);
  const home = env.HOME && env.HOME !== "" ? env.HOME : homedir();
  const install = installRoot(env);
  const entry = dashboardEntry(env);

  const args = [
    "run",
    "-d",
    "--name",
    DASHBOARD_CONTAINER,
    "--network",
    NETWORK,
    "--restart",
    "unless-stopped",
    "--label",
    "sandboxr.role=dashboard",
  ];

  for (const [key, value] of Object.entries(
    routeLabels({
      name: DASHBOARD_CONTAINER,
      // The bare domain, and only the bare domain. The dashboard never answers
      // on a per-sandbox hostname (contracts §3.2), so the terminal inherits the
      // control plane's session rather than needing one of its own.
      rule: `Host(\`${input.domain}\`)`,
      port: DASHBOARD_PORT,
      tls: input.tls,
    }),
  )) {
    args.push("--label", `${key}=${value}`);
  }

  args.push("-v", "/var/run/docker.sock:/var/run/docker.sock");
  args.push("-v", `${home}:${home}:ro`);
  // Nested inside the read-only home mount, and listed after it, so the state
  // directory is the one writable thing the dashboard can reach.
  args.push("-v", `${p.home}:${p.home}`);
  // A checkout outside the home directory still has to be readable: it is what
  // the dashboard is running.
  if (!contains(home, install)) args.push("-v", `${install}:${install}:ro`);

  const environment: Record<string, string> = {
    SANDBOXR_HOST: "0.0.0.0",
    SANDBOXR_PORT: String(DASHBOARD_PORT),
    SANDBOXR_DOMAIN: input.domain,
    SANDBOXR_HOME: p.home,
    SANDBOXR_DOCKER_SOCKET: "/var/run/docker.sock",
    SANDBOXR_CONTAINER_SCRIPTS: "/opt/sandboxr/scripts",
    // Without TLS the session cookie cannot be `Secure`, or the browser drops it
    // and the login form silently loops. The server says so at startup.
    ...(input.tls ? {} : { SANDBOXR_INSECURE_COOKIES: "1" }),
    ...(input.password ? { SANDBOXR_PASSWORD: input.password } : {}),
  };
  for (const [key, value] of Object.entries(environment)) args.push("-e", `${key}=${value}`);

  args.push("--workdir", install, input.image ?? env.SANDBOXR_DASHBOARD_IMAGE ?? DASHBOARD_IMAGE, "node", entry);
  return args;
}

export interface StartDashboardOptions extends DashboardInput {
  docker: Docker;
  log?: ((line: string) => void) | undefined;
}

/**
 * Starts the dashboard, replacing any earlier one.
 *
 * Replaced rather than reused: the password, the domain and whether cookies may
 * be `Secure` are all fixed at `docker run` time, and every one of them can
 * change between two `init` runs.
 */
export async function startDashboard(options: StartDashboardOptions): Promise<void> {
  const { docker } = options;
  const log = options.log ?? (() => undefined);

  await docker.ensureNetwork(NETWORK);
  if (await docker.containerExists(DASHBOARD_CONTAINER)) {
    await docker.rm(DASHBOARD_CONTAINER, { force: true });
  }
  await docker.ok(dashboardArgs(options));
  log(options.password ? "Dashboard started" : "Dashboard started with no password — it will admit nobody");
}

export async function stopDashboard(docker: Docker): Promise<boolean> {
  if (!(await docker.containerExists(DASHBOARD_CONTAINER))) return false;
  await docker.rm(DASHBOARD_CONTAINER, { force: true });
  return true;
}
