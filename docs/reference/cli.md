---
title: CLI commands
description: Every sandboxr command, its flags, what it touches and what it returns.
sidebar:
  order: 1
---

```
sandboxr <command> [slug] [flags]
```

Transcribed from `packages/cli/src/main.ts`, which is the authority. `sandboxr help` prints the
same tree.

## Conventions

**The slug is optional everywhere.** Standing in the worktree is enough — sandboxr derives the name
from a ticket-shaped id in the directory, then in the branch, then the branch itself, then the
directory. `--slug NAME` and the positional argument are the same thing.

The exceptions are `stop`, `start`, `keep` and `unkeep`: they act on a sandbox somewhere else on the
machine rather than the one you are standing in, so they want the slug spelled out.

**Output goes to two streams.** Human-readable text and progress go to **stderr**; `--json` puts
the result on **stdout**. `sandboxr logs` and `sandboxr db snapshot` put their real output on
stdout whether or not you asked for JSON, so redirecting either produces the file you expected.

| Exit | Means |
|---|---|
| `0` | Fine |
| `1` | Something failed |
| `2` | A config error, naming the file and the field |
| `3` | The sandbox is **degraded** — up, with failed migrations |

## Setup

### `sandboxr init`

Sets this machine up: creates `~/.sandboxr` and the shared Docker network, builds the base and
dashboard images, issues a certificate if one can be trusted, and starts the router and the
dashboard. Idempotent — it is also how you change the domain, rotate the password, or pick up TLS
after installing mkcert.

| Flag | What it does |
|---|---|
| `--no-tls` | Serve plain HTTP even if a trusted CA is present |
| `--tls` | Insist on HTTPS even if the CA is not trusted yet |
| `--rebuild` | Rebuild the base and dashboard images |
| `--bind ADDR` | Publish the router here instead of `127.0.0.1` |
| `--http-port N` | Publish HTTP here instead of 80 |
| `--https-port N` | Publish HTTPS here instead of 443 |

Reads `SANDBOXR_PASSWORD` and passes it to the dashboard. Without one, the dashboard starts and
admits nobody.

### `sandboxr teardown [--network]`

Stops the router and the dashboard, and with `--network` removes the shared network. **Leaves
sandboxes running** — those are `down`'s business.

## Sandboxes

### `sandboxr up [slug]`

Reads `sandboxr.yaml`, prepares the seed, builds the project image if needed, issues a certificate,
starts the container, waits for it, provisions the database, prints the URLs.

| Flag | Default | What it does |
|---|---|---|
| `--worktree PATH` | the current directory | Which worktree to build from |
| `--project NAME` | — | A project in the workspace, instead of a path. Needs `--branch` |
| `--branch NAME` | — | Which branch of that project to run. Its worktree is found, or cut |
| `--base REF` | — | Create `--branch` off this ref rather than expecting it to exist |
| `--ttl 12h\|never` | `~/.sandboxr/config.yaml`, else `12h` | Stop the sandbox once it has sat unused this long. `30m`, `12h`, `7d`, `never`. An unreadable value is refused by name |
| `--slug NAME` | derived | Same as the positional argument |
| `--with a,b` | none | Also start these `optional: true` runtimes |
| `--seed local\|file\|fixtures` | whatever the config allows | Force the seed source. An unrecognised value is refused by name |
| `--detach` | off | Do not wait, and skip the database step |
| `--timeout N` | `180` | Seconds to wait for the container to become ready |
| `--json` | off | The whole result on stdout |

With `--project` there is no config to read until the worktree exists, so the resolution happens in
core and the config is loaded from the worktree it picked. Without it, nothing changes: the current
directory, or `--worktree`. See [Projects, worktrees and lifetimes](../guides/managed-sandboxes.md).

`up` is the only command that **enforces the public-sandbox access rules**; everything else loads
the config without them, so you can still inspect and clean up a project whose config would be
refused.

Starting a sandbox that already exists replaces the container and keeps its volumes.

### `sandboxr down [slug] [--keep]`

Removes the container, its certificate and the router's entry for it, and — unless `--keep` — its
`data`, `blob`, `bin` and `www` volumes. Never touches the worktree, the branch or the source
database. A sandbox that does not exist is not an error.

### `sandboxr ls [--project NAME]`

Every sandbox on the machine: project, slug, state, ttl, branch, worktree. `*` after a branch means
the worktree had uncommitted changes when the sandbox started. `list` is an accepted alias.

**TTL** is one column for two facts, because they answer the same question — when does this go
away? It reads `12h`, `never`, `-` for a sandbox with no ttl, or `kept`. `kept` is shown *instead*
of the ttl rather than beside it: it is what the clock will actually do to that sandbox.

### `sandboxr stop <slug>`, `sandboxr start <slug>`

