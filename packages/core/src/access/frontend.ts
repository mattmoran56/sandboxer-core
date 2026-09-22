/**
 * A front end: the container that answers on the bare domain (contracts §7.2).
 *
 * The engine starts none. `sandboxer init` prepares the domain — the router, the
 * certificate, the base image, `host.env` — and then says that nothing is
 * serving it, because `sandboxer` is a command-line tool. Whoever wants a control
 * plane there puts a container of their own on the domain and labels it, and
 * everything below is the whole of what that takes.
 *
 * **Why this is a label and not a name.** Two things in the engine have to know
 * which containers are front ends, and neither may know what a dashboard is:
 * `parseAccessLog` reads a front end's lines as being *about* sandboxes rather
 * than *to* one (§3.4), and `expire` must not treat one as a sandbox that has
 * gone idle. A label answers both with one `docker ps` and stays true when the
 * embedder renames its container.
 *
 * The routing itself is ./router.ts's and does not move. This file only names
 * it: two routers onto one service, the bare domain and the private-app login
 * handshake, exactly as the dashboard has always had them.
 */

import type { Docker } from "../docker.js";
import { HANDSHAKE_PRIORITY, HANDSHAKE_ROUTER, handshakeRule, routeLabels } from "./router.js";

/** The label that says "this container answers on the bare domain". */
export const FRONTEND_LABEL = "sandboxer.frontend";

/**
 * The port the router forwards the bare domain to, when nobody says otherwise.
 *
 * 8080 because that is what the machine's front end has always listened on, and
 * changing it would silently move the forward-auth address away from a container
 * already running.
 */
export const DEFAULT_FRONTEND_PORT = 8080;

/**
 * The container the forward-auth middleware points at, when nobody says
 * otherwise.
 *
 * A private project's app hostnames are checked by asking the front end
 * `/auth/verify` (§7), so the router's own configuration has to name one by the
 * time a sandbox starts — before any front end exists to be listed. This is that
 * name, and it is the historical one: every machine with a router config on it
 * today has this string in `dynamic/middlewares.yml`. An embedder calling its
 * front end anything else says so, and `init` rewrites the file.
 */
export const DEFAULT_FRONTEND_CONTAINER = "sandboxer-dashboard";

export interface FrontendRoute {
  container: string;
  /** The port it listens on inside its container. */
  port: number;
  domain: string;
  tls: boolean;
}

/**
 * Traefik labels that route the bare domain here, behind the auth handshake.
 *
 * Two routers onto one service:
 *
 * The first is the control plane: the bare domain, and only the bare domain.
 * Everything a front end serves lives behind it, which is why its session cookie
 * can be host-only.
 *
 * The second is the private-app login handshake, and it is the one deliberate
 * exception to "the front end never answers on a sandbox hostname". It answers
 * one reserved path there — see `handshakeRule` — because the cookie that opens
 * a private app has to be set *on* that app's hostname, and only something
 * answering there can set it. It carries no forward-auth middleware, or the
 * request that exists to obtain a credential would need that credential first.
 *
 * **Its own function rather than an expression inside an argument list**,
 * because an embedder that starts the same container from a compose file has to
 * spell the same labels in YAML, and one shared function is what keeps the two
 * from drifting. The engine ships no compose file, so the test comparing the two
 * is the product's — which is exactly why this stays a function somebody else
 * can call rather than an object literal inlined here.
 */
export function frontendRouteLabels(route: FrontendRoute): Record<string, string> {
  return {
    [FRONTEND_LABEL]: "true",
    ...routeLabels({
      name: route.container,
      rule: `Host(\`${route.domain}\`)`,
      port: route.port,
      tls: route.tls,
    }),
    ...routeLabels({
      name: HANDSHAKE_ROUTER,
      rule: handshakeRule(route.domain),
      port: route.port,
      tls: route.tls,
      service: route.container,
      priority: HANDSHAKE_PRIORITY,
    }),
  };
}

/**
 * Every container currently claiming the bare domain. One `docker ps`.
 *
 * Stopped ones are included on purpose. The question this answers is "is this
 * name a front end rather than a sandbox", and a front end that is stopped is
 * still not a sandbox — reading one as a sandbox would put it in `expire`'s plan
 * and in the activity map, which is the drift the label exists to prevent.
 *
 * A daemon that will not answer yields an empty list rather than throwing. Every
 * caller here treats "no front ends" as "nothing is on the bare domain", which
 * is the same shape as the machine not having one, and neither reading loses
 * anything: the worst it costs is a front end's own log lines being ignored.
 */
export async function listFrontends(docker: Docker): Promise<string[]> {
  try {
    const rows = await docker.ps([`label=${FRONTEND_LABEL}`], { all: true });
    return rows.map((row) => row.name).filter((name) => name !== "");
  } catch {
    return [];
  }
}
