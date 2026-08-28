/**
 * `~/.sandboxr/secrets/<project>.env` — a project's third-party credentials.
 *
 * Two ways in, one file. **Importing** builds it from the `.env` files a
 * developer already has, under the project's own rules (contracts §5.2): `keep`
 * is an allow-list of third-party credentials, `never` rejects anything
 * describing *where* something runs, and `rename` carries a value across to the
 * name the code actually reads. **Editing** authors it directly, which is the
 * only route that works when the value is on no file on this machine — a fresh
 * checkout of a project whose `.env` files are all `.env.example` has nothing to
 * import from, so nothing reaches a sandbox at all.
 *
 * Nothing here prints a value except `revealProjectSecret`, which exists to be
 * called by one person about one variable. An import reports a count and a list
 * of names, and so does `describeProjectSecrets`, so both are safe to run with
 * someone watching, to paste into a ticket, or to hand to an agent — the whole
 * point is that credentials go from one file on disk to another without passing
 * through a terminal.
 */

import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

import { allowsRealCredentials } from "./config/access.js";
import { projectPath } from "./config/load.js";
import type { ResolvedConfig } from "./config/types.js";
import { paths } from "./paths.js";

/** `NAME=value`, with an optional `export ` and surrounding whitespace. */
const LINE = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/;

export interface SecretRules {
  keep: string[];
  rename: Record<string, string>;
  never: string[];
}

export interface SecretsReport {
  file: string;
  /** Files that existed and were read. */
  sources: string[];
  /** Files named by the config that were not there. */
  missing: string[];
  /** Names imported. Never values. */
  names: string[];
  count: number;
}

export interface SecretsCheck {
  file: string;
  exists: boolean;
  /** Names from `keep` (and its rename targets) that the file carries. */
  present: string[];
  /** Names the config asks for that the file does not have. */
  absent: string[];
}

/**
 * Parses one .env file.
 *
 * Strips a single layer of matching quotes, and a trailing comment from an
 * unquoted value — which dotenv treats as part of the value and the services do
 * not. An empty value is dropped: a name present but blank is what a template
 * looks like, and importing it would mask a real value from a later file.
 */
export function parseEnvFile(text: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const raw of text.split("\n")) {
    if (raw.trim() === "" || raw.trimStart().startsWith("#")) continue;
    const match = LINE.exec(raw.replace(/\r$/, ""));
    if (!match) continue;

    const name = match[1] as string;
    let value = (match[2] ?? "").trim();

    const first = value[0];
    if (value.length >= 2 && first !== undefined && (first === '"' || first === "'") && value.endsWith(first)) {
      value = value.slice(1, -1);
    } else if (value.includes(" #")) {
      value = value.slice(0, value.indexOf(" #")).trim();
    }

    if (value === "") continue;
    out.set(name, value);
  }
  return out;
}

/**
 * Whether a name matches any of a set of glob patterns.
 *
 * Only `*` is meaningful, which is what the config's `never` list uses:
 * `DB_*`, `*_URL`, `PORT`. Everything else is matched literally, so a pattern
 * cannot accidentally become a regex.
 */
export function matchesAny(name: string, patterns: string[]): boolean {
  return patterns.some((pattern) => globToRegExp(pattern).test(name));
}

function globToRegExp(pattern: string): RegExp {
  const escaped = pattern.replace(/[.*+?^${}()|[\]\\]/g, (char) => (char === "*" ? "[\\s\\S]*" : `\\${char}`));
  return new RegExp(`^${escaped}$`);
}

/**
 * Applies the config's rules to a set of parsed files.
 *
 * Files are processed in order and a later file wins, which is how a front-end
 * .env is allowed to supply a name the backend's does not have.
 *
 * `rename` outranks `never`. The two exist for opposite reasons: `never` is a
 * pattern over the *shape* of a name, and `rename` is an explicit statement
 * about one name. A browser-side `VITE_..._URL` that the config renames is a
 * vendor setting the sandbox cannot invent, and matching it against `*_URL`
 * would drop it — while the pattern still has to catch every inter-service URL
 * nobody thought to list.
 */