Stops the container, or starts a stopped one again. Everything else survives — the volumes, the
database, the worktree — so `start` takes seconds where `up` would rebuild and re-seed.

Stopping something already stopped is the state you asked for, so it exits `0`. Starting something
that does not exist cannot be, so it exits `1`.

### `sandboxr keep <slug>`, `sandboxr unkeep <slug>`

Exempts one sandbox from the idle clock, or hands it back. The marker records the sandbox's
`sandboxr.created` value, so it only counts for the container it was written for: keeping a sandbox
that is not there is refused rather than left as a file that would silently keep whatever next takes
the name.

`pin` and `unpin` are the names these had before, and still work. They are not listed in `--help`.

### `sandboxr expire [--dry-run] [--project NAME]`

Stops every sandbox that has sat unused past its limit. `--dry-run` prints what would be stopped and
why without stopping anything.

The clock runs from the later of the container's **current start time** and the last request that
reached the sandbox through the router — never from when it was created. So using a sandbox buys it
a full lifetime, and so does pressing `start`. A sandbox that is kept alive, one with no ttl, and
one Docker cannot give a start time for are all left alone. `--dry-run` lists what would be stopped
with the reason each was chosen; `--json` adds what was kept, with the reason each survived.

```
KEEP  main      — no expiry set
KEEP  staging   — 3h 25m left, idle 34m
STOP  tkt-4821  — idle 13h, past its 12h limit
```

Last activity is read from the shared router's access log at the moment it is asked for, so nothing
is stored and nothing can drift. With no router running, no sandbox has a last-activity time and
every one of them falls back to its start time — a log that cannot be read must never be mistaken
for "nobody has used anything".

#### The project a slug belongs to

`stop`, `start`, `keep` and `unkeep` name a sandbox rather than stand in one, so they work out its
project in this order:

1. `--project NAME`, if given.
2. The one sandbox in `sandboxr ls` with that slug. A slug in two projects is ambiguous and is
   refused, naming them, rather than picked between.
3. The config in the current worktree.

### `sandboxr status [slug]`

One sandbox in detail: state, branch, driver, migration verdict, access, worktree, which apps have
been built, and whether each backend answers its health path. Exit `3` if degraded.

### `sandboxr logs [slug] [--tail N] [-f]`

The container's own log stream. `--tail` defaults to **200**; `-f` / `--follow` streams. Takes **no**
service argument — for one service, read its file under
`~/.sandboxr/logs/<project>/<slug>/`.

### `sandboxr shell [slug] [-- command…]`

An interactive shell inside the sandbox, starting in `/workspace`. With `--` it runs that command
instead. Defaults to `bash`.

### `sandboxr reload [slug] …`

Rebuilds something inside a running sandbox and restarts it. Throws if the sandbox is missing or
stopped.

| Flag | What it rebuilds |
|---|---|
| `--migrate` | Re-runs this sandbox's migrations |
| `--web <label\|all\|built>` | A front-end. Bare `--web` means `all` |
| `--go [name]` | A backend. Bare `--go` means every backend. `--backend` is an accepted alias |

One kind at a time: `--migrate` wins, then `--web`, then `--go`. None of them is an error. Exit `1`
if any target failed, with the last 20 lines of its output.

### `sandboxr gc [--dry-run]`

Reaps sandboxes whose recorded worktree no longer exists, then removes `sandboxr-` volumes nothing
owns and nothing has mounted. Shared and `sandboxr-deps-*` volumes are left alone.

## Projects and worktrees

The workspace is the repositories sandboxr keeps for itself, so a sandbox can be a branch you pick
rather than a worktree you made.
[Projects, worktrees and lifetimes](../guides/managed-sandboxes.md) is the guide; these are the
commands.

| Command | What it does |
|---|---|
| `sandboxr project ls` | Every project in the workspace: name, base branch, origin |
| `sandboxr project available` | Repositories your `gh` can reach, newest-updated first. `added` marks the ones already in the workspace; `*` after a name means a fork |
| `sandboxr project clone <url> [--name NAME]` | Clone one in, as a bare mirror. `--name` overrides the name taken from the url |
| `sandboxr project fetch <name>` | Update its remote-tracking branches. Never touches local work |
| `sandboxr project prs <name>` | Open pull requests, as `gh` reports them. `*` after a number means draft |
| `sandboxr worktree ls <project>` | Every worktree cut from it. `~` after a branch means detached, `(GONE)` means the directory is not there |
| `sandboxr worktree add <project> <branch> [--base REF]` | Cut one for a branch, or hand back the one already there |
| `sandboxr worktree rm <project> <branch> [--force]` | Remove it. `--force` for a worktree with uncommitted work in it |

