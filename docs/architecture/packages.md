---
title: Package by package
description: What each package owns, what it exposes, who calls it, what it may never do, and the interfaces between them.
---

This page is for anyone about to change the code, or about to ask an agent to. It answers one
question per package: if this behaviour is wrong, which directory do I open?

The short answer is almost always `packages/core`. Core holds every decision about what a sandbox
is. The command line is a thin face over it, and so is anything else built on it. If a change
would let two faces disagree, it belongs in core.

**There is a second question underneath that one, and it is a repository boundary.** Everything
here is the **engine**: a command-line tool, and no control plane. A product is built on this
engine and lives in another repository. One rule holds the line: **the engine imports nothing from
the product; the product imports the engine.** So a change that would have core reach for a
control plane, an agent or a session belongs on the other side of it — and the shape of the fix is
always the same, a parameter the embedder supplies rather than a hook the engine reaches through.
See [contracts §2](contracts.md).

[The shape of it](index.md) is the one-screen version of this page. Read that first if you have
not.

```prompt
I want to change how sandboxer behaves. Before you write anything, work out which package the
change belongs in.

Read docs/architecture/packages.md, then docs/architecture/contracts.md. Follow these rules:
logic about what a sandbox is goes in packages/core, never in packages/cli; only container/ may
contain shell; the engine imports nothing from anything built on top of it. Documentation is
updated in the same change that makes it true.

Tell me which package you picked and why before you edit anything. Stop and ask me if the change
would alter a boundary described in contracts.md — that file has to change first, in its own
commit message.
```

## `packages/core`

**What it owns.** Everything. Reading and validating `sandboxer.yaml`. Deriving slugs, hostnames,
container names, volume names and image tags. Emitting [`plan.json`](plan-json.md). Building the
project's image layer. Working out the `docker run` arguments, the mounts and the memory limit.
The four database drivers. The shared router and the certificates. The git and GitHub plumbing.
The lifecycle verbs.

**Not** an agent, and **not** a control plane. sandboxer runs a worktree in a container and has no
name for a coding agent at all. It prepares the bare domain and leaves it empty — contracts §7.2 —
and starts nothing there.

Where the engine would otherwise have had to know what an embedder is doing, it takes a parameter
instead of reaching for one. `up` is handed a `ProvidedWorkspace` when the code it is to run is a
checkout the host has no worktree for, and `expire` is handed the activity somebody else can see
and the engine cannot.

**Its public surface** is one file: `packages/core/src/index.ts`. Nothing outside that file is
a contract.

**Who calls it.** `packages/cli`, and anything that embeds the engine. Nothing else here.

**What it may never do.** Format output for a human, know that a web server exists, or spawn a
process except through its own Docker wrapper.

<details class="agent">
<summary><b>Details for an agent</b> — core's modules, and which question each answers</summary>

The public surface is `packages/core/src/index.ts`. Its header says it plainly: nothing outside
that file is a contract.

