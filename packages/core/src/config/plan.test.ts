// Tests for the plan the container reads (contracts §5.5):
// - a fully-featured config emits exactly the documented shape, field by field
// - every runtime kind lands in one services array with an explicit kind
// - defaults are merged in, so nothing is left for the container to infer
// - optional fields are omitted rather than written as null or false
// - static_mode defaults to spa, and in_build_all only appears when false
// - the seed path is written through untouched: the caller has already resolved it to a
//   container path, and this is where it used to be basenamed and a declared file lost
// - every example config in the repo emits a plan whose keys the reference plans in
//   container/examples also have — the check that keeps the two halves of the tool honest
// - and the other direction: a config written to produce each worked plan produces it
//   exactly, which is the only way a field the container reads and the emitter cannot
//   produce shows up at all
// - writePlan: valid JSON on disk, and planPorts reads the ports back off it

import { readFileSync, readdirSync } from "node:fs";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { loadConfig, resolveConfig } from "./load.js";
import { planFor, planPorts, writePlan, type Plan, type PlanService } from "./plan.js";

const EXAMPLES = new URL("../../../../examples/", import.meta.url).pathname;
const REFERENCE = new URL("../../../../container/examples/", import.meta.url).pathname;

const full = resolveConfig(
  {
    project: "acme",
    sandboxer: ">=0.1.0",
    access: { apps: "private" },
    database: {
      driver: "mysql",
      version: "8.4",
      seed_from: { local: { container: "acme_db", database: "acme" }, fixtures: "db/seeds/fixtures.sql" },
      migrate: {
        workdir: "services",
        command: "go run ./cmd/migrate",
        since: "20240101",
        failure_pattern: "[0-9]+ failed",
        file_pattern: "[0-9]{8}-[^ ]+\\.sql",
        error_pattern: "Error [0-9]+",
      },
    },
    backends: {
      defaults: { workdir: "services", build: "go build -o {out} ./{name}", health: "/health" },
      services: [
        { name: "api", port: 8001, label: "api" },
        { name: "jobs", port: 8004, label: "jobs", optional: true },
      ],
    },
    frontends: {
      root: "web/packages",
      defaults: { build: "npx vite build", out: "dist" },
      apps: [
        { label: "app", package: "web" },
        { label: "www", package: "marketing", build: "npm run build", out: "out", static_mode: "html", memory: "6g" },
        { label: "docs", package: "docs", build: "npm run docs", out: "build", static_mode: "files", in_build_all: false },
        { label: "cms", package: "cms", serve: "npx next dev --port 3000", port: 3000, prepare: "npm run codegen", optional: true },
      ],
    },
    routes: { app: { "/api": "api", "/cms": "cms" } },
    storage: { driver: "minio", buckets: ["uploads", "avatars"] },
    deps: { root: "web" },
    toolchain: { go: "1.23", node: "22" },
    env: { DB_HOST: "${SANDBOXER_DB_HOST}", VITE_API_URL: "/api" },
  },
  "/repo/sandboxer.yaml",
);

