---
title: Glossary
description: Every term these pages use in a narrower sense than plain English, defined once and linked to the page that explains it.
---

Every word sandboxr uses precisely, in one list. Each entry is one or two sentences, and links the
page that explains the thing properly.

## A

**Anonymised** — an assertion, made by whoever wrote the config, that a database dump carries no
real personal data. `anonymised: true` beside a `seed_from.file` is the only thing that lets a
`public` project restore that dump. sandboxr cannot check it. See
[Access and security](../access.md).

**Access tier** — the three settings under `access:` in a config. `apps` decides whether the
sandbox's apps are open to anyone with the URL, `credentials` decides whether real third-party
credentials may reach it, and `controls` is always `password`. See
[Access and security](../access.md).

**Action** — one thing the dashboard is allowed to run, taken from a fixed table in its own source.
There is no box for typing a command, and there must never be one. See
[The dashboard](../guides/dashboard.md).

**Advisory lock** — a named lock a migration takes so two runs cannot overlap. sandboxr's is
`sandboxr_migrate_<project>_<slug>`. See [Databases](../databases.md).

**Agent prompt** — a block of text on one of these pages that you copy into a coding agent, so it
does the task for you. All of them are collected on
[Every agent prompt](agent-prompts.md).

**Agent session** — one `claude` process running *inside* a sandbox, on the worktree at
`/workspace`, started and driven from the dashboard. See
[Agent sessions in the dashboard](../guides/agent-sessions.md).

## B

