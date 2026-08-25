/**
 * `plan.json` — the container's entire view of a project (contracts §5.5).
 *
 * `sandboxr.yaml` is the human-facing file, and nothing inside a container ever
 * reads it. The plan is a flattened, fully-resolved projection of it: every
 * default already merged, one `services` array carrying all three runtime kinds
 * with an explicit `kind`, and nothing left to infer. Resolution is the host's
 * job because the host has a schema and a type checker, and the container side
 * has `jq`.
 *
 * The authoritative specification is `container/README.md` ("The plan"), with
 * worked examples in `container/examples/*.plan.json`. A test compares what this
 * emits against the shape of those, which is what keeps the two halves honest.
 *
 * Optional fields are *omitted* rather than written as `null` or `false`: the
 * container reads the plan with `jq` and an absent key is the idiom there, while
 * a null has to be special-cased at every read.
 */

import { mkdir, writeFile } from "node:fs/promises";
import { basename, dirname } from "node:path";

import type { ResolvedConfig, RouteMap } from "./types.js";

export interface PlanBackend {
  kind: "backend";
  name: string;
  label: string;
  port: number;
  build: string;
  health?: string;
  workdir?: string;
  memory?: string;
  optional?: true;
}

export interface PlanStatic {
  kind: "static";
  label: string;
  package: string;
  root: string;
  build: string;
  out: string;
  static_mode: "spa" | "files" | "html";
  memory?: string;
  /** Only written when false: the default is to be included. */
  in_build_all?: false;
  optional?: true;
}

export interface PlanServer {
  kind: "server";
  label: string;
  package: string;
  root: string;
  serve: string;
  port: number;
  prepare?: string;
  health?: string;
  memory?: string;
  optional?: true;
}

export type PlanService = PlanBackend | PlanStatic | PlanServer;

export interface PlanMigrate {
  command: string;
  workdir?: string;
  since?: string;
  failure_pattern?: string;
  file_pattern?: string;
  error_pattern?: string;
}

export interface PlanDatabase {
  driver: "mysql" | "d1" | "sqlite" | "none";
  version?: string;
  name?: string;
  owner?: string;
  fixtures?: string;
  seed?: { path: string; anonymised: boolean };
  migrate?: PlanMigrate;
}

export interface Plan {
  project: string;
  database: PlanDatabase;
  storage: { driver: "minio" | "none"; buckets?: string[] };
  toolchain: { go?: string; node?: string };
  deps?: { root: string; lockfile: string; install: string };
  services: PlanService[];
  routes: RouteMap;
  env: Record<string, string>;
}

export interface PlanInput {
  /** The seed artifact, as the container will see it in /sandboxr/cache. */
  seed?: { path: string; anonymised?: boolean | undefined } | undefined;
  /**
   * The dependency tree, when it was found on disk rather than declared.
   * Passed in so this stays a pure function of the config.
   */
  deps?: { root: string; lockfile: string; install: string } | undefined;
}

/** Drops keys whose value is undefined, so an absent field is absent. */
function compact<T extends object>(value: T): T {
  return Object.fromEntries(Object.entries(value).filter(([, v]) => v !== undefined)) as T;
}

/**
 * The single service allowed to open a file-backed database.
 *
 * The config may leave this out when the project has only one runtime, because
 * there is then nothing to choose between — but the plan may not. `run-server.sh`
 * withholds the database's location from every server that is not the owner, and
 * an absent owner there means no server gets it and the one that needed it fails
 * on a missing binding. So the single candidate is resolved into the plan here,
 * where the whole runtime list is in view.
 */
function ownerFor(config: ResolvedConfig): string | undefined {
  if (config.database.owner) return config.database.owner;
  if (config.database.driver !== "d1" && config.database.driver !== "sqlite") return undefined;

  const runtimes = [...config.backends.map((b) => b.name), ...config.frontends.map((f) => f.label)];
  return runtimes.length === 1 ? runtimes[0] : undefined;
}

export function planFor(config: ResolvedConfig, input: PlanInput = {}): Plan {
  const services: PlanService[] = [
    ...config.backends.map(
      (backend): PlanBackend =>
        compact({
          kind: "backend",
          name: backend.name,
          label: backend.label,
          port: backend.port,
          build: backend.build ?? "",
          health: backend.health,
          workdir: backend.workdir,
          memory: backend.memory,
          optional: backend.optional ? (true as const) : undefined,
        }),
    ),
    ...config.frontends.map((app): PlanService => {
      // `root` is always present, even when it is `.`: the container joins it
      // with the package name unconditionally, and an absent key there would
      // have to be defaulted in shell.
      const root = config.frontendRoot === "" ? "." : config.frontendRoot;
      if (app.kind === "server") {
        return compact({
          kind: "server",
          label: app.label,
          package: app.package,
          root,
          serve: app.serve ?? "",
          port: app.port ?? 0,
          prepare: app.prepare,
          health: app.health,
          memory: app.memory,
          optional: app.optional ? (true as const) : undefined,
        });
      }
      return compact({
        kind: "static",
        label: app.label,
        package: app.package,
        root,
        build: app.build ?? "",
        out: app.out ?? "dist",
        static_mode: app.staticMode,
        memory: app.memory,
        in_build_all: app.inBuildAll ? undefined : (false as const),
        optional: app.optional ? (true as const) : undefined,
      });
    }),
  ];

  const migrate = config.database.migrate;
  const database: PlanDatabase = compact({
    driver: config.database.driver,
    version: config.database.version,
    // Defaulted here rather than in the container: the name belongs to the
    // project, and a shell default would be a second place it is decided.
    name: config.database.driver === "none" ? undefined : config.project,
    owner: ownerFor(config),
    fixtures: config.database.seedFrom?.fixtures,
    seed: input.seed
      ? { path: basename(input.seed.path), anonymised: input.seed.anonymised === true }
      : undefined,
    migrate: migrate
      ? compact({
          command: migrate.command,
          workdir: migrate.workdir,
          since: migrate.since,
          failure_pattern: migrate.failurePattern,
          file_pattern: migrate.filePattern,
          error_pattern: migrate.errorPattern,
        })
      : undefined,
  });

  return compact({
    project: config.project,
    database,
    storage: compact({
      driver: config.storage.driver,
      buckets: config.storage.buckets.length > 0 ? config.storage.buckets : undefined,
    }),
    toolchain: compact({ go: config.toolchain.go, node: config.toolchain.node }),
    deps: config.deps ? { ...config.deps } : input.deps ? { ...input.deps } : undefined,
    services,
    routes: config.routes,
    env: config.env,
  });
}

/** Writes the plan where the container expects to find it mounted from. */
export async function writePlan(plan: Plan, path: string): Promise<string> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(plan, null, 2)}\n`);
  return path;
}

/**
 * The ports a plan's services hold, for a caller that has to publish them.
 *
 * Read off the plan rather than the config so there is one answer to "what does
 * this sandbox listen on", and it is the one the container is working from.
 */
export function planPorts(plan: Plan): Array<{ label: string; port: number }> {
  return plan.services
    .filter((service): service is PlanBackend | PlanServer => "port" in service && service.port > 0)
    .map((service) => ({ label: service.label, port: service.port }));
}