describe("planFor", () => {
  const plan = planFor(full, { seed: { path: "/sandboxer/cache/seed-acme-3f2a1b.sql.zst" } });

  it("emits the documented top-level shape", () => {
    expect(Object.keys(plan).sort()).toEqual([
      "database",
      "deps",
      "env",
      "project",
      "routes",
      "services",
      "storage",
      "toolchain",
    ]);
  });

  it("resolves the database, defaulting its name to the project", () => {
    expect(plan.database).toEqual({
      driver: "mysql",
      version: "8.4",
      name: "acme",
      fixtures: "db/seeds/fixtures.sql",
      seed: { path: "/sandboxer/cache/seed-acme-3f2a1b.sql.zst", anonymised: false },
      migrate: {
        command: "go run ./cmd/migrate",
        workdir: "services",
        since: "20240101",
        failure_pattern: "[0-9]+ failed",
        file_pattern: "[0-9]{8}-[^ ]+\\.sql",
        error_pattern: "Error [0-9]+",
      },
    });
  });

  // Whole and unmodified. Taking the basename here was right for a cached dump
  // and silently unfindable for a `file:` the project declared elsewhere, so the
  // resolution moved out to `seedMount` and this is now a pass-through.
  it("writes the seed path it was given, whole", () => {
    expect(plan.database.seed?.path).toBe("/sandboxer/cache/seed-acme-3f2a1b.sql.zst");
    expect(planFor(full, { seed: { path: "/sandboxer/seed/acme.sql.zst" } }).database.seed?.path).toBe(
      "/sandboxer/seed/acme.sql.zst",
    );
  });

  it("puts all three runtime kinds in one array, each saying which it is", () => {
    expect(plan.services.map((service) => `${service.kind}:${service.label}`)).toEqual([
      "backend:api",
      "backend:jobs",
      "static:app",
      "static:www",
      "static:docs",
      "server:cms",
    ]);
  });

  it("merges the defaults into every backend", () => {
    expect(plan.services[0]).toEqual({
      kind: "backend",
      name: "api",
      label: "api",
      port: 8001,
      build: "go build -o {out} ./{name}",
      health: "/health",
      workdir: "services",
    });
  });

  it("merges the defaults into every static app and carries its root", () => {
    expect(plan.services[2]).toEqual({
      kind: "static",
      label: "app",
      package: "web",
      root: "web/packages",
      build: "npx vite build",
      out: "dist",
      static_mode: "spa",
    });
  });

  it("resolves a served app without a build or an output directory", () => {
    expect(plan.services[5]).toEqual({
      kind: "server",
      label: "cms",
      package: "cms",
      root: "web/packages",
      serve: "npx next dev --port 3000",
      port: 3000,
      prepare: "npm run codegen",
      optional: true,
    });
  });

  // An absent key is the idiom on the container side, where the plan is read
  // with jq; a null would have to be special-cased at every read.
  it("omits an optional field rather than writing null or false", () => {
    const json = JSON.stringify(plan);
    expect(json).not.toContain("null");
    expect(json).not.toContain('"optional":false');
    expect(plan.services[0]).not.toHaveProperty("optional");
    expect(plan.services[2]).not.toHaveProperty("in_build_all");
  });

  it("writes in_build_all only for an app that opts out", () => {
    expect(plan.services[4]).toMatchObject({ label: "docs", in_build_all: false });
  });

  it("carries each app's static mode, defaulting to spa", () => {
    const modes = plan.services
      .filter((service): service is Extract<PlanService, { kind: "static" }> => service.kind === "static")
      .map((service) => `${service.label}:${service.static_mode}`);
    expect(modes).toEqual(["app:spa", "www:html", "docs:files"]);
  });

  it("passes the routes and the project's own variable names through", () => {
    expect(plan.routes).toEqual({ app: { "/api": "api", "/cms": "cms" } });
    expect(plan.env).toEqual({ DB_HOST: "${SANDBOXER_DB_HOST}", VITE_API_URL: "/api" });
  });

  it("carries the dependency tree with its defaults filled in", () => {
    expect(plan.deps).toEqual({ root: "web", lockfile: "package-lock.json", install: "npm ci --no-audit --no-fund" });
  });

  it("says storage is none rather than leaving it out", () => {
    const bare = planFor(
      resolveConfig(
        { project: "acme", sandboxer: ">=0.1.0", access: { apps: "private" }, database: { driver: "none" } },
        "/repo/sandboxer.yaml",
      ),
    );
    expect(bare.storage).toEqual({ driver: "none" });
    expect(bare.database).toEqual({ driver: "none" });
    expect(bare.services).toEqual([]);
    expect(bare.routes).toEqual({});
    expect(bare.env).toEqual({});
  });

  it("marks an anonymised dump as such, so the container can say what it restored", () => {
    const anonymised = resolveConfig(
      {
        project: "acme",
        sandboxer: ">=0.1.0",
        access: { apps: "public" },
        database: { driver: "mysql", seed_from: { file: "/seeds/d.sql", anonymised: true }, migrate: { command: "m" } },
      },
      "/repo/sandboxer.yaml",
    );
    const plan2 = planFor(anonymised, { seed: { path: "/sandboxer/seed/d.sql", anonymised: true } });
    expect(plan2.database.seed).toEqual({ path: "/sandboxer/seed/d.sql", anonymised: true });
  });

  it("carries the owner a file-backed driver requires", () => {
    const d1 = resolveConfig(
      {
        project: "acme",
        sandboxer: ">=0.1.0",
        access: { apps: "private" },
        database: { driver: "d1", owner: "app", seed_from: { fixtures: "f.sql" }, migrate: { command: "m" } },
        frontends: { apps: [{ label: "app", package: ".", serve: "s", port: 1 }] },
      },
      "/repo/sandboxer.yaml",
    );
    const plan3 = planFor(d1);
    expect(plan3.database.owner).toBe("app");
    expect(plan3.services[0]).toMatchObject({ kind: "server", root: "." });
  });

  // The config may leave the owner out when there is only one runtime to choose,
  // but the plan may not: `run-server.sh` withholds the database's location from
  // every server that is not the named owner, so an absent owner means no server
  // gets it and the one that needed it fails on a missing binding.
  it("resolves the owner a single-runtime config leaves out", () => {
    const implied = resolveConfig(
      {
        project: "acme",
        sandboxer: ">=0.1.0",
        access: { apps: "private" },
        database: { driver: "sqlite", seed_from: { fixtures: "f.sql" }, migrate: { command: "m" } },
        frontends: { apps: [{ label: "app", package: ".", serve: "s", port: 1 }] },
      },
      "/repo/sandboxer.yaml",
    );
    expect(planFor(implied).database.owner).toBe("app");
  });

  it("leaves the owner out for a driver that has no file to own", () => {
    expect(planFor(full).database.owner).toBeUndefined();
  });

  it("carries the health path of a served front-end", () => {
    const served = resolveConfig(
      {
        project: "acme",
        sandboxer: ">=0.1.0",
        access: { apps: "private" },
        frontends: { apps: [{ label: "app", package: ".", serve: "s", port: 1, health: "/healthz" }] },
      },
      "/repo/sandboxer.yaml",
    );
    expect(planFor(served).services[0]).toMatchObject({ kind: "server", health: "/healthz" });
  });

  // A static app is up as soon as the file server can find it, so there is no
  // process to probe and nothing for the container to do with a health path.
  it("does not carry a health path for a static app", () => {
    const built = resolveConfig(
      {
        project: "acme",
        sandboxer: ">=0.1.0",
        access: { apps: "private" },
        frontends: { apps: [{ label: "app", package: ".", build: "b", out: "dist", health: "/healthz" }] },
      },
      "/repo/sandboxer.yaml",
    );
    expect(planFor(built).services[0]).not.toHaveProperty("health");
  });
});