| Module | Answers |
|---|---|
| `config/schema.ts` | Every `sandboxer.yaml` field. Zod, strict objects, so a misspelled key is an error naming the key |
| `config/load.ts` | Loading and resolving a config. `ConfigError`, `loadConfig`, `resolveConfig`, `projectPath` |
| `config/locate.ts` | Where the config file is. The bounded walk up, and the workspace fallback |
| `config/access.ts` | Whether a `public` project is allowed to start. `publicAccessViolations`, `permittedSeeds`, `allowsRealCredentials` |
| `config/machine.ts` | `~/.sandboxer/config.yaml`: the machine's own `ttl` and `github` settings, and their precedence |
| `config/plan.ts` | `plan.json`. `planFor`, `writePlan`, `planPorts` |
| `config/version.ts` | The `sandboxer:` version range |
| `naming.ts` | Slugs, hostnames, container and volume names, image repositories, the migration lock name. `DEFAULT_DOMAIN`, `SLUG_MAX`, `NETWORK`, `SHARED_VOLUMES`, `PROTECTED_IMAGES` |
| `paths.ts` | Every host path under `SANDBOXER_HOME` that the engine owns |
| `docker.ts` | A typed wrapper over the `docker` CLI. Arguments are arrays, never shell strings, and the runner is injectable |
| `image.ts` | Rendering the project Dockerfile template, staging manifests, and the content-addressed tag |
| `install.ts` | Where this installation of sandboxer lives, so an embedder can mount it |
| `secrets.ts` | Reading, editing, importing, filtering and checking a project's third-party credentials |
| `git.ts` | `gitFacts`, `gitMounts`, `hostGitIdentity` — what makes git work inside a container |
| `forge.ts` | Everything that shells out to `gh`: repositories, pull requests, merged branches, and `createPullIndex` — a project's pull requests by branch, cached and bounded by a timeout so a hung `gh` cannot stall a page |
| `workspace.ts` | The managed workspace: `cloneProject`, `listProjects`, `findProject`, `fetchProject` |
| `worktree.ts` | Listing, adding and removing worktrees, and what a worktree reports |
| `sandbox/index.ts` | The lifecycle: `up`, `down`, `start`, `stop`, `list`, `status`, `reload`, `expire`, `gc`, `prune` |
| `sandbox/provided.ts` | `ProvidedWorkspace`: a `/workspace` somebody else resolved, for a sandbox whose code the host has no checkout of |
| `sandbox/labels.ts` | The label scheme, and `deriveState` |
| `sandbox/run.ts` | The `docker run` argument list, every mount, and the memory limit |
| `sandbox/layout.ts` | The container-side paths the host must agree with |
| `sandbox/expiry.ts` | The derived deadline, `parseTtl`, `formatTtl`, `planExpiry` |
| `sandbox/activity.ts` | Last activity: the router's access log, the attach markers, and whatever the caller hands in |
| `sandbox/keep.ts` | The keep-alive marker: `isKeptAlive`, `writeKeep`, `removeKeep` |
| `sandbox/env.ts` | The environment handed to a container |
| `drivers/` | `mysql`, `d1`/`sqlite` (one file driver), `none`, and the migration runner |
| `access/router.ts` | The shared router: its labels, its rules, its config, `startRouter`, `stopRouter` |
| `access/tls.ts` | mkcert: `issueCertificate`, `caTrusted`, and `baseCertificateNames` — the machine's one certificate |
| `access/frontend.ts` | The container on the bare domain: `FRONTEND_LABEL`, `frontendRouteLabels`, `listFrontends` |
| `access/index.ts` | `initAccess`, `teardownAccess`, `accessStatus`, `ensureBaseImage`. It prepares the bare domain and does not fill it |

Core depends on two runtime packages and nothing else: `yaml` and `zod`. `boundary.test.ts`
beside them walks every file under `src/`, tests included, and fails with the file, the line and
the specifier for anything that is not relative, `node:`-prefixed or one of those two.

</details>

## `packages/cli`

**What it owns.** Argument parsing, dispatch, and printing. One command does one thing and prints
the result.

**Its public surface** is the `sandboxer` binary, and the `USAGE` constant in
`packages/cli/src/main.ts` is the real, complete list of commands and flags. Every command returns
an exit code rather than calling `process.exit`, so the whole surface can be driven from a test.

**Who calls it.** People, and agents. Nothing in this repository calls it, and an embedder must
not either: it calls core in the same process.

**What it may never do.** Decide anything. If the CLI and an embedder could disagree about what
a sandbox is, the logic is in the wrong package.

<details class="agent">
<summary><b>Details for an agent</b> — the shape of the CLI package</summary>

| File | What it is |
|---|---|
| `bin/sandboxer.js` | The entry point named in `package.json`'s `bin` |
| `src/main.ts` | Dispatch, and `USAGE` — the authoritative command surface |
| `src/args.ts` | `parseArgs`, `flagString`, `flagBoolean`, `flagNumber`, `flagList` |
| `src/output.ts` | `Output`, which writes human text to stderr and `--json` to stdout |

Human-readable output goes to **stderr**; `--json` puts the result on **stdout**. That split is
what makes a command pipeable without losing its narration.

The package's only dependency is `@sandboxer/core`, and `src/boundary.test.ts` is the cut-down
half of core's: the CLI is the engine's whole face, so an import from outside the engine here
would ship in the binary a colleague installs.

Every command and flag is listed in [CLI commands](../reference/cli.md).

</details>

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

This package depends on `@sandboxer/tokens`, so the two share one stylesheet rather than
keeping two. It depends on nothing outside the engine: this site is the engine's, and an engine
package may not depend on a product one.

</details>

## `packages/tokens`

**What it owns.** One stylesheet, `tokens.css`: the palette, the three colour schemes, the two
themes, the fonts, the light/dark mechanism, the base layer and the named shapes. Its header
comment is the document for it.

