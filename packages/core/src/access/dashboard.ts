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
 * - `SANDBOXR_HOME`, read-write, because the session signing secret lives there
 *   and has to survive a restart — and because the plan `up` writes under it is
 *   what the dashboard reads to describe a project.
 * - The installation itself, read-only, because that is the code being run.
 *
 * What is deliberately *not* mounted is the user's home directory. An earlier
 * version bind-mounted all of it read-only, so that the dashboard could reach
 * any worktree named in a container label and read its `sandboxr.yaml`. That is
 * a great deal of filesystem to hand a container holding the Docker socket, and
 * on macOS it means sharing the whole tree with the VM: with a large monorepo
 * under it the share is enough to wedge the daemon, which shows up as a
 * container that will not answer SIGTERM and a Docker that has to be restarted.
 * The plan carries the same fields, so nothing needs the worktree at all.
 *
 * The workspace mount added later is deliberately not a return of that mistake.
 * It is one directory sandboxr owns and put the repositories in itself, not
 * wherever the user happens to keep checkouts, so its size is known and it is
 * the only tree shared with the VM. The rule that came out of the incident above
 * still holds: mount a directory this tool created, never one it merely found.
 */

import { existsSync } from "node:fs";
import { join } from "node:path";

import { nodeRunner, type Docker } from "../docker.js";
import { CREDENTIALS_ENV, hostClaudeCredentials } from "../agent/credentials.js";
import { hostGitIdentity, type GitIdentity } from "../git.js";
import { NETWORK } from "../naming.js";
import { isInside, paths } from "../paths.js";
import { dashboardEntry, installRoot } from "../install.js";
import { frontendRouteLabels } from "./frontend.js";

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
  /**
   * A GitHub token for the dashboard's `gh` and `git`.
   *
   * Needed as a *value*, not a mounted file. On macOS `gh` keeps the token in
   * the login keychain, so the `~/.config/gh` that gets mounted names the user
   * and carries no credential at all — and a private clone then fails with
   * "could not read Username for 'https://github.com'", which reads like a
   * missing prompt rather than a missing token.
   */
  ghToken?: string | undefined;
  /**
   * The identity a commit made in a sandbox is by.
   *
   * The dashboard has no gitconfig of its own — it is a bare `node:` image with
   * no home directory anybody has configured — so it cannot resolve this from
   * inside itself, and a sandbox it starts would otherwise be unable to commit
   * at all while one started from the CLI could. Passed at `init`, forwarded to
   * every sandbox: see `hostGitIdentity` in ../git.ts.
   */
  gitIdentity?: GitIdentity | undefined;
  /**
   * The host's Claude Code login, as a path on the *host*.
   *
   * Resolved at `init` and forwarded, for the reason the identity above is: the
   * dashboard's `$HOME` is not the person's, and it cannot see the host
   * filesystem at all, so a dashboard left to work this out for itself would
   * find nothing while the CLI found the file — and sandboxes started from the
   * browser would silently lack a login that sandboxes started from the terminal
   * had. It is a path, never the credential: the file is mounted into each
   * sandbox by the host daemon, and its contents are read by nothing here.
   */
  claudeCredentials?: string | undefined;
  env?: NodeJS.ProcessEnv | undefined;
  image?: string | undefined;
}

/**
 * The settings the dashboard inherits from whatever started it, if the host set
 * them.
 *
 * A named list rather than "anything starting with SANDBOXR_": a wildcard would
 * forward a variable a future version means something else by, and the dashboard
 * is the one container on the machine holding a credential.
 *
 * **The rule for being on this list is "core reads it, and a person sets it".**
 * The dashboard calls core in process — it never shells out to the CLI — so
 * anything core reads from the environment is read from *this container's*
 * environment. A documented setting missing from here is not a setting with a
 * different default in the dashboard; it is a setting that does nothing there,
 * silently, while `sandboxr` on the command line honours it.
 *
 * **The orchestrator entries are why this list is not only about credentials.**
 * The orchestrator runs inside the dashboard when `SANDBOXR_ORCHESTRATOR` is set
 * (contracts §10.7), and a flag that never reaches the container is a feature
 * that cannot be turned on in the one deployment most people use — the dashboard
 * served on the machine's own domain. The two socket paths travel with it because
 * a voice or a call is reached through a socket the host created; put one under
 * `SANDBOXR_HOME`, which is mounted at the same path inside and out, and the
 * container finds it exactly where the host left it.
 *
 * **The database entries are the same mistake, found later and the hard way.**
 * Every variable in "For a MySQL project" in docs/reference/environment.md was
 * absent from this list, so a dashboard could not be told anything at all about
 * a database. The one that bites first is `SANDBOXR_SOURCE_DB_PASSWORD`: seeding
 * a sandbox by forking a local container reads that container with
 * `SANDBOXR_SOURCE_DB_USER` and this, and the defaults are `root` and *empty* —
 * which is nobody's local MySQL. So `up` from the browser died on
 * `could not fingerprint … — are the source credentials right?` on every machine
 * whose database has a password, with the advice in that very message
 * ("Set SANDBOXR_SOURCE_DB_USER and SANDBOXR_SOURCE_DB_PASSWORD") having no
 * effect when followed. The same `up` from the terminal worked, which is the
 * shape of the whole bug: the two faces of one tool disagreeing about a setting.
 */