export function filterSecrets(files: Array<Map<string, string>>, rules: SecretRules): Map<string, string> {
  const keep = new Set(rules.keep);
  const renameTargets = new Set(Object.values(rules.rename));
  const collected = new Map<string, string>();

  for (const file of files) {
    for (const [name, value] of file) {
      const renamed = Object.hasOwn(rules.rename, name);
      const target = renamed ? (rules.rename[name] as string) : name;

      // An explicit rename is its own permission: the author has named both the
      // source and the destination, so neither list gets a say.
      if (!renamed) {
        if (matchesAny(target, rules.never)) continue;
        if (!keep.has(target) && !renameTargets.has(target)) continue;
      }
      collected.set(target, value);
    }
  }
  return collected;
}

export interface SecretsOptions {
  env?: NodeJS.ProcessEnv | undefined;
  /** Where the .env files are read from, when it is not the project root. */
  from?: string | undefined;
}

/** The comment at the top of a secrets file, which is now a file people edit. */
function authoredHeader(project: string): string {
  return [
    `# ${project}'s third-party credentials, for sandboxr. Do not commit.`,
    "#",
    "# Edited by hand, by `sandboxr secrets set` or from the dashboard, and merged",
    "# into by `sandboxr secrets import`. Database, object storage and inter-service",
    "# URLs are not here: a sandbox computes those for itself.",
  ].join("\n");
}

/**
 * Writes a set of credentials as the project's secrets file.
 *
 * Written to a temporary name and moved into place, so an interrupted save
 * cannot leave a half-written credential file behind, and chmodded 0600 because
 * it is the one file sandboxr keeps that holds real values.
 *
 * The `mode` on `writeFile` and the `chmod` after the rename are not redundant:
 * `mode` only applies when the temporary file is *created*, so a leftover
 * `.partial` from an interrupted earlier save would otherwise keep whatever
 * permissions it had.
 */
export async function writeSecretsFile(
  file: string,
  secrets: Map<string, string>,
  header?: string,
): Promise<void> {
  const names = [...secrets.keys()].sort();
  const body = [...(header ? [header, ""] : []), ...names.map((name) => `${name}=${secrets.get(name) ?? ""}`), ""].join(
    "\n",
  );

  await mkdir(dirname(file), { recursive: true });
  const temporary = `${file}.partial`;
  await writeFile(temporary, body, { encoding: "utf8", mode: 0o600 });
  await rename(temporary, file);
  await chmod(file, 0o600);
}

/**
 * Reads the files the config names and merges them into the project's secrets
 * file.
 *
 * **A merge, not a replacement.** The file is something a person edits now — see
 * `editProjectSecrets` below — so an import that rewrote the whole file would
 * silently drop every credential that came from anywhere else, which for a
 * project with no `.env` on disk is all of them. `replace` asks for the old
 * behaviour, which is still the right one for rebuilding a file from scratch.
 */
export async function importSecrets(
  config: ResolvedConfig,
  options: SecretsOptions & { replace?: boolean | undefined } = {},
): Promise<SecretsReport> {
  const p = paths(options.env);
  const file = p.secretsFile(config.project);

  const sources: string[] = [];
  const missing: string[] = [];
  const parsed: Array<Map<string, string>> = [];

  for (const relative of config.secrets.read) {
    const path = options.from ? projectPath({ ...config, root: options.from }, relative) : projectPath(config, relative);
    let text: string;
    try {
      text = await readFile(path, "utf8");
    } catch {
      missing.push(path);
      continue;
    }
    sources.push(path);
    parsed.push(parseEnvFile(text));
  }

  const collected = filterSecrets(parsed, config.secrets);
  // `names` is what this import contributed, which is what the report is about.
  // The file may well end up holding more than that.
  const names = [...collected.keys()].sort();

  const merged =
    options.replace === true ? collected : new Map([...(await readProjectSecrets(config.project, options)), ...collected]);
  await writeSecretsFile(file, merged, authoredHeader(config.project));

  return { file, sources, missing, names, count: names.length };
}

/**
 * Reports which of the names a project asks for the secrets file does not have.
 *
 * Presence only — it never reads a value, so its output is safe to print.
 */
