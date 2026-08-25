---
title: Glossary
description: Every term sandboxr uses in a specific sense — slug, plan, driver, runtime kind, supervisor, forward auth — each defined in a sentence or two, with the page that explains it properly.
sidebar:
  order: 4
---

> **Partly verified** — Every definition here comes from `docs/architecture/contracts.md` or from the code that implements it. Terms describing something not yet built say so in the entry.

Terms sandboxr uses in a narrower sense than plain English does. Each entry says what the thing
is **for** first, then what it is made of, and points at the page that explains it properly.

Where a term is fixed by `docs/architecture/contracts.md`, that is noted — a package that
disagrees with the contract is a bug rather than a variation.

## One sandbox, and what it is called

**Sandbox** — a complete, disposable copy of a project, running in one container: its services,
its front-ends, its own database, its own file storage. You make one per branch you are working
on, and several run at once on the same machine. Throwing one away costs nothing, which is the
whole point. [What sandboxr is](../introduction/what-it-is.md)

**Project** — a repository that has a `sandboxr.yaml` file at its root. The name in that file
appears in every hostname, container name and volume name the project's sandboxes use. One
project has many sandboxes. Contract §3.

**Slug** — the short name for one sandbox, so you can say which one you mean. sandboxr works it
out from the worktree directory or the branch, and it ends up in the hostname, the container
name and a database lock name. Capped at 31 characters. Contract §3.1.
[Why the ceiling matters](../databases/mysql.md)

**Label** — the name of one app or one API within a project, used as a piece of its hostname.
It comes from a `frontends` or `backends` entry, and two runtimes in a project may not share
one. Not to be confused with a *Docker label*, below.

**Hostname** — how you reach something in a sandbox. Every app answers on
`<slug>.<label>.<project>.<domain>` — for example `feat-123.app.acme.sbx.localhost`. The dashboard
answers on the bare domain, and never on a per-sandbox hostname. Contract §3.2.

**Domain** — the suffix all of those hang off. `SANDBOXR_DOMAIN`, default `sbx.localhost`.

<details>
<summary><b>Details for an agent:</b> how a slug is derived, and the exact arithmetic of the 31-character ceiling</summary>

Derived, in order of preference:

1. An explicit argument — `sandboxr up feat-123`.
2. A ticket-style id anywhere in the worktree directory name, matching `/[a-z]+-[0-9]+/i`.
3. That same pattern in the branch name.
4. The branch name.
5. The worktree directory name.

Then sanitised: lower-cased, every character outside `[a-z0-9-]` becomes `-`, runs of `-`
collapse, leading and trailing `-` are stripped.

**Over 31 characters**, it keeps the first 22, adds `-`, and appends the first 8 characters of
the SHA-256 of the *raw* input. Hashed rather than truncated because the slug ends up inside a
database lock name — `sandboxr_migrate_<project>_<slug>` — and MySQL silently cuts a lock name
off at 64 characters. Two long branch names that share a prefix would truncate to one lock, and
one sandbox's migration would wait for ever on another's.

Code: `deriveSlug()` and `lockName()` in `packages/core/src/naming.ts`. Contract §3.1.

</details>

## Where the code comes from

**Worktree** — a second checkout of the same repository, made with `git worktree add`, so
several branches are open on disk at once and share one `.git`. sandboxr works from worktrees
rather than clones: one sandbox per worktree, so a sandbox is always tied to exactly one
branch. **sandboxr has no command that creates one** — you make it yourself and point
`sandboxr up --worktree PATH` at it.

**Bind mount** — the mechanism that lets a container see a directory on your computer directly,
rather than a copy of it. Your worktree is bind-mounted into the sandbox at `/workspace`, so
saving a file on your machine changes it in the container instantly — and, in the other
direction, anything edited inside the container is edited on your branch and shows up in
`git status`. [Agents in a sandbox](../guides/agents-in-a-sandbox.md)