**Backend** — a [runtime kind](#r): something compiled to a binary, kept running, holding a port.
Declared under `backends:`. See [The three runtime kinds](../configuration/runtime-kinds.md).

**Bare domain** — the domain on its own, with nothing in front of it. That is the dashboard's
hostname, and it is never a sandbox's. See [Access and security](../access.md).

**Base image** — the generic image every sandbox on the machine shares: the supervisor, the
in-container router, the object store, `git`, `gh`, `claude` and the container scripts. Nothing
project-specific. Built by `sandboxr init`. See [Install it](../getting-started/install.md).

**Bind mount** — the mechanism that lets a container see a directory on your computer directly,
rather than a copy of it. Your worktree is bind-mounted at `/workspace`. See [Paths](paths.md).

**Blob volume** — `sandboxr-blob-<project>-<slug>`, holding one sandbox's uploaded files. See
[Paths](paths.md).

## C

**Caddy** — the router *inside* each sandbox. It splits traffic by label and by route prefix, and
serves the status surface. See [How a request arrives](../architecture/request-path.md).

**Container** — one running sandbox, named `sandboxr-<project>-<slug>`. One container per worktree,
holding every service that worktree needs. See
[How it works, in five steps](../how-it-works.md).

**Controls** — everything that changes a sandbox: start, stop, rebuild, migrate, shell, terminal.
**Controls are always behind a password and that cannot be turned off**, because the dashboard holds
the Docker socket. See [Access and security](../access.md).

## D

**Dashboard** — the web app that lists every worktree on the machine and starts, stops, rebuilds and
migrates the sandboxes on them. It sits on the [bare domain](#b). See
[The dashboard](../guides/dashboard.md).

**Degraded** — a state of its own: the container is running and the project's migration failed. The
services are started deliberately, because inspecting a failed migration is a reason the sandbox
exists. See [Testing a migration](../guides/testing-a-migration.md).

**Dependency volume** — `sandboxr-deps-<hash>`, holding one installed `node_modules` tree. The hash
is the lockfile's, so every sandbox with the same dependencies shares one install. See
[One repo, many branches](../setups/one-repo-many-worktrees.md).

**Detached worktree** — a worktree checked out at a commit rather than on a branch. It is how git
runs a branch that is already checked out somewhere else, and it is normal rather than a failure.
See [Projects, worktrees and lifetimes](../guides/managed-sandboxes.md).

**Dirty** — a sandbox built from a worktree that had uncommitted changes. `sandboxr ls` marks it
with a `*`. See [CLI commands](cli.md).

**Display name** — what you have chosen to call a worktree, instead of its branch: "the checkout
flow rewrite" rather than `feat/tkt-4821`. It is a label and nothing more — the [slug](#s), the
hostname, the container name and every URL still come from the branch and the directory, so renaming
a worktree moves no address. Set with `sandboxr worktree name`. See [CLI commands](cli.md).

**Domain** — the hostname suffix everything hangs off. `SANDBOXR_DOMAIN`, default `sbx.localhost`.
See [Environment variables](environment.md).

**Dormant service** — a runtime marked `optional:` that nobody asked to start. It has no route at
all, so its hostname answers 404 rather than pretending to be down. See
[The three runtime kinds](../configuration/runtime-kinds.md).

**Driver** — the implementation of one kind of database, behind a fixed interface: prepare a seed,
provision, migrate, snapshot, shell. Four exist: `mysql`, `d1`, `sqlite`, `none`. See
[Databases](../databases.md).

**Dry run** — `--dry-run` on `expire` and `gc`: print the plan and change nothing. `prune` works the
other way round, and removes only with `--yes`. See [CLI commands](cli.md).

## E

**Entrypoint** — the script that runs *before* the supervisor: it reads the plan, exports the
computed environment, writes the router config and generates the service list. See
[The startup graph](../architecture/startup.md).

**Expire** — stopping every sandbox that has sat unused past its limit. It stops; it never removes.
See [Projects, worktrees and lifetimes](../guides/managed-sandboxes.md).

## F

**Fixtures** — extra SQL applied *after* migrations. Deliberately non-fatal: a fixture that no
longer matches the schema is a signal, not a reason to refuse to start. See
[Databases](../databases.md).

**Forge** — the code host `gh` talks to, which today means GitHub. A machine without `gh` still
works; it just cannot list repositories or pull requests, and every worktree's pull-request mark is
simply absent rather than wrong. See
[Several repositories at once](../setups/many-projects.md).

**Forward auth** — how a `private` project's app hostnames are protected without a second login.
The shared router asks the dashboard whether the visitor's session is good, on every request. See
[Access and security](../access.md).

**Front-end** — anything declared under `frontends:`. There are two kinds: a
[static front-end](#s) and a [served front-end](#s). See
[The three runtime kinds](../configuration/runtime-kinds.md).

## G

**Garbage collection** — `sandboxr gc`. It reaps sandboxes whose worktree is gone, then removes
sandboxr volumes nothing owns. See [Start, stop, list, clean up](../guides/lifecycle.md).

**Grant** — two senses, both narrow. A password's grant is the set of projects it may control. An
agent grant is a standing permission a project has given a session. See
[Access and security](../access.md) and
[Agent sessions in the dashboard](../guides/agent-sessions.md).

## H

**Hostname** — `<slug>--<label>--<project>.<domain>`, for example
`tkt-4821--app--acme.sbx.localhost`. See [How it works, in five steps](../how-it-works.md).

## I

**Idle clock** — the timer behind a [ttl](#t). It measures **idleness, not uptime**: the deadline is
the later of the container's start time and the last time anybody used it, plus the ttl. Four things
count as use — a request through the router, opening the sandbox in the dashboard, an agent session
running on its worktree, and a terminal or agent panel held open on it — and the last two hold the
sandbox open until they stop. See
[Projects, worktrees and lifetimes](../guides/managed-sandboxes.md).

## K

**Keep-alive** — an exemption from the idle clock, set with `sandboxr keep` and removed with
`sandboxr unkeep`. It is a file on the host, and it records which container it was written for. See
[Projects, worktrees and lifetimes](../guides/managed-sandboxes.md).

## L

**Lockfile** — the file a package manager writes to pin exact dependency versions
(`package-lock.json`, `pnpm-lock.yaml`, `yarn.lock`, `bun.lock`). sandboxr hashes it to name the
shared dependency volume, so two branches with identical lockfiles share one install. See
[One repo, many branches](../setups/one-repo-many-worktrees.md).

**Label** (config) — the name of one app or one API inside a project, used as a piece of its
hostname. Two runtimes in one project may not share one. See
[sandboxr.yaml, field by field](../configuration/sandboxr-yaml.md).

**Label** (Docker) — where **all** durable state about a sandbox lives. There is no manifest file,
so `sandboxr ls` is a pure function of `docker ps`. See
[State lives in labels](../architecture/state.md).

**Long-run** — a supervised service that is kept alive and restarted if it dies: a backend, a served
front-end, the in-container router. See [The startup graph](../architecture/startup.md).

## M

**Machine config** — `~/.sandboxr/config.yaml`, the settings that belong to the machine rather than
to any project: how long a sandbox may sit unused, and which projects get this machine's GitHub
token. See [Paths](paths.md).

**MCP server** — an outside tool server an agent session can be given. Because a sandbox
authenticates with a setup-token, naming them in the dashboard's environment is the only route. See
[Agent sessions in the dashboard](../guides/agent-sessions.md).

**Migration** — a schema change, applied by **the project's own migration program**. sandboxr runs
the command the config names and reads its output. It never reimplements the logic. See
[Databases](../databases.md).

**mkcert** — the tool that issues the locally-trusted certificate the router serves. It is the only
certificate issuer sandboxr has. See [Install it](../getting-started/install.md).

## O

**One-shot** — a supervised step that runs once and finishes: restore the database, run migrations,
seed dependencies. One-shots *gate* long-runs, so nothing serves traffic against a database that is
not ready. See [The startup graph](../architecture/startup.md).

**Optional runtime** — a runtime declared `optional: true`, which does not start unless
`sandboxr up --with <label>` asks for it. See
[The three runtime kinds](../configuration/runtime-kinds.md).

**Owner** — for `d1` and `sqlite`, the single service allowed to open the database file. Every other
service is denied the file's location outright. See [Databases](../databases.md).

## P

**Permission mode** — which questions an agent session asks before it acts: `auto`, `acceptEdits`,
`manual`, `plan` or `dontAsk`. See
[Agent sessions in the dashboard](../guides/agent-sessions.md).

**Plan** — see [plan.json](#p).

**`plan.json`** — the fully resolved version of `sandboxr.yaml` that the host writes and the
container reads. Every default merged, every address computed, all three runtime kinds flattened
into one list. **Nothing inside a container ever reads `sandboxr.yaml`.** See
[plan.json](../architecture/plan-json.md).

**Private app** — an app hostname belonging to a project whose `access.apps` is `private`. The
router will not serve it without a dashboard session. See [Access and security](../access.md).

**Project** — a repository that describes itself in a `sandboxr.yaml`. The `project:` name in that
file appears in every hostname, container name and volume name. One project has many sandboxes. See
[Build your config, step by step](../configuration/index.md).

**Project layer** — the thin image built on top of the base image, holding what one project asks
for: its toolchains, its database engine, its installed dependencies. Its tag is a hash of what went
into it, so every sandbox of the project shares one. See
[The shape of it](../architecture/index.md).

**Prompt (agent)** — see [agent prompt](#a).

**Prune** — `sandboxr prune`, which reclaims the disk that building left behind. It reports by
default and removes only with `--yes`. See
[Giving Docker the whole machine](../guides/docker-capacity.md).

**Public app** — the default. Anyone who can reach the hostname can open the app, with no login. See
[Access and security](../access.md).

**Pull request state** — what became of the pull request on a worktree's branch: `draft`, `open`,
`closed` or `merged`. Four and not five — `draft` is GitHub's draft flag folded onto an *open* pull
request, so one that was a draft when it merged is `merged`. **No mark at all** means either that
there is no pull request or that this machine could not ask, and the two are deliberately one
answer. See [The dashboard](../guides/dashboard.md).

## R

**Reaper** — the loop that stops sandboxes past their idle limit. **It lives in the dashboard
process**, so nothing enforces a lifetime while the dashboard is not running. See
[Just the CLI, on my laptop](../setups/cli-only.md).

**Reload** — rebuilding something inside a sandbox that is already running: a backend, a front-end,
or the migrations. See [The edit–reload loop](../guides/edit-and-reload.md).

**Router** — there are two, and a request passes through both. The **shared router** is one Traefik
container per machine, which terminates TLS and picks a container by hostname. The **sandbox's own
router** is Caddy, inside every container. See
[How a request arrives](../architecture/request-path.md).

**Runtime kind** — what a declared thing actually *is* at run time: a backend, a static front-end,
or a served front-end. Exactly three, and none is a variation on another. See
[The three runtime kinds](../configuration/runtime-kinds.md).

## S

**Secrets** — third-party credentials a project needs, kept in one file per project that you edit
by hand, from the CLI or from the dashboard, and can import its own `.env` files into under rules
that refuse anything describing *where* something runs. The file is mounted read-only into every
sandbox of the project. Names are printed; values never are, except when you ask for one.
See [Secrets](../configuration/secrets.md).

**Storage** — the S3-compatible object store inside each sandbox, so uploads never reach a real
bucket. Declared as `storage: { driver: minio, buckets: [...] }`, and `none` by default. See
[sandboxr.yaml, field by field](../configuration/sandboxr-yaml.md).

**Supervisor** — the process inside a container that starts the project's services in the right
order and restarts one that dies. sandboxr's is [s6](#s). See
[The startup graph](../architecture/startup.md).

**s6** — the supervisor inside each container. It starts each service in order, restarts one that
dies, and compiles its service list once, before anything runs. See
[The startup graph](../architecture/startup.md).

**Sandbox** — a complete, disposable copy of a project running in one container: its services, its
front-ends, its own database, its own file storage. One per branch. See
[What sandboxr is](../introduction.md).

**Seed** — the starting data a sandbox's database is filled with. See
[Databases](../databases.md).

**Seed artifact** — the reusable *result* of preparing a seed, produced on the host and cached under
a name derived from its content. The expensive part happens once, not once per sandbox. See
[Databases](../databases.md).

**Seed source** — where a seed comes from: `local` (a database container you already run), `file` (a
dump you keep) or `fixtures` (SQL in the repository). See [Databases](../databases.md).

**Served front-end** — a front-end that *is* a long-running process serving itself, declared with
`serve:` and a `port`. The most expensive thing in a sandbox, because it holds its whole module graph
in memory whether or not anyone opens it. See
[The three runtime kinds](../configuration/runtime-kinds.md).

**Session** — the dashboard's signed-in state, held in a cookie. Not an
[agent session](#a). See [Access and security](../access.md).

**Side question** — a `/btw` in an agent session: a second, read-only process forked off the
conversation, so you can ask something without disturbing the run. See
[Agent sessions in the dashboard](../guides/agent-sessions.md).

**Slug** — the short name for one sandbox, and the first piece of its hostname. Derived, in order of
preference, from an explicit argument, a ticket-style id in the worktree directory name, that pattern
in the branch name, the branch name, then the directory name. Capped at **31 characters**, and hashed
rather than truncated past that. See [How it works, in five steps](../how-it-works.md).

**Snapshot** — the schema of a sandbox's database, printed. Two snapshots and `diff` is how you see
what a migration changed. See [Testing a migration](../guides/testing-a-migration.md).

**Static front-end** — a front-end built once into a directory of files and served as files,
declared with `out:`. No process, so it costs nothing when nobody is looking. Built on demand, never
at startup. See [The three runtime kinds](../configuration/runtime-kinds.md).

**`static_mode`** — how a built directory is served. `spa` sends every unknown path to `index.html`,
`html` looks up `about.html` when asked for `/about`, `files` returns a real 404. Declared rather
than guessed, because the wrong value **half-works** instead of failing. See
[sandboxr.yaml, field by field](../configuration/sandboxr-yaml.md).

**Status surface** — the paths under `/__sandboxr/` that every sandbox answers on *every* hostname it
serves, whether or not its database is ready. See
[How a request arrives](../architecture/request-path.md).

## T

**Terminal** — a shell inside a sandbox, in the browser. It is a route within the dashboard, so it
inherits the dashboard's session. See [Logs, shells and terminals](../guides/logs-and-shells.md).

**Toolchain** — the language runtimes a project asks for, as `toolchain: { go, node }`. They are
installed into the project layer. See
[sandboxr.yaml, field by field](../configuration/sandboxr-yaml.md).

**Traefik** — the shared router: one container per machine, in front of every sandbox. It reconciles
from Docker labels, so starting a sandbox writes no config file. See
[How a request arrives](../architecture/request-path.md).

**ttl** — how long a sandbox may sit **unused** before it is stopped. `30m`, `12h`, `3d`, a number
of seconds, or `never`. Default 12 hours. See
[Projects, worktrees and lifetimes](../guides/managed-sandboxes.md).

## W

**Workspace** — the repositories sandboxr keeps for itself, one directory per project, so a sandbox
can be a branch you pick rather than a worktree you made by hand. See
[Several repositories at once](../setups/many-projects.md).

**Worktree** — a second checkout of the same repository, made with `git worktree add`, so several
branches are open at once sharing one `.git`. sandboxr works from worktrees rather than clones, so a
sandbox is always tied to exactly one branch. See
[How it works, in five steps](../how-it-works.md).

---

**Next:** [Cheat sheet](cheat-sheet.md) for the same facts as commands and tables, or
[What sandboxr is](../introduction.md) if a definition here raised a bigger question.