export async function checkSecrets(config: ResolvedConfig, options: SecretsOptions = {}): Promise<SecretsCheck> {
  const p = paths(options.env);
  const file = p.secretsFile(config.project);

  let text: string;
  try {
    text = await readFile(file, "utf8");
  } catch {
    return { file, exists: false, present: [], absent: declaredNames(config) };
  }

  const have = parseEnvFile(text);
  const present: string[] = [];
  const absent: string[] = [];
  for (const name of declaredNames(config)) {
    (have.has(name) ? present : absent).push(name);
  }
  return { file, exists: true, present, absent };
}

/**
 * The names a working sandbox is expected to carry: the `keep` list, with any
 * name the config renames replaced by the name it is renamed to.
 *
 * `keep` does double duty, and it is worth saying which two jobs. It is the
 * allow-list an *import* filters against, and it is the project's statement of
 * which credentials it needs at all — which is what this reads it as. The second
 * job is the one that matters most now: a front-end built without its API key
 * does not fail, it falls back to whatever its code defaults to, and a project
 * whose default is a production URL gets a disposable sandbox quietly talking to
 * production. So "declared and absent" has to be something a person is shown,
 * not something they discover.
 */
export function declaredNames(config: ResolvedConfig): string[] {
  const renamed = new Set(Object.keys(config.secrets.rename));
  const names = new Set<string>();
  for (const name of config.secrets.keep) if (!renamed.has(name)) names.add(name);
  for (const target of Object.values(config.secrets.rename)) names.add(target);
  return [...names].sort();
}

/* --- editing, rather than importing ------------------------------------------
 *
 * Everything above builds the secrets file *from* files a developer already has.
 * Everything below lets a person author it directly, which is the only route
 * that works when the value exists nowhere on the machine yet — a fresh checkout
 * has no `.env` for the service that needs the key, so there is nothing to
 * import from and nothing reaches the sandbox at all.
 *
 * The file is the same file. There is deliberately no second, hand-edited one
 * layered over the imported one: two files holding the same name is two answers
 * to "what is this project's API key", and the one that loses is invisible.
 * `importSecrets` therefore merges rather than replaces.
 */

/** A variable name a shell and every runtime will accept. */
const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

/**
 * The names the sandbox works out for itself, which a secrets file may not
 * supply.
 *
 * This list is the exact set `container/scripts/env.sh` derives, and it exists
 * because that file now reads the secrets file *first*, so a name here would win
 * where it previously lost. Before the secrets file was mounted it arrived as a
 * `--env-file` layered under the generated one, and Docker settled the argument;
 * nothing settles it now except this refusal.
 *
 * A project's own `SANDBOXR_`-prefixed names are fine and are not covered here —
 * `secrets.rename` in the example monorepo config deliberately renames a
 * browser-side Auth0 domain to `SANDBOXR_AUTH0_SPA_DOMAIN`, which is a value
 * only the project can supply.
 */
export const RESERVED_ENV_NAMES = [
  "SANDBOXR_SLUG",
  "SANDBOXR_PROJECT",
  "SANDBOXR_DOMAIN",
  "SANDBOXR_ACCESS",
  "SANDBOXR_SCHEME",
  "SANDBOXR_PUBLIC_PORT",
  "SANDBOXR_WITH",
  "SANDBOXR_SEED",
  "SANDBOXR_PLAN",
  "SANDBOXR_SCRIPTS",
  "SANDBOXR_SANDBOX",
  "SANDBOXR_ENV_READY",
] as const;

/** The families of derived name, which are open-ended and so matched by prefix. */
export const RESERVED_ENV_PREFIXES = [
  "SANDBOXR_DB_",
  "SANDBOXR_S3_",
  "SANDBOXR_D1_",
  "SANDBOXR_URL_",
  "SANDBOXR_PORT_",
] as const;

/** Whether the sandbox computes this name for itself. */
export function isReservedEnvName(name: string): boolean {
  return (
    (RESERVED_ENV_NAMES as readonly string[]).includes(name) ||
    RESERVED_ENV_PREFIXES.some((prefix) => name.startsWith(prefix))
  );
}

/**
 * Why this name and value may not go in a project's secrets file, or undefined.
 *
 * A phrase that completes "NAME …", naming what to do instead — the same shape
 * as `AccessViolation.fix` in ./config/access.ts, and for the same reason: the
 * message is shown to whoever typed the name, and "invalid" tells them nothing.
 *
 * `config` is optional because the dashboard cannot always read one. Without it
 * the shape, reserved-name and newline rules still apply; only the project's own
 * `never` patterns are unenforceable, and those are the rules that exist to
 * catch an *import*, where nobody typed the name on purpose.
 */