**`SANDBOXR_HOME`** — the one directory on your computer where sandboxr keeps everything it
writes: cached database seeds, per-sandbox logs, certificates, secrets and generated files.
Defaults to `~/.sandboxr`, and is deliberately never inside a repository, so `git clean -xdf`
cannot destroy it. Contract §4. [Where everything lives](../orientation/where-things-live.md)

## What a project declares

**`sandboxr.yaml`** — the one file that describes a project to sandboxr: what to build, what
database to use, which credentials to bring. It lives at the root of the project *being
sandboxed*, not in sandboxr's own repository, so a new service and the settings describing it
land in the same commit. [Field by field](../configuration/sandboxr-yaml.md) ·
[Every field, in tables](./config-schema.md)

**Runtime kind** — what a thing declared in the config actually *is*, at run time. There are
exactly three, they behave completely differently, and none is a variation on another. Contract
§5.1. [Three runtime kinds](../configuration/runtime-kinds.md)

**Backend** — a service that is compiled to a binary, kept running, and holds a port. Declared
under `backends`. Its port is internal to the sandbox; you reach it through its hostname or
through a `routes` prefix on an app's hostname.

**Static front-end** — an app that is **built once into a directory of files** and then served
as files. Declared under `frontends` with `out:`. It is not a running process, so it costs
nothing when nobody is looking at it — and it is built on demand rather than at startup, so a
sandbox comes up in seconds.

**Served front-end** — an app that **is** a long-running process, serving itself. Declared
under `frontends` with `serve:` and a `port`. A development server or a Cloudflare Worker is
this: there is no built directory to hand to a file server. It is the most expensive thing in a
sandbox, because it holds its whole module graph in memory whether or not anyone opens it,
which is why one is often marked `optional`.

**`static_mode`** — how a *built* directory is served. Three genuinely different behaviours:
`spa` sends every unknown path to `index.html`, `html` looks up `about.html` when asked for
`/about`, and `files` returns a real 404. Declared rather than guessed, because the wrong value
**half-works** instead of failing — you find out from a user. Default `spa`. Contract §5.4.

**`optional`** — a runtime that does not start unless you ask for it with
`sandboxr up --with <label>`. For anything expensive and only occasionally needed.

**`access.apps`** — whether the sandbox's app hostnames need a login. `public` (the default)
means anybody with the URL can open them, which is the point of a sandbox URL. `private` puts
them behind the dashboard's password. Contract §7.

**`access.credentials`** — whether real third-party credentials may reach this sandbox.
`dummy` (the default) or `real`. It exists because anyone who can drive a public app could
otherwise make it send real email or spend real credit, so using real credentials in a public
sandbox has to be a deliberate, reviewed choice. Contract §5.3.
[Public sandboxes](../security/public-sandboxes.md)

## The one file between host and container

**The plan** (also **plan file**, `plan.json`) — the fully-resolved version of `sandboxr.yaml`
that the host writes and the container reads. Every default is already merged, every address
already computed, and all three runtime kinds are flattened into one list with an explicit
`kind`. **Nothing inside a container ever reads `sandboxr.yaml`.** That single boundary is why
the container never has to understand YAML, and why supporting a new kind of project is a
change on the host side only. Contract §5.5.
[The container boundary](../architecture/plan-json.md)

<details>
<summary><b>Details for an agent:</b> where the plan is written, where it is mounted, and what specifies its shape</summary>

- Written to `~/.sandboxr/build/<project>/<slug>.plan.json` on the host.
- Mounted at `/sandboxr/plan.json` inside the container, **read-only** — a container that could
  rewrite its own plan could change what it claims to be running.
- Emitted by `packages/core/src/config/plan.ts`.
- Specified by the "The plan" section of `container/README.md`, with two worked examples in
  `container/examples/*.plan.json`. That specification outranks this site.

Nothing in the container's scripts names a service, a port, a package or a route. They are all
read from the plan, which is what lets one generic image serve both a multi-service monorepo on
MySQL and a single Worker on a file database.

