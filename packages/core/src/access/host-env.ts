/**
 * The values only the *host* can resolve, written to a file a compose file can
 * read.
 *
 * `docker-compose.yml` at the top of this repository runs the same constellation
 * `init` does — the router, the dashboard, the orchestrator — and the division
 * between them is stated in contracts §11: **compose owns the shape, core owns
 * the values.** Everything in that file is either a constant core also names or a
 * `${…}` out of the operator's `.env`.
 *
 * That division has exactly one hole, and this module is it. Four of the
 * dashboard's variables are not settings anybody types; they are facts about the
 * machine that something has to go and *look up*, and only a process on the host
 * can:
 *
 * - `GH_TOKEN`, because on macOS `gh` keeps it in the login keychain and only
 *   `gh auth token` can read it out. A container cannot open a keychain.
 * - `GIT_AUTHOR_NAME` and `GIT_AUTHOR_EMAIL`, because the dashboard's `$HOME` is
 *   not the person's and it has no gitconfig of its own to read.
 * - `SANDBOXR_CLAUDE_CREDENTIALS`, because it is a path on the host filesystem,
 *   which the dashboard cannot see to resolve.
 *
 * `startDashboard` already resolves all of them at `docker run` time. This writes
 * the same ones, from the same functions, to `$SANDBOXR_HOME/host.env`, so the
 * compose deployment gets them from core rather than from a second lookup written
 * in YAML that could not do the lookup anyway.
 *
 * **Mode 0600, because it holds a GitHub token**, like `secrets/<project>.env`.
 *
 * **`CLAUDE_CODE_OAUTH_TOKEN` is in here and it is not a fifth fact.** It is
 * `SANDBOXR_CLAUDE_TOKEN` under the name Claude Code itself reads, which is the
 * rename `orchestratorArgs` already does in code; doing it here means the compose
 * file does not have to. Both services load this file, so the dashboard sees that
 * token under two names — the same secret it is already given as
 * `SANDBOXR_CLAUDE_TOKEN` (see `FORWARDED_VARIABLES`), not a new one. The login
 * this package is careful to keep out of the web server is the *credentials
 * file*, and that is still only ever a path here and a mount there.
 */

import { chmod, writeFile } from "node:fs/promises";

import { CREDENTIALS_ENV } from "../agent/credentials.js";
import type { GitIdentity } from "../git.js";
import { paths } from "../paths.js";

export class HostEnvError extends Error {
  override readonly name = "HostEnvError";
}

export interface HostFacts {
  /** The GitHub token, from the environment or the keychain. */
  ghToken?: string | undefined;
  /** The identity a commit made in a sandbox is by. */
  gitIdentity?: GitIdentity | undefined;
  /** The host path of the Claude login. */
  claudeCredentials?: string | undefined;
  /** The setup token, written under Claude Code's own name for it. */
  claudeToken?: string | undefined;
}

/**
 * The file's keys, in the order they are written.
 *
 * Fixed rather than derived from the object, so two runs on one machine produce
 * the same file and reading a diff of it means something.
 */
export const HOST_ENV_KEYS = [
  "GH_TOKEN",
  "GIT_AUTHOR_NAME",
  "GIT_AUTHOR_EMAIL",
  CREDENTIALS_ENV,
  "CLAUDE_CODE_OAUTH_TOKEN",
] as const;

/**
 * The facts as environment entries.
 *
 * Absent ones are left out rather than written empty, for the reason
 * `forwardedEnvironment` gives: the server's own default has to stay reachable,
 * and "this machine has no token" must not read as "the token is the empty
 * string".
 */
export function hostEnvironment(facts: HostFacts): Record<string, string> {
  const held: Record<string, string> = {};
  const set = (key: string, value: string | undefined): void => {
    if (value !== undefined && value.trim() !== "") held[key] = value;
  };
  set("GH_TOKEN", facts.ghToken);
  set("GIT_AUTHOR_NAME", facts.gitIdentity?.name);
  set("GIT_AUTHOR_EMAIL", facts.gitIdentity?.email);
  set(CREDENTIALS_ENV, facts.claudeCredentials);
  set("CLAUDE_CODE_OAUTH_TOKEN", facts.claudeToken);
  return held;
}

/**
 * The file's contents: a header, then one `KEY="value"` line per fact.
 *
 * Double-quoted rather than bare, because a bare value loses everything from an
 * unescaped ` #` onwards and a commit identity is exactly the sort of string with
 * spaces in it. Inside the quotes only `\` and `"` need escaping — and a newline
 * is refused rather than escaped, because a value carrying one would make the rest
 * of the file parse as something nobody wrote.
 */
export function formatHostEnv(values: Record<string, string>): string {
  const lines = [
    "# Written by `sandboxr init`. Edits are lost on the next run.",
    "#",
    "# The values only the host can resolve — the keychain's GitHub token, this",
    "# machine's commit identity, the path of the Claude login. docker-compose.yml",
    "# reads it as an env_file. See packages/core/src/access/host-env.ts.",
  ];
  for (const key of HOST_ENV_KEYS) {
    const value = values[key];
    if (value === undefined) continue;
    if (/[\r\n]/.test(value)) {
      throw new HostEnvError(`${key} contains a newline, which cannot be written to an env file`);
    }
    lines.push(`${key}="${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`);
  }
  return `${lines.join("\n")}\n`;
}

export interface WriteHostEnvOptions {
  facts: HostFacts;
  env?: NodeJS.ProcessEnv | undefined;
}

/** Writes `$SANDBOXR_HOME/host.env` and returns its path. */
export async function writeHostEnv(options: WriteHostEnvOptions): Promise<string> {
  const file = paths(options.env ?? process.env).hostEnvFile;
  await writeFile(file, formatHostEnv(hostEnvironment(options.facts)), "utf8");
  await chmod(file, 0o600);
  return file;
}
