---
title: Glossary
description: Every term sandboxr uses in a narrower sense than plain English does.
sidebar:
  order: 4
---

## One sandbox, and what it is called

**Sandbox** — a complete, disposable copy of a project running in one container: its services, its
front-ends, its own database, its own file storage. One per branch, several at once, and throwing
one away costs nothing.

**Project** — a repository with a `sandboxr.yaml` at its root. The name in that file appears in
every hostname, container name and volume name. One project has many sandboxes.

**Slug** — the short name for one sandbox. Derived, in order of preference, from an explicit
argument, a ticket-style id (`/[a-z]+-[0-9]+/i`) in the worktree directory name, that pattern in
the branch, the branch itself, then the directory. Sanitised to `[a-z0-9-]` and capped at **31
characters**; over that, the first 22 characters plus 8 characters of the SHA-256 of the *raw*
input. Hashed rather than truncated because two long branch names sharing a prefix would otherwise
collide on one database lock.

**Label** — the name of one app or one API within a project, used as a piece of its hostname. It
comes from a `frontends` or `backends` entry, and two runtimes may not share one. Not a *Docker
label*, below.

**Hostname** — `<slug>.<label>.<project>.<domain>`, e.g. `tkt-4821.app.acme.sbx.localhost`. The
dashboard answers on the bare domain and never on a per-sandbox hostname.

**Domain** — the suffix all of those hang off. `SANDBOXR_DOMAIN`, default `sbx.localhost`.

## Where the code comes from

**Worktree** — a second checkout of the same repository made with `git worktree add`, so several
branches are open at once sharing one `.git`. sandboxr works from worktrees rather than clones, so
a sandbox is always tied to exactly one branch. **sandboxr has no command that creates one.**

**Bind mount** — the mechanism that lets a container see a directory on your computer directly
rather than a copy. Your worktree is bind-mounted at `/workspace`, so a saved file is inside the
container instantly and a file the container writes shows up in your `git status`.

**`SANDBOXR_HOME`** — the one host directory sandboxr writes to: cached seeds, per-sandbox logs,
certificates, secrets and generated files. Defaults to `~/.sandboxr`, and is deliberately never
inside a repository.

## What a project declares

**`sandboxr.yaml`** — the one file describing a project to sandboxr. It lives at the root of the
project *being sandboxed*, so a new service and the settings describing it land in the same commit.

**Runtime kind** — what a declared thing actually *is* at run time. Exactly three, and none is a
variation on another.

- **Backend** — compiled to a binary, kept running, holds a port. Declared under `backends`.
- **Static front-end** — built once into a directory of files and served as files. Declared with
  `out:`. No process, so it costs nothing when nobody is looking, and it is built on demand rather
  than at startup.
- **Served front-end** — *is* a long-running process serving itself. Declared with `serve:` and a
  `port`. The most expensive thing in a sandbox, because it holds its whole module graph in memory
  whether or not anyone opens it — which is why one is often `optional`.

**`static_mode`** — how a *built* directory is served: `spa` sends every unknown path to
`index.html`, `html` looks up `about.html` when asked for `/about`, `files` returns a real 404.
Declared rather than guessed, because the wrong value **half-works** instead of failing.

**`optional`** — a runtime that does not start unless you ask for it with `up --with <label>`.

**`access.apps`** — `public` (the default) means anybody with the URL can open the sandbox's apps;
`private` puts them behind the dashboard's session.

**`access.credentials`** — `dummy` (the default) or `real`. Whether real third-party credentials
may reach this sandbox. Anyone who can drive a public app could otherwise make it send real email
or spend real credit.

## The one file between host and container

**The plan** (`plan.json`) — the fully resolved version of `sandboxr.yaml` that the host writes and
the container reads. Every default merged, every address computed, all three runtime kinds
flattened into one list with an explicit `kind`. **Nothing inside a container ever reads
`sandboxr.yaml`.**

Written to `~/.sandboxr/build/<project>/<slug>.plan.json`, mounted at `/sandboxr/plan.json`
read-only — a container that could rewrite its own plan could change what it claims to be running.
Specified by `container/README.md`, which outranks this site.

## Databases

**Driver** — the implementation of one kind of database behind a fixed five-method interface:
`prepareSeed`, `provision`, `migrate`, `snapshot`, `shell`. Four exist: `mysql`, `d1`, `sqlite`,
`none`.

