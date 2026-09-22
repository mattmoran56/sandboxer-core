/**
 * The values only the *host* can resolve, written to a file a compose file can
 * read.
 *
 * A product deploying the constellation `init` prepares — the router, its own
 * control plane, whatever else it runs — describes it in a compose file of its
 * own, and the division between that file and this code is stated in Jef's §8:
 * **compose owns the shape, core owns the values.** Everything in such a file is
 * either a constant core also names or a `${…}` out of the operator's `.env`.
 * **The engine ships no compose file**; it ships the half of the pair that a
 * compose file cannot write for itself.
 *
 * That division has exactly one hole, and this module is it. Some of a
 * front end's variables are not settings anybody types; they are facts about the
 * machine that something has to go and *look up*, and only a process on the host
 * can. The engine owns three of them:
 *
 * - `GH_TOKEN`, because on macOS `gh` keeps it in the login keychain and only
 *   `gh auth token` can read it out. A container cannot open a keychain.
 * - `GIT_AUTHOR_NAME` and `GIT_AUTHOR_EMAIL`, because a front end's `$HOME` is
 *   not the person's and it has no gitconfig of its own to read.
 *
 * An embedder starting its front end with `docker run` resolves all three at
 * that moment, from the functions below. This writes the same ones to
 * `$SANDBOXER_HOME/host.env`, so a compose deployment gets them from core rather
 * than from a second lookup written in YAML that could not do the lookup
 * anyway.
 *
 * **The embedder owns its own values.** `hostEnvironment(facts, extra)` appends
 * whatever keys the caller names, sorted, and they go through the same quoting
 * and the same newline refusal. Jef passes two of its own: a path on the host
 * filesystem that its dashboard container cannot see to resolve, and a setup
 * token under the name the tool that reads it expects. Neither is a fact about a
 * *sandbox*, and the engine has no business naming either; what it owns is the
 * file and the rule that writing it is safe.
 *
 * So that division gains a clause: compose owns the shape, core owns the
 * values, **and the embedder owns its own values**.
 *
 * **Mode 0600, because it holds a GitHub token**, like `secrets/<project>.env`.
 */

import { chmod, writeFile } from "node:fs/promises";

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
}

/**
 * The engine's own keys, in the order they are written.
 *
 * Fixed rather than derived from the object, so two runs on one machine produce
 * the same file and reading a diff of it means something. An embedder's keys
 * follow these, sorted, for the same reason.
 */
export const HOST_ENV_KEYS = ["GH_TOKEN", "GIT_AUTHOR_NAME", "GIT_AUTHOR_EMAIL"] as const;

/**
 * The facts as environment entries, plus whatever the embedder named.
 *
 * Absent ones are left out rather than written empty, for the reason
 * `forwardedEnvironment` gives: the server's own default has to stay reachable,
 * and "this machine has no token" must not read as "the token is the empty
 * string". An `extra` value that is empty or blank is dropped on the same terms.
 *
 * An extra key that collides with one of the engine's wins, deliberately: an
 * embedder that names `GH_TOKEN` knows something the engine's own lookup does
 * not, and silently discarding it would leave a fact on the floor with no
 * symptom until a push failed.
 */
export function hostEnvironment(facts: HostFacts, extra: Record<string, string | undefined> = {}): Record<string, string> {
  const held: Record<string, string> = {};
  const set = (key: string, value: string | undefined): void => {
    if (value !== undefined && value.trim() !== "") held[key] = value;
  };
  set("GH_TOKEN", facts.ghToken);
  set("GIT_AUTHOR_NAME", facts.gitIdentity?.name);
  set("GIT_AUTHOR_EMAIL", facts.gitIdentity?.email);
  for (const key of Object.keys(extra).sort()) set(key, extra[key]);
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
    "# Written by `sandboxer init`. Edits are lost on the next run.",
    "#",
    "# The values only the host can resolve — the keychain's GitHub token, this",
    "# machine's commit identity, and whatever else the tool that ran `init` had",
    "# to look up here. A compose deployment reads it as an env_file.",
    "# See packages/core/src/access/host-env.ts.",
  ];
  // The engine's keys first, in their fixed order; then the embedder's, sorted.
  // Both are stable, so two runs on one machine produce the same file.
  const rest = Object.keys(values)
    .filter((key) => !(HOST_ENV_KEYS as readonly string[]).includes(key))
    .sort();
  for (const key of [...HOST_ENV_KEYS, ...rest]) {
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
  /** Keys only the embedder can name — see the note at the top of this file. */
  extra?: Record<string, string | undefined> | undefined;
  env?: NodeJS.ProcessEnv | undefined;
}

/** Writes `$SANDBOXER_HOME/host.env` and returns its path. */
export async function writeHostEnv(options: WriteHostEnvOptions): Promise<string> {
  const file = paths(options.env ?? process.env).hostEnvFile;
  await writeFile(file, formatHostEnv(hostEnvironment(options.facts, options.extra ?? {})), "utf8");
  await chmod(file, 0o600);
  return file;
}
