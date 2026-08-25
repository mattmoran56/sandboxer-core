---
title: The two tiers
description: Apps are open, controls are behind a password — one session mechanism used twice, why an unprotected action endpoint is root on the host, and the half of this that is not running yet.
sidebar:
  order: 1
---

> **Written, never run** — The dashboard's half — passwords, sessions, per-project grants, the verify endpoint — is written and has tests for each property below, but has never been run. The router's half has never been run at all, so private apps are not protected on any machine today.

sandboxr splits everything it serves into exactly two tiers.

| Tier | What is in it | How it is protected |
|---|---|---|
| **Apps** | Everything a sandbox serves: front-ends, APIs | Open to anyone by default. `access.apps: private` puts them behind the session |
| **Controls** | The dashboard, the terminal, start, stop, rebuild, migrate, delete | **A password. Always. Not configurable.** |

There is **one** authentication mechanism, and it is used twice. The dashboard owns sessions. The
router protects everything else by asking the dashboard.

```mermaid
flowchart TB
  vis["Browser"] --> router["Shared router — NOT BUILT YET<br/>terminates TLS, routes on hostname"]
  router --> q{"Which hostname?"}
  q -->|"an app of a public project"| app["The sandbox container<br/>no check"]
  q -->|"an app of a private project"| fa["NOT BUILT YET<br/>ask the dashboard: GET /auth/verify"]
  fa -->|"200"| app
  fa -->|"401"| deny["Refused"]
  q -->|"the bare domain"| dash["The dashboard<br/>session cookie required"]
  dash --> docker[("The Docker socket")]
  dash --> term["The terminal, a page inside it"]
```

*One session mechanism. Open app hostnames skip the check; nothing else does. Everything marked NOT BUILT YET is design, not behaviour.*


## Why apps are open by default

Because the point of a sandbox URL is to send it to somebody.

A designer, a product manager, the person who filed the ticket — none of them should need an
account on your Docker host to look at a branch. Someone who finds a sandbox sees a preview of
unreleased work, which is usually fine and often the entire objective.

That default comes with two conditions attached, and both are enforced as **refusals** rather than
warnings. Read [public sandboxes](./public-sandboxes.md) before you expose anything.

## Why the controls are not negotiable

The dashboard talks to the **Docker socket**, because that is how it starts and stops containers.

That is not a detail you can design around. Access to the Docker socket is equivalent to being root
on the machine, whatever flags it is mounted with: a process that can reach it can start a
container with the whole host filesystem mounted inside it.

So an action endpoint reachable without a session is not a leak and not a misconfigured page. It is
**arbitrary code execution, as root, on the machine**.

> [!CAUTION] If you skim one paragraph on this site, make it this one
> There is no mode in which the controls are open. No flag for local development, no "it is only on
> my laptop" exception, no environment variable that turns it off. With no password configured, every
> action endpoint refuses. Asking for a way around it is asking for a way to hand your machine to
> whoever finds port 443.
>
> The password is a root credential. Treat it that way: long, random, in a secret manager, rotated by
> changing the variable and restarting.

## The honest state of the private tier

**No machine-wide router runs today, so a `private` project's apps are not actually protected.**

The dashboard's half is written: `GET /auth/verify` answers 200 or 401, and checks the session's
grant against the project the forwarded hostname belongs to. The router's half — a shared proxy in
front of every sandbox, sending private hostnames through that check first — has just been written
in `packages/core/src/access/`, and nothing starts it. `sandboxr up` does not.

Until it does, sandboxes are reachable only however you have wired your own machine, and
`access.apps: private` records an intention rather than enforcing one. Do not rely on it to keep
anything off the network.

<details>
<summary><b>Details for an agent:</b> how the router is meant to enforce it, and what exists so far</summary>

The design, from `docs/architecture/contracts.md` §7:

- One router container per machine, in front of every sandbox, reconciling from Docker labels — so
  starting a sandbox never rewrites a config file and never triggers a reload.
- Each sandbox's container carries the labels that describe its own route. A project whose
  `access.apps` is `private` gets a forward-auth middleware in that route; a public one does not.
- The middleware points at the dashboard's `GET /auth/verify`, and forwards the hostname it is
  asking about. `verify` answers 200 when the session exists **and** its grant covers that
  hostname's project, and 401 otherwise. So a password scoped to one project cannot unlock
  another's private apps.

What exists: `packages/core/src/access/router.ts` builds the route labels and the middleware
definition, and `packages/server` serves `verify` with tests for both answers.

What does not: nothing starts the router as part of a sandbox's lifecycle, and the code has never
been run. Wildcard DNS and real certificates are also not built — see
[what is built](../reference/status.md).

</details>

## The non-negotiables

These come from the contract, and they are what "behind a password" actually means in code. Each
has a test in `packages/server`.

### No action endpoint is reachable without a session

Not one. Not a health check that happens to accept a container name. Not a "read-only" listing that
leaks worktree paths. Not a WebSocket that authenticates after the upgrade. A test posts every
action in the table, to every route, with no cookie, and asserts 401 — and that neither the core
library nor Docker was touched.

### The set of actions is closed

