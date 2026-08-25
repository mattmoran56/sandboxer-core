/**
 * The authoritative schema for `sandboxr.yaml` (contracts §5).
 *
 * Everything is a strict object, so a misspelled key is an error naming the key
 * rather than a setting that silently does nothing — which in a config that
 * decides what a sandbox serves is the difference between a clear failure and a
 * confusing one.
 *
 * Two shapes are accepted for `backends` and `frontends`: the mapping form the
 * example configs use (`defaults:` beside `services:` / `apps:`), and a bare
 * list for a project with nothing to default. The mapping form is canonical
 * because a `defaults:` block cannot legally sit inside a YAML sequence.
 */

import { z } from "zod";

/** Project names go into hostnames, so they share the hostname alphabet. */
const projectName = z
  .string()
  .regex(/^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/, "must be lowercase letters, digits and dashes");

/** One hostname label: `<slug>.<label>.<project>.<domain>`. */
const hostLabel = z
  .string()
  .regex(/^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/, "must be a hostname label: lowercase, digits and dashes")
  .max(63);

const port = z.number().int().min(1).max(65535);

/** A docker memory limit, e.g. `6g` or `512m`. */
const memory = z.string().regex(/^[0-9]+(b|k|m|g)?$/i, "must be a docker memory limit, e.g. 6g");

const nonEmpty = z.string().min(1);

export const seedFromSchema = z.strictObject({
  local: z
    .strictObject({
      container: nonEmpty,
      database: nonEmpty.optional(),
    })
    .optional(),
  file: nonEmpty.optional(),
  fixtures: nonEmpty.optional(),
  anonymised: z.boolean().optional(),
});

export const migrateSchema = z.strictObject({
  workdir: nonEmpty.optional(),
  command: nonEmpty,
  since: z.union([nonEmpty, z.number()]).optional(),
  // Patterns the container uses to turn a runner's output into progress and a
  // named failure. Optional, and passed through untouched: every runner prints
  // something different, and guessing is what a per-project parser would be.
  failure_pattern: nonEmpty.optional(),
  file_pattern: nonEmpty.optional(),
  error_pattern: nonEmpty.optional(),
});

export const databaseSchema = z.strictObject({
  driver: z.enum(["mysql", "d1", "sqlite", "none"]),
  version: z.union([nonEmpty, z.number()]).optional(),
  seed_from: seedFromSchema.optional(),
  migrate: migrateSchema.optional(),
  owner: nonEmpty.optional(),
});

const backendFields = {
  build: nonEmpty.optional(),
  workdir: nonEmpty.optional(),
  health: nonEmpty.optional(),
  memory: memory.optional(),
  optional: z.boolean().optional(),
};

export const backendEntrySchema = z.strictObject({
  name: nonEmpty,
  port,
  label: hostLabel,
  ...backendFields,
});

export const backendsSchema = z.union([
  z.strictObject({
    defaults: z.strictObject(backendFields).optional(),
    services: z.array(backendEntrySchema),
  }),
  z.array(backendEntrySchema).transform((services) => ({ services })),
]);

const frontendFields = {
  build: nonEmpty.optional(),
  out: nonEmpty.optional(),
  serve: nonEmpty.optional(),
  /** Run once before a served app starts: a codegen step, a schema pull. */
  prepare: nonEmpty.optional(),
  /** Health path, probed to decide whether a served app is up. */
  health: nonEmpty.optional(),
  port: port.optional(),
  memory: memory.optional(),
  /**
   * How a built directory is served. The three cases are genuinely different —
   * a single-page app needs every unknown path to fall back to index.html, a
   * generator emitting `about.html` needs extensionless lookup, and a plain
   * directory of files needs a real 404 — and one mode makes two of the three
   * half-work rather than fail outright.
   */
  static_mode: z.enum(["spa", "files", "html"]).optional(),
  in_build_all: z.boolean().optional(),
  optional: z.boolean().optional(),
};

export const frontendEntrySchema = z.strictObject({
  label: hostLabel,
  package: nonEmpty,
  ...frontendFields,
});

export const frontendsSchema = z.union([
  z.strictObject({
    root: nonEmpty.optional(),
    defaults: z.strictObject(frontendFields).optional(),
    apps: z.array(frontendEntrySchema),
  }),
  z.array(frontendEntrySchema).transform((apps) => ({ apps })),
]);

/** Path prefix to backend name, per app label. */
export const routesSchema = z.record(hostLabel, z.record(z.string().startsWith("/"), nonEmpty));

export const secretsSchema = z.strictObject({
  read: z.array(nonEmpty).optional(),
  keep: z.array(nonEmpty).optional(),
  rename: z.record(nonEmpty, nonEmpty).optional(),
  never: z.array(nonEmpty).optional(),
});

export const storageSchema = z.strictObject({
  driver: z.enum(["minio", "none"]),
  buckets: z.array(nonEmpty).optional(),
});

/**
 * The Node dependency tree, when the project has one.
 *
 * Named rather than inferred because the directory holding the lockfile is not
 * always the directory holding the packages, and the shared dependency volume is
 * mounted at exactly one path.
 */
export const depsSchema = z.strictObject({
  root: nonEmpty,
  lockfile: nonEmpty.optional(),
  install: nonEmpty.optional(),
});

export const toolchainSchema = z.strictObject({
  go: z.union([nonEmpty, z.number()]).optional(),
  node: z.union([nonEmpty, z.number()]).optional(),
});

export const accessSchema = z.strictObject({
  apps: z.enum(["public", "private"]).optional(),
  controls: z.literal("password").optional(),
  credentials: z.enum(["dummy", "real"]).optional(),
});

export const configSchema = z.strictObject({
  project: projectName,
  sandboxr: nonEmpty,
  database: databaseSchema.optional(),
  backends: backendsSchema.optional(),
  frontends: frontendsSchema.optional(),
  routes: routesSchema.optional(),
  secrets: secretsSchema.optional(),
  storage: storageSchema.optional(),
  deps: depsSchema.optional(),
  toolchain: toolchainSchema.optional(),
  access: accessSchema.optional(),
  /**
   * The mapping from sandboxr's own variable names to the project's.
   *
   * The sandbox computes *where* everything is and exports it under a
   * `SANDBOXR_` prefix; the project reads its own names for the same things.
   * Only the project knows its own spelling, so it says so here — values are
   * expanded by substitution, never by a shell, so a value is data.
   */
  env: z.record(z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/), z.string()).optional(),
});

export type RawConfig = z.infer<typeof configSchema>;
