// Tests for the dashboard container's `docker run` arguments:
// - the mount set, asserted exactly: the socket, SANDBOXR_HOME and the installation, nothing more
// - the password is passed through, or omitted entirely
// - a GitHub token is passed as a value, and omitted entirely when there is none
// - Secure cookies are dropped only when there is no TLS to carry them
// - two Traefik routers onto one service: the bare domain, and the reserved handshake path on any
//   sandbox hostname
// - the handshake router outranks a sandbox's own rule and carries no forward-auth middleware
// - the agent-session variables are forwarded from the host, and a blank one is omitted rather
//   than passed through as an empty value

import { describe, expect, it } from "vitest";

import { DASHBOARD_CONTAINER, DASHBOARD_PORT, dashboardArgs } from "./dashboard.js";
import { AUTH_MIDDLEWARE, HANDSHAKE_PRIORITY, HANDSHAKE_ROUTER, handshakeRule } from "./router.js";

/**
 * The mount set is the dashboard's blast radius.
 *
 * This container holds the Docker socket, so every path handed to it is a path
 * a stolen session can read. It is also, on macOS, a path shared into the Linux
 * VM — and a share large enough to cover a developer's whole home directory is
 * enough to wedge the daemon under load. Both reasons point the same way, so the
 * list is asserted exactly rather than "contains what we need": a mount added
 * without thinking about it should fail this test.
 */
const mountsOf = (args: string[]): string[] =>
  args.flatMap((arg, index) => (arg === "-v" ? [args[index + 1] as string] : []));

/** The `--label key=value` pairs, as a map. */
const labelsOf = (args: string[]): Record<string, string> => {
  const out: Record<string, string> = {};
  for (let i = 0; i < args.length - 1; i++) {
    if (args[i] !== "--label") continue;
    const [key, ...rest] = (args[i + 1] as string).split("=");
    out[key as string] = rest.join("=");
  }
  return out;
};

const env = {
  HOME: "/Users/dev",
  SANDBOXR_HOME: "/Users/dev/.sandboxr",
  SANDBOXR_INSTALL: "/opt/sandboxr-install",
};

describe("dashboardArgs", () => {
  it("mounts the socket, SANDBOXR_HOME and the installation — and nothing else", () => {
    expect(mountsOf(dashboardArgs({ domain: "sbx.localhost", tls: true, env }))).toEqual([
      "/var/run/docker.sock:/var/run/docker.sock",
      "/Users/dev/.sandboxr:/Users/dev/.sandboxr",
      "/opt/sandboxr-install:/opt/sandboxr-install:ro",
    ]);
  });

  it("never mounts the home directory", () => {
    // The regression this guards: an earlier version mounted all of $HOME so the
    // dashboard could read a worktree's sandboxr.yaml. It reads the plan under
    // SANDBOXR_HOME instead, so no worktree needs to be reachable at all.
    const mounts = mountsOf(dashboardArgs({ domain: "sbx.localhost", tls: true, env }));
    expect(mounts).not.toContain("/Users/dev:/Users/dev:ro");
    expect(mounts.some((mount) => mount.startsWith("/Users/dev:"))).toBe(false);
  });

  it("mounts the installation even when it sits inside the home directory", () => {
    // The old code skipped this mount whenever the install was under $HOME,
    // because the blanket home mount already covered it. Nothing covers it now.
    const inside = { ...env, SANDBOXR_INSTALL: "/Users/dev/code/sandboxr" };
    expect(mountsOf(dashboardArgs({ domain: "sbx.localhost", tls: true, env: inside }))).toContain(
      "/Users/dev/code/sandboxr:/Users/dev/code/sandboxr:ro",
    );
  });

  it("passes the password through, and omits it entirely when there is none", () => {
    const withPassword = dashboardArgs({ domain: "sbx.localhost", tls: true, password: "hunter2", env });
    expect(withPassword).toContain("SANDBOXR_PASSWORD=hunter2");

    const without = dashboardArgs({ domain: "sbx.localhost", tls: true, env });
    expect(without.some((arg) => arg.startsWith("SANDBOXR_PASSWORD"))).toBe(false);
  });

  it("drops Secure cookies only when there is no TLS to carry them", () => {
    const plain = dashboardArgs({ domain: "sbx.localhost", tls: false, env });
    expect(plain).toContain("SANDBOXR_INSECURE_COOKIES=1");

    const secure = dashboardArgs({ domain: "sbx.localhost", tls: true, env });
    expect(secure.some((arg) => arg.startsWith("SANDBOXR_INSECURE_COOKIES"))).toBe(false);
  });
});

