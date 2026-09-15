// Pins the top-level docker-compose.yml to this package.
//
// `docker compose up` starts the same three containers `sandboxr init` does, so
// the file is a second spelling of what `routerArgs`, `dashboardArgs` and
// `orchestratorArgs` already decide. This is what stops the two drifting, the way
// `HANDSHAKE_PATH` is pinned across core and the server and `PROTECTED_IMAGES` is
// pinned across naming.ts and access/index.ts. It covers:
//  - the router's image, command, published ports and mount set
//  - the dashboard's image, command, working directory, mount set and labels —
//    including the handshake rule, which is a regular expression nobody should be
//    editing in two places
//  - every variable `FORWARDED_VARIABLES` names is passed through, and the only
//    key compose adds is the one host.env deliberately renames
//  - the orchestrator's mounts, command and environment
//  - the names, the network and the role labels the rest of the tool looks for
//  - the two boundaries the file has to state: it covers no sandbox, and it holds
//    no Telegram credential
//
// The interpolation `docker compose` does is emulated here rather than shelled out
// to, so the suite needs no Docker.

import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { parse } from "yaml";
import { describe, expect, it } from "vitest";

import { CREDENTIALS_ENV } from "../agent/credentials.js";
import { installRoot } from "../install.js";
import { NETWORK } from "../naming.js";
import {
  DASHBOARD_CONTAINER,
  FORWARDED_VARIABLES,
  dashboardArgs,
  dashboardLabels,
} from "./dashboard.js";
import { HOST_ENV_KEYS } from "./host-env.js";
import { ORCHESTRATOR_CONTAINER, orchestratorArgs } from "./orchestrator.js";
import { ROUTER_CONTAINER, regexLiteral, routerArgs } from "./router.js";

const ROOT = installRoot({});
const SOURCE = readFileSync(join(ROOT, "docker-compose.yml"), "utf8");
const EXAMPLE = readFileSync(join(ROOT, ".env.example"), "utf8");
const FILE = parse(SOURCE) as {
  name: string;
  networks: Record<string, { name: string; external: boolean }>;
  services: Record<string, Record<string, unknown>>;
};

/**
 * What `docker compose` would make of a string, given these variables.
 *
 * Two rules, which is all this file uses: `$$` is a literal `$`, and `${NAME}` or
 * `${NAME:-fallback}` is a lookup. Emulated rather than obtained by running
 * `docker compose config`, because a unit test that needs a daemon is a unit test
 * that does not run in CI.
 */
const render = (value: string, vars: Record<string, string>): string =>
  value.replace(/\$\$|\$\{([A-Za-z_][A-Za-z0-9_]*)(?::-([^}]*))?\}/g, (whole, name: string, fallback?: string) => {
    if (whole === "$$") return "$";
    const set = vars[name];
    if (set !== undefined && set !== "") return set;
    return fallback ?? "";
  });

const service = (name: string): Record<string, unknown> => {
  const found = FILE.services[name];
  expect(found, `docker-compose.yml has no "${name}" service`).toBeDefined();
  return found as Record<string, unknown>;
};

const mountsOf = (name: string, vars: Record<string, string>): string[] =>
  ((service(name).volumes as string[]) ?? []).map((mount) => render(mount, vars));

/** The `-v` values out of a `docker run` argument list, in order. */
const runMounts = (args: string[]): string[] =>
  args.flatMap((arg, index) => (arg === "-v" ? [args[index + 1] as string] : []));

/** The `-e KEY=value` keys out of a `docker run` argument list. */
const runEnvKeys = (args: string[]): string[] =>
  args.flatMap((arg, index) => (arg === "-e" ? [(args[index + 1] as string).split("=")[0] as string] : []));

/**
 * A home that is not on this machine, so nothing resolves by accident, plus one
 * directory that really exists — `dashboardArgs` mounts gh's configuration only
 * when it is there, and a test where it is not would assert a shorter mount list
 * than the compose file has.
 */
const ghConfig = mkdtempSync(join(tmpdir(), "sandboxr-gh-"));
const HOME = "/srv/sandboxr-home";
const WORKSPACE = "/srv/sandboxr-workspace";
const DOMAIN = "sbx.example.test";

const env: NodeJS.ProcessEnv = {
  SANDBOXR_HOME: HOME,
  // Outside the home on purpose: inside it, `dashboardArgs` skips the mount
  // rather than binding one tree twice, and the compose file always binds it.
  SANDBOXR_WORKSPACE: WORKSPACE,
  SANDBOXR_INSTALL: ROOT,
  GH_CONFIG_DIR: ghConfig,
};