</details>

## Databases

**Driver** — the implementation of one kind of database, behind a fixed five-method interface,
so the rest of sandboxr never has to know which one is in use. There are four: `mysql`, `d1`,
`sqlite` and `none`. Contract §6. [The driver model](../databases/drivers.md)

**Seed** — the starting data a sandbox's database is filled with, so a fresh sandbox is
immediately useful rather than empty. It comes from one of three places, declared in
`database.seed_from`: a copy of a database container you already run (`local`), a dump file
(`file`), or nothing but fixtures (`fixtures`).

**Seed artifact** — the reusable *result* of preparing a seed, produced on the host and cached
in `~/.sandboxr/cache` under a name derived from its content. Every sandbox of that project
then fills its database from that one artifact, so the expensive part happens once rather than
once per sandbox. Preparing it happens on the host, before the container starts, which is why a
data change never requires rebuilding an image.

**Fixtures** — extra SQL applied *after* migrations, from `seed_from.fixtures`. Deliberately
non-fatal: a fixture that no longer matches the schema is a useful signal, not a reason to
refuse to start.

**Migration** — a change to the database schema, applied by **the project's own migration
program**. sandboxr never reimplements that logic; it runs the command in `database.migrate`
and reads its output. Contract §6.
[Testing a migration](../guides/testing-a-migration.md)

**Advisory lock** — a named lock a migration takes in the database so two runs cannot overlap
and corrupt each other. sandboxr's is `sandboxr_migrate_<project>_<slug>`, and the 31-character
slug ceiling exists to keep that name under MySQL's 64-character limit.

**Degraded** — a sandbox whose container is running and whose **migration failed**. It is a
state of its own rather than "broken", because the services are deliberately started anyway:
inspecting a failed migration is one of the reasons the sandbox exists, and killing the
container would destroy the evidence. Contract §6.

<details>
<summary><b>Details for an agent:</b> the five driver methods, and the four rules every driver obeys</summary>

```ts
prepareSeed(ctx)          // produce the cached artifact, on the host
provision(ctx, seed)      // fill this sandbox's database from it
migrate(ctx)              // run the project's own migration command
snapshot(ctx)             // print the schema, structure only
shell(ctx)                // an interactive shell against this sandbox's database
```

Four rules, from `packages/core/src/drivers/types.ts` and contract §6:

- **The source database is only ever read.** Every destructive operation targets a copy. That
  is what makes it safe to point a half-written migration at real data.
- **A failed migration does not stop the sandbox.** Record it, mark the sandbox degraded, let
  the services boot.
- **The schema baseline survives a failed run.** Snapshot before migrating, and re-take the
  baseline only after a success — otherwise a half-migrated schema overwrites the last known
  good one, and the comparison shows nothing exactly when it matters most.
- **Never reimplement the project's migration logic.** Shell out to the command in the config.

</details>

## Inside a running sandbox

**Supervisor** — the small program inside the container that starts each service in the right
order, restarts one that dies, and keeps them out of each other's way. It exists because a
sandbox runs many processes and a container normally runs one.

**One-shot and long-run** — the two kinds of thing the supervisor manages. A **one-shot** runs
once and finishes: restoring the database, applying migrations, seeding dependencies. A
**long-run** is kept alive: a backend, a served front-end, the router. One-shots *gate*
long-runs, so nothing starts serving traffic against a database that is not ready yet.
[The startup graph](../architecture/startup.md)

**Entrypoint** — the script that runs *before* the supervisor. It reads the plan, exports the
computed environment, writes the router's configuration and generates the list of services,
then hands over. It cannot be the supervisor itself, because the supervisor compiles its list
of services once, before anything runs — so the list has to be settled first.

**Router** — the thing that takes a request for a hostname and sends it to whatever should
answer. **There are two, and only the inner one exists.**

