---
title: Package by package
description: What each package owns, what it exposes, who calls it, what it may never do, and the interfaces between them.
---

This page is for anyone about to change the code, or about to ask an agent to. It answers one
question per package: if this behaviour is wrong, which directory do I open?

The short answer is almost always `packages/core`. Core holds every decision about what a sandbox
is. The command line and the dashboard are thin faces over it. If a change would let those two
faces disagree, it belongs in core.

**There is a second question underneath that one, and it is a repository boundary.** `core`,
`cli`, `docs`, `container/` and `docs/` are the **engine**, sandboxr, which is moving to a
repository of its own. `server`, `web`, `orchestrator`, `voice`, `telegram`,
`orchestrator-daemon` and `sidecars/` are **Jef**, the product built on it. One rule holds the
line: **the engine imports nothing from the product; the product imports the engine.** So a
change that would have core reach for a session, an agent or the dashboard belongs on the other
side of it — and the shape of the fix is always the same, a parameter the embedder supplies
rather than a hook the engine reaches through. See
[contracts §2](contracts.md).

[The shape of it](index.md) is the one-screen version of this page. Read that first if you have
not.

```prompt
I want to change how sandboxr behaves. Before you write anything, work out which package the
change belongs in.

Read docs/architecture/packages.md, then docs/architecture/contracts.md. Follow these rules:
logic about what a sandbox is goes in packages/core, never in packages/cli, packages/server or
packages/web; only container/ may contain shell; the browser app renders what the API sends and
decides nothing. Documentation is updated in the same change that makes it true.

Tell me which package you picked and why before you edit anything. Stop and ask me if the change
would alter a boundary described in contracts.md — that file has to change first, in its own
commit message.
```

## `packages/core`

**What it owns.** Everything. Reading and validating `sandboxr.yaml`. Deriving slugs, hostnames,
container names, volume names and image tags. Emitting [`plan.json`](plan-json.md). Building the
project's image layer. Working out the `docker run` arguments, the mounts and the memory limit.
The four database drivers. The shared router, the certificates and the dashboard container. The
git and GitHub plumbing. The lifecycle verbs. The agent-session machinery.

**Its public surface** is one file: `packages/core/src/index.ts`. Nothing outside that file is
a contract.

**Who calls it.** `packages/cli` and `packages/server`, and nothing else.

**What it may never do.** Format output for a human, know that a web server exists, or spawn a
process except through its own Docker wrapper.

<details class="agent">
<summary><b>Details for an agent</b> — core's modules, and which question each answers</summary>

The public surface is `packages/core/src/index.ts`. Its header says it plainly: nothing outside
that file is a contract.

| Module | Answers |
|---|---|
| `config/schema.ts` | Every `sandboxr.yaml` field. Zod, strict objects, so a misspelled key is an error naming the key |
| `config/load.ts` | Loading and resolving a config. `ConfigError`, `loadConfig`, `resolveConfig`, `projectPath` |
| `config/locate.ts` | Where the config file is. The bounded walk up, and the workspace fallback |
| `config/access.ts` | Whether a `public` project is allowed to start. `publicAccessViolations`, `permittedSeeds`, `allowsRealCredentials` |
| `config/machine.ts` | `~/.sandboxr/config.yaml`: the machine's own `ttl` and `github` settings, and their precedence |
| `config/plan.ts` | `plan.json`. `planFor`, `writePlan`, `planPorts` |
| `config/version.ts` | The `sandboxr:` version range |
| `naming.ts` | Slugs, hostnames, container and volume names, image repositories, the migration lock name. `DEFAULT_DOMAIN`, `SLUG_MAX`, `NETWORK`, `SHARED_VOLUMES`, `PROTECTED_IMAGES` |
| `paths.ts` | Every host path under `SANDBOXR_HOME` |
| `docker.ts` | A typed wrapper over the `docker` CLI. Arguments are arrays, never shell strings, and the runner is injectable |
| `image.ts` | Rendering the project Dockerfile template, staging manifests, and the content-addressed tag |
| `install.ts` | Where this installation of sandboxr lives, so the dashboard can mount it |
| `secrets.ts` | Reading, editing, importing, filtering and checking a project's third-party credentials |
| `git.ts` | `gitFacts`, `gitMounts`, `hostGitIdentity` — what makes git work inside a container |
| `forge.ts` | Everything that shells out to `gh`: repositories, pull requests, merged branches, and `createPullIndex` — a project's pull requests by branch, cached and bounded by a timeout so a hung `gh` cannot stall a page |
| `workspace.ts` | The managed workspace: `cloneProject`, `listProjects`, `findProject`, `fetchProject` |
| `worktree.ts` | Listing, adding and removing worktrees, and what a worktree reports |
| `sandbox/index.ts` | The lifecycle: `up`, `down`, `start`, `stop`, `list`, `status`, `reload`, `expire`, `gc`, `prune` |
| `sandbox/labels.ts` | The label scheme, and `deriveState` |
| `sandbox/run.ts` | The `docker run` argument list, every mount, and the memory limit |
| `sandbox/layout.ts` | The container-side paths the host must agree with |
| `sandbox/expiry.ts` | The derived deadline, `parseTtl`, `formatTtl`, `planExpiry` |
| `sandbox/activity.ts` | Last activity, parsed out of the shared router's access log |
| `sandbox/keep.ts` | The keep-alive marker: `isKeptAlive`, `writeKeep`, `removeKeep` |
| `sandbox/env.ts` | The environment handed to a container |
| `drivers/` | `mysql`, `d1`/`sqlite` (one file driver), `none`, and the migration runner |
| `access/router.ts` | The shared router: its labels, its rules, its config, `startRouter`, `stopRouter` |
| `access/tls.ts` | mkcert: `issueCertificate`, `caTrusted`, and `baseCertificateNames` — the machine's one certificate |
| `access/frontend.ts` | The container on the bare domain: `FRONTEND_LABEL`, `frontendRouteLabels`, `listFrontends` |
| `access/dashboard.ts` | The dashboard container's own `docker run` arguments |
| `access/index.ts` | `initAccess`, `teardownAccess`, `accessStatus`, `ensureBaseImage` |
| `agent/` | Claude Code sessions: the stream parser, the transcript store, the launch arguments, permissions and grants |

