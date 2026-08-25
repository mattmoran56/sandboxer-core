---
title: What is built
description: Which claims on this site describe code that has been run, which describe code that has never been run, and which describe things nobody has started building — page by page, and honestly.
sidebar:
  order: 5
---

> **Verified** — This page is a report on the other pages. It is checked against the repository each time the docs are revised.

sandboxr is being documented alongside code that is still being written. This page exists so you
never have to guess which is which.

Every page carries a small marker under its title with one of five words. This is what each one
means, and where the whole project actually stands.

| Marker | Means |
|---|---|
| **Verified** | Somebody ran this and watched it work |
| **Partly verified** | Some of it has been run — the page's note says which parts |
| **Written, never run** | The code exists, has tests, and has never been run against a real project |
| **Designed, not built** | Decided and written down in the contract. No code yet |
| **Planned, not built** | Nobody has started. Read it as intent |

> [!NOTE] One project has now been booted in a sandbox
> The Workers example in `examples/demo-worker` has been run end to end: `sandboxr init` set up
> the router, DNS and certificate; `sandboxr up` built a project image, started a container,
> created its D1 database, ran the project's own migrations and served a page over HTTPS. It was
> then run **twice at once** from two git worktrees, each with its own database, its own
> hostname and its own container.
>
> Bidirectional editing was checked too: a file changed on the host appeared instantly inside the
> container, and a file written inside the container appeared in `git status` on the host.
>
> **What that does not cover:** no MySQL project has been run, nothing with a compiled backend or
> a bundled front-end has been built, and the dashboard has only been exercised over HTTP —
> its terminal has not been driven from a browser. Treat every command outside that narrow path
> as the interface the code intends, not as behaviour anyone has observed.

## Where the code stands

| Part | State |
|---|---|
| `docs/architecture/contracts.md` | **Settled.** The authority. A package that disagrees with it is a bug. |
| `container/` | **Written, partly verified.** Base image, project template, service and router generators, database drivers, build and run scripts. What has been exercised is below. |
| `packages/core` | **Written, run end to end once** against the Workers demo. Config, drivers, plan emission, secrets, naming, Docker orchestration, lifecycle. Unit-tested. |
| `packages/cli` | **Written, run end to end once.** `init`, `up`, `ls`, `logs`, `config` and `doctor` have all been run for real. The whole command surface on [the CLI page](./cli.md) exists. |
| `packages/server` | **Written, partly run.** The dashboard serves, redirects to HTTPS and refuses an unauthenticated request; a browser has loaded the login page. The action list and the terminal have not been driven from a browser. |
| `packages/docs` | This site. |

## What has actually been run

All of this was exercised against the **base** image, hand-written plans and stub commands. None
of it involved a real project.

- `bash -n` and `shellcheck -x -S warning` are clean across every container script.
- Both example plans generate a service tree and a router config, and both generated router
  configs pass `caddy validate`.
- Served for real: a built app serves; a deep path falls back to `index.html`; an unbuilt app
  answers 503 with instructions; `/__sandboxr/live` answers 200 on any hostname; an unknown host
  answers 404 naming the host it was asked for.
- The database-init → migrate → status chain produces the right verdict for each outcome: no
  migration command → `ok`/`skipped`; a failing command → `degraded`/`failed` with the file and
  error extracted; a command that exits zero while printing its own failure summary →
  `degraded`, caught by `failure_pattern`; a clean run → `ok`.
- The static builder refuses a declared `memory:` the container cannot meet, and builds and
  swaps in a directory when it can.
- The project image template renders lint-clean (`docker build --check`) for three block
  combinations: Go + Node + MySQL, Node + SQLite, and Go alone.
- The base image builds — about 400 MB, glibc 2.36 — and boots: the supervisor compiles the
  generated tree, the ungated services start, database init runs the driver dispatch and creates
  buckets, an on-demand build lands in the web root and is served through the generated router,
  and every computed and aliased environment variable reaches each supervised service.
- The host packages have unit tests: naming, paths, config loading, plan emission, seed choice,
  access refusals, the Docker argument builder, the garbage-collection plan, and — in the server
  package — every security property listed on [the dashboard page](../guides/dashboard.md).

## What is written and has never run

