import { describe, expect, it } from "vitest";

import {
  HANDSHAKE_PRIORITY,
  handshakeRule,
  portSuffix,
  regexLiteral,
  routeLabels,
  routerArgs,
  routerPorts,
  sandboxRouteLabels,
  sandboxRule,
} from "./router.js";

describe("regexLiteral", () => {
  it.each([
    ["sbx.localhost", "sbx\\.localhost"],
    ["plain", "plain"],
    ["a+b", "a\\+b"],
    ["a[b]c", "a\\[b\\]c"],
    ["", ""],
  ])("escapes %s", (input, expected) => {
    expect(regexLiteral(input)).toBe(expected);
  });
});

describe("sandboxRule", () => {
  it("matches every label under one sandbox, and nothing else", () => {
    const rule = sandboxRule("tkt-1", "acme", "sbx.localhost");
    expect(rule).toBe("HostRegexp(`^tkt-1--[a-z0-9]+(?:-[a-z0-9]+)*--acme\\.sbx\\.localhost$`)");

    // The expression inside the backticks is what Traefik compiles, so it is
    // worth exercising as a real regular expression rather than as a string.
    const pattern = new RegExp(rule.slice("HostRegexp(`".length, -"`)".length));
    expect(pattern.test("tkt-1--app--acme.sbx.localhost")).toBe(true);
    expect(pattern.test("tkt-1--admin-api--acme.sbx.localhost")).toBe(true);
    // A different sandbox, a different project, and the bare domain all miss.
    expect(pattern.test("tkt-2--app--acme.sbx.localhost")).toBe(false);
    expect(pattern.test("tkt-1--app--other.sbx.localhost")).toBe(false);
    expect(pattern.test("sbx.localhost")).toBe(false);
    // The old three-label shape must not still match, or a stale DNS entry would
    // route to a sandbox whose Caddy no longer knows the name.
    expect(pattern.test("tkt-1.app.acme.sbx.localhost")).toBe(false);
    // A label holding `--` would divide two ways. It has to miss here, or this
    // rule and `hostFor` would disagree about what a hostname means.
    expect(pattern.test("tkt-1--a--b--acme.sbx.localhost")).toBe(false);
  });

  it("escapes a domain that contains regex metacharacters", () => {
    expect(sandboxRule("s", "p", "a.b")).toContain("a\\.b");
  });
});

describe("routeLabels", () => {
  it("puts a plain http route on the web entry point and asks for no TLS", () => {
    const labels = routeLabels({ name: "x", rule: "Host(`a`)", port: 80, tls: false });
    expect(labels["traefik.enable"]).toBe("true");
    expect(labels["traefik.http.routers.x.entrypoints"]).toBe("web");
    expect(labels["traefik.http.routers.x.tls"]).toBeUndefined();
    expect(labels["traefik.http.services.x.loadbalancer.server.port"]).toBe("80");
  });

  it("puts a TLS route on websecure", () => {
    const labels = routeLabels({ name: "x", rule: "Host(`a`)", port: 8080, tls: true });
    expect(labels["traefik.http.routers.x.entrypoints"]).toBe("websecure");
    expect(labels["traefik.http.routers.x.tls"]).toBe("true");
  });

  it("joins middlewares, and omits the key when there are none", () => {
    expect(routeLabels({ name: "x", rule: "r", port: 1, tls: false, middlewares: ["a@file", "b@file"] })[
      "traefik.http.routers.x.middlewares"
    ]).toBe("a@file,b@file");
    expect(
      routeLabels({ name: "x", rule: "r", port: 1, tls: false, middlewares: [] })[
        "traefik.http.routers.x.middlewares"
      ],
    ).toBeUndefined();
  });

  // A second router on a container that already has one: Traefik links a lone
  // router to a lone service by itself, but two routers are ambiguous unless each
  // says which service it means.
  it("points at an existing service instead of declaring another", () => {
    const labels = routeLabels({ name: "second", rule: "r", port: 1, tls: true, service: "first" });
    expect(labels["traefik.http.routers.second.service"]).toBe("first");
    expect(labels["traefik.http.services.second.loadbalancer.server.port"]).toBeUndefined();
  });

  it("names its own service when it declares one", () => {
    const labels = routeLabels({ name: "x", rule: "r", port: 8080, tls: false });
    expect(labels["traefik.http.routers.x.service"]).toBe("x");
    expect(labels["traefik.http.services.x.loadbalancer.server.port"]).toBe("8080");
  });

  it("writes a priority only when one is given", () => {
    expect(routeLabels({ name: "x", rule: "r", port: 1, tls: false, priority: 42 })[
      "traefik.http.routers.x.priority"
    ]).toBe("42");
    expect(routeLabels({ name: "x", rule: "r", port: 1, tls: false })["traefik.http.routers.x.priority"]).toBeUndefined();
  });
});