Core depends on two runtime packages and nothing else: `yaml` and `zod`.

</details>

## `packages/cli`

**What it owns.** Argument parsing, dispatch, and printing. One command does one thing and prints
the result.

**Its public surface** is the `sandboxr` binary, and the `USAGE` constant in
`packages/cli/src/main.ts` is the real, complete list of commands and flags. Every command returns
an exit code rather than calling `process.exit`, so the whole surface can be driven from a test.

**Who calls it.** People, and agents. Nothing in this repository calls it — in particular the
dashboard does not.

**What it may never do.** Decide anything. If the CLI and the dashboard could disagree about what
a sandbox is, the logic is in the wrong package.

<details class="agent">
<summary><b>Details for an agent</b> — the shape of the CLI package</summary>

| File | What it is |
|---|---|
| `bin/sandboxr.js` | The entry point named in `package.json`'s `bin` |
| `src/main.ts` | Dispatch, and `USAGE` — the authoritative command surface |
| `src/args.ts` | `parseArgs`, `flagString`, `flagBoolean`, `flagNumber`, `flagList` |
| `src/output.ts` | `Output`, which writes human text to stderr and `--json` to stdout |

Human-readable output goes to **stderr**; `--json` puts the result on **stdout**. That split is
what makes a command pipeable without losing its narration.

The package's only dependency is `@sandboxr/core`.

Every command and flag is listed in [CLI commands](../reference/cli.md).

</details>

## `packages/server`

**What it owns.** The dashboard's server side. Sessions and the password. The JSON API. The closed
table of actions and their streamed output. The log stream. The terminal WebSocket. The agent
WebSocket. The reaper that stops sandboxes past their idle limit. It also serves the browser
app's built bundle and one HTML shell.

**Its public surface** is `packages/server/src/index.ts`: `createServer`, `createApp`,
`loadServerConfig`, the action table, the session and password types, and its own thin Docker
client.

**Who calls it.** The browser, over HTTP. And `sandboxr-server`, its own binary.

**What it may never do.** Shell out to the `sandboxr` command. Reach core anywhere except through
`src/core/adapter.ts`. Offer a generic "run this command" endpoint. Render a sentence the browser
should be writing.

<details class="agent">
<summary><b>Details for an agent</b> — the server's routes, and the rules they follow</summary>

Every route declares its auth. There is no default, so a route added without a decision does not
compile rather than shipping open.

**Read routes.** Each requires a session, and each one naming a `:project` is additionally checked
against that session's grant.