export function envNameRefusal(name: string, value: string, config?: ResolvedConfig | null): string | undefined {
  if (!ENV_NAME.test(name)) {
    return "is not a usable variable name — letters, digits and underscores, and not starting with a digit";
  }
  if (isReservedEnvName(name)) {
    return "is a name the sandbox works out for itself, so a value here would either be ignored or point the sandbox at something that is not its own";
  }
  // Newline, not whitespace: a value crosses into the container as one line of a
  // file read a line at a time, so a second line would silently become a
  // variable of its own or be dropped. `--env-file` could not carry one either.
  if (/[\r\n]/.test(value)) {
    return "may not contain a newline — a sandbox reads its environment one line at a time";
  }
  if (config) {
    const pattern = config.secrets.never.find((candidate) => matchesAny(name, [candidate]));
    if (pattern !== undefined) {
      return `matches this project's never pattern "${pattern}", which is there so that nothing describing where a service runs reaches a sandbox. Put it in secrets.rename in sandboxr.yaml if the project really needs it`;
    }
  }
  return undefined;
}

/**
 * One variable, as everything outside core is allowed to see it.
 *
 * No value, and that is the type doing the work rather than a convention: the
 * only function that returns a value is `revealProjectSecret`, so a route or a
 * view that never calls it cannot leak one by accident.
 */
export interface SecretVar {
  name: string;
  /** The last few characters, when there are enough of them to spare. */
  hint?: string;
  /** How long the value is, which is enough to spot a truncated paste. */
  chars: number;
}

export interface SecretsView {
  file: string;
  exists: boolean;
  /**
   * Whether this project may carry real credentials at all.
   *
   * False for public apps that have not opted in, which is the refusal `up`
   * raises (./config/access.ts). Said here as well so the answer arrives
   * *before* somebody types a key in, rather than as a failure to start
   * afterwards.
   */
  editable: boolean;
  /** True when a config was readable, so `editable` and `absent` mean something. */
  configKnown: boolean;
  vars: SecretVar[];
  /** Names the project declares it needs that the file does not have. */
  absent: string[];
}

/**
 * How much of a value may be shown without showing the value.
 *
 * Four characters, and only from a value long enough that four of them are not
 * most of it. The point is to tell two keys apart — "is this the one I rotated?"
 * — which the tail answers and a length alone does not.
 */
const HINT_CHARS = 4;
const HINT_MIN_LENGTH = 12;

export function hintFor(value: string): string | undefined {
  return value.length >= HINT_MIN_LENGTH ? value.slice(-HINT_CHARS) : undefined;
}

/** Reads a project's secrets file. An absent file is an empty map, not an error. */
export async function readProjectSecrets(
  project: string,
  options: SecretsOptions = {},
): Promise<Map<string, string>> {
  const file = paths(options.env).secretsFile(project);
  try {
    return parseEnvFile(await readFile(file, "utf8"));
  } catch {
    return new Map();
  }
}

/**
 * What a project's environment looks like, without any of it.
 *
 * `config` may be null: the dashboard reads a project's config best-effort, and
 * a project whose `sandboxr.yaml` it cannot reach still has a secrets file worth
 * editing. `configKnown` says which of the two happened, so a caller can say so
 * rather than presenting a guess as an answer.
 */
export async function describeProjectSecrets(
  project: string,
  config: ResolvedConfig | null,
  options: SecretsOptions = {},
): Promise<SecretsView> {
  const file = paths(options.env).secretsFile(project);
  const have = await readProjectSecrets(project, options);
  const declared = config ? declaredNames(config) : [];

  return {
    file,
    exists: have.size > 0 || existsSync(file),
    // Permissive when nothing is known: refusing to let somebody edit a file
    // because its project's config could not be read would turn an unreadable
    // config into a locked dashboard. `up` still enforces the real rule.
    editable: config ? allowsRealCredentials(config) : true,
    configKnown: config !== null,
    vars: [...have.keys()].sort().map((name) => {
      const value = have.get(name) ?? "";
      const hint = hintFor(value);
      return hint === undefined ? { name, chars: value.length } : { name, hint, chars: value.length };
    }),
    absent: declared.filter((name) => !have.has(name)),
  };
}