| Which | What it does | Built? |
|---|---|---|
| The **sandbox's own router**, inside every container | Splits `feat-123.app.acme.sbx.localhost` from `feat-123.api.acme.sbx.localhost` once a request has arrived, and serves the status surface and the "not built yet" pages | **yes** — generated at every boot from the plan |
| The **machine-wide router**, in front of every sandbox | Would terminate TLS and pick a container by hostname | **no** — designed only |

> [!WARNING] Nothing answers a sandbox hostname today
> sandboxr labels every sandbox container `sandboxr.router=true` so a machine-wide router could
> find them, but no code starts or configures one. Until that exists, a sandbox is reachable only
> from inside — `sandboxr shell <slug>` — or through a proxy you run yourself.
> [What is built](./status.md)

**Status surface** — four paths every sandbox answers on **every** hostname it serves, so
anything can ask a sandbox how it is doing without knowing anything about it:
`/__sandboxr/live`, `/__sandboxr/status.json`, `/__sandboxr/built.json` and
`/__sandboxr/health/<service>`. The state in `status.json` is composed from marker files each
writer drops, never asserted by one of them, so two writers cannot disagree about whether the
sandbox is degraded.

**Base image** — the small generic image every sandbox on the machine shares: the supervisor,
the router, the file storage and sandboxr's own scripts. Nothing about any particular project.
About 400 MB, one per machine.

**Project layer** — the thin image on top of the base holding exactly what one project asks
for: its language toolchains, its database engine and its installed dependencies. Adding a
second project to a machine should cost one thin layer rather than another few gigabytes.
**Nothing builds this yet** — `container/project/Dockerfile.template` exists and no code renders
it. [What is built](./status.md)

## Controlling a sandbox

**The dashboard** — the web page that lists every sandbox on the machine, with buttons to
start, stop, rebuild and migrate, and a terminal inside any of them. It exists so none of that
requires a terminal, a checkout, or knowing any commands. It runs the same code the CLI does,
so the two can never disagree. It lives on the bare domain, always behind a password.
[The dashboard](../guides/dashboard.md)

**Action** — one thing the dashboard is allowed to do, from a **fixed list** in its source.
There is no "run this command" box and there must never be one: the dashboard holds the Docker
socket, so a general-purpose command endpoint behind a password would be a remote shell with an
extra step. Contract §8.

**Forward auth** — how a *private* project's app hostnames are protected without a second login
system. The router, before serving the request, asks the dashboard `GET /auth/verify`, which
answers 200 or 401 based on the visitor's existing session. Public projects skip it entirely.
Contract §7.

**Docker label** — where **all** state about a sandbox lives: `sandboxr.project`, `.slug`,
`.branch`, `.commit`, `.dirty`, `.worktree`, `.driver`, `.created`, `.access`. There is no
manifest file and no database of sandboxes, so `sandboxr ls` and `sandboxr gc` are pure
functions of `docker ps` and nothing can drift out of sync. Contract §3.4.
[State lives in labels](../architecture/state.md)

<details>
<summary><b>Details for an agent:</b> why runtime state is not a label, even though it would be convenient</summary>

Labels hold **durable** facts only — everything above is fixed when the sandbox is created and
does not change while it runs.

Whether a sandbox is starting, running or degraded is derived at read time instead, from the
container plus the sandbox's own status surface. A label saying `running` would be a second
source of truth that goes stale the moment a process dies.

That matters most in the one case you care about: a failed migration deliberately leaves the
container running, so anything reading only Docker's own state reports a degraded sandbox as
perfectly healthy.

</details>

## Two words that mean something narrower here

**Worktree, not clone.** A sandbox is bound to a `git worktree` directory, not to a repository.
Several branches of one repository are checked out at once, sharing one `.git`, and one of them
is bind-mounted into the container read-write.

**Sandbox, not staging.** There is no high availability, no backup of a sandbox's database and
no promise it survives a host reboot with its data intact. A sandbox is disposable; the durable
thing is the git branch it was made from.
[What sandboxr is not](../running-on-a-server.md)