There is no "run this command" box, and there must never be one. The things the dashboard can do
are a fixed table in the server package, and lookup goes through a `Map`, so a request naming
`constructor` or `__proto__` resolves to nothing.

This is what stops the dashboard being a shell with a nicer font. An attacker who gets a session
still cannot run arbitrary commands — only the enumerated ones.

### Every input is validated, and commands are argument arrays

Slugs, project names and branch names are checked against the documented patterns **before** they
reach a command. Commands are executed as argument arrays, never as a shell string with a request
value pasted into it.

Treat every request as untrusted, including one that arrives with a valid session. A slug is
`[a-z0-9-]` with a 31-character ceiling; anything else is rejected rather than escaped.

### Login is rate-limited, and the password is never recoverable

A password with no rate limit is a password you can guess at HTTP speed. Attempts are limited per
client and server-wide, and a refused attempt is not counted — so hammering cannot extend a lockout
on a shared proxy address.

The password is compared with a timing-safe comparison over the whole table, so login costs the
same whichever password matched. It is stored as a hash and salt, the environment variables are
deleted once read, and it appears in no log, no page and no redirect.

## Different people, different projects

One password can grant everything, or several passwords can each grant a subset — so a contractor
working on one project cannot control another.

```bash
# Grants every project.
export SANDBOXR_PASSWORD='...'

# Grants only the acme project.
export SANDBOXR_PASSWORD_ACME='...'

# A password that should cover two projects: name it after either one,
# then list what it really grants.
export SANDBOXR_PROJECTS_ACME='acme,worker-thing'
```

The grant is checked everywhere, not only on the buttons: the sandbox list is filtered, the terminal
refuses to open, a global action needs a grant covering everything, and the check that protects
private apps refuses a hostname belonging to a project the session was not granted.

<details>
<summary><b>Details for an agent:</b> the session cookie, where its key lives, and the six public routes</summary>

`POST /auth/login` takes a password and sets a signed cookie: `HttpOnly` so page JavaScript cannot
read it, `Secure` so it never crosses plain HTTP, `SameSite=Lax` so another site cannot make your
browser perform an action with it, `Path=/`, and a `Max-Age` matching the session lifetime
(`SANDBOXR_SESSION_HOURS`, default 168).

The token carries its own grant and expiry and is signed with the key at
`$SANDBOXR_HOME/state/session.key` (mode 0600) — so there is no session table to lose, and
restarting the dashboard does not log everybody out. The signature is checked **before** the payload
is parsed, so a forged payload never reaches `JSON.parse`.

The public route set is exactly six, asserted as a literal list so that making something public is a
visible change to a test:

| Route | What it is |
|---|---|
| `GET /healthz` | Liveness |
| `GET /login` | The password form |
| `POST /auth/login` | Rate-limited. Password in, cookie out |
| `POST /auth/logout` | Clears the cookie |
| `GET /auth/verify` | 200 or 401 — the router's question |
| `GET /assets/*` | The dashboard's own CSS and JS, a closed set |

Everything else needs a session, and everything under `/p/:project/` needs a session whose grant
covers that project. Locally, over plain HTTP, `SANDBOXR_INSECURE_COOKIES=1` drops `Secure`; it is
the only supported reason to set it and the server says so at startup every time.

</details>

## Why the terminal is a page, not a hostname

The terminal lives at `/p/<project>/s/<slug>/terminal`, **inside the dashboard**, on the bare
domain. It never gets a hostname of its own, and that is structural rather than a routing
convenience.

- Inside the dashboard it inherits the dashboard's session automatically. There is no second way in
  to get wrong.
- On a per-sandbox hostname it would sit alongside apps that are open by default. One routing
  mistake, one copied config block, and you have published an interactive shell inside a container
  with your worktree mounted in it.

The dashboard itself is on the bare domain and never on a per-sandbox hostname, for the same
reason.

## What this protects against, and what it does not

| Threat | Covered? |
|---|---|
| Somebody finding an app URL | Yes, in the sense that this is the intended behaviour for a public project — and the [two requirements](./public-sandboxes.md) are what make it safe |
| Somebody finding the dashboard | Yes. Password, rate-limited, timing-safe, nothing reflected |
| Somebody guessing a slug to reach a private app | **Not today.** Private apps are meant to sit behind the session, and the router that would enforce that is not running |
| A person who has the password doing damage | **No.** The password is full control of every sandbox on the host. It is a root credential |
| A malicious app *inside* a sandbox | Partly. It is a container, and the worktree is mounted read-write. It can rewrite your branch |
| Data leaking out of an open app | Only through the seed and credential refusals. Those are the whole defence, which is why they are refusals |

That read-write worktree is deliberate — it is what lets
[an agent work inside a sandbox](../guides/agents-in-a-sandbox.md). It is a feature with a sharp edge, not an
oversight.

## Related

- [Public sandboxes](./public-sandboxes.md) — the two refusals. Read it before you expose
  anything.
- [The dashboard](../guides/dashboard.md) — every variable it reads and every action it offers.
- [Deployment guide](../running-on-a-server.md) — running this where other people can reach it.