| Area | What a real run would settle |
|---|---|
| **The whole host path** | `sandboxr up` has never completed. Every step in it is written and unit-tested; none has been exercised against a live Docker daemon and a real repository. |
| The project image layer | It renders lint-clean and has **never been built**. Every download in it is unproven: the Go and Node index queries, the MySQL tarball URL for a real series, the `sqlite3` and `libaio1` installs. |
| Toolchain resolution | That a prefix such as `1.26` or `24` picks the release a project meant, on both processor architectures. |
| MySQL | Data-directory initialisation, the app user and its grants against a live server, restoring a real dump, and the schema snapshot. |
| Dependency seeding | The seed from the image's install path, the lockfile-hash mismatch that falls back to a real install, and the workspace bin re-linking. |
| `d1` / `sqlite` | Provisioning from real miniflare state, locating the SQLite file by glob, and whether the `owner` rule actually prevents the deadlock it exists to prevent. |
| The service graph under load | It boots for a two-service plan. Five backends, a dev server and a first-boot restore have not been started together. |
| Backends | None has been built or run. The staleness check and the build-failure pause are untested against a real compiler. |
| The dashboard | It has never served a page to a browser, and has never listed a real sandbox. |

Nothing in that list is expected to be *structurally* wrong. All of it is expected to have at
least one thing wrong in the details.

## What does not exist at all

These are documented on this site as intent. It is worth being blunt about which.

**The machine-wide router.** This is the biggest gap, and the one most likely to surprise you.
Nothing in this repository starts, configures or reconciles a router that maps a hostname to a
container. Containers are labelled `sandboxr.router=true` so that a router could find them, and
that is the whole of it. Until it exists, a sandbox hostname resolves to nothing and a `private`
project's apps are not actually protected, because the check that would protect them is a
router feature. [How it is meant to work](../architecture/request-path.md).

**Building the per-project image.** `container/project/Dockerfile.template` exists and renders
correctly. Nothing renders it for you, stages a build context, or runs `docker build`.
`packages/core` defaults to `sandboxr/base:latest` and takes an override from the
`SANDBOXR_IMAGE` environment variable, so a project layer you build by hand can be used — but
you build it by hand.

**One-time machine setup.** There is no `sandboxr init`. Nothing installs a DNS resolver, creates
a certificate authority, issues a certificate or starts a router. [Setup](../getting-started/setup.md) is a
manual procedure today.

**Remote deployment.** No code requests a certificate over ACME, writes a DNS record, or installs
a service unit. [The deployment guide](../running-on-a-server.md) is a plan with the arithmetic worked
out.

**A coding-agent service.** sandboxr does not install, declare or supervise a coding agent inside
a sandbox. [That page](../guides/agents-in-a-sandbox.md) describes running your own agent against the bind
mount, which is a way of working rather than a feature.

**Database diff and reset.** The driver interface has `snapshot`, and the CLI exposes it. There
is no `db diff` and no `db reset`; comparing before and after is two snapshots and `diff`, and
starting clean is `down` then `up`.

**CI.** Nothing runs the tests, the shell linting or the docs build automatically.

## Page by page

