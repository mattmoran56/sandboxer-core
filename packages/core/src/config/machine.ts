/**
 * `~/.sandboxr/config.yaml` — the machine's own settings, not a project's.
 *
 * `sandboxr.yaml` (see ./schema.ts) belongs to the project being sandboxed and
 * is versioned with its code. This file belongs to the machine sandboxr runs
 * on, and holds the one thing that is a property of the machine rather than of
 * any project: how long a sandbox may sit unused before it is stopped. A laptop
 * and a shared server want different answers to that, and neither answer
 * belongs in somebody's repository.
 *
 * ```yaml
 * ttl: 12h
 * projects:
 *   acme: { ttl: 3d }
 * ```
 *
 * Two rules, both about not destroying work:
 *
 * - **A missing file is not an error.** It means the built-in defaults, which is
 *   what every machine that has never been configured is asking for.
 * - **A malformed file is an error**, reported by name with the path. The
 *   tempting alternative — warn and fall back to the default — silently applies
 *   a lifetime nobody chose to a machine where somebody has just written down
 *   the lifetime they wanted. That is how a `3d` that was really `3D` ends up
 *   stopping a week of work after twelve hours.
 */

import { readFile, writeFile } from "node:fs/promises";
import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";

import { parse as parseYaml } from "yaml";
import { z } from "zod";

import { paths } from "../paths.js";
import { parseTtl } from "../sandbox/expiry.js";
import { ConfigError } from "./load.js";

/**
 * How long a sandbox may sit unused when nothing says otherwise.
 *
 * Twelve hours, so a sandbox started in the morning is still there after lunch
 * and one left running overnight is not.
 */
export const DEFAULT_TTL = "12h";

const ttlField = z.string().refine((value) => parseTtl(value) !== undefined, {
  message: "must be a lifetime like 30m, 12h, 3d, a number of seconds, or never",
});

/**
 * Strict, like the project schema and for the same reason: a misspelled key in
 * a file that decides when containers stop must be an error naming the key, not
 * a setting that quietly does nothing.
 */
export const machineConfigSchema = z.strictObject({
  ttl: ttlField.optional(),
  projects: z.record(z.string(), z.strictObject({ ttl: ttlField.optional() })).optional(),
});

/**
 * The file as written, with every field still optional.
 *
 * Deliberately not defaulted at parse time: `resolveTtl` has to be able to tell
 * "the file said 12h" from "the file said nothing", because an environment
 * variable sits between those two answers.
 */
export type MachineConfig = z.infer<typeof machineConfigSchema>;

/** The commented file `init` writes, and the documentation of record for it. */
export const MACHINE_CONFIG_EXAMPLE = `# sandboxr, machine settings. Edit freely — nothing regenerates this file.
#
# How long a sandbox may sit unused before it is stopped. The clock runs from
# the last request that reached it through the router, so a sandbox somebody is
# using never runs out; one nobody has opened since this morning does.
#
# An expired sandbox is stopped, never deleted: its database and its uploads are
# still there, and \`sandboxr start <slug>\` brings it back in seconds.
#
# Forms: 30m, 12h, 3d, a plain number of seconds, or never.
ttl: 12h

# Per project, for the ones that want a different answer. Optional — remove the
# whole block if every project on this machine is the same.
#projects:
#  acme: { ttl: 3d }
#  demo: { ttl: never }
`;

/**
 * The machine's settings, or the defaults when there is no file.
 *
 * Throws a `ConfigError` naming the path for anything that is present but
 * unreadable — see the note at the top of the file.
 */
export async function loadMachineConfig(env: NodeJS.ProcessEnv = process.env): Promise<MachineConfig> {
  const file = paths(env).configFile;

  let text: string;
  try {
    text = await readFile(file, "utf8");
  } catch (error) {
    // Only "there is no file" is an absent config. A file that exists and
    // cannot be read — wrong owner, wrong mode — is a real failure, and
    // treating it as "unconfigured" would apply defaults to a machine that is
    // configured and just not letting us see how.
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
    throw new ConfigError(file, (error as Error).message);
  }

  let parsed: unknown;
  try {
    parsed = parseYaml(text);
  } catch (error) {
    throw new ConfigError(file, (error as Error).message);
  }

  // An empty file parses to null, and means the same as no file at all.
  if (parsed === null || parsed === undefined) return {};

  const result = machineConfigSchema.safeParse(parsed);
  if (!result.success) {
    const issue = result.error.issues[0];
    const field = issue && issue.path.length > 0 ? issue.path.map(String).join(".") : undefined;
    throw new ConfigError(file, issue?.message ?? "is not valid", field);
  }
  return result.data;
}

export interface TtlInput {
  /** What the command was given, if anything. `--ttl`, or the dashboard's field. */
  explicit?: string | undefined;
  /** Which project the sandbox belongs to, for the per-project entry. */
  project?: string | undefined;
  config?: MachineConfig | undefined;
  env?: NodeJS.ProcessEnv | undefined;
}

/**
 * The lifetime a sandbox should be labelled with.
 *
 * Precedence, most specific first — the order is the contract and is documented
 * in docs/reference/environment.md:
 *
 * 1. what the command was told (`--ttl`)
 * 2. the project's entry in `config.yaml`
 * 3. the file's top-level `ttl`
 * 4. `SANDBOXR_TTL_HOURS`, which is what a service unit sets
 * 5. the built-in `DEFAULT_TTL`
 *
 * The environment variable sits *below* the file on purpose. It is set once by
 * whoever installed the service and then forgotten; the file is what somebody
 * edits when they want a different answer, and an edit that loses to a variable
 * nobody remembers setting is the worst kind of not working.
 */
export function resolveTtl(input: TtlInput = {}): string {
  const explicit = input.explicit?.trim();
  if (explicit !== undefined && explicit !== "") return explicit;

  const config = input.config ?? {};
  const forProject = input.project === undefined ? undefined : config.projects?.[input.project]?.ttl;
  if (forProject !== undefined) return forProject;
  if (config.ttl !== undefined) return config.ttl;

  const hours = (input.env ?? process.env).SANDBOXR_TTL_HOURS;
  if (hours !== undefined && hours.trim() !== "") {
    const candidate = `${hours.trim()}h`;
    // An unreadable variable falls through to the default rather than failing
    // the start. Unlike the file, nobody has just typed this: it comes from a
    // unit file written months ago, and refusing to start a sandbox over it
    // would be a surprising place to discover the typo.
    if (parseTtl(candidate) !== undefined) return candidate;
  }

  return DEFAULT_TTL;
}

/**
 * Writes the commented example, unless there is already a file.
 *
 * Returns the path when it wrote one, so `init` can say so — a config file
 * nobody knows exists is one nobody edits. An existing file is never touched,
 * whatever is in it.
 */
export async function writeMachineConfigExample(env: NodeJS.ProcessEnv = process.env): Promise<string | undefined> {
  const file = paths(env).configFile;
  await mkdir(dirname(file), { recursive: true });
  try {
    // `wx` rather than a stat first: two `init` runs at once would both see no
    // file and the second would overwrite the first's — and this file is one
    // somebody may have edited between them.
    await writeFile(file, MACHINE_CONFIG_EXAMPLE, { encoding: "utf8", flag: "wx" });
    return file;
  } catch {
    return undefined;
  }
}