`project prs` reads GitHub through `gh`, and an empty answer has more than one cause — so it says
which: not a GitHub repo, no `gh` or a `gh` that is not logged in, or genuinely nothing open.

`project available` reads GitHub through `gh` too, so it is the same story: with no `gh`, or one
that is not logged in, it says so in a sentence and exits `0` — an empty list is an ordinary answer,
and `project clone <url>` still works. It lists the 200 most recently updated repositories and says
so when there were more, because a repository missing from a list you are picking from otherwise
reads as one `gh` cannot see.

A repository counts as `added` when a project in the workspace was cloned from it, whichever way
each of them spells the URL — a project cloned over ssh and a listing giving https are one
repository, not two.

Naming a project that is not in the workspace exits `1` and says so; it never clones one by
accident.

## Databases

| Command | What it does | Needs a running sandbox |
|---|---|---|
| `sandboxr db seed [--seed SOURCE]` | Produce or refresh the seed artifact | no |
| `sandboxr db migrate [slug]` | Run the project's migration command. Exit `1` on failure, and it prints the baseline's path | yes |
| `sandboxr db snapshot [slug]` | Print the schema to **stdout** | yes |
| `sandboxr db shell [slug]` | An interactive database prompt. Read-only for `d1` | yes |

There is no `db diff` and no `db reset`: two snapshots and `diff`, and `down` then `up`.

## Secrets

| Command | What it does |
|---|---|
| `sandboxr secrets import` | Read the project's `.env` files and write `~/.sandboxr/secrets/<project>.env` |
| `sandboxr secrets check` | Say which credentials are missing, by name. Exit `1` if any is |

Both print **names only, never values**.

## Working out what is wrong

### `sandboxr doctor`

Checks, in order: Docker is running; the base image exists; the router is running; the dashboard is
running; whether the router is serving HTTP or HTTPS and why; `SANDBOXR_PASSWORD` is set; a config
was found; the config resolves; a file database is pointed at the sandbox's state directory; the
project's secrets are present; where `SANDBOXR_HOME` is; how many sandboxes exist.

Exit `1` if it finds anything. Every finding names the fix.

### `sandboxr config`

Which config was used and what it resolved to — project, file, root, origin, driver, access,
backends, front-ends. Exit `2` if there is no config here or in any parent. `--json` prints the
whole resolved config, which is the fastest way to see what a default became.

`file` is the file the settings came from and `root` is the directory they resolve against — the
one mounted at `/workspace`. They are the same directory for a project that describes itself at its
own repo root, and `origin` says when they are not:

```
demo
  file        /home/you/.sandboxr/workspace/demo/sandboxr.yaml
  root        /home/you/.sandboxr/workspace/demo/wt/tkt-5000
  origin      the workspace project directory, not this worktree
   ! this worktree has no sandboxr.yaml of its own, so the project-level one applies
```

That is a [project-level config](../guides/managed-sandboxes.md#a-config-for-a-project-that-has-not-committed-one),
the fallback for a worktree that carries none. `sandboxr doctor` names it too.

### `sandboxr version`, `sandboxr help`

## What each command touches

| Command | Scope | Destructive |
|---|---|---|
| `init` | machine | Replaces the router and dashboard containers |
| `teardown` | machine | Removes them. Leaves sandboxes alone |
| `up` | one sandbox | Replaces the container; **keeps** its volumes |
| `down` | one sandbox | Removes the container, database and uploads |
| `ls`, `status`, `logs`, `config`, `doctor`, `version` | — | No |
| `stop`, `start` | one sandbox | No — the container only |
| `keep`, `unkeep` | one sandbox | No — one file under `~/.sandboxr/state/keep/` |
| `expire` | machine | Stops **every** sandbox past its idle limit. Nothing is removed |
| `project ls`, `project available`, `project prs`, `worktree ls` | workspace | No |
| `project clone`, `project fetch` | workspace | Writes a project directory; a fetch never touches local work |
| `worktree add` | one project | Creates a checkout |
| `worktree rm` | one project | Removes a checkout, and with `--force` any uncommitted work in it |
| `shell` | one sandbox | Whatever you run |
| `reload` | one sandbox | Rebuilds; touches data only with `--migrate` |
| `gc` | machine | Reaps **every** sandbox whose worktree is gone |
| `db seed` | project | Rewrites the shared seed artifact |
| `db migrate` | one sandbox | That sandbox's database only |
| `db snapshot`, `db shell` | one sandbox | `shell` is interactive |
| `secrets import` | project | Writes the project's secrets file |

## Related

- [Start, stop, list, clean up](../guides/lifecycle.md) — the same commands, with context
- [Projects, worktrees and lifetimes](../guides/managed-sandboxes.md) — the workspace, lifetimes and keep-alive
- [Environment variables](environment.md)
