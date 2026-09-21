/**
 * The orchestrator container: the machine's own agent, beside the dashboard.
 *
 * The orchestrator is a `claude` session rather than a service. It has no port
 * and answers no request; the dashboard reaches into it with `docker exec` the
 * same way it reaches into a sandbox, so what runs here is a process that stays
 * up and does nothing until it is spoken to.
 *
 * **Why it is not simply `claude` inside the dashboard container.** The dashboard
 * is the password-protected web surface, and `dashboard.ts` is deliberate that
 * the Claude login never goes inside it — it is handed a *path* and mounts the
 * file into each sandbox. An agent needs that login. Putting the agent in the
 * dashboard would therefore mean putting the credential in the web server, which
 * is precisely the thing that decision avoids. A container of its own keeps the
 * boundary: the login sits beside the dashboard, not inside it.
 *
 * The mounts are the dashboard's, plus the credential, and each is load-bearing:
 *
 * - The Docker socket, because the agent's job is to drive sandboxes.
 * - `SANDBOXR_HOME`, read-write, because the run index and the plans live there.
 * - The installation, read-only, because that is the sandboxr CLI it runs.
 * - The workspace, read-write, because that is where the repositories are.
 * - The Claude login, read-write and *shared*, for the reason a sandbox shares
 *   it: an OAuth refresh token rotates and is single-use, so two copies
 *   invalidate each other the first time either refreshes — and Claude Code
 *   reports that by blanking its own file rather than by failing loudly.
 */

import type { Docker } from "../docker.js";
import { CREDENTIALS_ENV, hostClaudeCredentials } from "../agent/credentials.js";
import { NETWORK } from "../naming.js";
import { isInside, paths } from "../paths.js";
import { installRoot } from "../install.js";
import { CREDENTIALS_FILE } from "../agent/credentials.js";

export const ORCHESTRATOR_CONTAINER = "sandboxr-orchestrator";

/** The image, built from `container/orchestrator/Dockerfile`. */
export const ORCHESTRATOR_IMAGE_NAME = "sandboxr/orchestrator";

export interface OrchestratorInput {
  /** The host path of the Claude login. Without one the agent cannot run at all. */
  claudeCredentials?: string | undefined;
  env?: NodeJS.ProcessEnv | undefined;
  image?: string | undefined;
}

/**
 * The `docker run` argument list. Pure, so a test can read every mount and
 * variable without a daemon.
 *
 * The command is a sleep, and that is the whole design: nothing runs here until
 * the dashboard execs a `claude` into it. A container that ran the agent as its
 * entrypoint would be one conversation, ended by every restart; execing into an
 * idle container means the agent's lifetime is the conversation's, not the
 * container's.
 */
export function orchestratorArgs(input: OrchestratorInput): string[] {
  const env = input.env ?? process.env;
  const p = paths(env);
  const install = installRoot(env);

  const args = [
    "run",
    "-d",
    "--name",
    ORCHESTRATOR_CONTAINER,
    "--network",
    NETWORK,
    "--restart",
    "unless-stopped",
    "--label",
    "sandboxr.role=orchestrator",
  ];

  args.push("-v", "/var/run/docker.sock:/var/run/docker.sock");
  // Mounted at the identical path inside and out, like the dashboard's, because
  // a worktree records an absolute path back to its repository and the CLI hands
  // the same path to `docker run` on the host.
  args.push("-v", `${p.home}:${p.home}`);
  args.push("-v", `${install}:${install}:ro`);
  if (!isInside(p.workspace, p.home)) args.push("-v", `${p.workspace}:${p.workspace}`);
  // The login. No file, no mount: Docker does not refuse a bind whose source is
  // missing, it silently creates a *directory* there — and the host would be left
  // with a directory where its credential used to be.
  if (input.claudeCredentials) args.push("-v", `${input.claudeCredentials}:${CREDENTIALS_FILE}`);

  // The setup token, when the machine has one.
  //
  // **On macOS this is usually the only credential that works**, and the mount
  // above is not a substitute: the login lives in the login keychain, so
  // `~/.claude/.credentials.json` is either absent or — as on a machine that has
  // authorised an MCP server — a file holding *those* tokens and no account
  // login at all. A container cannot read a keychain, so `claude setup-token` on
  // the host is the route in. Claude Code ranks an explicit token above a stored
  // login, so passing both is safe and the token wins.
  const token = (env.SANDBOXR_CLAUDE_TOKEN ?? env.CLAUDE_CODE_OAUTH_TOKEN ?? "").trim();

  for (const [key, value] of Object.entries({
    SANDBOXR_HOME: p.home,
    SANDBOXR_DOCKER_SOCKET: "/var/run/docker.sock",
    ...(token ? { CLAUDE_CODE_OAUTH_TOKEN: token } : {}),
    // Claude Code checks CI to decide whether it may prompt. A session on the end
    // of a pipe cannot, and saying so up front avoids a first turn spent finding
    // that out.
    CI: "true",
    TERM: "dumb",
    ...(input.claudeCredentials ? { [CREDENTIALS_ENV]: input.claudeCredentials } : {}),
  })) {
    args.push("-e", `${key}=${value}`);
  }

  args.push("--workdir", p.workspace);
  args.push(input.image ?? env.SANDBOXR_ORCHESTRATOR_IMAGE ?? `${ORCHESTRATOR_IMAGE_NAME}:latest`);
  // Idle. The agent is execed in; see the note on the command above.
  args.push("sleep", "infinity");
  return args;
}

export interface StartOrchestratorOptions extends OrchestratorInput {
  docker: Docker;
  log?: ((line: string) => void) | undefined;
}

/**
 * Starts the orchestrator container, replacing any earlier one.
 *
 * Replaced rather than reused for the reason the dashboard is: the mounts and
 * the credential path are fixed at `docker run` time, and both can change
 * between two `init` runs.
 */
export async function startOrchestrator(options: StartOrchestratorOptions): Promise<void> {
  const { docker } = options;
  const log = options.log ?? (() => undefined);
  const env = options.env ?? process.env;
  const claudeCredentials = options.claudeCredentials ?? hostClaudeCredentials(env);

  if (!claudeCredentials) {
    // Said rather than guessed at: without a login the agent starts and then
    // fails its first request with an auth error the browser cannot explain.
    log("No Claude login on this machine, so the orchestrator agent has no credential to run on.");
  }

  await docker.rm(ORCHESTRATOR_CONTAINER).catch(() => undefined);
  await docker.ok(orchestratorArgs({ ...options, env, ...(claudeCredentials ? { claudeCredentials } : {}) }));
  log("Orchestrator started");
}

export async function stopOrchestrator(docker: Docker): Promise<void> {
  await docker.rm(ORCHESTRATOR_CONTAINER).catch(() => undefined);
}
