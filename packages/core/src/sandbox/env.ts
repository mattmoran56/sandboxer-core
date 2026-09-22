/**
 * What the host tells a container about itself.
 *
 * Deliberately small. The container *derives* where everything is — the
 * database inside it, the object storage inside it, each app's own hostname —
 * and exports those under a `SANDBOXER_` prefix; the plan's `env` map then joins
 * those to the project's own variable names. So the host supplies only the
 * handful of facts the container cannot work out for itself: which slug this is,
 * which domain it answers on, and the credentials its own services are created
 * with.
 *
 * Contracts §5.2 is the reason for the split: anything describing *where*
 * something runs is computed rather than imported, because importing a
 * developer's `DB_HOST` would point a disposable copy at their real database.
 */

import type { ResolvedConfig } from "../config/types.js";
import { DEFAULT_DOMAIN, hostFor, urlFor } from "../naming.js";

export interface ContainerEnvInput {
  config: ResolvedConfig;
  slug: string;
  domain?: string | undefined;
  /** Credentials the sandbox's own database is created with. */
  database?: { user: string; password: string } | undefined;
  /** Credentials the sandbox's own object storage is created with. */
  storage?: { key: string; secret: string } | undefined;
  /** Optional runtimes to start. */
  with?: string[] | undefined;
  /** Which seed source was chosen, so the container can say what it restored. */
  seed?: string | undefined;
  /** Whether the router in front terminates TLS. Absent means it does. */
  scheme?: "http" | "https" | undefined;
  /**
   * The port the router is published on, when it is not the scheme's default.
   *
   * The container builds every SANDBOXER_URL_<LABEL> from this, and a URL with
   * the port missing points at whatever else owns 443 on the machine.
   */
  publicPort?: string | undefined;
}

/** Turns a hostname label into the variable-name form of itself. */
export function envKeyFor(label: string): string {
  return label.toUpperCase().replace(/[^A-Z0-9]/g, "_");
}

export function containerEnv(input: ContainerEnvInput): Record<string, string> {
  const domain = input.domain ?? DEFAULT_DOMAIN;
  const database = input.database ?? { user: "sandboxer", password: "sandboxer" };
  const storage = input.storage ?? { key: "sandboxer", secret: "sandboxer" };

  const env: Record<string, string> = {
    // The one required variable: the container knows its project from the plan,
    // but only the host knows which worktree this is.
    SANDBOXER_SLUG: input.slug,
    SANDBOXER_PROJECT: input.config.project,
    SANDBOXER_DOMAIN: domain,
    SANDBOXER_ACCESS: input.config.access.apps,
    // The container builds SANDBOXER_URL_<LABEL> from these two. Only the host
    // knows whether the shared router found a certificate to serve, and on which
    // port it ended up.
    SANDBOXER_SCHEME: input.scheme ?? "https",
    SANDBOXER_PUBLIC_PORT: input.publicPort ?? "",
  };

  if (input.config.database.driver === "mysql") {
    env.SANDBOXER_DB_USER = database.user;
    env.SANDBOXER_DB_PASSWORD = database.password;
  }
  if (input.config.storage.driver === "minio") {
    env.SANDBOXER_S3_KEY = storage.key;
    env.SANDBOXER_S3_SECRET = storage.secret;
  }
  if (input.with && input.with.length > 0) env.SANDBOXER_WITH = input.with.join(",");
  if (input.seed) env.SANDBOXER_SEED = input.seed;

  return env;
}

/** The hostname each label answers on, which `status` and the CLI both print. */
export function urlsFor(
  config: ResolvedConfig,
  slug: string,
  domain = DEFAULT_DOMAIN,
  scheme: "http" | "https" = "https",
  portSuffix = "",
): Record<string, string> {
  const urls: Record<string, string> = {};
  for (const runtime of [...config.frontends, ...config.backends]) {
    urls[runtime.label] = `${urlFor({ slug, label: runtime.label, project: config.project, domain, scheme })}${portSuffix}`;
  }
  return urls;
}

export function hostsFor(config: ResolvedConfig, slug: string, domain = DEFAULT_DOMAIN): string[] {
  return [...config.frontends, ...config.backends].map((runtime) =>
    hostFor({ slug, label: runtime.label, project: config.project, domain }),
  );
}

/**
 * Renders an environment as a file.
 *
 * Values are written raw rather than quoted, because this file is read by
 * `docker run --env-file`, which does not interpret quotes and would carry them
 * into the value.
 */
export function renderEnvFile(env: Record<string, string>, header?: string): string {
  const lines = header ? [`# ${header}`, ""] : [];
  for (const key of Object.keys(env).sort()) {
    lines.push(`${key}=${env[key] ?? ""}`);
  }
  lines.push("");
  return lines.join("\n");
}
