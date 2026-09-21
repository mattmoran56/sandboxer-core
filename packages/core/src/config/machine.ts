/**
 * `~/.sandboxr/config.yaml` — the machine's own settings, not a project's.
 *
 * `sandboxr.yaml` (see ./schema.ts) belongs to the project being sandboxed and
 * is versioned with its code. This file belongs to the machine sandboxr runs
 * on, and holds what is a property of the machine rather than of any project:
 * how long a sandbox may sit unused before it is stopped, and which projects may
 * be handed this machine's own credentials. A laptop and a shared server want
 * different answers to both, and neither answer belongs in somebody's
 * repository.
 *
 * ```yaml
 * ttl: 12h
 * github: none
 * share:
 *   - host: ~/.claude/.credentials.json
 *     into: /root/.claude/.credentials.json
 * projects:
 *   acme-monorepo: { ttl: 3d, github: token }
 * ```
 *
 * A `projects:` key is a project's **workspace directory name** or the
 * `project:` its `sandboxr.yaml` declares — either will do, directory first.
 * The example above is written with the two spelled differently on purpose: an
 * example where they agree is what let this file's lookup match one name for a
 * year without anybody noticing. See `projectEntry`.
 *
 * `share:` is here for the same reason `github:` is, and the reason is below:
 * these are the *operator's* files, and which of them every sandbox on the
 * machine may read is the machine's decision.
 *
 * `github:` is here, and not in `sandboxr.yaml`, on purpose. The token is the
 * *operator's*, not the project's, and a setting that lives in a repository is a
 * setting a repository can ask for — clone something, start a sandbox, and its
 * committed config has helped itself to a credential that reaches every
 * repository you can push to. The machine decides which projects it trusts with
 * its own credentials; a project never votes on that.
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

import { statSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";

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
 * Whether a sandbox is handed this machine's GitHub token.
 *
 * A closed set rather than a boolean, so the day a project is given a scoped
 * app installation instead of the operator's own token, the third value has
 * somewhere to go and the file does not have to change shape.
 */
export const GITHUB_MODES = ["none", "token"] as const;
export type GithubMode = (typeof GITHUB_MODES)[number];

/**
 * Off, and deliberately off by default.
 *
 * `gh auth token` on a developer's laptop is usually a credential with `repo`
 * across *every* repository they can reach — not this project's. Handing that
 * to every sandbox on the machine means anything running in one, including a
 * dependency's install script and an agent executing the branch's own code, can
 * push and open pull requests as them. `DEFAULT_ALLOWED_TOOLS` in
 * ../agent/launch.ts already draws this line for a session's commands: inside a
 * sandbox everything is recoverable by deleting it, "and that stops being true
 * the moment a command reaches the network with the person's credentials".
 *
 * So the widening is opt-in. Forgetting to opt in used to cost a silence: `git
 * commit` works inside a sandbox whatever this says, so nothing was wrong until
 * a `git push` failed hours later, inside an agent session. `up` now says on
 * every start where this resolves to `none` that the sandbox has no token and
 * which key would give it one — see ../sandbox/index.ts.
 */
export const DEFAULT_GITHUB: GithubMode = "none";

const githubField = z.enum(GITHUB_MODES);

/**
 * Strict, like the project schema and for the same reason: a misspelled key in
 * a file that decides when containers stop must be an error naming the key, not
 * a setting that quietly does nothing.
 */
export const sharedFileSchema = z.strictObject({
  /** A path on this machine. `~` expands to `$HOME`. */
  host: z.string().min(1),
  /** Where it appears inside every sandbox. Absolute. */
  into: z.string().min(1).startsWith("/", { message: "must be an absolute path inside the container" }),
});

/** One host file, bind-mounted into every sandbox this machine starts (§4.3). */
export type SharedFile = z.infer<typeof sharedFileSchema>;