/**
 * One value, by name.
 *
 * The only function here that returns a credential. Separate from
 * `describeProjectSecrets` so that revealing one is a request of its own —
 * something a person did, to one variable, rather than a field that came along
 * with a list.
 */
export async function revealProjectSecret(
  project: string,
  name: string,
  options: SecretsOptions = {},
): Promise<string | undefined> {
  return (await readProjectSecrets(project, options)).get(name);
}

export interface SecretsEdit {
  /** Names to set to a value, replacing whatever the file had. */
  set?: Record<string, string> | undefined;
  /** Names to remove. Applied after `set`, so removing wins. */
  unset?: string[] | undefined;
  /** A whole `.env` to merge in, parsed by the same reader an import uses. */
  text?: string | undefined;
}

export interface SecretRefusal {
  name: string;
  reason: string;
}

export interface SecretsEditReport extends SecretsView {
  added: string[];
  updated: string[];
  removed: string[];
  /**
   * What was not applied, and why.
   *
   * Collected rather than thrown. A pasted `.env` is the case that decides this:
   * one `DB_HOST` in a file of twenty good names would otherwise lose the other
   * nineteen, and the person would have to find the offending line by bisecting
   * their own paste.
   */
  refused: SecretRefusal[];
}

/**
 * Applies an edit to a project's secrets file and says what changed.
 *
 * Order is `text`, then `set`, then `unset`: a pasted file is the coarse
 * statement and a typed field is the specific one, so the specific one wins, and
 * a removal wins over both because it is the only one of the three that cannot
 * be expressed another way.
 *
 * The write is the same atomic 0600 write an import does, so an interrupted save
 * cannot leave half a credential file behind.
 */
export async function editProjectSecrets(
  project: string,
  config: ResolvedConfig | null,
  edit: SecretsEdit,
  options: SecretsOptions = {},
): Promise<SecretsEditReport> {
  const before = await readProjectSecrets(project, options);
  const next = new Map(before);
  const refused: SecretRefusal[] = [];

  const proposed = new Map<string, string>();
  if (edit.text !== undefined) for (const [name, value] of parseEnvFile(edit.text)) proposed.set(name, value);
  for (const [name, value] of Object.entries(edit.set ?? {})) proposed.set(name, value);

  for (const [name, value] of proposed) {
    const reason = envNameRefusal(name, value, config);
    if (reason !== undefined) {
      refused.push({ name, reason });
      continue;
    }
    next.set(name, value);
  }

  const removed: string[] = [];
  for (const name of edit.unset ?? []) {
    if (next.delete(name)) removed.push(name);
  }

  const added = [...next.keys()].filter((name) => !before.has(name)).sort();
  const updated = [...next.keys()]
    .filter((name) => before.has(name) && before.get(name) !== next.get(name))
    .sort();

  await writeSecretsFile(paths(options.env).secretsFile(project), next, authoredHeader(project));

  return {
    ...(await describeProjectSecrets(project, config, options)),
    added,
    updated,
    removed: removed.sort(),
    refused,
  };
}

/**
 * A short digest of everything a sandbox's environment was built from.
 *
 * Stamped on the container as a label at `up` and compared against the current
 * answer, which is how the dashboard can say "this sandbox started before that
 * change" without keeping a record of its own — contracts §3.4's rule that what
 * is true of a sandbox lives on the container, not in a file beside it.
 *
 * The plan's `env` map is folded in as well as the secrets, because the two
 * together are the environment: renaming `VITE_API_URL` in `sandboxr.yaml`
 * changes what a sandbox would be built with just as surely as rotating a key.
 */
export function envDigest(secrets: Map<string, string>, planEnv: Record<string, string> = {}): string {
  const hash = createHash("sha256");
  for (const name of [...secrets.keys()].sort()) hash.update(`s ${name} ${secrets.get(name)} `);
  for (const name of Object.keys(planEnv).sort()) hash.update(`p ${name} ${planEnv[name]} `);
  return hash.digest("hex").slice(0, 16);
}
