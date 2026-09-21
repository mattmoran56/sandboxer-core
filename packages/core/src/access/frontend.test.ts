// Tests for the front end: a container on the bare domain (contracts §7.2).
// - frontendRouteLabels: the label set is exactly what dashboard.test.ts asserts
//   today, for a container the engine has never heard of
// - frontendRouteLabels: two routers onto one service, and the second one names it
// - frontendRouteLabels: the handshake carries an explicit priority and no forward-auth
// - frontendRouteLabels: no certificate puts both routers on the web entry point
// - frontendRouteLabels: `sandboxr.frontend` is stamped, which is what listFrontends finds
// - listFrontends: the label filter, stopped containers included, and a daemon
//   that will not answer reading as "nothing is on the bare domain"

import { describe, expect, it } from "vitest";

import type { ContainerRow, Docker } from "../docker.js";
import { FRONTEND_LABEL, frontendRouteLabels, listFrontends } from "./frontend.js";
import { AUTH_MIDDLEWARE, HANDSHAKE_PRIORITY, HANDSHAKE_ROUTER, handshakeRule } from "./router.js";

const ROUTE = { container: "acme-console", port: 9100, domain: "sbx.localhost", tls: true };

const labels = (tls = true): Record<string, string> => frontendRouteLabels({ ...ROUTE, tls });

describe("frontendRouteLabels", () => {
  it("serves the control plane on the bare domain and nowhere else", () => {
    expect(labels()["traefik.enable"]).toBe("true");
    expect(labels()[`traefik.http.routers.${ROUTE.container}.rule`]).toBe("Host(`sbx.localhost`)");
    expect(labels()[`traefik.http.services.${ROUTE.container}.loadbalancer.server.port`]).toBe("9100");
  });

  // The one deliberate exception to "the front end never answers on a sandbox
  // hostname". The cookie that opens a private app has to be set *on* that app's
  // hostname, and only something answering there can set it.
  it("also answers the reserved handshake path on any sandbox hostname", () => {
    expect(labels()[`traefik.http.routers.${HANDSHAKE_ROUTER}.rule`]).toBe(handshakeRule("sbx.localhost"));
    // One service, two routers, so each has to say which service it means.
    expect(labels()[`traefik.http.routers.${HANDSHAKE_ROUTER}.service`]).toBe(ROUTE.container);
    expect(labels()[`traefik.http.services.${HANDSHAKE_ROUTER}.loadbalancer.server.port`]).toBeUndefined();
  });

  it("gives the handshake an explicit priority rather than leaving it to rule length", () => {
    expect(labels()[`traefik.http.routers.${HANDSHAKE_ROUTER}.priority`]).toBe(String(HANDSHAKE_PRIORITY));
  });

  // The request whose entire purpose is to obtain a credential cannot be made to
  // present that credential first.
  it("puts no forward-auth in front of either router", () => {
    for (const router of [ROUTE.container, HANDSHAKE_ROUTER]) {
      expect(labels()[`traefik.http.routers.${router}.middlewares`], router).toBeUndefined();
    }
    expect(Object.values(labels())).not.toContain(AUTH_MIDDLEWARE);
  });

  it("follows the router onto the web entry point when there is no certificate", () => {
    for (const router of [ROUTE.container, HANDSHAKE_ROUTER]) {
      expect(labels(false)[`traefik.http.routers.${router}.entrypoints`], router).toBe("web");
      expect(labels(false)[`traefik.http.routers.${router}.tls`], router).toBeUndefined();
    }
  });

  // What `parseAccessLog` and `expire` read to tell a front end from a sandbox.
  // Without it a front end's own container would be read as a sandbox that has
  // gone idle, and its log lines as traffic to one.
  it("stamps the label that says this container is on the bare domain", () => {
    expect(labels()[FRONTEND_LABEL]).toBe("true");
  });
});

const row = (name: string, state: string): ContainerRow => ({ name, id: name, state, labels: {} });

function fakeDocker(rows: ContainerRow[] | Error): { docker: Docker; filters: string[][] } {
  const filters: string[][] = [];
  const docker = {
    async ps(given: string[]) {
      filters.push(given);
      if (rows instanceof Error) throw rows;
      return rows;
    },
  } as unknown as Docker;
  return { docker, filters };
}

describe("listFrontends", () => {
  it("asks docker for the label and nothing else", async () => {
    const { docker, filters } = fakeDocker([row("acme-console", "running")]);
    expect(await listFrontends(docker)).toEqual(["acme-console"]);
    expect(filters[0]).toEqual([`label=${FRONTEND_LABEL}`]);
  });

  // A stopped front end is still not a sandbox. The question is what a name *is*,
  // not whether it is up, and leaving a stopped one out would hand it to `expire`
  // as a sandbox that has been idle since it was created.
  it("includes a stopped front end", async () => {
    const { docker } = fakeDocker([row("acme-console", "exited"), row("acme-admin", "running")]);
    expect(await listFrontends(docker)).toEqual(["acme-console", "acme-admin"]);
  });

  // A daemon that will not answer is a fact about the daemon. "No front ends" is
  // the same answer as a machine that has none, and the worst it costs is a front
  // end's own log lines being ignored for one pass.
  it("reads a daemon that will not answer as nothing on the bare domain", async () => {
    const { docker } = fakeDocker(new Error("Cannot connect to the Docker daemon"));
    expect(await listFrontends(docker)).toEqual([]);
  });
});
