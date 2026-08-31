// Tests for finding, validating and resolving sandboxr.yaml:
// - every shipped example config parses and resolves, checked structurally rather than by value
// - loadConfig: the error when there is no config anywhere (finding one is locate.test.ts's job)
// - the version constraint: satisfied, unsatisfied, unparseable
// - defaults merging for backends and front-ends, including a served app under a static default
// - the three runtime kinds: static, server, and the errors for an app that is neither or both
// - routes: a backend target, a served-front-end target, an unknown target, an unknown label
// - labels: two runtimes cannot share one hostname label; two backends cannot share a name
// - the hostname alphabet: a project or a label holding `--` is refused, because `--` is the separator
// - the DNS-label budget: hostLabels counts `s3`, and a project that leaves no usable slug is refused at load
// - file-backed drivers: the single-owner rule, and an owner that names nothing
// - contracts §5.3: a public sandbox refuses a live fork and an unmarked dump, and accepts fixtures or an anonymised one
// - ConfigError: names the file and the field, for a schema error and for a resolution error

import { readdirSync } from "node:fs";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { SLUG_MIN, slugCeiling } from "../naming.js";
import { ConfigError, hostLabels, loadConfig, resolveConfig } from "./load.js";

const EXAMPLES = new URL("../../../../examples/", import.meta.url).pathname;

/** The smallest config that resolves, as a base for one-field variations. */
const minimal = {
  project: "thing",
  sandboxr: ">=0.1.0",
  access: { apps: "private" },
};

function resolveDoc(document: unknown, file = "/repo/sandboxr.yaml") {
  return resolveConfig(document, file);
}

/**
 * Every example config has to resolve.
 *
 * The assertions are structural rather than value-by-value: the examples exist
 * to demonstrate the schema and are expected to change, and a test that pinned
 * their contents would fail on an edit to a comment. What must never change is
 * that each one parses, resolves and classifies its runtimes correctly.
 *
 * Access enforcement is off here on purpose. "The schema accepts this file" and
 * "this file may run public apps over that data" are different questions;
 * §5.3 is asserted below against configs written for it.
 */
describe("the example configs", () => {
  const files = readdirSync(EXAMPLES).filter((name) => name.endsWith(".yaml") || name.endsWith(".yml"));

  it("finds examples to check", () => {
    expect(files.length).toBeGreaterThan(0);
  });

  it.each(files)("resolves %s", async (name) => {
    const config = await loadConfig(join(EXAMPLES, name), { enforceAccess: false });

    expect(config.project).toMatch(/^[a-z0-9][a-z0-9-]*$/);
    expect(config.file).toBe(join(EXAMPLES, name));
    expect(config.root).toBe(EXAMPLES.replace(/\/$/, ""));
    expect(["mysql", "d1", "sqlite", "none"]).toContain(config.database.driver);
    expect(["public", "private"]).toContain(config.access.apps);
    expect(config.access.controls).toBe("password");

    // A resolved runtime is complete: nothing downstream has to re-derive a
    // build command, an output directory or a port.
    for (const backend of config.backends) {
      expect(backend.build).toBeTruthy();
      expect(backend.port).toBeGreaterThan(0);
    }
    for (const app of config.frontends) {
      if (app.kind === "static") {
        expect(app.out).toBeTruthy();
        expect(app.build).toBeTruthy();
        expect(app.serve).toBeUndefined();
      } else {
        expect(app.serve).toBeTruthy();
        expect(app.port).toBeGreaterThan(0);
        // A served app must not inherit an output directory from a static
        // default block: it has no build to fill one.
        expect(app.out).toBeUndefined();
      }
    }

    // Every route target names something declared, which resolveConfig checks.
    for (const prefixes of Object.values(config.routes)) {
      for (const target of Object.values(prefixes)) expect(target).toBeTruthy();
    }
  });

  it("covers both a server-backed and a file-backed driver between them", async () => {
    const drivers = new Set<string>();
    for (const name of files) {
      drivers.add((await loadConfig(join(EXAMPLES, name), { enforceAccess: false })).database.driver);
    }
    expect(drivers.has("mysql")).toBe(true);
    expect([...drivers].some((driver) => driver === "d1" || driver === "sqlite")).toBe(true);
  });
});

describe("loadConfig", () => {
  it("explains itself when it finds nothing", async () => {
    const dir = await mkdtemp(join(tmpdir(), "sbx-none-"));
    await expect(loadConfig(join(dir, "definitely", "not", "here"))).rejects.toThrow(/sandboxr\.yaml/);
  });
});

