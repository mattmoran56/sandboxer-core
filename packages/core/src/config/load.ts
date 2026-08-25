/**
 * Finding, parsing and resolving `sandboxr.yaml`.
 *
 * Resolution is where the file stops being a document and becomes something the
 * rest of the tool can use without re-deciding anything: `defaults:` merged into
 * every entry, each front-end classified as static or served, routes checked
 * against the things they name, and the version constraint checked against this
 * tool. Every failure is a `ConfigError` naming the file and the field.
 */

import { readFile, stat } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";

import { parse as parseYaml } from "yaml";
import { z } from "zod";

import { TOOL_VERSION } from "../tool-version.js";
import { publicAccessViolations } from "./access.js";
import { configSchema, type RawConfig } from "./schema.js";
import type {
  BackendService,
  DatabaseConfig,
  FrontendApp,
  ProjectConfig,
  ResolvedConfig,
  RouteMap,
  SecretsConfig,
} from "./types.js";
import { VersionError, satisfies } from "./version.js";

export const CONFIG_FILENAME = "sandboxr.yaml";

/** Alternative spellings, accepted in this order when both are present. */
const CONFIG_FILENAMES = [CONFIG_FILENAME, "sandboxr.yml", ".sandboxr.yaml"] as const;

export class ConfigError extends Error {
  override readonly name = "ConfigError";
  readonly file: string;
  readonly field?: string | undefined;

  constructor(file: string, message: string, field?: string) {
    super(field ? `${file}: ${field}: ${message}` : `${file}: ${message}`);
    this.file = file;
    this.field = field;
  }
}

export interface LoadOptions {
  /** The version the `sandboxr:` constraint is checked against. */
  toolVersion?: string | undefined;
  /**
   * Whether to refuse a config whose public apps would be backed by real data.
   * Off only for tools that read a config to describe it rather than run it.
   */
  enforceAccess?: boolean | undefined;
}

async function isFile(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isFile();
  } catch {
    return false;
  }
}

/**
 * Walks up from a directory looking for a config file.
 *
 * The file lives at the root of the project being sandboxed, so any directory
 * inside that project is a legal place to run a command from — which is what
 * makes `sandboxr up` work from wherever you happen to be.
 */
export async function findConfig(from: string = process.cwd()): Promise<string | undefined> {
  let dir = resolve(from);
  for (;;) {
    for (const name of CONFIG_FILENAMES) {
      const candidate = join(dir, name);
      if (await isFile(candidate)) return candidate;
    }
    const parent = dirname(dir);
    if (parent === dir) return undefined;
    dir = parent;
  }
}

/** Renders a zod issue path as the dotted field name a config author sees. */
function fieldOf(issue: z.core.$ZodIssue): string {
  return issue.path.length === 0 ? "(root)" : issue.path.map((p) => String(p)).join(".");
}

/**
 * Validates and resolves already-parsed YAML.
 *
 * Separate from reading the file so a caller — a test, or a server rendering
 * someone's config — can validate a document it already has.
 */
export function resolveConfig(document: unknown, file: string, options: LoadOptions = {}): ResolvedConfig {
  const parsed = configSchema.safeParse(document);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    if (!issue) throw new ConfigError(file, "does not match the schema");
    throw new ConfigError(file, issue.message, fieldOf(issue));
  }
  const raw = parsed.data;

  checkToolVersion(raw, file, options.toolVersion ?? TOOL_VERSION);

  const root = dirname(resolve(file));
  const resolved: ResolvedConfig = {
    file: resolve(file),
    root,
    project: raw.project,
    sandboxr: raw.sandboxr,
    database: resolveDatabase(raw, file),
    backends: resolveBackends(raw, file),
    frontendRoot: raw.frontends && "root" in raw.frontends ? (raw.frontends.root ?? "") : "",
    frontends: resolveFrontends(raw, file),
    routes: (raw.routes ?? {}) as RouteMap,
    secrets: resolveSecrets(raw),
    // Absent means no object storage rather than an unknown: the container
    // needs a driver either way, and `none` is a real answer.
    storage: { driver: raw.storage?.driver ?? "none", buckets: raw.storage?.buckets ?? [] },
    deps: raw.deps
      ? {
          root: raw.deps.root,
          lockfile: raw.deps.lockfile ?? "package-lock.json",
          install: raw.deps.install ?? "npm ci --no-audit --no-fund",
        }
      : undefined,
    env: raw.env ?? {},
    toolchain: {
      go: raw.toolchain?.go === undefined ? undefined : String(raw.toolchain.go),
      node: raw.toolchain?.node === undefined ? undefined : String(raw.toolchain.node),
    },
    access: {
      apps: raw.access?.apps ?? "public",
      controls: raw.access?.controls ?? "password",
      credentials: raw.access?.credentials ?? "dummy",
    },
  };

  checkLabels(resolved, file);
  checkRoutes(resolved, file);
  checkFileDatabaseOwner(resolved, file);

  if (options.enforceAccess !== false) {
    const violations = publicAccessViolations(resolved);
    const first = violations[0];
    if (first) {
      throw new ConfigError(file, `${first.reason}. ${first.fix}`, first.field);
    }
  }

  return resolved;
}