| Route | Answers |
|---|---|
| `GET /api/bootstrap` | The domain, the session, the closed action table, and the default lifetime the new-sandbox form offers |
| `GET /api/workspace` | Every project, worktree and sandbox on the machine, plus a summary. Each worktree carries the state of its pull request |
| `GET /api/projects/:project` | One project's worktrees, branches and open pull requests |
| `GET /api/p/:project/s/:slug` | One sandbox in full, with the apps and services its config declares |
| `GET /api/repos` | The repositories this machine's `gh` can offer, each marked as already in the workspace or not |
| `GET /api/p/:project/s/:slug/agent/runs` | The agent sessions recorded against one sandbox, newest first. The index only |
| `GET /api/agent/models` | The models a session may run on, and the permission modes it may run in |
| `GET /api/p/:project/agent/grants` | The standing permissions this project has been granted |
| `DELETE /api/p/:project/agent/grants/:id` | Withdraws one. The only `DELETE` in the API |
| `GET /api/p/:project/s/:slug/agent/commands` | The slash commands a session on that sandbox can be offered |
| `GET /p/:project/s/:slug/logs` | The sandbox's log stream |

**Action routes.** Three of them, one per scope, all `POST`:
`/actions/:action`, `/p/:project/actions/:action`, `/p/:project/s/:slug/actions/:action`.

**Sockets.** The terminal at `/p/:project/s/:slug/terminal`, and the agent at
`/p/:project/s/:slug/agent`.