describe("the version constraint", () => {
  it("accepts a tool that satisfies it", () => {
    expect(resolveConfig({ ...minimal, sandboxr: ">=0.1.0" }, "/f.yaml", { toolVersion: "0.4.0" }).project).toBe(
      "thing",
    );
  });

  it("refuses a tool that is too old, naming the field", () => {
    try {
      resolveConfig({ ...minimal, sandboxr: ">=2.0.0" }, "/f.yaml", { toolVersion: "0.1.0" });
      expect.unreachable("should have thrown");
    } catch (error) {
      expect(error).toBeInstanceOf(ConfigError);
      expect((error as ConfigError).field).toBe("sandboxr");
      expect((error as ConfigError).message).toContain("/f.yaml");
      expect((error as ConfigError).message).toContain(">=2.0.0");
    }
  });

  it("refuses a constraint it cannot parse", () => {
    expect(() => resolveConfig({ ...minimal, sandboxr: "whenever" }, "/f.yaml")).toThrow(ConfigError);
  });
});

describe("backends", () => {
  it("merges the defaults block into every entry", () => {
    const config = resolveDoc({
      ...minimal,
      backends: {
        defaults: { build: "go build -o {out} ./{name}", workdir: "go", health: "/health" },
        services: [
          { name: "one", port: 1, label: "one" },
          { name: "two", port: 2, label: "two", health: "/healthz" },
        ],
      },
    });
    expect(config.backends[0]).toMatchObject({ workdir: "go", health: "/health", optional: false });
    expect(config.backends[1]?.health).toBe("/healthz");
  });

  it("accepts a bare list for a project with nothing to default", () => {
    const config = resolveDoc({
      ...minimal,
      backends: [{ name: "one", port: 1, label: "one", build: "make" }],
    });
    expect(config.backends).toHaveLength(1);
  });

  it("refuses an entry with no build command anywhere", () => {
    expect(() => resolveDoc({ ...minimal, backends: { services: [{ name: "one", port: 1, label: "one" }] } })).toThrow(
      /build command/,
    );
  });

  it.each([
    ["a port out of range", { name: "a", port: 99999, label: "a", build: "x" }],
    ["a label that is not a hostname label", { name: "a", port: 1, label: "Not A Label", build: "x" }],
    ["an unknown key", { name: "a", port: 1, label: "a", build: "x", healthh: "/h" }],
    ["a missing port", { name: "a", label: "a", build: "x" }],
  ])("refuses %s", (_name, entry) => {
    expect(() => resolveDoc({ ...minimal, backends: { services: [entry] } })).toThrow(ConfigError);
  });
});

describe("front-ends", () => {
  it("classifies a static app and a served app", () => {
    const config = resolveDoc({
      ...minimal,
      frontends: {
        root: "packages",
        defaults: { build: "npx vite build", out: "dist" },
        apps: [
          { label: "app", package: "core" },
          { label: "cms", package: "cms", serve: "npx next dev", port: 3000 },
        ],
      },
    });
    expect(config.frontends[0]).toMatchObject({ kind: "static", out: "dist", build: "npx vite build" });
    expect(config.frontends[1]).toMatchObject({ kind: "server", serve: "npx next dev", port: 3000 });
    expect(config.frontends[1]?.out).toBeUndefined();
    expect(config.frontends[1]?.build).toBeUndefined();
  });

  it("defaults inBuildAll on and lets an entry opt out", () => {
    const config = resolveDoc({
      ...minimal,
      frontends: {
        defaults: { build: "b", out: "dist" },
        apps: [
          { label: "a", package: "a" },
          { label: "b", package: "b", in_build_all: false },
        ],
      },
    });
    expect(config.frontends[0]?.inBuildAll).toBe(true);
    expect(config.frontends[1]?.inBuildAll).toBe(false);
  });

  it("refuses an app that is both a static build and a server", () => {
    expect(() =>
      resolveDoc({
        ...minimal,
        frontends: { apps: [{ label: "a", package: "a", out: "dist", serve: "x", port: 1 }] },
      }),
    ).toThrow(/pick one/);
  });

  it("refuses a served app with no port, which the router would have nowhere to send", () => {
    expect(() => resolveDoc({ ...minimal, frontends: { apps: [{ label: "a", package: "a", serve: "x" }] } })).toThrow(
      /port/,
    );
  });

  it("refuses a static app with no output directory", () => {
    expect(() =>
      resolveDoc({ ...minimal, frontends: { apps: [{ label: "a", package: "a", build: "b" }] } }),
    ).toThrow(/out/);
  });
});

