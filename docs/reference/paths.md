---
title: Paths
description: Every path sandboxr reads or writes — in its own repository, in your project, on your computer, and inside a container.
---

Four separate places, and mixing them up is the most common way to get lost. This page lists all of
them.

## 1. Your project's repository

One file, at the root of the project you want to sandbox.

```
your-project/
  sandboxr.yaml     ← the whole configuration, versioned with the code
```

It lives with the project rather than with sandboxr, so a new service and the settings that describe
it land in the same commit.

**The directory holding that file is what gets mounted at `/workspace`.** The config's directory, not
the git top level — so a project kept in a subdirectory of a larger repository is mounted at the
right level.

There is one exception, for a managed project that has not committed a config yet. It can keep one
[beside its mirror](#the-workspace), and every worktree with none of its own uses it. The worktree is
still what gets mounted.

## 2. On your computer

Everything sandboxr writes at run time lives under `SANDBOXR_HOME`, default `~/.sandboxr`.

| Path | What it holds | Survives `down`? |
|---|---|---|
| `cache/` | Database seed artifacts, named by content | yes |
| `logs/<project>/<slug>/` | Per-sandbox logs, and the schema baselines | **yes** — deliberately |
| `tls/` | Certificates and keys the router serves | yes |
| `state/` | Router config, the dynamic config directory, the dashboard's session key | yes |
| `state/keep/<project>/<slug>` | Keeps one sandbox alive past its idle limit | **no** — see below |
| `state/name/<project>/<slug>` | What to call one worktree on screen | **yes** — see below |
| `state/slug/<project>/<worktree dir>` | The slug a worktree was given when it collided with a sibling | **yes** — see below |
| `state/attach/<project>/<slug>` | When a socket was last held open on one sandbox | yes — see below |
| `state/session/<session>/` | The same three files, for a session rather than a worktree — see below | goes with the session |
| `secrets/<project>.env` | Third-party credentials, mode 0600. **A file you edit** — see below | yes |
| `build/<project>/<slug>.env` | The generated environment for one sandbox | yes |
| `build/<project>/<slug>.plan.json` | The plan for one sandbox | yes |
| `bin/` | Helper binaries built on the host | yes |
| `run/` | The Unix sockets the voice and Telegram sidecars listen on | yes |
| `host.env` | What only this machine can look up, for the compose deployment. Mode 0600 — see below | yes |
| `agent/runs.json` | Which agent session belongs to which sandbox | yes |
| `agent/grants.json` | Standing agent permissions, per project | yes |
| `agent/log/<id>.jsonl` | One agent session's transcript, append-only | yes |
| `config.yaml` | The machine's own settings | yes |
| `workspace/<project>/` | A managed project: its bare clone and its worktrees | yes |
| `workspace/<project>/sandboxr.yaml` | Optional: a config for worktrees that have none | yes |

The logs surviving is on purpose. The logs from a sandbox you have just deleted are usually exactly
the ones you wanted.

> [!NOTE] Never inside a repository
> `git clean -xdf` is an ordinary thing to run, and it would destroy the seed cache, the certificates
> and every sandbox's logs.

### The two files you edit

`config.yaml` holds what belongs to the machine rather than to any project. `sandboxr init` writes a
commented example the first time and never touches it again.

```yaml
# How long a sandbox may sit unused before it is stopped.
ttl: 12h
# Whether a sandbox is handed this machine's GitHub token. `none` or `token`.
github: none
# Files on this machine that every sandbox can read. One file per row, never a
# directory. `~` expands.
share:
  - host: ~/.claude/.credentials.json
    into: /root/.claude/.credentials.json
# Per project, optional. The key is the project's workspace directory, or the
# `project:` its own sandboxr.yaml declares. Either works.
projects:
  acme-monorepo: { ttl: 3d, github: token }
```

`share:` is how a login you already have on this machine — a Claude credential, an `.npmrc`, a
read-only deploy key — reaches the containers without being copied into an image or typed into a
project's secrets.

> [!WARNING] A row whose file is missing or empty is skipped, on purpose
> Docker answers a missing bind source by creating a **directory** at that path on your machine,
> which loses the file you were pointing at. An empty file mounted over a container's working copy
> replaces something with nothing — which is how a Mac whose `~/.claude/.credentials.json` is an
> empty placeholder made every sandbox report `Not logged in`, with a valid login sitting on the
> host the whole time. So sandboxr checks that the source is a file with something in it, and
> quietly leaves the row out otherwise. It never reads what is in it.

> [!WARNING] Upgrading: a machine with no `share:` row shares nothing
> The Claude credential used to be mounted unconditionally. It is now a row like any other, so a
> machine upgraded without one loses that login in every sandbox at once. `jef init` writes and
> repairs the row; if you run the CLI on its own, add it by hand.

A missing file means the defaults. A malformed one is an error naming the file and the key — because
silently applying a default lifetime to a machine where somebody has just written down the lifetime
they wanted is how a week of work gets stopped after twelve hours.

A `projects:` key naming no project is a warning rather than an error: one stale entry must not stop
every other project on the machine starting. `sandboxr doctor` names it, and lists the names that
would have matched.

`secrets/<project>.env` is the other one. It holds a project's third-party credentials, at mode
`0600`, as `NAME="value"` one per line. It is **edited, not generated**: `sandboxr secrets set`,
`sandboxr secrets edit` and the dashboard's Environment panel all author it directly, and
`sandboxr secrets import` merges a project's own `.env` files into whatever is already there. It is
mounted read-only into every sandbox of the project, so an edit reaches a running one on a restart.
See [Secrets](../configuration/secrets.md).

### `host.env`, which you do not edit

`host.env` is the opposite of those two: generated every time `sandboxr init` runs, so an edit to it
is lost. It holds the handful of values only a program running on this machine can find — the GitHub
token out of the login keychain, your commit identity out of your gitconfig, and the path of your
Claude login — and [the compose deployment](../guides/compose.md) reads it. It is mode `0600` because
it holds a token. The settings *you* choose live in `.env` beside the compose file, which is
hand-written and never generated.

### The keep-alive marker

`state/keep/<project>/<slug>` is the only row that does not survive `down`, including `down --keep`.
The container is gone either way, and a marker for a container that no longer exists means nothing.

It is not relied on, though. The file records which container instance it was written for, so one
left behind by a bare `docker rm` is ignored rather than applied to whatever takes the slug next.

### The attach heartbeat

`state/attach/<project>/<slug>` is stamped every thirty seconds while the dashboard is holding a
terminal or an agent panel open on that sandbox, and once more when the last one closes. Only its
modification time is read; the text inside is there so the directory means something if you look at
it.

It exists because a websocket does not appear in the router's log until it *closes*, and the line is
stamped with the moment it opened — so a session held open for longer than the sandbox's lifetime
left no evidence of being used, and the sandbox was stopped underneath it. This is the one thing on
the machine sandboxr has to write down rather than derive, because the only process that knows a
socket is open is the one holding it, and `sandboxr expire` on the command line is a different
process.

It survives `down`, and a stale one is harmless: all it records is a moment, and a moment older than
the container currently holding that name counts for nothing. Delete it if you like — the sandbox
falls back to its start time, which is the same thing that happens if the dashboard has never run.

### A worktree's name

`state/name/<project>/<slug>` holds what you have chosen to call one worktree — "the checkout flow
rewrite" rather than `feat/tkt-4821`. It is the row directly above's opposite number, and comparing
the two is the quickest way to see the rule both follow.

A keep-alive marker applies to a container, so it names one and dies with it. A name applies to the
*worktree*, which outlives every sandbox cut on it — so it carries no instance and survives `down`,
a delete, and being started again. Stamping it would mean a rename quietly undoing itself the next
time you rebuilt.

It is only a label. **Renaming a worktree moves nothing**: the slug, the hostname, the container
name and every URL are still built from the branch and the directory. Set it with
`sandboxr worktree name <project> <branch> <name>`; an empty name hands the worktree back to its
branch. The file is plain text and you can edit it by hand — one that has been
edited into something that is not a name (more than 60 characters, or with a line break in it) is
read as *no name*, so the worktree shows its branch again rather than showing something broken.

### A worktree's given slug

`state/slug/<project>/<worktree dir>` exists for one situation: two branches on one ticket.
`feat/eng-3941-answers-page` and `feat/eng-3941-run-selector` both derive the slug `eng-3941`,
and a slug is what names the container, the volumes, the hostname and the database lock — so
without this the two branches would be one sandbox, and starting the second would take the
first one's database.

When sandboxr cuts the second worktree it notices, gives it a slug of its own — `eng-3941-7k2f`,
four random characters — and writes it here. **The random part cannot be worked out again, so
this file is the only place the answer exists.** Everything that needs the slug reads it from
here first and derives only when there is nothing to read.

It is keyed on the worktree's *directory* name rather than on a slug, because the slug is the
thing the file decides. It survives `down` and every rebuild, for the same reason a worktree's
name does: it belongs to the worktree, not to a container. `sandboxr worktree rm` deletes it.

You can edit it by hand, and a file edited into something that is not a slug reads as *nothing
recorded* — the worktree goes back to the slug it derives. That is visible and undoable, which
is what you want from a value that ends up in a hostname.

> [!NOTE] Only worktrees sandboxr cut for you
> The check happens when sandboxr creates a worktree, so it covers the ones under
> `workspace/<project>/wt/`. Worktrees you keep yourself, in your own repository, can still
> collide — pass a name with `sandboxr up <name>` if two of them share a ticket.

### A session's three files

A **session** — the thing that replaces the worktree, and which nothing you can type reaches yet
([What is built](status.md)) — keeps the same three files as the rows above, in one directory of
its own:

```
state/session/<session>/keep      keeps the session's container alive past its idle limit
state/session/<session>/name      what to call the session on screen
state/session/<session>/attach    when a socket was last held open on it
```

Each one behaves exactly as its worktree counterpart above does, including which of them carries
a stamp and which must not. What is different is the shape, and the reason is a collision you
would never find from the symptom: `state/keep/` has a *project* directory at its first level, so
a session and a project of the same name would have been one file — and a sandbox would have
stopped expiring because somebody had pinned a session.

The directory is created the first time there is something to put in it, and deleting the session
removes the whole of it in one go.

### The workspace

The workspace has its own variable, `SANDBOXR_WORKSPACE`, because the repositories are the one part
of this tree worth putting on a different disk. Inside it, one directory per project:

```
<workspace>/<project>/
  sandboxr.yaml    optional — a config for every worktree that has none of its own
  repo.git/        a bare clone — this is what makes the directory a project
  wt/<branch>/     one worktree per branch, all peers
```

**A project is a directory containing `repo.git`.** There is no registry file, so listing the
projects is a directory read — a pure function of the filesystem, for the same reason `sandboxr ls`
is a pure function of `docker ps`.

`sandboxr.yaml` here is the only file you put in a project directory by hand, and it is a stopgap. A
worktree is a separate checkout, so an uncommitted config in one does not exist in any other, and
without this you would copy the file into every new worktree for ever. A worktree that carries its
own config always wins, so committing the file upstream ends the arrangement on its own. See
[Several repositories at once](../setups/many-projects.md).

> [!WARNING] The project directory is read, never mounted
> It holds `repo.git` and every other worktree. Only a worktree is ever mounted at `/workspace`, and
> running `sandboxr up` from the project directory itself is refused with an error saying so.

`SANDBOXR_HOME` overrides the root and everything else is derived from it, so there is no second
variable to set. On a server, set it **in the service definition**, not in a login shell: a service
started at boot has no login shell, and the fallback to `~/.sandboxr` under a service account puts
the state somewhere nobody looks.

## 3. Inside a running sandbox

| Path | What it is | Mounted |
|---|---|---|
| `/workspace` | Your worktree | read-write |
| `/sandboxr/plan.json` | The plan | read-only |
| `/sandboxr/secrets.env` | The project's third-party credentials — only when it has a secrets file | read-only |
| `/sandboxr/cache/` | The host's seed cache | read-only |
| `/sandboxr/seed/<name>` | A seed file you declared with `seed_from.file` — that one file, from wherever you keep it | read-only |
| `/var/lib/sandboxr/data` | The database | the `data` volume |
| `/var/lib/sandboxr/blob` | Object storage | the `blob` volume |
| `/var/lib/sandboxr/bin` | Compiled backends | the `bin` volume |
| `/srv/www` | Built websites, one directory per app label | the `www` volume |
| `/srv/www/.built.json` | What this sandbox has built, and when | on that volume |
| `/var/log/sandboxr` | Per-service log files | from the host's `logs/` |
| `/run/sandboxr` | Marker files the status document is composed from | a tmpfs — gone with the container |
| `/opt/sandboxr/scripts/` | The container scripts | from the image |
| `/opt/deps` | Dependencies installed into the image, copied out on first boot | from the image |
| `/go/pkg/mod`, `/go/cache` | Go's module and build caches | machine-wide volumes |
| `/root/.claude` | Claude Code's state | the machine-wide `sandboxr-claude` volume |
| `/root/.claude/.credentials.json` | The host's own `~/.claude/.credentials.json`, when it has one. On Linux that file is its Claude Code login; on macOS it [usually is not](../guides/agent-sessions.md#on-macos-that-file-is-usually-not-your-login) | that one file, read-write |

```bash
sandboxr shell tkt-4821      # and look for yourself
```

<details class="agent">
<summary><b>Details for an agent</b> — the two mounts that make git work, and why they use host paths</summary>

Two more mounts exist and they are not in the table because their paths are not fixed: **the worktree
a second time, at the path the host calls it**, and **the repository the worktree points at**,
read-write.

A linked worktree's `.git` is a *file* holding `gitdir: <repo>/worktrees/<name>` — an absolute host
path. A container with only `/workspace` therefore fails every git command with
`fatal: not a git repository`, naming a directory that is not there. Mounting both at the identical
path inside and out is what fixes it. The repository mount is read-write because `git commit` writes
objects and refs into it.

Neither is present for a plain checkout, whose `.git` is inside `/workspace` already. The host
decides which is which.

The Claude credential is **one file, and the directory around it is deliberately not mounted.**
Binding all of the host's `~/.claude` would give every sandbox write access to its `settings.json`,
which can define hooks — commands the host's own Claude Code then executes. It is shared rather than
copied because an OAuth refresh token rotates and is single-use: two copies invalidate each other the
first time either side refreshes, which is why that mount is read-write.

The Go cache paths must keep agreeing with the image's `GOPATH` and `GOCACHE`. Mounting a volume
anywhere else leaves the real cache in the container's writable layer, where it dies with the
container — and the symptom is not a missing mount, it is "sandboxes are just slow", for ever.

</details>

## 4. The sandboxr repository

Where to look when you need the source rather than the documentation.
[Package by package](../architecture/packages.md) is the guide to this.

| Path | What it is |
|---|---|
| `packages/core` | Config, drivers, Docker orchestration, the access layer, lifecycle |
| `packages/cli` | The whole command surface |
| `packages/server` | The dashboard's server |
| `packages/web` | The dashboard's browser app |
| `packages/docs` | The machinery that publishes `docs/` as a site |
| `container/base`, `container/project` | The two images |
| `container/scripts` | What a sandbox runs at boot |
| `docs/architecture/contracts.md` | **The source of truth for every boundary** |
| `examples/` | Example configs, and a project that really runs |

<details class="agent">
<summary><b>Details for an agent</b> — which file answers which question</summary>

| Question | File |
|---|---|
| What fields does `sandboxr.yaml` accept? | `packages/core/src/config/schema.ts` |
| What refuses a config, and why? | `packages/core/src/config/load.ts`, `access.ts`, `advice.ts` |
| What is in `~/.sandboxr/config.yaml`? | `packages/core/src/config/machine.ts` |
| What does the container actually receive? | `packages/core/src/config/plan.ts`, and `container/README.md` |
| What is a sandbox called? | `packages/core/src/naming.ts` |
| Where does sandboxr write on my disk? | `packages/core/src/paths.ts`, and `packages/sessions/src/paths.ts` for a session's own files |
| Which paths does the container see? | `packages/core/src/sandbox/layout.ts` |
| What does `docker run` get? | `packages/core/src/sandbox/run.ts` |
| What does the host pass into a container? | `packages/core/src/sandbox/env.ts` |
| Every command and flag | `packages/cli/src/main.ts`, the `USAGE` constant |
| The dashboard's own variables | `packages/server/src/env.ts` |
| What the dashboard can run | `packages/server/src/actions/table.ts` — a closed list |
| What does the container do at boot? | `container/scripts/entrypoint.sh` |
| How is a database seeded and migrated? | `container/scripts/db/<driver>.sh` |

</details>

## Docker object names

For a project `acme` and a slug `tkt-4821`:

| Object | Name |
|---|---|
| Container | `sandboxr-acme-tkt-4821` |
| Network | `sandboxr` — one, shared by every sandbox on the machine |
| Database volume | `sandboxr-data-acme-tkt-4821` |
| Uploads volume | `sandboxr-blob-acme-tkt-4821` |
| Binaries volume | `sandboxr-bin-acme-tkt-4821` |
| Built sites volume | `sandboxr-www-acme-tkt-4821` |
| Shared dependencies | `sandboxr-deps-<16 hex of the lockfile hash>` |
| Shared Go caches | `sandboxr-gocache`, `sandboxr-gomod` |
| Shared agent state | `sandboxr-claude` |
| Project image | `sandboxr/acme:<12 hex of the build inputs>` |
| Machine images | `sandboxr/base`, `sandboxr/dashboard` |
| The router | `sandboxr-router` |
| The dashboard | `sandboxr-dashboard` |

## What is not stored anywhere

There is no list of sandboxes. No manifest file, no database of what exists. Everything sandboxr
knows about a running sandbox is read from Docker container labels at the moment you ask.
[Why that matters](../architecture/state.md).

---

**Next:** [Environment variables](environment.md) for what gets written into
`build/<project>/<slug>.env`, or [Giving Docker the whole machine](../guides/docker-capacity.md) when
one of these directories has grown too large.