export const FORWARDED_VARIABLES = [
  "SANDBOXR_CLAUDE_TOKEN",
  "SANDBOXR_CLAUDE_MODEL",
  "SANDBOXR_CLAUDE_MCP",
  "SANDBOXR_CLAUDE_PERMISSION_MODE",
  "SANDBOXR_ORCHESTRATOR",
  "SANDBOXR_ORCHESTRATOR_STALL_MS",
  "SANDBOXR_ORCHESTRATOR_SUMMARIES",
  "SANDBOXR_VOICE_SOCKET",
  "SANDBOXR_TELEGRAM_SOCKET",
  // Reading the database being copied *from*: a container on the host, which
  // the dashboard reaches over the mounted Docker socket.
  "SANDBOXR_SOURCE_DB_USER",
  "SANDBOXR_SOURCE_DB_PASSWORD",
  // The database made *inside* a sandbox, and what the app connects to it as.
  "SANDBOXR_DB_USER",
  "SANDBOXR_DB_PASSWORD",
  "SANDBOXR_DB_ROOT_PASSWORD",
  "SANDBOXR_DB_NAME",
  "SANDBOXR_DB_FILE",
  // Which MySQL a dump is restored into, and how long a cached dump stands.
  "SANDBOXR_MYSQL_IMAGE",
  "SANDBOXR_CACHE_TTL_HOURS",
] as const;

const forwardedEnvironment = (env: NodeJS.ProcessEnv): Record<string, string> => {
  const held: Record<string, string> = {};
  for (const name of FORWARDED_VARIABLES) {
    const value = env[name];
    if (value !== undefined && value.trim() !== "") held[name] = value;
  }
  return held;
};

/**
 * The Traefik labels that put the dashboard on the machine.
 *
 * The dashboard is a **front end** (contracts §7.5): a container on the bare
 * domain. The two routers, the handshake exception and the reasoning behind both
 * are `frontendRouteLabels` in ./frontend.ts, which is the engine's general form
 * of this and is what `sandboxr.frontend` is stamped by. Nothing about the shape
 * was the dashboard's — this is only the one front end Jef happens to run.
 *
 * **Its own function rather than an expression inside `dashboardArgs`**, because
 * the top-level `docker-compose.yml` starts this same container and therefore has
 * to spell the same labels in YAML. `access/compose.test.ts` compares that file
 * against *this*, so a rule edited here fails there rather than drifting.
 */
export function dashboardLabels(input: { domain: string; tls: boolean }): Record<string, string> {
  return frontendRouteLabels({
    container: DASHBOARD_CONTAINER,
    port: DASHBOARD_PORT,
    domain: input.domain,
    tls: input.tls,
  });
}

/**
 * The `docker run` argument list for the dashboard. Pure, so a test can read
 * every mount and every variable without a daemon.
 */
