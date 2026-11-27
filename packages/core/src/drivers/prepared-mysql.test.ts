// Covers plan validation, physical seed selection, and the opt-in, isolated
// MySQL integration fixture exercising fresh and existing volumes.
import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { expect, it } from "vitest";
import { resolveConfig } from "../config/load.js";
import { planFor } from "../config/plan.js";
import { chooseSeed } from "./seed.js";

const key = "a".repeat(64);
const config = (database: object) =>
  resolveConfig({ project: "demo", sandboxer: ">=0.1.0", database }, "/demo/sandboxer.yaml");

it("requires an exact MySQL artifact key and refuses competing data sources", () => {
  for (const database of [
    { driver: "mysql", prepared_baseline: "../x" },
    { driver: "sqlite", prepared_baseline: key },
    { driver: "mysql", prepared_baseline: key, seed_from: { fixtures: "other.sql" } },
  ]) expect(() => config(database)).toThrow();
  const resolved = config({ driver: "mysql", prepared_baseline: key });
  expect(planFor(resolved).database).toMatchObject({ prepared_baseline: key, name: "demo" });
  expect(chooseSeed(resolved)).toEqual({ source: "prepared" });
  expect(() => chooseSeed(resolved, { prefer: "local" })).toThrow(/seed override/);
});

it("requires a logical MySQL seed for automatic local baseline caching", () => {
  for (const database of [
    { driver: "sqlite", cache_baseline: true, seed_from: { file: "db.sqlite" } },
    { driver: "mysql", cache_baseline: true, prepared_baseline: key },
    { driver: "mysql", cache_baseline: true, seed_from: { fixtures: "fixtures.sql" } },
  ]) expect(() => config(database)).toThrow(/cache_baseline/);
  for (const seed_from of [{ file: "seed.sql.zst" }, { local: { container: "source" } }]) {
    const resolved = resolveConfig({ project: "demo", sandboxer: ">=0.1.0", access: { apps: "private" },
      database: { driver: "mysql", cache_baseline: true, seed_from } }, "/demo/sandboxer.yaml");
    expect(resolved.database.cacheBaseline).toBe(true);
    expect(planFor(resolved).database.cache_baseline).toBe(true);
  }
});

const image = process.env.SANDBOXER_TEST_MYSQL_IMAGE;
it.skipIf(!image)("boots isolated copies of a verified prepared MySQL baseline", async () => {
  const container = fileURLToPath(new URL("../../../../container/", import.meta.url));
  const { stdout } = await promisify(execFile)("docker", ["run", "--rm", "--pull=never", "--network", "none",
    "-v", `${container}scripts:/opt/sandboxer/scripts:ro`, "-v", `${container}tests/mysql-baseline.sh:/test.sh:ro`,
    "--entrypoint", "bash", image!, "/test.sh"]);
  expect(stdout).toContain("Verified two private MySQL servers");
}, 180_000);

it.skipIf(!image)("caches local logical seeds without sharing runtime state", async () => {
  const container = fileURLToPath(new URL("../../../../container/", import.meta.url));
  const { stdout } = await promisify(execFile)("docker", ["run", "--rm", "--pull=never", "--network", "none",
    "-v", `${container}scripts:/opt/sandboxer/scripts:ro`, "-v", `${container}tests/mysql-local-baseline.sh:/test.sh:ro`,
    "--entrypoint", "bash", image!, "/test.sh"]);
  expect(stdout).toContain("Verified local cache miss/hit, changed-seed invalidation, private data/credentials/identity");
}, 180_000);