/** Reads, parses and resolves a config, finding it by walking up from `from`. */
export async function loadConfig(from: string = process.cwd(), options: LoadOptions = {}): Promise<ResolvedConfig> {
  const file = (await isFile(from)) ? resolve(from) : await findConfig(from);
  if (!file) {
    throw new ConfigError(
      join(resolve(from), CONFIG_FILENAME),
      `no ${CONFIG_FILENAME} here or in any parent directory — a project describes itself in one at its repo root`,
    );
  }

  let document: unknown;
  const text = await readFile(file, "utf8");
  try {
    document = parseYaml(text);
  } catch (error) {
    throw new ConfigError(file, `is not valid YAML: ${(error as Error).message}`);
  }
  if (document === null || document === undefined) throw new ConfigError(file, "is empty");

  return resolveConfig(document, file, options);
}

function checkToolVersion(raw: RawConfig, file: string, toolVersion: string): void {
  let ok: boolean;
  try {
    ok = satisfies(toolVersion, raw.sandboxr);
  } catch (error) {
    if (error instanceof VersionError) {
      throw new ConfigError(file, `${error.message} — expected something like ">=0.1.0"`, "sandboxr");
    }
    throw error;
  }
  if (!ok) {
    throw new ConfigError(
      file,
      `needs sandboxr ${raw.sandboxr}, and this is ${toolVersion} — upgrade the tool, or relax the constraint`,
      "sandboxr",
    );
  }
}

function resolveDatabase(raw: RawConfig, file: string): DatabaseConfig {
  const db = raw.database;
  if (!db) return { driver: "none" };

  const seed = db.seed_from;
  const migrate = db.migrate;
  if (db.driver !== "none" && !migrate && !seed) {
    throw new ConfigError(file, "a driver with neither a seed nor a migration has nothing to do", "database");
  }

  return {
    driver: db.driver,
    version: db.version === undefined ? undefined : String(db.version),
    seedFrom: seed
      ? {
          local: seed.local,
          file: seed.file,
          fixtures: seed.fixtures,
          anonymised: seed.anonymised,
        }
      : undefined,
    migrate: migrate
      ? {
          workdir: migrate.workdir,
          command: migrate.command,
          since: migrate.since === undefined ? undefined : String(migrate.since),
          failurePattern: migrate.failure_pattern,
          filePattern: migrate.file_pattern,
          errorPattern: migrate.error_pattern,
        }
      : undefined,
    owner: db.owner,
  };
}

function resolveBackends(raw: RawConfig, file: string): BackendService[] {
  const block = raw.backends;
  if (!block) return [];
  const defaults = "defaults" in block ? (block.defaults ?? {}) : {};

  return block.services.map((entry) => {
    const build = entry.build ?? defaults.build;
    if (!build) {
      throw new ConfigError(file, "has no build command, and backends.defaults sets none", `backends.${entry.name}`);
    }
    return {
      name: entry.name,
      port: entry.port,
      label: entry.label,
      build,
      workdir: entry.workdir ?? defaults.workdir,
      health: entry.health ?? defaults.health,
      memory: entry.memory ?? defaults.memory,
      optional: entry.optional ?? defaults.optional ?? false,
    };
  });
}

function resolveFrontends(raw: RawConfig, file: string): FrontendApp[] {
  const block = raw.frontends;
  if (!block) return [];
  const defaults = "defaults" in block ? (block.defaults ?? {}) : {};

  return block.apps.map((entry) => {
    const field = `frontends.${entry.label}`;
    if (entry.out && entry.serve) {
      throw new ConfigError(file, "is both a static build (`out`) and a server (`serve`) — pick one", field);
    }

    // The entry decides its own kind before defaults are consulted: a served
    // app declared under a `defaults: { out: dist }` must not inherit an output
    // directory it has no build to fill.
    const kind: FrontendApp["kind"] = entry.serve
      ? "server"
      : entry.out
        ? "static"
        : defaults.out
          ? "static"
          : defaults.serve
            ? "server"
            : "static";

    const serve = kind === "server" ? (entry.serve ?? defaults.serve) : undefined;
    const out = kind === "static" ? (entry.out ?? defaults.out) : undefined;
    const build = kind === "static" ? (entry.build ?? defaults.build) : undefined;

    if (kind === "static" && !out) {
      throw new ConfigError(file, "needs an `out` directory or a `serve` command", field);
    }
    if (kind === "static" && !build) {
      throw new ConfigError(file, "has no build command, and frontends.defaults sets none", field);
    }
    // A served app is reached by proxy, so its port is what the router needs;
    // without it there is nothing to send traffic to.
    const port = entry.port ?? defaults.port;
    if (kind === "server" && port === undefined) {
      throw new ConfigError(file, "is a server, so it needs the `port` it listens on", field);
    }

    return {
      label: entry.label,
      package: entry.package,
      build,
      out,
      serve,
      prepare: kind === "server" ? (entry.prepare ?? defaults.prepare) : undefined,
      // Only a served app has a process to probe; a built directory is up as
      // soon as the file server can find it.
      health: kind === "server" ? (entry.health ?? defaults.health) : undefined,
      port,
      // A single-page app is the common case, and it is the one mode that is
      // wrong in the least damaging way when the author has not thought about it.
      staticMode: entry.static_mode ?? defaults.static_mode ?? "spa",
      memory: entry.memory ?? defaults.memory,
      inBuildAll: entry.in_build_all ?? defaults.in_build_all ?? true,
      optional: entry.optional ?? defaults.optional ?? false,
      kind,
    };
  });
}

