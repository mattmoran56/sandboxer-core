/**
 * Finding, parsing and resolving `sandboxer.yaml`.
 *
 * Resolution is where the file stops being a document and becomes something the
 * rest of the tool can use without re-deciding anything: `defaults:` merged into
 * every entry, each front-end classified as static or served, routes checked
 * against the things they name, and the version constraint checked against this
 * tool. Every failure is a `ConfigError` naming the file and the field.
 */

import { readFile } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";

import { parse as parseYaml } from "yaml";
import { z } from "zod";

import { DNS_LABEL_MAX, SLUG_MIN, slugCeiling } from "../naming.js";
import { TOOL_VERSION } from "../tool-version.js";
import { publicAccessViolations } from "./access.js";
import { CONFIG_FILENAME, isWorkspaceProjectDir, locateConfig, type ConfigOrigin } from "./locate.js";
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
  /** The version the `sandboxer:` constraint is checked against. */
  toolVersion?: string | undefined;
  /**
   * Whether to refuse a config whose public apps would be backed by real data.
   * Off only for tools that read a config to describe it rather than run it.
   */
  enforceAccess?: boolean | undefined;
  /**
   * The environment the workspace path is read from, for locating a
   * project-level config. Taken as an argument, like paths(), so a test can
   * point the workspace at a temporary directory without mutating the process.
   */
  env?: NodeJS.ProcessEnv | undefined;
}

export interface ResolveOptions extends LoadOptions {
  /**
   * The directory the config governs. Defaults to the file's own directory,
   * which is right for every config that lives in the repo it describes.
   */
  root?: string | undefined;
  /** Where the file came from. Defaults to "repo". */
  origin?: ConfigOrigin | undefined;
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
export function resolveConfig(document: unknown, file: string, options: ResolveOptions = {}): ResolvedConfig {
  const parsed = configSchema.safeParse(document);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    if (!issue) throw new ConfigError(file, "does not match the schema");
    throw new ConfigError(file, issue.message, fieldOf(issue));
  }
  const raw = parsed.data;

  checkToolVersion(raw, file, options.toolVersion ?? TOOL_VERSION);

  const root = options.root === undefined ? dirname(resolve(file)) : resolve(options.root);
  const resolved: ResolvedConfig = {
    file: resolve(file),
    root,
    origin: options.origin ?? "repo",
    project: raw.project,
    sandboxer: raw.sandboxer,
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
  checkHostBudget(resolved, file);
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

/**
 * Reads, parses and resolves the config that governs `from`.
 *
 * `from` may be a directory or the config file itself. Which file is read, and
 * which directory it governs, are locateConfig's decisions — including the
 * project-level fallback for a managed worktree (contracts §5.6).
 */
export async function loadConfig(from: string = process.cwd(), options: LoadOptions = {}): Promise<ResolvedConfig> {
  const env = options.env ?? process.env;
  const location = await locateConfig(from, { env });
  if (!location) {
    throw new ConfigError(
      join(resolve(from), CONFIG_FILENAME),
      `no ${CONFIG_FILENAME} here or in any parent directory — a project describes itself in one at its repo root`,
    );
  }
  const { file } = location;

  // **Refused, never mounted.** `root` becomes `/workspace`, and a workspace
  // project directory holds `repo.git` and every worktree of the project — so
  // mounting it puts all of them inside the sandbox and resolves every declared
  // path one directory too high. locateConfig keeps the walk-up inside a
  // worktree, and this catches the ways in that do not go through it: a config
  // file named directly, or a command run from the project directory itself.
  if (isWorkspaceProjectDir(location.root, env)) {
    throw new ConfigError(
      file,
      `is the project-level config for a managed project, so it cannot be run from ${location.root} — ` +
        "that directory holds repo.git and every worktree, and mounting it would put all of them in the sandbox. " +
        `Run from a worktree under ${join(location.root, "wt")}, where this file applies on its own`,
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

  return resolveConfig(document, file, { ...options, root: location.root, origin: location.origin });
}

function checkToolVersion(raw: RawConfig, file: string, toolVersion: string): void {
  let ok: boolean;
  try {
    ok = satisfies(toolVersion, raw.sandboxer);
  } catch (error) {
    if (error instanceof VersionError) {
      throw new ConfigError(file, `${error.message} — expected something like ">=0.1.0"`, "sandboxer");
    }
    throw error;
  }
  if (!ok) {
    throw new ConfigError(
      file,
      `needs sandboxer ${raw.sandboxer}, and this is ${toolVersion} — upgrade the tool, or relax the constraint`,
      "sandboxer",
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
 * Every runtime answers on `<slug>--<label>--<project>.<domain>`, so two runtimes
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
 * Every hostname label this project serves.
 *
 * The declared runtimes, plus `s3` when the sandbox runs object storage of its
 * own: that store answers on a hostname like any other app, so it spends the
 * same DNS-label budget, and a project whose arithmetic ignored it would have
 * one hostname over the limit and every other one fine.
 */
export function hostLabels(config: ResolvedConfig): string[] {
  const labels = [...config.frontends, ...config.backends].map((runtime) => runtime.label);
  if (config.storage.driver === "minio") labels.push("s3");
  return [...new Set(labels)];
}

/**
 * The slug ceiling this project's config implies.
 *
 * The one function anything outside core should call for it, because it is the
 * pairing of the project name with the *longest* label that decides the answer,
 * and a caller that picked either half on its own would get a ceiling that is
 * quietly too generous. Everything that derives a slug for a project — `up`, the
 * CLI's listing, the dashboard's worktree view — has to agree on this number, or
 * the name on the screen is not the name the sandbox gets.
 */
export function slugCeilingFor(config: ResolvedConfig): number {
  return slugCeiling(config.project, hostLabels(config));
}

/**
 * Whether this project leaves a slug worth having.
 *
 * Contracts §3.2 puts the slug, the longest hostname label and the project name
 * in one DNS label, and a DNS label stops at 63 characters. So a long project
 * name and a long label do not fail on their own — they quietly spend the slug's
 * share of the budget, and what breaks is the *next* branch with a long name, at
 * `up`, as a hostname that resolves to nothing. Refused here instead, once, with
 * the three numbers named, because this is the only place all three are known
 * before anything has been started.
 */
function checkHostBudget(config: ResolvedConfig, file: string): void {
  const labels = hostLabels(config);
  const ceiling = slugCeilingFor(config);
  if (ceiling >= SLUG_MIN) return;

  const longest = labels.reduce((a, b) => (b.length > a.length ? b : a), "");
  throw new ConfigError(
    file,
    `project "${config.project}" (${config.project.length} characters) with its longest label "${longest}" ` +
      `(${longest.length}) leaves a slug budget of ${ceiling}, under the minimum of ${SLUG_MIN}. ` +
      `A sandbox hostname is one DNS label — <slug>--<label>--<project> — capped at ${DNS_LABEL_MAX} characters. ` +
      "Shorten the project name or the label.",
    "project",
  );
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

/**
 * Resolves a config-relative path against the tree the config governs.
 *
 * Against `root`, never `dirname(config.file)` — a project-level config sits
 * outside the worktree it configures, and every path it declares still has to
 * land inside that worktree.
 */
export function projectPath(config: ResolvedConfig, relative: string): string {
  return isAbsolute(relative) ? relative : join(config.root, relative);
}

/** The raw document shape, for callers that want to render a config back out. */
export type { ProjectConfig };