export function dashboardArgs(input: DashboardInput): string[] {
  const env = input.env ?? process.env;
  const p = paths(env);
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

  for (const [key, value] of Object.entries(dashboardLabels(input))) {
    args.push("--label", `${key}=${value}`);
  }

  args.push("-v", "/var/run/docker.sock:/var/run/docker.sock");
  // `SANDBOXR_HOME`, read-write: the session secret lives here, and so does the
  // plan the dashboard reads to describe a project.
  args.push("-v", `${p.home}:${p.home}`);
  // The installation, read-only: it is the code this container runs.
  args.push("-v", `${install}:${install}:ro`);
  // The workspace, read-write: the dashboard clones repositories and adds
  // worktrees in here, and reads each project's sandboxr.yaml out of one.
  //
  // Mounted at the identical path inside and out, like the home above, and that
  // is not cosmetic: a git worktree records an absolute path back to its
  // repository, so a worktree created under a different mount point would be
  // broken for every other reader of that directory — including `up`, which
  // hands the same path to `docker run` on the host.
  //
  // Skipped when the workspace is already inside the home, which is the default,
  // rather than mounting the same directory twice.
  if (!isInside(p.workspace, p.home)) args.push("-v", `${p.workspace}:${p.workspace}`);
  // gh's configuration, read-only, when there is any.
  //
  // This buys two things at once: `gh pr list` is authenticated, and — because
  // dashboard/Dockerfile writes the credential helper `gh auth setup-git` would
  // have written — so is `git fetch` over https. Without it the dashboard would
  // need its own deploy keys, and a private repository would fail to clone with
  // an error about a terminal prompt being disabled, which reads as anything but
  // "no credentials".
  const ghConfig = ghConfigDir(env);
  if (ghConfig && existsSync(ghConfig)) args.push("-v", `${ghConfig}:/root/.config/gh:ro`);

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
    ...(input.ghToken ? { GH_TOKEN: input.ghToken } : {}),
    // git's own variable names rather than a SANDBOXR_ pair, because these are
    // what `hostGitIdentity` reads back out and what git itself honours — one
    // spelling from the host, through here, into a sandbox.
    ...(input.gitIdentity?.name ? { GIT_AUTHOR_NAME: input.gitIdentity.name } : {}),
    ...(input.gitIdentity?.email ? { GIT_AUTHOR_EMAIL: input.gitIdentity.email } : {}),
    // Where the host keeps its Claude Code login, so the sandboxes this
    // dashboard starts can bind-mount it. Omitted when there is no such file,
    // so that "this machine has no host login" stays distinguishable from "a
    // path that resolves to nothing" — a bind whose source is missing does not
    // fail, it makes a directory. See ../agent/credentials.ts.
    ...(input.claudeCredentials ? { [CREDENTIALS_ENV]: input.claudeCredentials } : {}),
    // The agent-session settings, forwarded from whatever started the dashboard.
    //
    // Forwarded rather than mounted, and the reason is the same one the GH_TOKEN
    // comment gives above: on macOS `claude` keeps its credential in the login
    // keychain, so there is no file to mount — the only thing that can cross
    // into the container is a value. `SANDBOXR_CLAUDE_TOKEN` is a long-lived
    // token from `claude setup-token`, held in the dashboard's environment and
    // handed to a session's exec; it is written to no file, in the container or
    // out of it.
    //
    // Absent ones are omitted rather than passed empty, so the server's own
    // defaults apply and "no credential on this machine" stays a distinguishable
    // state from "a credential that is the empty string".
    ...forwardedEnvironment(env),
  };
  for (const [key, value] of Object.entries(environment)) args.push("-e", `${key}=${value}`);

  args.push("--workdir", install, input.image ?? env.SANDBOXR_DASHBOARD_IMAGE ?? DASHBOARD_IMAGE, "node", entry);
  return args;
}

/**
 * The host's GitHub token, from the environment or from `gh` itself.
 *
 * Never throws and never logs the value: a machine with no gh, or one that is
 * not logged in, simply has no token, and the dashboard says so once at start
 * rather than failing every clone with a confusing git error.
 */
export async function hostGhToken(env: NodeJS.ProcessEnv = process.env): Promise<string | undefined> {
  const declared = env.GH_TOKEN ?? env.GITHUB_TOKEN;
  if (declared && declared !== "") return declared;
  try {
    const result = await nodeRunner("gh", ["auth", "token"]);
    const token = result.code === 0 ? result.stdout.trim() : "";
    return token === "" ? undefined : token;
  } catch {
    return undefined;
  }
}

/** Where gh keeps its configuration, honouring its own override. */
export function ghConfigDir(env: NodeJS.ProcessEnv = process.env): string | undefined {
  if (env.GH_CONFIG_DIR && env.GH_CONFIG_DIR !== "") return env.GH_CONFIG_DIR;
  const home = env.HOME;
  return home && home !== "" ? join(home, ".config", "gh") : undefined;
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

  // Resolved here rather than left to the caller: `gh auth token` is the only
  // thing that can read a token out of the host's keychain, and the dashboard
  // is useless for a private repository without one. An explicit value wins, so
  // a service unit can set GH_TOKEN and never invoke gh at all.
  const ghToken = options.ghToken ?? (await hostGhToken(options.env ?? process.env));
  if (!ghToken) {
    log("No GitHub token, so private repositories and pull requests will not be readable.");
  }

  // Resolved here for the same reason as the token: this is the last moment
  // anything can read the *host's* gitconfig. Inside the dashboard there is
  // none, and a sandbox started from the browser would then be one an agent
  // could edit but not commit in.
  const gitIdentity = options.gitIdentity ?? (await hostGitIdentity(options.env ?? process.env));
  if (!gitIdentity.name || !gitIdentity.email) {
    log("This machine has no git user.name/user.email, so commits inside a sandbox will be refused by git.");
  }

  // And for the same reason again: this is the last moment anything can look at
  // the *host's* filesystem. Inside the dashboard the path would resolve against
  // a container's `$HOME` and answer no.
  const claudeCredentials = options.claudeCredentials ?? hostClaudeCredentials(options.env ?? process.env);

  await docker.ensureNetwork(NETWORK);
  if (await docker.containerExists(DASHBOARD_CONTAINER)) {
    await docker.rm(DASHBOARD_CONTAINER, { force: true });
  }
  await docker.ok(
    dashboardArgs({
      ...options,
      ...(ghToken ? { ghToken } : {}),
      ...(claudeCredentials ? { claudeCredentials } : {}),
      gitIdentity,
    }),
  );
  log(options.password ? "Dashboard started" : "Dashboard started with no password — it will admit nobody");
}

export async function stopDashboard(docker: Docker): Promise<boolean> {
  if (!(await docker.containerExists(DASHBOARD_CONTAINER))) return false;
  await docker.rm(DASHBOARD_CONTAINER, { force: true });
  return true;
}