function resolveSecrets(raw: RawConfig): SecretsConfig {
  return {
    read: raw.secrets?.read ?? [],
    keep: raw.secrets?.keep ?? [],
    rename: raw.secrets?.rename ?? {},
    never: raw.secrets?.never ?? [],
  };
}

/**
 * Every runtime answers on `<slug>.<label>.<project>.<domain>`, so two runtimes
 * sharing a label would share a hostname and one would be unreachable.
 */
function checkLabels(config: ResolvedConfig, file: string): void {
  const seen = new Map<string, string>();
  for (const backend of config.backends) {
    const clash = seen.get(backend.label);
    if (clash) {
      throw new ConfigError(file, `label "${backend.label}" is already used by ${clash}`, `backends.${backend.name}`);
    }
    seen.set(backend.label, `backend ${backend.name}`);
  }
  for (const app of config.frontends) {
    const clash = seen.get(app.label);
    if (clash) {
      throw new ConfigError(file, `label "${app.label}" is already used by ${clash}`, `frontends.${app.label}`);
    }
    seen.set(app.label, `frontend ${app.label}`);
  }

  const names = new Set<string>();
  for (const backend of config.backends) {
    if (names.has(backend.name)) {
      throw new ConfigError(file, `two backends are called "${backend.name}"`, "backends");
    }
    names.add(backend.name);
  }
}

/**
 * A route names the thing traffic is sent to, which is either a backend or a
 * front-end that runs as a server. A typo here is a 404 in a browser with
 * nothing in any log, so it is caught while the config is being read.
 */
function checkRoutes(config: ResolvedConfig, file: string): void {
  const backendNames = new Set(config.backends.map((b) => b.name));
  const serverLabels = new Set(config.frontends.filter((f) => f.kind === "server").map((f) => f.label));
  const appLabels = new Set(config.frontends.map((f) => f.label));

  for (const [label, prefixes] of Object.entries(config.routes)) {
    if (!appLabels.has(label)) {
      throw new ConfigError(file, `no front-end is labelled "${label}"`, `routes.${label}`);
    }
    for (const [prefix, target] of Object.entries(prefixes)) {
      if (!backendNames.has(target) && !serverLabels.has(target)) {
        throw new ConfigError(
          file,
          `"${target}" is neither a backend nor a served front-end`,
          `routes.${label}."${prefix}"`,
        );
      }
    }
  }
}

/**
 * File-backed drivers admit exactly one writer.
 *
 * Two processes opening the same D1 file deadlock, so the config has to name
 * the single service that owns it. This is a rule of the driver rather than a
 * workaround, which is why it is checked rather than defaulted.
 */
function checkFileDatabaseOwner(config: ResolvedConfig, file: string): void {
  if (config.database.driver !== "d1" && config.database.driver !== "sqlite") return;

  const runtimes = [...config.backends.map((b) => b.name), ...config.frontends.map((f) => f.label)];
  const owner = config.database.owner;

  if (!owner) {
    if (runtimes.length <= 1) return;
    throw new ConfigError(
      file,
      `a ${config.database.driver} database admits one writer, so it must name the service that owns it (one of: ${runtimes.join(", ")})`,
      "database.owner",
    );
  }
  if (!runtimes.includes(owner)) {
    throw new ConfigError(file, `"${owner}" is not a declared backend or front-end`, "database.owner");
  }
}

/** Resolves a config-relative path against the project root. */
export function projectPath(config: ResolvedConfig, relative: string): string {
  return isAbsolute(relative) ? relative : join(config.root, relative);
}

/** The raw document shape, for callers that want to render a config back out. */
export type { ProjectConfig };