**Its public surface** is one export, `@sandboxer/tokens/tokens.css`. There is no build: the file
is shipped as written, so it declares the three `@fontsource*` packages it imports, and Tailwind
as a peer — the app's own `@tailwindcss/vite` is what resolves that import, and a second copy
nested here would be a different Tailwind from the one the plugin runs.

**Who calls it.** `packages/docs`, and nothing else here. A product built on the engine, in
another repository, imports it too, so the stylesheet has exactly one copy rather than two.

**What it may never do.** Contain a component, a script, or anything specific to one app. It
exists so that no app owns the palette — a colour that the two consuming apps disagreed about
would be visible to anyone who opened both.

## `container/`

**What it owns.** Everything that runs inside a sandbox. The generic base image. The per-project
Dockerfile template. The entrypoint. The generators that write the service tree and the internal
router config. The build, run, database, migration and status scripts.

**Its public surface** is two files and one variable: `/sandboxer/plan.json`, the mounts the host is
expected to provide, and `SANDBOXER_SLUG`. `container/README.md` is the authoritative specification
of the plan, and `container/examples/*.plan.json` holds two worked examples.

**Who calls it.** Docker, at boot. And `docker exec`, when the host runs a build, a migration or a
database verb.

**What it may never do.** Read `sandboxer.yaml`. Name a service, port, package or route of its own.
Assume any project toolchain exists — these scripts run under s6 before and sometimes without one.

<details class="agent">
<summary><b>Details for an agent</b> — the container's own layout</summary>

| Path | What it is |
|---|---|
| `base/Dockerfile` | The generic base: Debian bookworm, s6-overlay, Caddy, MinIO, `jq`, `envsubst`, `git`, `gh`, and these scripts. No Docker client, and no agent |
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

Both generators are overridable through `SANDBOXER_SCRIPTS`, `SANDBOXER_RUN`, `SANDBOXER_LOGS`,
`SANDBOXER_STATE`, `SANDBOXER_WWW`, `SANDBOXER_S6_DIR` and `SANDBOXER_S6_SKEL`, so they can be run
against a scratch directory without a container. `container/README.md` has the commands.

</details>

## The interfaces between them

Five boundaries. Each one is narrow on purpose, and each one is the place a mistake would otherwise
be invisible.

| Boundary | What crosses it | Rule |
|---|---|---|
| `cli` → `core` | Direct function calls, in process | The CLI passes arguments and prints results. It never computes a name, a path or a state |
| an embedder → `core` | Direct function calls, in process, through one file of the embedder's | **Never shells out to the CLI.** A renamed core export is then a compile error in that one file. One way only, and `packages/core/src/boundary.test.ts` is what says so — core importing anything built on it is the boundary failing, not a shortcut |
| `core` → `container` | `plan.json`, mounted read-only, plus the environment | The plan is fully resolved. The container never merges a default or infers a kind |
| `core` → Docker | Container labels, mounts, image tags, and the shared network | State lives only in labels. `list`, and which sandboxes `gc` reaps, are pure functions of `docker ps` |
| `container` → the host | The status surface over HTTP, and marker files under `/run/sandboxer` | Every writer records a fact. Nothing asserts a state |

<details class="facts">
<summary><b>Fact sheet</b> — the real dependency edges, from each package.json</summary>

| Package | Depends on |
|---|---|
| `@sandboxer/core` | `yaml`, `zod` |
| `@sandboxer/cli` | `@sandboxer/core` |
| `@sandboxer/docs` | `@sandboxer/tokens`, `marked`, `mermaid`, React |
| `@sandboxer/tokens` | The three `@fontsource*` packages it imports; Tailwind, as a peer |
| `container/` | Nothing in `packages/`. Only what the base image guarantees |

**`packages/` is built in directory order, not dependency order.** `npm run build --workspaces`
walks the directory listing, so a root build gets the order right by accident rather than by
design. What actually orders a build against another package's output is TypeScript: a package's
`tsconfig.json` lists what it needs under `references`, and `tsc -b` builds those first.
`packages/cli` references `../core` for exactly that reason.

A package whose reference is missing passes on a warm tree and fails on a cold clone, with
`Cannot find module` — which reads like a missing install rather than a build order. Building one
package on its own is where it bites.

```bash
npm run build                    # every package
npm --workspace @sandboxer/cli run build    # one package, and its references first
```

</details>

**Next:** [Design decisions](decisions.md) for why each of these boundaries is where it is, or
[plan.json](plan-json.md) for the one between the host and the container in full.