| Page | Marker | Notes |
|---|---|---|
| [What sandboxr is](../introduction/what-it-is.md) | Designed | Hostname shape, label sources and the two tiers are contract §1–§3. |
| [When to use it](../introduction/when-to-use.md) | Partly | The memory and timing figures come from the tool sandboxr generalises, on one large monorepo. |
| [The map](../orientation/repository-map.md) | Partly | The layout and responsibilities are real. The end-to-end flow has not been run. |
| [The life of a sandbox](../orientation/life-of-a-sandbox.md) | Unrun | Every step exists in code; the sequence has never completed. |
| [Where everything lives](../orientation/where-things-live.md) | Partly | Repository layout and host paths are in code. Container paths are what the scripts use. |
| [Prerequisites](../getting-started/prerequisites.md) | Partly | The base-image size is measured. Everything about a project layer is an estimate — none has been built. |
| [Set up your machine](../getting-started/setup.md) | Planned | There is no setup command. The requirements are structural; the procedure is manual and untried. |
| [Your first sandbox](../getting-started/first-sandbox.md) | Unrun | The commands exist. The sequence has never completed. |
| [Lifecycle](../guides/lifecycle.md) | Unrun | Every command exists in `packages/cli`. |
| [The edit–reload loop](../guides/edit-and-reload.md) | Partly | The commands exist; the timings are measured elsewhere. Reproduce them before quoting them. |
| [Logs, shells and terminals](../guides/logs-and-shells.md) | Unrun | The per-service log files were exercised in the base image. The CLI side has not been run. |
| [The dashboard](../guides/dashboard.md) | Unrun | Written and tested, including its security properties. No browser has loaded it. |
| [sandboxr.yaml](../configuration/sandboxr-yaml.md) | Verified | The schema is code, is tested, and is the authority. |
| [Three runtime kinds](../configuration/runtime-kinds.md) | Partly | Static and served behaviour was exercised in the base image; backends were not. |
| [Secrets](../configuration/secrets.md) | Unrun | The import and its rules are written and unit-tested. |
| [Both examples](../configuration/example-monorepo.md) | Designed | Copied from `examples/` in the repository. Neither has been started. |
| [The driver model](../databases/drivers.md) | Designed | The interface is contract §6, implemented in `packages/core/src/drivers`. |
| [MySQL](../databases/mysql.md) | Partly | The reasoning transfers from the predecessor tool. Nothing has restored a real dump. |
| [D1 and SQLite](../databases/d1-sqlite.md) | Partly | The `owner` rule is implemented and unproven. |
| [Testing a migration](../guides/testing-a-migration.md) | Unrun | The four `db` commands exist. The workflow has not been walked. |
| [The two tiers](../security/two-tiers.md) | Partly | The dashboard half is written and tested. The router half does not exist. |
| [Public sandboxes](../security/public-sandboxes.md) | Verified | The refusals are implemented in `packages/core/src/config/access.ts` and unit-tested. |
| [Deployment guide](../running-on-a-server.md) | Planned | The sizing, DNS arithmetic and certificate constraint are worked out. Nothing has been run. |
| [Agents in a sandbox](../guides/agents-in-a-sandbox.md) | Partly | The bind mount is real. There is no agent service, and the workflow is how the predecessor was used. |
| [How a request arrives](../architecture/request-path.md) | Partly | The inner router is generated and validated. The outer router does not exist. |
| [The startup graph](../architecture/startup.md) | Partly | Generated, and boots for a small plan. Not exercised under a large one. |
| [plan.json](../architecture/plan-json.md) | Partly | The emitter and the reader are both written and agree on two worked examples. |
| [State lives in labels](../architecture/state.md) | Verified | Contract §3.4, implemented and unit-tested. |
| [Design decisions](../architecture/decisions.md) | Partly | Each entry is a decision already taken. The cost estimates are measured elsewhere. |
| [Troubleshooting](../troubleshooting.md) | Partly | Every entry is a failure that actually happened, in the predecessor or while building `container/`. The causes transfer even where the commands do not. |
| [CLI commands](./cli.md) | Unrun | Transcribed from `packages/cli/src/main.ts`. |
| [Environment variables](./environment.md) | Partly | The host-side set is code. The computed set is what the container scripts export. |
| [Config schema](./config-schema.md) | Verified | Transcribed from `packages/core/src/config/schema.ts`. |
| [Glossary](./glossary.md) | Partly | Each term notes where it is defined. |

## Gaps still open in the contract

Recorded here rather than papered over. Each is a documentation bug worth fixing in
`docs/architecture/contracts.md`.

1. **§5's YAML example does not parse.** `backends:` is shown as a block sequence with a
   `defaults:` mapping key as a sibling of the list items, which is invalid YAML. The schema
   accepts the mapping form the real examples use (`backends: { defaults, services }`,
   `frontends: { root, defaults, apps }`) *and* a bare list, so this is only an error in the
   contract's prose. These docs follow the schema.
2. **No CLI surface is pinned.** §3.4 names `ls` and `gc`; §8 says the dashboard's actions are a
   closed table but does not enumerate it. The CLI now exists and is much larger than either.
   Nothing prevents it drifting.
3. **`env:` and `deps:` are in the schema and not in the contract.** Both are load-bearing —
   `env` is the only thing joining the sandbox's computed addresses to the project's own variable
   names — and §5 does not mention either.
4. **Seed precedence is decided in code, not in the contract.** `local`, then `file`, then
   `fixtures`, filtered by what the access rules permit. §5 lists the sources without saying
   which wins.
5. **`db diff` and `db reset` have no home.** §6's interface has `snapshot` but nothing that
   compares two, and no verb that returns a database to a clean restore. The container's `db.sh`
   exposes `diff` but the CLI does not.

<details>
<summary><b>Details for an agent:</b> the gaps that used to be on this list and are now closed</summary>

Fixed since the first version of these docs:

- **`anonymised: true`** exists on `database.seed_from`, so §5.3's refusal has something to read.
- **`access.credentials: dummy|real`** exists, so "unless explicitly opted in" has an opt-in.
- **§5.3's first condition is no longer ambiguous.** `packages/core/src/config/access.ts`
  implements the reading these docs use: a public sandbox may seed from `fixtures`, or from a
  `file` marked anonymised, and never from `local`.
- **`degraded` has a home.** §3.4 now says explicitly that labels hold durable state only, and
  that runtime state is derived at read time from the container plus its own status surface.
- **`static_mode`, `in_build_all`, `database.owner`, `storage`, `SANDBOXR_MIGRATE_SINCE` and the
  `--persist-to` requirement** are all specified in §5.4.
- **`plan.json` is a named boundary** with an authoritative shape, in §5.5.

</details>