/**
 * The plans in `container/examples` are the container's own worked examples.
 *
 * Comparing values would be comparing two independently invented projects, so
 * what is checked is the direction that actually matters: every key this emitter
 * produces must be a key those reference plans also carry, because the container
 * only reads keys it knows about. A field invented here would be silently
 * ignored over there, which is exactly the drift this test exists to catch.
 */
describe("the emitted plan against the container's reference plans", () => {
  const references = readdirSync(REFERENCE)
    .filter((name) => name.endsWith(".plan.json"))
    .map((name) => JSON.parse(readFileSync(join(REFERENCE, name), "utf8")) as Plan);

  const knownTopLevel = new Set(references.flatMap((plan) => Object.keys(plan)));
  const knownDatabase = new Set(references.flatMap((plan) => Object.keys(plan.database)));
  const knownMigrate = new Set(references.flatMap((plan) => Object.keys(plan.database.migrate ?? {})));
  const knownService = new Map<string, Set<string>>();
  for (const plan of references) {
    for (const service of plan.services) {
      const keys = knownService.get(service.kind) ?? new Set<string>();
      for (const key of Object.keys(service)) keys.add(key);
      knownService.set(service.kind, keys);
    }
  }

  it("has reference plans to compare against", () => {
    expect(references.length).toBeGreaterThan(0);
    expect(knownTopLevel.size).toBeGreaterThan(0);
  });

  const configs = readdirSync(EXAMPLES).filter((name) => name.endsWith(".yaml") || name.endsWith(".yml"));

  it.each(configs)("%s emits only keys the container knows", async (name) => {
    const config = await loadConfig(join(EXAMPLES, name), { enforceAccess: false });
    const plan = planFor(config, { seed: { path: `/sandboxer/cache/seed-${config.project}-abc.sql.zst` } });

    for (const key of Object.keys(plan)) expect([...knownTopLevel]).toContain(key);
    for (const key of Object.keys(plan.database)) expect([...knownDatabase]).toContain(key);
    for (const key of Object.keys(plan.database.migrate ?? {})) expect([...knownMigrate]).toContain(key);
    for (const service of plan.services) {
      const known = knownService.get(service.kind);
      expect(known, `no reference plan has a ${service.kind} service`).toBeDefined();
      for (const key of Object.keys(service)) expect([...(known ?? [])]).toContain(key);
    }
  });

  it.each(configs)("%s emits every key the container requires", async (name) => {
    const config = await loadConfig(join(EXAMPLES, name), { enforceAccess: false });
    const plan = planFor(config);
    for (const required of ["project", "database", "storage", "toolchain", "services", "routes", "env"]) {
      expect(plan).toHaveProperty(required);
    }
    for (const service of plan.services) {
      expect(service.label).toBeTruthy();
      expect(["backend", "static", "server"]).toContain(service.kind);
      if (service.kind === "static") expect(service.static_mode).toBeTruthy();
      if (service.kind === "server") expect(service.port).toBeGreaterThan(0);
      if (service.kind === "backend") expect(service.build).toBeTruthy();
    }
  });
});