describe("routes", () => {
  const base = {
    ...minimal,
    backends: [{ name: "api", port: 1, label: "api", build: "b" }],
    frontends: {
      defaults: { build: "b", out: "dist" },
      apps: [
        { label: "app", package: "a" },
        { label: "cms", package: "c", serve: "s", port: 2 },
      ],
    },
  };

  it("accepts a backend and a served front-end as targets", () => {
    const config = resolveDoc({ ...base, routes: { app: { "/api": "api", "/cms": "cms" } } });
    expect(config.routes.app?.["/cms"]).toBe("cms");
  });

  it("refuses a target that names nothing", () => {
    expect(() => resolveDoc({ ...base, routes: { app: { "/api": "nope" } } })).toThrow(/neither a backend/);
  });

  it("refuses a route on a label no front-end has", () => {
    expect(() => resolveDoc({ ...base, routes: { nope: { "/api": "api" } } })).toThrow(/no front-end is labelled/);
  });

  it("refuses a prefix that is not a path", () => {
    expect(() => resolveDoc({ ...base, routes: { app: { api: "api" } } })).toThrow(ConfigError);
  });
});

describe("labels and names", () => {
  it("refuses two runtimes on one hostname label", () => {
    expect(() =>
      resolveDoc({
        ...minimal,
        backends: [{ name: "one", port: 1, label: "app", build: "b" }],
        frontends: { apps: [{ label: "app", package: "a", build: "b", out: "dist" }] },
      }),
    ).toThrow(/already used by/);
  });

  it("refuses two backends with one name", () => {
    expect(() =>
      resolveDoc({
        ...minimal,
        backends: [
          { name: "one", port: 1, label: "a", build: "b" },
          { name: "one", port: 2, label: "b", build: "b" },
        ],
      }),
    ).toThrow(/two backends/);
  });

  // `--` is what a flattened hostname divides on (contracts §3.2), so a
  // component holding one would make `a--b--c--d.<domain>` unreadable.
  it("refuses a project name holding a double dash", () => {
    expect(() => resolveDoc({ ...minimal, project: "acme--web" })).toThrow(ConfigError);
  });

  it("refuses a label holding a double dash", () => {
    expect(() =>
      resolveDoc({ ...minimal, backends: [{ name: "one", port: 1, label: "admin--api", build: "b" }] }),
    ).toThrow(ConfigError);
  });
});

