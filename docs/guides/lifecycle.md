---
title: Start, stop, list, clean up
description: up, ls, status, down, gc and prune — what each one really removes, and why deleting a sandbox can never lose your work.
sidebar:
  order: 1
---

```bash
cd .worktrees/tkt-4821
sandboxr up          # start a sandbox from this worktree
sandboxr ls          # every sandbox on this machine
sandboxr status      # this one, in detail
sandboxr down        # remove it, and its database and uploads
sandboxr gc          # reap sandboxes whose worktree is gone
sandboxr prune       # what disk could be handed back, and how much
```

Every one takes an optional **slug**. You rarely type it: standing in the worktree is enough.
`sandboxr down tkt-4821` and `sandboxr down` run from `.worktrees/tkt-4821` are the same command.

## `up`

Reads `sandboxr.yaml`, prepares a copy of the database, builds the project's image layer if it is
not already there, starts the container, waits for it, and prints one URL per app.

| Flag | Default | What it does |
|---|---|---|
| *(positional)* `slug` | derived | The sandbox's name. Also `--slug NAME` |
| `--worktree PATH` | the current directory | Which worktree to build from |
| `--with a,b` | none | Start these `optional: true` runtimes as well |
| `--seed local\|file\|fixtures` | whatever the config allows | Force the seed source |
| `--detach` | off | Do not wait, and skip the database step |
| `--timeout N` | `180` | Seconds to wait for the container to become ready |
| `--json` | off | The whole result as JSON on stdout |

| Exit | Means |
|---|---|
| `0` | Started |
| `2` | A config error, naming the file and the field |
| `3` | Started **degraded** — up, with failed migrations |
| `1` | Anything else |

`--with` exists because some things are too expensive to run for everybody. A live dev server
holds hundreds of megabytes for as long as the container lives, whether or not anyone opens it,
so a runtime declared `optional: true` starts only when asked for by name.

**Starting a sandbox that already exists is not an error.** The container is replaced from the
current config and the current commit; its volumes are untouched, so the database, the uploads
and the built apps carry over. That makes `up` the right command after editing `sandboxr.yaml`,
and after a dependency change — the dependency volume is named after a lockfile hash, so a new
lockfile means a different volume, and only a fresh container can pick it up.

> [!NOTE] The source database is only ever read
> Wherever the data comes from, sandboxr copies it first and works on the copy. Nothing a sandbox
> does can reach back into the database it was copied from.

## `ls`

```
PROJECT  SLUG       STATE     BRANCH             WORKTREE
acme     tkt-4821   running   tkt-4821           /home/dev/acme/.worktrees/tkt-4821
acme     tkt-4907   running   tkt-4907*          /home/dev/acme/.worktrees/tkt-4907
acme     fix-nav    degraded  fix/nav-overflow   /home/dev/acme/.worktrees/fix-nav

* uncommitted changes when the sandbox started
```

`list` is accepted as well as `ls`; `--project NAME` narrows it. This table is a pure function of
`docker ps` — every column is read from a label on the container, so nothing can drift out of
sync. [State lives in labels](../architecture/state.md).

| State | Means |
|---|---|
| `starting` | Up, and has not yet said whether its migrations worked |
| `running` | Up, migrations succeeded |
| `degraded` | Up, and its **migrations failed** |
| `stopped` | The container exists but is not running |

`degraded` is deliberate rather than a half-failure: looking at a migration that has just failed
is one of the main reasons to have a sandbox.

## `status`

One sandbox in detail, including which of its backends actually answer. It probes each backend's
declared health path from inside the container, so "up" means the process responded, not that
Docker thinks it is running.

```
acme/tkt-4821  running
  branch      tkt-4821 (clean)
  driver      mysql
  migrations  ok
  access      apps public
  worktree    /home/dev/acme/.worktrees/tkt-4821
  built       app, admin

  api         up
  admin-api   up
  jobs        down
```

Exit code `3` if the sandbox is degraded.

## `down`

```bash
sandboxr down            # container, database, storage, built binaries, built apps
sandboxr down --keep     # container only; the volumes stay
```

| What it removes | What it never touches |
|---|---|
| The container | Your worktree |
| `sandboxr-data-*` — the database | Your branch, your commits, your uncommitted changes |
| `sandboxr-blob-*` — file storage | The database it was seeded from |
| `sandboxr-bin-*` — built binaries | The seed cache |
| `sandboxr-www-*` — built front-ends | The shared dependency volume |
| Its certificate and the router's entry for it | Other sandboxes |

A sandbox that does not exist is not an error — `down` says so and returns.

`--keep` is for when you want a fresh container against the same database: the next `up` restores
nothing and starts in seconds.

## `gc`

```bash
sandboxr gc --dry-run
sandboxr gc
```

Reaps a sandbox when its recorded worktree no longer exists on disk, then removes any
`sandboxr-` volume that no surviving sandbox owns and nothing has mounted. Shared volumes and
`sandboxr-deps-*` volumes are left alone.

`--dry-run` prints the plan and changes nothing.

## `prune`

```bash
sandboxr prune                      # a report; removes nothing
sandboxr prune --yes                # remove what it listed
sandboxr prune --build-cache --yes  # and Docker's build cache with it
```

`gc` reclaims what a *sandbox* held. `prune` reclaims what *building* them left behind: the project
images a newer build replaced, plus any orphaned volume, plus — only when asked — Docker's build
cache. Neither of the first two is freed by stopping a container, and on a machine that has run out
of room they are usually most of the problem.

**It removes nothing without `--yes`**, which is the other way round from `gc --dry-run`. What `gc`
removes costs a restart; what `prune` removes costs a toolchain rebuild on the next `up`, so the
safe answer is the one you get by typing nothing extra.

Each project's newest image always survives, and the shared volumes — `sandboxr-claude` and the Go
caches — are never offered at all.

[Giving Docker the whole machine](docker-capacity.md) covers where the space went, and the blunter
Docker commands for when this is not enough.

## Related

- [Giving Docker the whole machine](docker-capacity.md) — when the disk is the problem
- [The edit–reload loop](edit-and-reload.md) — what to run after you change a file
- [Every worktree at once](../getting-started/every-worktree.md)
- [CLI reference](../reference/cli.md) — every command, every flag