describe("handshakeRule", () => {
  it("matches the reserved path on any sandbox hostname", () => {
    const component = "[a-z0-9]+(?:-[a-z0-9]+)*";
    expect(handshakeRule("sbx.localhost")).toBe(
      `HostRegexp(\`^${component}--${component}--${component}\\.sbx\\.localhost$\`) && PathPrefix(\`/.sandboxr/auth\`)`,
    );
  });

  it("escapes the domain, so a dot in it is not a wildcard", () => {
    expect(handshakeRule("a.b")).toContain("a\\.b");
  });

  // One label above the domain, divided into three, is a sandbox; the
  // dashboard's own bare domain has no label at all. So this rule cannot shadow
  // the control plane however it is ordered.
  it("cannot match the dashboard's own hostname", () => {
    const pattern = new RegExp(
      handshakeRule("sbx.localhost").match(/HostRegexp\(`([^`]+)`\)/)?.[1] as string,
    );
    expect(pattern.test("tkt-1--web--acme.sbx.localhost")).toBe(true);
    expect(pattern.test("sbx.localhost")).toBe(false);
    expect(pattern.test("web--acme.sbx.localhost")).toBe(false);
    expect(pattern.test("a.tkt-1--web--acme.sbx.localhost")).toBe(false);
    expect(pattern.test("tkt-1--a--b--acme.sbx.localhost")).toBe(false);
  });

  // Traefik defaults a router's priority to the length of its rule, which would
  // decide this by accident: whether the handshake rule or a sandbox's own is the
  // longer string depends on how long somebody's branch name is.
  it("outranks the rule for the sandbox it sits in front of", () => {
    expect(HANDSHAKE_PRIORITY).toBeGreaterThan(sandboxRule("tkt-1", "acme", "sbx.localhost").length);
    expect(HANDSHAKE_PRIORITY).toBeGreaterThan(handshakeRule("sbx.localhost").length);
  });
});

describe("sandboxRouteLabels", () => {
  const base = { container: "sandboxr-acme-tkt-1", slug: "tkt-1", project: "acme", domain: "sbx.localhost" };

  it("sends traffic to the sandbox's own router on port 80", () => {
    const labels = sandboxRouteLabels({ ...base, tls: true, access: "public" });
    expect(labels["traefik.http.services.sandboxr-acme-tkt-1.loadbalancer.server.port"]).toBe("80");
  });

  it("puts a private project behind forward-auth and a public one in front of nothing", () => {
    expect(
      sandboxRouteLabels({ ...base, tls: true, access: "private" })[
        "traefik.http.routers.sandboxr-acme-tkt-1.middlewares"
      ],
    ).toBe("sandboxr-auth@file");
    expect(
      sandboxRouteLabels({ ...base, tls: true, access: "public" })[
        "traefik.http.routers.sandboxr-acme-tkt-1.middlewares"
      ],
    ).toBeUndefined();
  });
});

describe("routerArgs", () => {
  const files = { config: "/h/state/traefik.yml", dynamic: "/h/state/dynamic" };
  const cert = { name: "d", certFile: "/h/tls/d.pem", keyFile: "/h/tls/d-key.pem", trusted: true };

  it("publishes 443 only when there is a certificate to serve on it", () => {
    const plain = routerArgs({ files, bind: "127.0.0.1" });
    expect(plain).toContain("127.0.0.1:80:80");
    expect(plain.join(" ")).not.toContain(":443:443");

    const secure = routerArgs({ files, cert, tlsDir: "/h/tls", bind: "127.0.0.1" });
    expect(secure).toContain("127.0.0.1:443:443");
    expect(secure.join(" ")).toContain("/h/tls:/etc/traefik/tls:ro");
  });

  it("mounts the docker socket read-only", () => {
    expect(routerArgs({ files, bind: "127.0.0.1" })).toContain("/var/run/docker.sock:/var/run/docker.sock:ro");
  });

  it("binds only where it is told to", () => {
    expect(routerArgs({ files, bind: "0.0.0.0" })).toContain("0.0.0.0:80:80");
  });

  // The one thing on the machine sandboxr cannot assume it owns. Another local
  // router already on 80 makes `docker run` fail with nothing that names a fix.
  it("publishes the ports it is given, and keeps the container's own at 80/443", () => {
    const args = routerArgs({ files, cert, tlsDir: "/h/tls", bind: "127.0.0.1", ports: { http: 8080, https: 8443 } });
    expect(args).toContain("127.0.0.1:8080:80");
    expect(args).toContain("127.0.0.1:8443:443");
  });
});

describe("routerPorts and portSuffix", () => {
  it("defaults to the standard ports, which need no suffix", () => {
    expect(routerPorts({})).toEqual({ http: 80, https: 443 });
    expect(portSuffix("http", { http: 80, https: 443 })).toBe("");
    expect(portSuffix("https", { http: 80, https: 443 })).toBe("");
  });

  it("reads an override and then puts it in the URL", () => {
    const ports = routerPorts({ SANDBOXR_HTTP_PORT: "8080", SANDBOXR_HTTPS_PORT: "8443" });
    expect(ports).toEqual({ http: 8080, https: 8443 });
    expect(portSuffix("https", ports)).toBe(":8443");
  });

  it.each(["", "0", "70000", "not-a-port"])("ignores %s and keeps the default", (value) => {
    expect(routerPorts({ SANDBOXR_HTTP_PORT: value }).http).toBe(80);
  });
});