**Public routes.** `/healthz`, `GET /login`, `POST /auth/login`, `POST /auth/logout`,
`GET /auth/verify` (the router's forward-auth), `GET /.sandboxr/auth` (the private-app handshake),
and `/assets/*`.

**The HTML shell** is served at `/`, `/new`, `/settings`, `/repos`, `/p/:project`,
`/p/:project/branches`, `/p/:project/w/:slug` and `/p/:project/s/:slug`. All eight return the same
document; the browser app decides what to draw.

`GET /api/workspace` is polled every thirty seconds. Nothing is fetched while the tab is hidden or
while an action is running; a failed poll leaves the last good answer on screen and marks it stale;
returning to the tab refreshes at once.

`/login` and the private-app handshake pages stay server-rendered, on purpose. Login is the only
way back in, so it has to work when the bundle does not — and a browser's password manager only
recognises a real `<form>` doing a real `POST`.

| File | What it is |
|---|---|
| `src/app.ts` | Every route, and the auth each one declares |
| `src/server.ts`, `src/bin.ts` | The HTTP server and its binary |
| `src/env.ts` | Every environment variable the server reads, and its default |
| `src/core/adapter.ts` | **The one file that knows how core is really called** |
| `src/core/port.ts` | `CoreApi` — the interface the rest of the package talks to |
| `src/actions/table.ts` | The closed action table |
| `src/actions/stream.ts` | Server-Sent Events: `start`, `log`, `step`, `done` |
| `src/auth/` | Passwords, sessions, the rate limiter, the login and verify routes |
| `src/api/dto.ts` | The shapes the API answers with |
| `src/sandboxes/` | Collecting, probing and modelling what the API reports |
| `src/docker/` | A minimal Docker socket client, for streaming an exec and hijacking a terminal |
| `src/reaper.ts` | The idle timer |
| `src/ui/` | The HTML shell, the login page and the handshake pages |

</details>

## `packages/web`

**What it owns.** The dashboard as a browser app. React, TypeScript, Tailwind, built by Vite into
`dist/`. The sidebar of sessions, the panes, the forms, the log and terminal views, the agent
session view, the themes.

**Its public surface** is its build output. `package.json` exports `./dist/*` and nothing else, and
`@jef/server` serves that directory.

**Who calls it.** A browser.

**What it may never do.** Hold any logic about what a sandbox is. Which actions apply to a stopped
sandbox, what makes one degraded, what sentence a destructive action confirms with, how a slug is
derived — every one of those is decided by core, reported by the server, and rendered here.

> [!IMPORTANT] The server sends facts and the browser writes sentences
> No field of any API response is a rendered string. An expiry is an instant, never `"3h 20m
> left"`. A state is `degraded`, never `"degraded — something failed during boot"`. A page showing
> a countdown re-renders it every second anyway, so a server-rendered copy of the same wording
> would only be a second version to disagree with.

<details class="agent">
<summary><b>Details for an agent</b> — the browser app, and the one constraint on its build</summary>

`packages/web/src/api/types.ts` is the browser's half of a contract whose other half is
`packages/server/src/api/dto.ts`. They are two declarations of one thing, kept in step by hand,
because importing the server's types would drag `node:http` and the Docker client into a browser
bundle.

**The content-security policy is a constraint on the build, not a preference.** No `unsafe-inline`
for script, and no external origin. Nothing executable is inlined into a page, and nothing is
fetched from another host — so no inlined assets, one stylesheet, and fonts served from this
machine rather than a font CDN.

There is no relaxation, including for the terminal. xterm's default renderer draws by injecting
`<style>` elements, so the app loads its canvas renderer instead, which injects none.

`npm --workspace @jef/web run dev` serves the app with hot reload and proxies everything the
server owns — the API, the login form, the action streams, the terminal socket — to
`http://127.0.0.1:8080`. `SANDBOXR_SERVER` points it somewhere else.

</details>

> [!WARNING] The browser app has never been driven through a day's work
> Its pieces are unit-tested and its API is typed at both ends. Nobody has sat in front of it and
> taken a project from start to finish. See [What is built](../reference/status.md).

## `packages/docs`

**What it owns.** The machinery that turns `docs/` into a website: a React app built by Vite,
prerendered to static HTML. It renders Markdown with `marked`, diagrams with `mermaid` and code
with `shiki`.

**Its public surface** is a built site. Nothing imports it.

**Who calls it.** `npm run docs:dev`, and whatever publishes the site.

**What it may never do.** Be required for a page to be readable. The pages are plain Markdown in
`docs/`, with no imports and no JSX, so GitHub renders them directly.

<details class="agent">
<summary><b>Details for an agent</b> — writing a page, without breaking the site</summary>

- Pages live in `docs/`, as plain Markdown. `packages/docs/AUTHORING.md` is the specification.
- **The sidebar is a hand-maintained list in `packages/docs/src/nav.ts`.** Add, move or remove a
  page and you must update it, or the page exists and is unreachable. Its labels must match each
  page's `title`.
- Links between pages are **relative file paths** (`../reference/cli.md`). A build plugin rewrites
  them for the site. An absolute site path breaks GitHub and is a bug.
- Callouts are GitHub alerts (`> [!WARNING]`). Diagrams are ` ```mermaid ` fences. Both render
  natively on GitHub and are transformed for the site.
- `docs/architecture/contracts.md`, `packages/docs/AUTHORING.md` and any `README.md` are
  deliberately **not** site pages.

This package depends on `@jef/web`, so the two share one design system rather than keeping two.

</details>

## The orchestrator, and `sidecars/`

A second reader of sessions, opposite to the dashboard: it watches all of them and tells you
only when one needs you. Four TypeScript packages and two Python sidecars, in a strict dependency
DAG — nothing depends back up the chain, and voice never imports telegram.

- **`packages/orchestrator`** — the base. The model that folds the run index, the event stream
  and Claude Code's hooks into signals; the policy that turns a signal into an update, a question
  or silence; the `Notifier` / `Forker` / `Summariser` / `Responder` interfaces; the hook ingest
  server and the store feeder. Core-only, pure where it can be.
- **`packages/voice`** — a `Notifier` that speaks and listens. The announcement ledger, the
  barge-in `Speaker`, and the `SessionHistory` that is rewritten to what you actually heard when
  you cut in. Drives the voice sidecar over a line protocol.
- **`packages/telegram`** — a `Notifier` that calls you when you are away. The control protocol
  and `TelegramCall`; the on-call conversation is a voice `Notifier`, reused whole.
- **`packages/orchestrator-daemon`** — the top of the stack: wires the above from the environment
  and runs the loop. Its bin is `sandboxr-orchestrator`.

**`sidecars/`** is the one place host-side code is not TypeScript. On-device speech recognition,
neural text-to-speech and Telegram group-call media are Python ecosystems, so the audio **body**
is Python: `sidecars/voice` (Whisper, Piper, Silero) and `sidecars/telegram` (Telethon,
pytgcalls, reusing the voice engine). Each has a stdlib, `pytest`-covered core and heavy engines
behind an optional extra. Their control planes stay TypeScript. See
[the orchestrator guide](../guides/orchestrator.md) and `sidecars/README.md`.

Boundaries hold here too: speech never leaves the machine (the Telegram call excepted, which is
your own account), and the base package never imports voice or telegram.

**The agent you talk to is not in this DAG.** The four packages above are the *watching* half —
noticing, deciding, saying. The conversation is a real Claude Code session, and it lives in
`packages/server` (`orchestrator-agent.ts`, its socket, and the MCP server that gives it reach into
the other sessions) because that is where `AgentSessions` and the Docker client already are. It
runs in a container of its own, `sandboxr-orchestrator` — the dashboard's image plus `claude` —
because the dashboard is the password-protected web surface and never holds the Claude login.

## `container/`

**What it owns.** Everything that runs inside a sandbox. The generic base image. The per-project
Dockerfile template. The entrypoint. The generators that write the service tree and the internal
router config. The build, run, database, migration and status scripts.

**Its public surface** is two files and one variable: `/sandboxr/plan.json`, the mounts the host is
expected to provide, and `SANDBOXR_SLUG`. `container/README.md` is the authoritative specification
of the plan, and `container/examples/*.plan.json` holds two worked examples.

**Who calls it.** Docker, at boot. And `docker exec`, when the host runs a build, a migration or a
database verb.

**What it may never do.** Read `sandboxr.yaml`. Name a service, port, package or route of its own.
Assume any project toolchain exists — these scripts run under s6 before and sometimes without one.

<details class="agent">
<summary><b>Details for an agent</b> — the container's own layout</summary>

| Path | What it is |
|---|---|
| `base/Dockerfile` | The generic base: Debian bookworm, s6-overlay, Caddy, MinIO, `jq`, `envsubst`, `git`, `gh`, `claude`, and these scripts |
| `base/s6/` | The s6 bundle skeleton, copied in at boot and then added to |
| `project/Dockerfile.template` | The per-project layer. Rendered by the host, with blocks `go`, `node`, `mysql`, `sqlite`, `gomod`, `deps` |
| `scripts/entrypoint.sh` | PID 1's first process. Reads the plan, exports the environment, generates everything, `exec`s `/init` |
| `scripts/lib.sh`, `scripts/env.sh` | The sourced library, and the derivation of everything a sandbox computes for itself |
| `scripts/gen-services.sh` | Writes the s6 service tree from the plan |
| `scripts/gen-caddyfile.sh` | Writes the sandbox's own router config from the plan |
| `scripts/db-init.sh`, `scripts/db/<driver>.sh` | First boot, and one file per database driver |
| `scripts/migrate-run.sh` | Runs the project's own migration command and records a verdict |
| `scripts/build-static.sh`, `build-backend.sh`, `build-server.sh` | The on-demand builds |
| `scripts/run-backend.sh`, `run-server.sh`, `caddy.sh`, `logged.sh` | The supervised services |
| `scripts/status.sh` | Composes `status.json` from the marker files |
| `examples/*.plan.json` | Two worked plans, used to exercise the generators |

Both generators are overridable through `SANDBOXR_SCRIPTS`, `SANDBOXR_RUN`, `SANDBOXR_LOGS`,
`SANDBOXR_STATE`, `SANDBOXR_WWW`, `SANDBOXR_S6_DIR` and `SANDBOXR_S6_SKEL`, so they can be run
against a scratch directory without a container. `container/README.md` has the commands.

</details>

## The interfaces between them

Six boundaries. Each one is narrow on purpose, and each one is the place a mistake would otherwise
be invisible.

| Boundary | What crosses it | Rule |
|---|---|---|
| `cli` → `core` | Direct function calls, in process | The CLI passes arguments and prints results. It never computes a name, a path or a state |
| `server` → `core` | Direct function calls, in process, through `src/core/adapter.ts` only | **Never shells out to the CLI.** A renamed core export is a compile error in that one file |
| `web` ↔ `server` | HTTP and JSON, plus two WebSockets | The server sends facts; the browser writes sentences. Actions are a closed table, never a command in the request |
| `core` → `container` | `plan.json`, mounted read-only, plus the environment | The plan is fully resolved. The container never merges a default or infers a kind |
| `core` → Docker | Container labels, mounts, image tags, and the shared network | State lives only in labels. `list`, and which sandboxes `gc` reaps, are pure functions of `docker ps` |
| `container` → the host | The status surface over HTTP, and marker files under `/run/sandboxr` | Every writer records a fact. Nothing asserts a state |

<details class="facts">
<summary><b>Fact sheet</b> — the real dependency edges, from each package.json</summary>

| Package | Depends on |
|---|---|
| `@sandboxr/core` | `yaml`, `zod` |
| `@sandboxr/cli` | `@sandboxr/core` |
| `@jef/server` | `@sandboxr/core`, `@jef/web`, `ws` |
| `@jef/web` | React, xterm, `marked`, the bundled fonts |
| `@sandboxr/docs` | `@jef/web`, `marked`, `mermaid`, React |
| `container/` | Nothing in `packages/`. Only what the base image guarantees |

**`@jef/server` depends on `@jef/web` and serves its `dist/`.** That is why a root
`npm run build` gets the order right and building the server alone does not: without the bundle the
dashboard answers its HTML shell and then 404s every asset, which looks like a blank page rather
than a missing build.

```bash
npm run build                              # every package, in dependency order
npm --workspace @jef/web run build    # the browser bundle on its own
```

</details>

**Next:** [Design decisions](decisions.md) for why each of these boundaries is where it is, or
[plan.json](plan-json.md) for the one between the host and the container in full.