/**
 * The shape check above only sees keys the example configs happen to declare, so
 * a field the container reads and the emitter cannot produce passes it unnoticed.
 * These go the other way: the config that should produce each worked plan, and
 * the whole plan compared field for field.
 */
describe("planFor reproduces the container's worked plans exactly", () => {
  const reference = (name: string) => JSON.parse(readFileSync(join(REFERENCE, name), "utf8")) as Plan;

  it("monolith.plan.json", () => {
    const config = resolveConfig(
      {
        project: "acme",
        sandboxer: ">=0.1.0",
        database: {
          driver: "mysql",
          version: "8.4",
          seed_from: { file: "/seeds/acme.sql.zst", fixtures: "migrations/seeds/fixtures.sql", anonymised: true },
          migrate: {
            workdir: "services",
            command: "go run ./cmd/migrate --env local --dir ../migrations",
            since: "20260209",
            failure_pattern: "[0-9]+ failed",
            file_pattern: "[0-9]{8}-[0-9]{4}-[^ ]+\\.sql",
          },
        },
        storage: { driver: "minio", buckets: ["uploads", "avatars"] },
        toolchain: { go: "1.26", node: "24" },
        deps: { root: "web", lockfile: "package-lock.json", install: "npm ci --no-audit --no-fund" },
        backends: {
          defaults: { workdir: "services", build: "go build -o {out} ./{name}", health: "/health" },
          services: [
            { name: "api", port: 8001, label: "api" },
            { name: "adminApi", port: 8081, label: "admin-api" },
            { name: "worker", port: 8004, label: "worker", optional: true },
          ],
        },
        frontends: {
          root: "web/packages",
          defaults: { build: "npx vite build", out: "dist" },
          apps: [
            { label: "app", package: "app" },
            { label: "admin", package: "admin" },
            { label: "www", package: "site", build: "npm run build", out: "out", static_mode: "html", memory: "6g" },
            {
              label: "docs",
              package: "docs",
              build: "npm run build:docs",
              out: "build",
              static_mode: "files",
              in_build_all: false,
            },
            {
              label: "cms",
              package: "cms",
              serve: "npx next dev --port 3000 --hostname 127.0.0.1",
              port: 3000,
              optional: true,
            },
          ],
        },
        routes: {
          app: { "/api": "api", "/cms": "cms" },
          admin: { "/api/admin": "adminApi", "/api": "api" },
        },
        env: {
          DB_HOST: "${SANDBOXER_DB_HOST}",
          DB_PORT: "${SANDBOXER_DB_PORT}",
          DB_NAME: "${SANDBOXER_DB_NAME}",
          DB_USER: "${SANDBOXER_DB_USER}",
          DB_PASSWORD: "${SANDBOXER_DB_PASSWORD}",
          S3_ENDPOINT: "${SANDBOXER_S3_ENDPOINT}",
          S3_KEY: "${SANDBOXER_S3_KEY}",
          S3_SECRET: "${SANDBOXER_S3_SECRET}",
          S3_BUCKET: "uploads",
          VITE_API_URL: "/api",
          VITE_APP_URL: "${SANDBOXER_URL_APP}",
          VITE_ADMIN_URL: "${SANDBOXER_URL_ADMIN}",
        },
      },
      "/repo/sandboxer.yaml",
    );

    // The seed is an artifact rather than a config field, so it arrives the way
    // a real run supplies it: already resolved to the path the container will
    // open it at, by `seedMount`.
    const plan = planFor(config, { seed: { path: "/sandboxer/cache/acme-3f2a1b.sql.zst", anonymised: true } });

    expect(plan).toEqual(reference("monolith.plan.json"));
  });

  it("worker.plan.json", () => {
    const config = resolveConfig(
      {
        project: "edge-thing",
        sandboxer: ">=0.1.0",
        database: {
          driver: "d1",
          owner: "app",
          seed_from: { file: ".wrangler/state", fixtures: "seeds/fixtures.sql", anonymised: true },
          migrate: { command: "npx wrangler d1 migrations apply DB --local --persist-to $SANDBOXER_D1_DIR" },
        },
        storage: { driver: "none" },
        toolchain: { node: "24" },
        deps: { root: ".", lockfile: "package-lock.json", install: "npm ci --no-audit --no-fund" },
        frontends: {
          root: ".",
          apps: [
            {
              label: "app",
              package: ".",
              serve: "npx wrangler dev --port 8787 --ip 127.0.0.1 --persist-to $SANDBOXER_D1_DIR",
              port: 8787,
              health: "/health",
            },
          ],
        },
        routes: {},
        env: { API_TOKEN: "dummy", APP_URL: "${SANDBOXER_URL_APP}" },
      },
      "/repo/sandboxer.yaml",
    );

    const plan = planFor(config, { seed: { path: "/sandboxer/cache/edge-thing-state", anonymised: true } });
    const want = reference("worker.plan.json");

    // The worked plan leaves `database.name` out and lets `entrypoint.sh` default
    // it to the project. The plan is the fully-resolved projection, so the emitter
    // writes the value the container would have derived rather than leaving one
    // fact to be decided in two places.
    expect(plan.database).toEqual({ ...want.database, name: "edge-thing" });
    expect({ ...plan, database: undefined }).toEqual({ ...want, database: undefined });
  });
});

describe("writePlan", () => {
  it("writes valid JSON where the container mounts it from", async () => {
    const dir = await mkdtemp(join(tmpdir(), "sbx-plan-"));
    const path = join(dir, "build", "acme", "tkt-1.plan.json");
    await writePlan(planFor(full), path);
    const written = JSON.parse(await readFile(path, "utf8")) as Plan;
    expect(written.project).toBe("acme");
    expect(written.services).toHaveLength(6);
  });
});

describe("planPorts", () => {
  it("reads the ports off the plan, so there is one answer to what it listens on", () => {
    expect(planPorts(planFor(full))).toEqual([
      { label: "api", port: 8001 },
      { label: "jobs", port: 8004 },
      { label: "cms", port: 3000 },
    ]);
  });
});
