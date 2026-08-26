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
| `--slug NAME` | derived | Same as the positional argument |
| `--with a,b` | none | Also start these `optional: true` runtimes |
| `--seed local\|file\|fixtures` | whatever the config allows | Force the seed source. An unrecognised value is refused by name |
| `--detach` | off | Do not wait, and skip the database step |
| `--timeout N` | `180` | Seconds to wait for the container to become ready |
| `--json` | off | The whole result on stdout |

`up` is the only command that **enforces the public-sandbox access rules**; everything else loads
the config without them, so you can still inspect and clean up a project whose config would be
refused.

Starting a sandbox that already exists replaces the container and keeps its volumes.

### `sandboxr down [slug] [--keep]`

Removes the container, its certificate and the router's entry for it, and — unless `--keep` — its
`data`, `blob`, `bin` and `www` volumes. Never touches the worktree, the branch or the source
database. A sandbox that does not exist is not an error.

### `sandboxr ls [--project NAME]`

Every sandbox on the machine: project, slug, state, branch, worktree. `*` after a branch means the
worktree had uncommitted changes when the sandbox started. `list` is an accepted alias.

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

Where the config was found and what it resolved to — project, file, driver, access, backends,
front-ends. Exit `2` if there is no config here or in any parent. `--json` prints the whole
resolved config, which is the fastest way to see what a default became.

### `sandboxr version`, `sandboxr help`

## What each command touches

| Command | Scope | Destructive |
|---|---|---|
| `init` | machine | Replaces the router and dashboard containers |
| `teardown` | machine | Removes them. Leaves sandboxes alone |
| `up` | one sandbox | Replaces the container; **keeps** its volumes |
| `down` | one sandbox | Removes the container, database and uploads |
| `ls`, `status`, `logs`, `config`, `doctor`, `version` | — | No |
| `shell` | one sandbox | Whatever you run |
| `reload` | one sandbox | Rebuilds; touches data only with `--migrate` |
| `gc` | machine | Reaps **every** sandbox whose worktree is gone |
| `db seed` | project | Rewrites the shared seed artifact |
| `db migrate` | one sandbox | That sandbox's database only |
| `db snapshot`, `db shell` | one sandbox | `shell` is interactive |
| `secrets import` | project | Writes the project's secrets file |

## Related

- [Start, stop, list, clean up](../guides/lifecycle.md) — the same commands, with context
- [Environment variables](environment.md)