describe("the DNS-label budget (contracts §3.1)", () => {
  // The store answers on a hostname like any other app, so it spends the same
  // budget. A project whose arithmetic ignored it would have exactly one
  // hostname over the limit and every other one fine.
  it("counts the reserved s3 label", () => {
    const config = resolveDoc({ ...minimal, storage: { driver: "minio", buckets: ["a"] } });
    expect(hostLabels(config)).toContain("s3");
  });

  // The example the rule was written from: the subtraction allows 40, and the
  // lock-name ceiling of 31 still wins.
  it("accepts a project whose budget is generous, at the unchanged ceiling", () => {
    const config = resolveDoc({
      ...minimal,
      project: "redeployable",
      backends: [{ name: "one", port: 1, label: "company", build: "b" }],
    });
    expect(slugCeiling(config.project, hostLabels(config))).toBe(31);
  });

  // The case that actually binds, and the reason this is checked at load rather
  // than discovered at `up` as a hostname that resolves to nothing.
  it("accepts a project whose budget binds, and lowers the ceiling", () => {
    const config = resolveDoc({
      ...minimal,
      project: "redeployable-platform-services",
      backends: [{ name: "one", port: 1, label: "admin-console", build: "b" }],
    });
    expect(slugCeiling(config.project, hostLabels(config))).toBe(16);
  });

  it("refuses a project that leaves no usable slug, naming all three numbers", () => {
    const project = "a-really-long-project-name-that-eats-the-whole-budget";
    let thrown: unknown;
    try {
      resolveDoc({ ...minimal, project, backends: [{ name: "one", port: 1, label: "administration", build: "b" }] });
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(ConfigError);
    const message = (thrown as ConfigError).message;
    expect(message).toContain(project);
    expect(message).toContain("administration");
    expect(message).toContain(String(SLUG_MIN));
  });
});

describe("file-backed drivers", () => {
  const d1 = (extra: Record<string, unknown>) => ({
    ...minimal,
    database: { driver: "d1", seed_from: { fixtures: "seeds/f.sql" }, migrate: { command: "x" }, ...extra },
    frontends: {
      apps: [
        { label: "app", package: ".", serve: "a", port: 1 },
        { label: "other", package: ".", serve: "b", port: 2 },
      ],
    },
  });

  it("accepts an owner that names a declared runtime", () => {
    expect(resolveDoc(d1({ owner: "app" })).database.owner).toBe("app");
  });

  // Two processes opening one file deadlock, so the config has to say which one
  // owns it as soon as there is more than one candidate.
  it("refuses to guess the owner when several runtimes could write", () => {
    expect(() => resolveDoc(d1({}))).toThrow(/one writer/);
  });

  it("does not need an owner when there is only one runtime", () => {
    const config = resolveDoc({
      ...minimal,
      database: { driver: "sqlite", seed_from: { fixtures: "f.sql" }, migrate: { command: "x" } },
      frontends: { apps: [{ label: "app", package: ".", serve: "a", port: 1 }] },
    });
    expect(config.database.owner).toBeUndefined();
  });

  it("refuses an owner that names nothing", () => {
    expect(() => resolveDoc(d1({ owner: "ghost" }))).toThrow(/not a declared backend/);
  });
});

describe("public sandboxes (contracts §5.3)", () => {
  const publicWith = (seed: Record<string, unknown>) => ({
    project: "p",
    sandboxr: ">=0.1.0",
    access: { apps: "public" },
    database: { driver: "mysql", seed_from: seed, migrate: { command: "x" } },
  });

  it("refuses a live fork", () => {
    try {
      resolveDoc(publicWith({ local: { container: "db", database: "prod" } }));
      expect.unreachable("should have thrown");
    } catch (error) {
      expect(error).toBeInstanceOf(ConfigError);
      expect((error as ConfigError).field).toBe("database.seed_from.local");
      expect((error as ConfigError).message).toMatch(/data leak/);
    }
  });

  it("refuses a dump that is not marked anonymised", () => {
    expect(() => resolveDoc(publicWith({ file: "/seeds/dump.sql.zst" }))).toThrow(/anonymised/);
  });

  it("accepts a dump that says it is anonymised", () => {
    expect(resolveDoc(publicWith({ file: "/seeds/dump.sql.zst", anonymised: true })).access.apps).toBe("public");
  });

  it("accepts fixtures, even alongside a live fork it may not use", () => {
    const config = resolveDoc(
      publicWith({ local: { container: "db" }, file: "/seeds/d.sql", fixtures: "seeds/f.sql" }),
    );
    expect(config.access.apps).toBe("public");
  });

  it("lets a private sandbox fork live data, which is what private is for", () => {
    const config = resolveDoc({
      ...publicWith({ local: { container: "db" } }),
      access: { apps: "private" },
    });
    expect(config.access.apps).toBe("private");
  });

  it("can be asked not to enforce, for a tool that only describes a config", () => {
    const config = resolveConfig(publicWith({ local: { container: "db" } }), "/f.yaml", { enforceAccess: false });
    expect(config.access.apps).toBe("public");
  });

  it("defaults apps to public, so a config that says nothing gets the safe seed rules", () => {
    expect(() =>
      resolveDoc({
        project: "p",
        sandboxr: ">=0.1.0",
        database: { driver: "mysql", seed_from: { local: { container: "db" } }, migrate: { command: "x" } },
      }),
    ).toThrow(ConfigError);
  });
});

describe("ConfigError", () => {
  it("names the file and the field for a schema error", () => {
    try {
      resolveDoc({ project: "Not Valid", sandboxr: ">=0.1.0" });
      expect.unreachable("should have thrown");
    } catch (error) {
      expect((error as ConfigError).file).toBe("/repo/sandboxr.yaml");
      expect((error as ConfigError).field).toBe("project");
    }
  });

  it("rejects an unknown top-level key rather than ignoring it", () => {
    expect(() => resolveDoc({ ...minimal, frontend: [] })).toThrow(ConfigError);
  });

  it("rejects a driver with nothing to do", () => {
    expect(() => resolveDoc({ ...minimal, database: { driver: "mysql" } })).toThrow(/nothing to do/);
  });

  it("reports invalid YAML against the file", async () => {
    const dir = await mkdtemp(join(tmpdir(), "sbx-bad-"));
    const file = join(dir, "sandboxr.yaml");
    await writeFile(file, "project: [unclosed\n");
    await expect(loadConfig(file)).rejects.toThrow(/not valid YAML/);
  });

  it("reports an empty file", async () => {
    const dir = await mkdtemp(join(tmpdir(), "sbx-empty-"));
    const file = join(dir, "sandboxr.yaml");
    await writeFile(file, "\n");
    await expect(loadConfig(file)).rejects.toThrow(/is empty/);
  });
});