/** The `.env` a person would have written for that environment. */
const vars: Record<string, string> = {
  SANDBOXR_HOME: HOME,
  SANDBOXR_WORKSPACE: WORKSPACE,
  SANDBOXR_INSTALL: ROOT,
  GH_CONFIG_DIR: ghConfig,
  SANDBOXR_DOMAIN: DOMAIN,
  SANDBOXR_DOMAIN_RE: regexLiteral(DOMAIN),
  SANDBOXR_CLAUDE_CREDENTIALS: "/srv/claude/.credentials.json",
};

describe("the file itself", () => {
  it("is one project, on the shared network the sandboxes are already on", () => {
    expect(FILE.name).toBe("sandboxr");
    // External rather than created: a router on `sandboxr_default` would be on a
    // network no sandbox is on, and every app would 404 at the router.
    expect(FILE.networks.default).toEqual({ name: NETWORK, external: true });
  });

  it("says that it covers no sandbox, because `down` will not stop one", () => {
    // Boundary one. A sandbox is made per worktree at run time and its name is
    // built out of a branch this file could not have known about, so `docker
    // compose down` leaves every one of them running. Somebody has to be told.
    expect(SOURCE).toMatch(/never a sandbox/i);
    expect(SOURCE).toContain("sandboxr down");
    expect(SOURCE).toContain("sandboxr gc");
  });
});

describe("the router", () => {
  const expected = routerArgs({
    files: { config: join(HOME, "state", "traefik.yml"), dynamic: join(HOME, "state", "dynamic") },
    tlsDir: join(HOME, "tls"),
    cert: { name: DOMAIN, certFile: "cert.pem", keyFile: "key.pem", trusted: true },
    bind: "127.0.0.1",
    ports: { http: 80, https: 443 },
  });

  it("is the same container core would run", () => {
    const router = service("router");
    expect(router.container_name).toBe(ROUTER_CONTAINER);
    expect(render(router.image as string, vars)).toBe(expected[expected.length - 2]);
    expect(router.command).toEqual([expected[expected.length - 1]]);
    expect(router.labels).toEqual({ "sandboxr.role": "router" });
    expect(router.restart).toBe("unless-stopped");
  });

  it("mounts what core mounts, in the same order", () => {
    expect(mountsOf("router", vars)).toEqual(runMounts(expected));
  });

  it("publishes the ports core publishes", () => {
    const published = ((service("router").ports as string[]) ?? []).map((port) => render(port, vars));
    const wanted = expected.flatMap((arg, index) => (arg === "-p" ? [expected[index + 1] as string] : []));
    expect(published).toEqual(wanted);
  });
});

describe("the dashboard", () => {
  it("is the same container core would run", () => {
    const dashboard = service("dashboard");
    const args = dashboardArgs({ domain: DOMAIN, tls: true, env });
    expect(dashboard.container_name).toBe(DASHBOARD_CONTAINER);
    expect(render(dashboard.working_dir as string, vars)).toBe(ROOT);
    expect((dashboard.command as string[]).map((part) => render(part, vars))).toEqual([
      "node",
      join(ROOT, "packages", "server", "dist", "bin.js"),
    ]);
    expect(args).toContain("--workdir");
    expect(dashboard.restart).toBe("unless-stopped");
  });

  it("mounts what core mounts, in the same order", () => {
    expect(mountsOf("dashboard", vars)).toEqual(runMounts(dashboardArgs({ domain: DOMAIN, tls: true, env })));
  });

  it("carries the same routers, including the handshake rule", () => {
    // The handshake rule is a Go regular expression assembled from HOST_COMPONENT
    // and HOST_SEPARATOR. Nobody should be maintaining a second copy of it by
    // hand, so this is the assertion that says the copy in YAML is still the one
    // `handshakeRule` produces.
    const labels = Object.fromEntries(
      Object.entries(service("dashboard").labels as Record<string, string>).map(([key, value]) => [
        key,
        render(String(value), { ...vars, SANDBOXR_ENTRYPOINT: "websecure", SANDBOXR_TLS: "true" }),
      ]),
    );
    expect(labels).toEqual({ "sandboxr.role": "dashboard", ...dashboardLabels({ domain: DOMAIN, tls: true }) });
  });

  it("passes through every variable core forwards, and nothing core does not set", () => {
    const declared = (service("dashboard").environment as string[]).map((entry) => entry.split("=")[0] as string);
    // host.env is loaded as an env_file, so its keys are part of what this
    // container ends up with.
    const reaching = new Set([...declared, ...HOST_ENV_KEYS]);
    // tls: false, so that SANDBOXR_INSECURE_COOKIES — which core sets only when
    // there is no certificate to carry a Secure cookie — is in the comparison.
    const wanted = runEnvKeys(
      dashboardArgs({
        domain: DOMAIN,
        tls: false,
        password: "x",
        ghToken: "x",
        gitIdentity: { name: "x", email: "x" },
        claudeCredentials: "/srv/claude/.credentials.json",
        env: { ...env, ...Object.fromEntries(FORWARDED_VARIABLES.map((name) => [name, "set"])) },
      }),
    );

    for (const key of wanted) expect([...reaching], `${key} never reaches the dashboard`).toContain(key);
    // One key over, and it is the deliberate one: host.env writes the setup token
    // under the name Claude Code reads, which is the same secret the dashboard is
    // already given as SANDBOXR_CLAUDE_TOKEN. See access/host-env.ts.
    expect([...reaching].filter((key) => !wanted.includes(key))).toEqual(["CLAUDE_CODE_OAUTH_TOKEN"]);
  });

  it("names every forwarded variable, so none is silently dropped", () => {
    const declared = (service("dashboard").environment as string[]).map((entry) => entry.split("=")[0] as string);
    for (const name of FORWARDED_VARIABLES) expect(declared).toContain(name);
  });
});