describe("the dashboard's two routers", () => {
  const labels = (tls = true) => labelsOf(dashboardArgs({ domain: "sbx.localhost", tls, env }));

  it("serves the control plane on the bare domain and nowhere else", () => {
    expect(labels()[`traefik.http.routers.${DASHBOARD_CONTAINER}.rule`]).toBe("Host(`sbx.localhost`)");
    expect(labels()[`traefik.http.services.${DASHBOARD_CONTAINER}.loadbalancer.server.port`]).toBe(
      String(DASHBOARD_PORT),
    );
    expect(dashboardArgs({ domain: "sbx.localhost", tls: true, env })).toContain(
      `SANDBOXR_PORT=${DASHBOARD_PORT}`,
    );
  });

  // The one deliberate exception to "the dashboard never answers on a sandbox
  // hostname". The cookie that opens a private app has to be set *on* that app's
  // hostname, and only something answering there can set it.
  it("also answers the reserved handshake path on any sandbox hostname", () => {
    expect(labels()[`traefik.http.routers.${HANDSHAKE_ROUTER}.rule`]).toBe(handshakeRule("sbx.localhost"));
    // One service, two routers, so each has to say which service it means.
    expect(labels()[`traefik.http.routers.${HANDSHAKE_ROUTER}.service`]).toBe(DASHBOARD_CONTAINER);
    expect(labels()[`traefik.http.services.${HANDSHAKE_ROUTER}.loadbalancer.server.port`]).toBeUndefined();
  });

  it("gives the handshake an explicit priority rather than leaving it to rule length", () => {
    expect(labels()[`traefik.http.routers.${HANDSHAKE_ROUTER}.priority`]).toBe(String(HANDSHAKE_PRIORITY));
  });

  // The request whose entire purpose is to obtain a credential cannot be made to
  // present that credential first.
  it("puts no forward-auth in front of either router", () => {
    for (const router of [DASHBOARD_CONTAINER, HANDSHAKE_ROUTER]) {
      expect(labels()[`traefik.http.routers.${router}.middlewares`], router).toBeUndefined();
    }
    expect(Object.values(labels())).not.toContain(AUTH_MIDDLEWARE);
  });

  it("follows the router onto the web entry point when there is no certificate", () => {
    for (const router of [DASHBOARD_CONTAINER, HANDSHAKE_ROUTER]) {
      expect(labels(false)[`traefik.http.routers.${router}.entrypoints`], router).toBe("web");
      expect(labels(false)[`traefik.http.routers.${router}.tls`], router).toBeUndefined();
    }
  });
});

describe("the GitHub token", () => {
  const env = { SANDBOXR_HOME: "/home/dev/.sandboxr", HOME: "/home/dev" };

  // As a value, not a mounted file. On macOS `gh` keeps the token in the login
  // keychain, so the mounted ~/.config/gh names the user and carries no
  // credential — and a private clone then fails with "could not read Username
  // for 'https://github.com'", which reads like a missing prompt.
  it("reaches the container as GH_TOKEN", () => {
    const args = dashboardArgs({ domain: "sbx.localhost", tls: true, ghToken: "gho_example", env });
    expect(args).toContain("GH_TOKEN=gho_example");
  });

  it("is omitted entirely when there is none, rather than sent empty", () => {
    const args = dashboardArgs({ domain: "sbx.localhost", tls: true, env });
    expect(args.some((arg) => arg.startsWith("GH_TOKEN="))).toBe(false);
  });
});

/**
 * The agent-session settings reach the container as *values*, because there is
 * nothing to mount: on macOS `claude` keeps its credential in the login
 * keychain, so a mounted config directory carries no token at all.
 *
 * Blank is treated as absent throughout. An exported-but-empty variable is what
 * a shell profile that sets something conditionally leaves behind, and passing
 * it on would turn "this machine has no credential" — which the dashboard can
 * explain — into "the credential is the empty string", which it cannot.
 */
describe("the agent-session variables", () => {
  const varsOf = (args: string[]): Record<string, string> => {
    const out: Record<string, string> = {};
    for (let i = 0; i < args.length - 1; i++) {
      if (args[i] !== "-e") continue;
      const [key, ...rest] = (args[i + 1] as string).split("=");
      out[key as string] = rest.join("=");
    }
    return out;
  };

  it("forwards each one the host set", () => {
    const vars = varsOf(
      dashboardArgs({
        domain: "sbx.localhost",
        tls: true,
        env: {
          ...env,
          SANDBOXR_CLAUDE_TOKEN: "sk-ant-oat01-example",
          SANDBOXR_CLAUDE_MODEL: "claude-opus-5",
          SANDBOXR_CLAUDE_MCP: '{"mcpServers":{}}',
          SANDBOXR_CLAUDE_PERMISSION_MODE: "auto",
        },
      }),
    );
    expect(vars.SANDBOXR_CLAUDE_TOKEN).toBe("sk-ant-oat01-example");
    expect(vars.SANDBOXR_CLAUDE_MODEL).toBe("claude-opus-5");
    expect(vars.SANDBOXR_CLAUDE_MCP).toBe('{"mcpServers":{}}');
    expect(vars.SANDBOXR_CLAUDE_PERMISSION_MODE).toBe("auto");
  });

  it("omits one the host never set, and one it set to blank", () => {
    const vars = varsOf(
      dashboardArgs({
        domain: "sbx.localhost",
        tls: true,
        env: { ...env, SANDBOXR_CLAUDE_TOKEN: "   " },
      }),
    );
    expect(vars).not.toHaveProperty("SANDBOXR_CLAUDE_TOKEN");
    expect(vars).not.toHaveProperty("SANDBOXR_CLAUDE_MODEL");
  });

  it("forwards nothing else beginning SANDBOXR_CLAUDE", () => {
    // A named list rather than a prefix match, so a variable a later version
    // gives a different meaning to is not handed to the container by accident.
    const vars = varsOf(
      dashboardArgs({
        domain: "sbx.localhost",
        tls: true,
        env: { ...env, SANDBOXR_CLAUDE_SOMETHING_ELSE: "no" },
      }),
    );
    expect(vars).not.toHaveProperty("SANDBOXR_CLAUDE_SOMETHING_ELSE");
  });
});
