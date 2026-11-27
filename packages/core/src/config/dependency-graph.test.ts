// Covers the Node install gate from sandboxer.yaml through the generated s6 graph:
// legacy plans, independently declared migrations and backends, inherited overrides,
// served frontends, and projects without a dependency tree.
import { execFileSync } from "node:child_process";
import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { expect, it } from "vitest";

import { resolveConfig } from "./load.js";
import { planFor, type Plan } from "./plan.js";

const container = fileURLToPath(new URL("../../../../container/", import.meta.url));
const base = {
  project: "demo", sandboxer: ">=0.1.0", access: { apps: "private" },
  database: { driver: "mysql", migrate: { command: "go run ./migrate" } },
  storage: { driver: "minio", buckets: ["uploads"] },
  deps: { root: "web" },
  backends: {
    defaults: { build: "go build -o {out} ./{name}" },
    services: [{ name: "api", label: "api", port: 8000 }],
  },
  frontends: { apps: [{ label: "web", package: "web", port: 3000, serve: "npm start" }] },
};

async function graph(tmp: string, plan: Plan) {
  const path = join(tmp, "plan.json");
  const output = join(tmp, "s6");
  await writeFile(path, JSON.stringify(plan));
  execFileSync("bash", [join(container, "scripts/gen-services.sh")], {
    env: { PATH: process.env.PATH, SANDBOXER_PLAN: path, SANDBOXER_SCRIPTS: join(container, "scripts"),
      SANDBOXER_S6_DIR: output, SANDBOXER_S6_SKEL: join(container, "base/s6") },
  });
  return async (service: string) => (await readdir(join(output, service, "dependencies.d"))).sort();
}

it("overlaps opted-out migrations and backends while keeping the database and JS gates", async ctx => {
  const tmp = await mkdtemp(join(tmpdir(), "sandboxer-depgraph-"));
  ctx.onTestFinished(() => rm(tmp, { recursive: true, force: true }));
  const legacy = planFor(resolveConfig(base, "/repo/sandboxer.yaml"));
  const legacyEdges = await graph(tmp, legacy);
  expect(await legacyEdges("db-init")).toEqual(["deps-init", "minio", "mysqld"]);
  expect(await legacyEdges("api")).toEqual(["db-init", "deps-init"]);
  expect(await legacyEdges("web-web")).toEqual(["db-init", "deps-init"]);

  const config = resolveConfig({
    ...base,
    database: { ...base.database, migrate: { ...base.database.migrate, requires_deps: false } },
    backends: {
      defaults: { ...base.backends.defaults, requires_deps: false },
      services: [...base.backends.services, { name: "worker", port: 8001, label: "worker", requires_deps: true }],
    },
  }, "/repo/sandboxer.yaml");
  expect(config.database.migrate?.requiresDeps).toBe(false);
  expect(config.backends.map(service => service.requiresDeps)).toEqual([false, true]);
  const plan = planFor(config);
  expect(plan.database.migrate?.requires_deps).toBe(false);
  const edges = await graph(tmp, plan);
  expect(await edges("db-init")).toEqual(["minio", "mysqld"]);
  expect(await edges("api")).toEqual(["db-init"]);
  expect(await edges("worker")).toEqual(["db-init", "deps-init"]);
  expect(await edges("web-web")).toEqual(["db-init", "deps-init"]);
  expect(await edges("caddy")).toEqual([]);
});

it("retains the legacy gate without a migration and emits no missing Node dependency", async ctx => {
  const tmp = await mkdtemp(join(tmpdir(), "sandboxer-depgraph-"));
  ctx.onTestFinished(() => rm(tmp, { recursive: true, force: true }));
  const document = { ...base, database: { driver: "none" }, storage: { driver: "none" } };
  const edges = await graph(tmp, planFor(resolveConfig(document, "/repo/sandboxer.yaml")));
  expect(await edges("db-init")).toEqual(["deps-init"]);
  const { deps: _deps, ...noNode } = document;
  const bare = await graph(tmp, planFor(resolveConfig(noNode, "/repo/sandboxer.yaml")));
  expect(await bare("db-init")).toEqual([]);
  expect(await bare("api")).toEqual(["db-init"]);
  expect(await bare("web-web")).toEqual(["db-init"]);
});

it("rejects nonboolean Node gate declarations", () => {
  expect(() => resolveConfig({
    ...base, database: { ...base.database, migrate: { ...base.database.migrate, requires_deps: "false" } },
  }, "/repo/sandboxer.yaml")).toThrow(/requires_deps/);
  expect(() => resolveConfig({
    ...base, backends: { ...base.backends, defaults: { ...base.backends.defaults, requires_deps: "false" } },
  }, "/repo/sandboxer.yaml")).toThrow();
});
