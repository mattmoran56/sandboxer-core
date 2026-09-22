// Tests for what the host tells a container about itself:
// - the slug, project, domain and access mode are always present
// - database credentials only for a server driver; storage credentials only when storage is declared
// - optional runtimes and the chosen seed source are passed when given
// - nothing describing where something runs is exported: the container derives those itself
// - envKeyFor: a dashed label folds to an env-safe key
// - urlsFor / hostsFor: one entry per label, default and overridden domain
// - renderEnvFile: sorted, unquoted, with a header

import { describe, expect, it } from "vitest";

import { resolveConfig } from "../config/load.js";
import type { ResolvedConfig } from "../config/types.js";
import { containerEnv, envKeyFor, hostsFor, renderEnvFile, urlsFor } from "./env.js";

function config(extra: Record<string, unknown>): ResolvedConfig {
  return resolveConfig(
    { project: "acme", sandboxer: ">=0.1.0", access: { apps: "private" }, ...extra },
    "/repo/sandboxer.yaml",
  );
}

const withRuntimes = config({
  database: { driver: "mysql", seed_from: { fixtures: "f.sql" }, migrate: { command: "m" } },
  backends: [
    { name: "api", port: 8001, label: "api", build: "b" },
    { name: "billingApi", port: 8002, label: "billing-api", build: "b" },
  ],
  frontends: {
    defaults: { build: "build", out: "dist" },
    apps: [
      { label: "app", package: "web" },
      { label: "cms", package: "cms", serve: "serve", port: 3000 },
    ],
  },
  storage: { driver: "minio", buckets: ["uploads"] },
});

describe("containerEnv", () => {
  const env = containerEnv({ config: withRuntimes, slug: "tkt-1", domain: "sbx.localhost" });

  it("identifies the sandbox, which is the one thing the container cannot derive", () => {
    expect(env).toMatchObject({
      SANDBOXER_SLUG: "tkt-1",
      SANDBOXER_PROJECT: "acme",
      SANDBOXER_DOMAIN: "sbx.localhost",
      SANDBOXER_ACCESS: "private",
    });
  });

  it("passes the credentials the sandbox's own server is created with", () => {
    expect(env.SANDBOXER_DB_USER).toBe("sandboxer");
    expect(env.SANDBOXER_DB_PASSWORD).toBe("sandboxer");
    expect(env.SANDBOXER_S3_KEY).toBe("sandboxer");
  });

  it("takes credentials it is handed", () => {
    const custom = containerEnv({
      config: withRuntimes,
      slug: "s",
      database: { user: "u", password: "pw" },
      storage: { key: "k", secret: "s3" },
    });
    expect(custom).toMatchObject({ SANDBOXER_DB_USER: "u", SANDBOXER_DB_PASSWORD: "pw", SANDBOXER_S3_KEY: "k" });
  });

  it("says nothing about a database for a project with none", () => {
    const bare = containerEnv({ config: config({ database: { driver: "none" } }), slug: "s" });
    expect(bare.SANDBOXER_DB_USER).toBeUndefined();
  });

  it("says nothing about storage unless storage is declared", () => {
    const bare = containerEnv({ config: config({ database: { driver: "none" } }), slug: "s" });
    expect(bare.SANDBOXER_S3_KEY).toBeUndefined();
  });

  it("passes optional runtimes and the chosen seed source when given", () => {
    const env2 = containerEnv({ config: withRuntimes, slug: "s", with: ["cms", "jobs"], seed: "fixtures" });
    expect(env2.SANDBOXER_WITH).toBe("cms,jobs");
    expect(env2.SANDBOXER_SEED).toBe("fixtures");
  });

  // The container derives every address itself, and the plan's `env` map joins
  // those to the project's own names. Exporting them here as well would be a
  // second place the same fact is decided.
  it("exports nothing describing where a service or a database is", () => {
    for (const key of Object.keys(env)) {
      expect(key.startsWith("SANDBOXER_")).toBe(true);
    }
    expect(env.DB_HOST).toBeUndefined();
    expect(env.SANDBOXER_URL_APP).toBeUndefined();
    expect(env.CORS_ALLOWED_ORIGINS).toBeUndefined();
  });
});

describe("envKeyFor", () => {
  it.each([
    ["api", "API"],
    ["billing-api", "BILLING_API"],
    ["profile-pics", "PROFILE_PICS"],
  ])("folds %s", (label, want) => {
    expect(envKeyFor(label)).toBe(want);
  });
});

describe("urlsFor and hostsFor", () => {
  it("cover every label once", () => {
    const urls = urlsFor(withRuntimes, "tkt-1");
    expect(Object.keys(urls).sort()).toEqual(["api", "app", "billing-api", "cms"]);
    expect(hostsFor(withRuntimes, "tkt-1")).toHaveLength(4);
  });

  it("uses the default domain, and an override when given", () => {
    expect(urlsFor(withRuntimes, "s").app).toBe("https://s--app--acme.sbx.localhost");
    expect(urlsFor(withRuntimes, "s", "sbx.dev").app).toBe("https://s--app--acme.sbx.dev");
  });
});

describe("renderEnvFile", () => {
  it("sorts the keys, so a diff between two sandboxes is readable", () => {
    expect(renderEnvFile({ B: "2", A: "1" })).toBe("A=1\nB=2\n");
  });

  // docker's --env-file does not interpret quotes and would carry them into
  // the value.
  it("does not quote values", () => {
    expect(renderEnvFile({ A: "one two" })).toContain("A=one two");
  });

  it("writes a header when given one", () => {
    expect(renderEnvFile({ A: "1" }, "generated")).toBe("# generated\n\nA=1\n");
  });

  it("handles an empty value", () => {
    expect(renderEnvFile({ A: "" })).toBe("A=\n");
  });
});