**Seed** — the starting data a sandbox's database is filled with, from `local` (a database
container you already run), `file` (a dump), or `fixtures`.

**Seed artifact** — the reusable *result* of preparing a seed, produced on the host and cached in
`~/.sandboxr/cache` under a name derived from its content. The expensive part happens once rather
than once per sandbox, which is why a data change never requires rebuilding an image.

**Fixtures** — extra SQL applied *after* migrations. Deliberately non-fatal: a fixture that no
longer matches the schema is a useful signal, not a reason to refuse to start.

**Migration** — a schema change, applied by **the project's own migration program**. sandboxr runs
the command in `database.migrate` and reads its output; it never reimplements the logic.

**Advisory lock** — a named lock a migration takes so two runs cannot overlap. sandboxr's is
`sandboxr_migrate_<project>_<slug>`, passed as `SANDBOXR_MIGRATION_LOCK`, and the 31-character slug
ceiling exists to keep it under MySQL's silent 64-character limit.

**Degraded** — a sandbox whose container is running and whose **migration failed**. A state of its
own rather than "broken", because the services are deliberately started anyway.

**Owner** — for `d1` and `sqlite`, the single runtime allowed to open the database file. Two
processes opening one file deadlock, so every non-owner is denied the file's location outright.

## Inside a running sandbox

**Supervisor** — the small program inside the container that starts each service in order,
restarts one that dies, and keeps them out of each other's way.

**One-shot and long-run** — a one-shot runs once and finishes (restore, migrate, seed
dependencies); a long-run is kept alive (a backend, a served front-end, the router). One-shots
*gate* long-runs, so nothing serves traffic against a database that is not ready.

**Entrypoint** — the script that runs *before* the supervisor: reads the plan, exports the computed
environment, writes the router config, generates the service list, then hands over. It cannot be
the supervisor, because the supervisor compiles its service list once, before anything runs.

**The two routers** — a request passes through both.

| Which | What it does |
|---|---|
| **The shared router** — one Traefik container per machine | Terminates TLS, matches the hostname, picks a container. Reconciles from Docker labels, so starting a sandbox writes no config |
| **The sandbox's own router** — Caddy, inside every container | Splits by label and by `routes` prefix, and serves the status surface and the "not built yet" pages. Generated from the plan at every boot |

**Status surface** — four paths every sandbox answers on *every* hostname it serves:
`/__sandboxr/live`, `/__sandboxr/status.json`, `/__sandboxr/built.json` and
`/__sandboxr/health/<service>`. The state is composed from marker files each writer drops, never
asserted by one of them.

**Base image** — the small generic image every sandbox shares: supervisor, router, object store,
`jq`, the container scripts. About 400 MB, one per machine, nothing project-specific.

**Project layer** — the thin image on top of the base holding what one project asks for: its
toolchains, its database engine, its installed dependencies. Rendered and built by the first
`sandboxr up`, and content-addressed, so branches that change neither share one image.

## Controlling a sandbox

**The dashboard** — the web app that lists every **worktree** on the machine, starts, stops,
rebuilds and migrates the sandboxes on them, and gives you a terminal inside any one. Two packages:
`@sandboxr/server` answers JSON and serves one HTML shell, and `@sandboxr/web` is the browser app
that shell loads. The server calls the same `@sandboxr/core` the CLI does, in process, so the two
can never disagree. Always behind a password.

**Action** — one thing the dashboard is allowed to do, from a **fixed table** in its source. There
is no "run this command" box and there must never be one.

**Forward auth** — how a *private* project's app hostnames are protected without a second login
system. The shared router asks the dashboard's `GET /auth/verify`, which answers 200 or 401 from
the visitor's existing session and also checks that the session's grant covers that project.

**Docker label** — where **all** durable state about a sandbox lives: `sandboxr.project`, `.slug`,
`.branch`, `.commit`, `.dirty`, `.worktree`, `.driver`, `.created`, `.access`. There is no manifest
file, so `sandboxr ls` and `sandboxr gc` are pure functions of `docker ps`. Runtime state —
starting, running, degraded — is derived at read time instead, because a label saying `running`
would be a second source of truth that goes stale the moment a process dies.

## Two words that mean something narrower here

**Worktree, not clone.** A sandbox is bound to a `git worktree` directory, not to a repository.

**Sandbox, not staging.** No high availability, no backup of a sandbox's database, no promise it
survives a host reboot with its data intact. A sandbox is disposable; the durable thing is the git
branch it was made from.
