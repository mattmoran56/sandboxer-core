/**
 * Building `~/.sandboxr/secrets/<project>.env` from the .env files a developer
 * already has.
 *
 * Nothing here prints a value. An import reports a count and a list of names,
 * so it is safe to run with someone watching, to paste into a ticket, or to
 * hand to an agent — the whole point is that credentials go from one file on
 * disk to another without passing through a terminal.
 *
 * What is imported is decided by the project's own config (contracts §5.2):
 * `keep` is an allow-list of third-party credentials, `never` rejects anything
 * describing *where* something runs, and `rename` carries a value across to the
 * name the code actually reads.
 */

import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

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

/**
 * Reads the files the config names and writes the project's secrets file.
 *
 * The file is written to a temporary name and moved into place, so an
 * interrupted import cannot leave a half-written credential file behind, and it
 * is chmodded 0600 because it is the one file here that holds real values.
 */
export async function importSecrets(config: ResolvedConfig, options: SecretsOptions = {}): Promise<SecretsReport> {
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
  const names = [...collected.keys()].sort();

  const body = [
    `# Generated by \`sandboxr secrets import\` for ${config.project}. Do not commit.`,
    "# Third-party credentials only: database, object storage and inter-service",
    "# URLs are computed per sandbox.",
    "",
    ...names.map((name) => `${name}=${collected.get(name) ?? ""}`),
    "",
  ].join("\n");

  await mkdir(dirname(file), { recursive: true });
  const temporary = `${file}.partial`;
  await writeFile(temporary, body, { encoding: "utf8", mode: 0o600 });
  await rename(temporary, file);
  await chmod(file, 0o600);

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
    return { file, exists: false, present: [], absent: wanted(config) };
  }

  const have = parseEnvFile(text);
  const present: string[] = [];
  const absent: string[] = [];
  for (const name of wanted(config)) {
    (have.has(name) ? present : absent).push(name);
  }
  return { file, exists: true, present, absent };
}

/**
 * The names a working sandbox is expected to carry: the `keep` list, with any
 * name the config renames replaced by the name it is renamed to.
 */
function wanted(config: ResolvedConfig): string[] {
  const renamed = new Set(Object.keys(config.secrets.rename));
  const names = new Set<string>();
  for (const name of config.secrets.keep) if (!renamed.has(name)) names.add(name);
  for (const target of Object.values(config.secrets.rename)) names.add(target);
  return [...names].sort();
}