export const machineConfigSchema = z.strictObject({
  ttl: ttlField.optional(),
  github: githubField.optional(),
  share: z.array(sharedFileSchema).optional(),
  projects: z
    .record(z.string(), z.strictObject({ ttl: ttlField.optional(), github: githubField.optional() }))
    .optional(),
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

# Whether a sandbox is handed this machine's GitHub token, so that \`gh\` and
# \`git push\` work inside it and an agent can open a pull request.
#
# \`none\` (the default) or \`token\`. \`token\` means the credential \`gh auth token\`
# prints here — usually one that can push to every repository you can — is in
# the environment of every process in that project's sandboxes, the project's
# own code included. That is a real widening, which is why it is off until you
# say otherwise, and why it is set per project rather than machine-wide.
#
# git itself works either way: a sandbox can always commit to its own worktree.
#
# Note that a session also has to be allowed to run \`git push\` and \`gh\`: neither
# is in the default allowlist, so a token on its own is not enough.
github: none

# Files on this machine that every sandbox can read, bind-mounted one at a time.
#
# This is how a login you already have — a Claude credential, an .npmrc, a
# read-only deploy key — reaches the containers without being copied into an
# image or typed into a project's secrets. \`~\` expands.
#
# One file per row, never a directory. Mounting a directory hands every sandbox
# everything else in it, and for a tool's config directory that usually includes
# settings the host itself executes.
#
# A row whose \`host:\` is missing, or empty, is skipped rather than mounted:
# Docker answers a missing bind source by creating a *directory* at that path on
# the host, and an empty file mounted over a container's working copy replaces a
# credential with nothing.
#share:
#  - host: ~/.claude/.credentials.json
#    into: /root/.claude/.credentials.json

# Per project, for the ones that want a different answer. Optional — remove the
# whole block if every project on this machine is the same.
#
# The key is a project's directory in the workspace — the name the dashboard
# shows and every URL uses — or the \`project:\` its own sandboxr.yaml declares.
# Either works; the directory wins if a machine has both. A key matching neither
# does nothing at all, so \`sandboxr doctor\` names one it cannot match.
#projects:
#  acme-monorepo: { ttl: 3d, github: token }
#  demo: { ttl: never }
`;

/**
 * The `share:` rows this machine can actually honour, with `~` expanded.
 *
 * The disk-touching is here rather than in ../sandbox/run.ts, which is
 * deliberately a pure function over an input record so that every mount can be
 * asserted without a daemon and without touching disk. Same division as
 * `gitMounts` and `hostGitIdentity` in ../git.ts.
 *
 * **Two guards that look like belt-and-braces and are not.** Both were learned
 * from the Claude credential this key replaced, and both generalise:
 *
 * **The file has to be there.** Docker does not refuse a bind whose source is
 * missing — it silently creates a *directory* at that path on the host and
 * mounts that. Whatever was supposed to read the file then fails with a message
 * naming neither Docker nor the mount, and the host is left with a directory
 * where its own file used to be.
 *
 * **The file has to be non-empty.** A zero-byte file mounted over a container's
 * working copy replaces something with nothing, and the failure looks nothing
 * like its cause. The incident: on macOS `~/.claude/.credentials.json` is often
 * an empty placeholder, because the account login is in the keychain. Mounted,
 * it made Claude Code report `Not logged in` inside every sandbox on the
 * machine — with a valid credential sitting on the host the whole time.
 * Observed, not feared.
 *
 * Size, never contents. sandboxr has no reason to read a file somebody asked it
 * to share, and does not.
 *
 * A row that is skipped is skipped silently and one at a time. The alternative —
 * refusing to start — would mean a machine could not run a sandbox because an
 * operator's `.npmrc` had been tidied away, which is not a fault of the sandbox.
 */
export function sharedFiles(config: MachineConfig, env: NodeJS.ProcessEnv = process.env): SharedFile[] {
  const home = env.HOME?.trim();
  const out: SharedFile[] = [];
  for (const row of config.share ?? []) {
    const host = row.host.startsWith("~/") && home ? join(home, row.host.slice(2)) : row.host;
    try {
      const stat = statSync(host);
      if (!stat.isFile() || stat.size === 0) continue;
    } catch {
      // No file, or a path this process may not stat. Either way there is
      // nothing to share.
      continue;
    }
    out.push({ host, into: row.into });
  }
  return out;
}

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

/** One project's settings, as `projects:` holds them. */
export type MachineProjectEntry = NonNullable<MachineConfig["projects"]>[string];

/**
 * Which project a `projects:` entry is being looked up for.
 *
 * **A project has two names and an operator sees the wrong one.** §3 and §4.1:
 * the workspace *directory* is what the dashboard lists, what every URL carries
 * and what is on disk, while the `project:` in that repo's `sandboxr.yaml` is
 * what hostnames, container names and labels are built from. They are allowed to
 * differ, and on any repository whose directory is `acme-monorepo` and whose
 * config says `project: acme`, they do.
 *
 * This used to be looked up on the declared name alone, and that is the bug this
 * type exists to close: an operator whose workspace holds `acme-monorepo` wrote
 * `acme:` — the only name anything had ever shown them — and got nothing. Not an
 * error, not a warning: the entry matched no project, so every project fell
 * through to the machine-wide value, and the first symptom was an agent three
 * commands in saying it could not push. The cause did not resemble the symptom
 * at all.
 *
 * So **either name is a key**, directory first. `projectFor` in
 * packages/web/src/lib/group.ts already resolves a project by either name, so
 * matching on one here made the product disagree with itself.
 */
export interface ProjectKey {
  /** The `project:` the repo's own `sandboxr.yaml` declares (§5). */
  project?: string | undefined;
  /** The workspace directory name (§4.1), when the project is a managed one. */
  directory?: string | undefined;
  /**
   * Every project directory in the workspace, when the caller can see it.
   *
   * Only used to settle a collision — a key that is *some other* project's
   * directory name. See `projectEntry`. A caller with no view of the workspace
   * omits it and gets the plain two-step.
   */
  directories?: readonly string[] | undefined;
}

/** A `projects:` entry, and which of the project's two names found it. */
export interface ProjectEntryMatch {
  /** The key as written in `config.yaml`. Worth quoting back at somebody. */
  key: string;
  entry: MachineProjectEntry;
  via: "directory" | "project";
}

/**
 * The `projects:` entry that governs a project, or undefined when none does.
 *
 * The directory name is checked first and the declared name second, and that
 * order is the contract (§4.3). The directory is the key an operator can see
 * without opening a file, so it is the one a key is presumed to mean.
 *
 * **The collision, and why the directory wins it.** Two projects may disagree:
 * `acme` is one project's directory *and* another project's declared
 * `project:`. A key of `acme` then reads as both. It resolves to the project
 * whose *directory* it is, and never reaches the other one — because the
 * operator who typed it was looking at a list of directories, and because the
 * failure of guessing wrong is not symmetric: guessing wrong about `github:`
 * hands one project's opt-in to a repository nobody opted in. A caller that
 * cannot see the workspace cannot detect the collision and takes the two-step;
 * `up` and the dashboard can, and pass `directories`.
 */
export function projectEntry(
  config: MachineConfig | undefined,
  key: ProjectKey,
): ProjectEntryMatch | undefined {
  const entries = config?.projects;
  if (entries === undefined) return undefined;

  const { directory, project, directories } = key;

  if (directory !== undefined) {
    const entry = entries[directory];
    if (entry !== undefined) return { key: directory, entry, via: "directory" };
  }

  if (project === undefined || project === directory) return undefined;
  // Owned by whichever project's directory it is, so not an alias for this one.
  if (directories?.includes(project) === true) return undefined;
  const entry = entries[project];
  return entry === undefined ? undefined : { key: project, entry, via: "project" };
}

export interface TtlInput extends ProjectKey {
  /** What the command was given, if anything. `--ttl`, or the dashboard's field. */
  explicit?: string | undefined;
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
 * 2. the project's entry in `config.yaml`, under either of its names (`projectEntry`)
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
  const forProject = projectEntry(config, input)?.entry.ttl;
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

/** A project this machine can see, by both of its names. */
export interface ProjectIdentity {
  /** The workspace directory name (§4.1). */
  directory: string;
  /** The `project:` its config declares, when that has been read. */
  project?: string | undefined;
}

/** What a `projects:` block looks like held up against the projects that exist. */
export interface MachineConfigReview {
  /** Keys naming no project this machine can see. */
  unmatched: string[];
  /** Keys that are one project's directory *and* another's declared name. */
  ambiguous: string[];
  /** Every name that would have matched, sorted — what to write instead. */
  known: string[];
}

/**
 * A `projects:` block checked against the projects that exist.
 *
 * **This is a warning and never an error, and that placement is the decision.**
 * `loadMachineConfig` refuses a malformed file, because a `3d` typed as `3D` is
 * a lifetime nobody chose being applied to a machine somebody has just
 * configured. A key naming a project that does not exist is the same class of
 * mistake and cannot take the same remedy: the file is machine-wide, so
 * refusing to load it over a stale entry for a project somebody deleted last
 * month would stop every *other* project on the machine starting. One dead line
 * would take the whole file down.
 *
 * It also cannot be answered where the file is read. `loadMachineConfig` knows
 * nothing about the workspace — it takes an environment and returns a document —
 * and asking it to walk the workspace would put a directory listing behind every
 * ttl lookup, including the ones inside the reaper's loop.
 *
 * So the question is asked by whoever can already see both halves: `sandboxr
 * doctor`, which exists to hold the machine up against its config and name the
 * fix, and `up`, which says it about the one project it is starting. Neither
 * refuses.
 *
 * `known` is deliberately every *matchable* name rather than a guess at what
 * was meant. The operator in the report that prompted this wrote a name that was
 * a plausible spelling of a real project; the useful reply is the list of names
 * that work, not a nearest-neighbour that might be wrong twice.
 *
 * `projects` is what the caller can see, which on a machine that runs sandboxes
 * from checkouts outside the workspace is not all of them. A key naming such a
 * project therefore reads as unmatched. That is the accepted cost of saying
 * anything at all: the alternative is the silence this exists to end, and the
 * message names the fix as "rename it or remove it" rather than asserting the
 * project does not exist.
 */
export function reviewProjectEntries(
  config: MachineConfig | undefined,
  projects: readonly ProjectIdentity[],
): MachineConfigReview {
  const directories = new Set(projects.map((project) => project.directory));
  const declared = new Set(
    projects.flatMap((project) => (project.project === undefined ? [] : [project.project])),
  );

  const keys = Object.keys(config?.projects ?? {});
  const unmatched = keys.filter((key) => !directories.has(key) && !declared.has(key));
  // Only a real collision — one project's directory that is *also* a different
  // project's declared name. A project whose two names agree is the ordinary
  // case and is not ambiguous with itself.
  const ambiguous = keys.filter(
    (key) =>
      directories.has(key) &&
      projects.some((project) => project.project === key && project.directory !== key),
  );

  const known = [...new Set([...directories, ...declared])].sort((a, b) => a.localeCompare(b));
  return { unmatched, ambiguous, known };
}

export interface GithubInput extends ProjectKey {
  config?: MachineConfig | undefined;
}

/** Where a resolved `github` came from, so a message can name it. */
export interface GithubDecision {
  mode: GithubMode;
  /** The `projects:` key that decided it, when one did. */
  key?: string | undefined;
  source: "project" | "machine" | "default";
}

/**
 * Whether this project's sandboxes may carry the machine's GitHub token.
 *
 * Precedence, most specific first, and the order is the contract (§4.3):
 *
 * 1. the project's entry in `config.yaml`, under *either* of its names — see
 *    `projectEntry`, which is where the bug this replaced lived
 * 2. the file's top-level `github`
 * 3. the built-in `DEFAULT_GITHUB`, which is `none`
 *
 * Deliberately shorter than `resolveTtl`'s ladder: there is no flag and no
 * environment variable. A lifetime is a scheduling preference and worth being
 * able to override per run; this is a decision about which code gets to act as
 * the person running it, and a decision like that should be written down in one
 * file that somebody can read, not settable by whatever started the process.
 */
export function resolveGithub(input: GithubInput = {}): GithubMode {
  return decideGithub(input).mode;
}

/**
 * The same answer, with the rung of the ladder that produced it.
 *
 * Split out rather than inlined at the one caller because the *reason* is what
 * a person needs: "off" is nearly always what somebody expects to be able to
 * change, and "off, and no line in your file mentions this project" is a
 * different instruction from "off, because your file's top-level `github` says
 * so". `up` prints one of those sentences; see ../sandbox/index.ts.
 */
export function decideGithub(input: GithubInput = {}): GithubDecision {
  const config = input.config ?? {};
  const match = projectEntry(config, input);
  if (match?.entry.github !== undefined) {
    return { mode: match.entry.github, key: match.key, source: "project" };
  }
  if (config.github !== undefined) return { mode: config.github, source: "machine" };
  return { mode: DEFAULT_GITHUB, source: "default" };
}
