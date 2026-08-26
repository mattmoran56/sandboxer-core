import { describe, expect, it } from "vitest";

import { DASHBOARD_CONTAINER, DASHBOARD_PORT, dashboardArgs } from "./dashboard.js";

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

  it("answers on the bare domain only", () => {
    const args = dashboardArgs({ domain: "sbx.localhost", tls: true, env });
    const rule = args.find((arg) => arg.includes("rule=Host("));
    expect(rule).toContain("Host(`sbx.localhost`)");
    expect(args).toContain(`SANDBOXR_PORT=${DASHBOARD_PORT}`);
    expect(args).toContain(DASHBOARD_CONTAINER);
  });
});