describe("the orchestrator", () => {
  const args = orchestratorArgs({
    claudeCredentials: vars.SANDBOXR_CLAUDE_CREDENTIALS as string,
    env: { ...env, SANDBOXR_CLAUDE_TOKEN: "t" },
  });

  it("is the same container core would run, and it idles", () => {
    const orchestrator = service("orchestrator");
    expect(orchestrator.container_name).toBe(ORCHESTRATOR_CONTAINER);
    expect(orchestrator.command).toEqual(["sleep", "infinity"]);
    expect(render(orchestrator.working_dir as string, vars)).toBe(WORKSPACE);
    expect(orchestrator.labels).toEqual({ "sandboxr.role": "orchestrator" });
    // Behind a profile, because its image is built only when the feature is on.
    expect(orchestrator.profiles).toEqual(["orchestrator"]);
  });

  it("mounts what core mounts, in the same order", () => {
    expect(mountsOf("orchestrator", vars)).toEqual(runMounts(args));
  });

  it("gets every variable core gives it", () => {
    const declared = (service("orchestrator").environment as string[]).map((entry) => entry.split("=")[0] as string);
    const reaching = new Set([...declared, ...HOST_ENV_KEYS]);
    for (const key of runEnvKeys(args)) expect([...reaching], `${key} never reaches the orchestrator`).toContain(key);
    // The credential path and the login it names are both core's, so they are
    // asserted rather than assumed.
    expect([...reaching]).toContain(CREDENTIALS_ENV);
  });
});

describe("the sidecars", () => {
  it("reach the dashboard over $SANDBOXR_HOME/run, not a named volume", () => {
    // The dashboard already binds SANDBOXR_HOME at the identical path inside and
    // out, so one SANDBOXR_VOICE_SOCKET value is correct on both sides. A named
    // volume would make the path mean something different in each container.
    for (const name of ["voice", "telegram"]) {
      expect(mountsOf(name, vars)).toContain(`${HOME}/run:/run/sandboxr`);
    }
  });

  it("holds no Telegram credential, here or in .env.example", () => {
    // Boundary two. A bare name takes whatever the shell that ran `docker compose`
    // exported; a `NAME=value` entry would be the credential written down.
    for (const entry of service("telegram").environment as string[]) {
      expect(entry, `${entry} gives a Telegram variable a value in the compose file`).not.toContain("=");
      expect(entry).toMatch(/^SANDBOXR_TELEGRAM_/);
    }
    const assigned = EXAMPLE.split("\n").filter((line) => /^\s*SANDBOXR_TELEGRAM_/.test(line));
    expect(assigned, "a Telegram variable is set in .env.example").toEqual([]);
  });
});

describe(".env.example", () => {
  it("exists, so `cp .env.example .env` is a real instruction", () => {
    expect(existsSync(join(ROOT, ".env.example"))).toBe(true);
  });

  it("names every variable the compose file interpolates without a fallback", () => {
    // A `${NAME}` with no `:-` is required: compose substitutes an empty string
    // and warns, and an empty bind-mount source is a container that will not
    // start for a reason the message does not name.
    const required = new Set<string>();
    for (const match of SOURCE.matchAll(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g)) required.add(match[1] as string);
    for (const name of required) {
      expect(EXAMPLE, `.env.example never mentions ${name}`).toContain(name);
    }
  });
});
