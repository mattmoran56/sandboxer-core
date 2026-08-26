---
title: State lives in labels
description: Why there is no list of sandboxes anywhere, and how runtime state is derived instead of stored.
sidebar:
  order: 4
---

There is no manifest file and no database of sandboxes. `sandboxr ls` is a pure function of
`docker ps`, and every column comes from a label on the container.

```
sandboxr.project    the project's name
sandboxr.slug       the sandbox's short name — the filter that finds every sandbox
sandboxr.branch     the branch it started from, or "?"
sandboxr.commit     the commit it started from, or "?"
sandboxr.dirty      "true" or "false" — the worktree's state when it started
sandboxr.worktree   the absolute path it was built from
sandboxr.driver     the database driver
sandboxr.created    ISO 8601
sandboxr.access     public or private
sandboxr.ttl        seconds it may run for, or "never"
```

The router and the dashboard carry `sandboxr.role=router` / `=dashboard` instead, so neither ever
appears in a sandbox listing.

## Labels hold durable state only

A label is fixed when the container is created and cannot change while it runs. So anything that
changes at runtime is **derived at read time** instead:

| Changes at runtime | Where it actually lives |
|---|---|
| Which front-ends have been built | `/srv/www/.built.json`, inside the container |
| Whether the last migration succeeded | a marker file in `/run/sandboxr`, inside the container |
| Whether a backend is healthy right now | asked, live, over `/__sandboxr/health/<service>` |
| `running` / `degraded` / `stopped` / `starting` | computed from Docker's state plus those markers |
| When a sandbox expires | `State.StartedAt` + `sandboxr.ttl`, computed per read |

## What labels-only buys

- **A listing cannot be stale.** A container that does not exist cannot appear in `sandboxr ls`,
  because the listing *is* the container set.
- **The dashboard cannot lie.** It reads live, so there is no cache to invalidate.
- **Crash recovery is free.** Interrupt `up` halfway, reboot, `docker rm` a container by hand —
  there is no bookkeeping left inconsistent, because there is no bookkeeping.
- **The router needs no configuration file.** It resolves a hostname by matching labels, so
  starting a sandbox makes its hostnames work with nothing to write and nothing to reload.

## The alternative, and why it is worse

A manifest file — a JSON list of sandboxes, updated on `up` and `down` — fails in the ordinary
case, not the exotic one. Every one of these leaves it wrong:

- `up` is interrupted after the container starts and before the file is written.
- The machine reboots during a `down`.
- Somebody runs `docker rm` directly, which people do.
- Two `up` commands race on the file.
- The file sits inside a repository and `git clean` removes it.
- Docker's own pruning removes a container.

Each is recoverable with a reconciliation step — whose job is to compare the file against
`docker ps` and believe `docker ps`. At which point the file is a cache of the thing you already
have to read, and its only remaining function is to be wrong occasionally.

> [!TIP] The general shape of the argument
> When the truth is already stored somewhere durable that you have to read anyway, a second copy is
> not state. It is a bug with a schema.

## What it costs

**A label is a string.** No nested structures, no lists, no booleans — `sandboxr.dirty` is the text
`"true"`.

**`sandboxr.commit` and `sandboxr.dirty` go stale.** They are a snapshot from `up`, so a commit you
make in the worktree afterwards is not reflected. They answer "what was this started from", not
"what is it now", and the code says so rather than pretending otherwise. That is a genuine wart,
and it is preferable to keeping a second copy of the truth on the host.

**There is no history.** Remove a container and its state goes with it — right for a sandbox, but
you cannot ask what existed last week.

## Two things that look like exceptions, and are not

A managed dashboard needs to know about projects with nothing running, and needs a way to say
"keep this one". Both put something on the host, and on a fast read this page forbids that. Here is
the line.

**The test is not "is it state".** It is the one the argument above actually turns on: *does this
file's correctness depend on a container?* If it does, it needs a pass that compares it against
`docker ps` and believes `docker ps` — and at that point it is a cache of something you had to read
anyway. If it does not, it is an original.

**The workspace** — `~/.sandboxr/workspace/<project>/repo.git` — is an original. Where a repository
lives on this machine is recorded nowhere else that survives the last container: the
`sandboxr.worktree` label dies with the container, and the plan file holds container paths. Run the
six failures listed above against it and none of them apply: no lifecycle command writes it, a
`docker rm` leaves a project that correctly now has no sandboxes, and it is outside every
repository. It is also not a *list* — a project is a directory containing `repo.git`, so the
listing is a `readdir`, the same shape of answer as `docker ps`. And it may only ever *add*
projects to the dashboard, never filter them: the page shows the workspace unioned with what is
running, so nothing running can be hidden by deregistering anything.

**A pin** — `state/pins/<project>/<slug>` — is the harder case, because it is genuinely about one
container. It is legal only because of one detail: the file contains that container's
`sandboxr.created` value, and a pin whose stamp does not match is ignored. That makes a stale pin
fail closed, which is what removes the need for a reconciliation pass. Without the stamp it would
be exactly the bug this page describes — and a nasty one, since slugs are derived from ticket ids,
so a pin outliving its sandbox would silently pin the next sandbox to take the same name.

The general form: **a file that records what you want is not a copy of what is true.** It earns its
place by being unable to disagree with reality — not by being written carefully.

## What is not in labels

Some things must **outlive** a container. Those live under `SANDBOXR_HOME` (`~/.sandboxr`):

| Path | Why it is not a label |
|---|---|
| `cache/` | Seed artifacts, shared between sandboxes and expensive to rebuild |
| `logs/<project>/<slug>/` | Survive the container on purpose — the logs from a sandbox you just deleted are the ones you want |
| `tls/`, `state/` | Machine-level, not per-sandbox |
| `secrets/<project>.env` | Per project, mode 0600, and must never be in an image |
| `build/<project>/<slug>.env`, `.plan.json` | Regenerated on every `up` |
| `workspace/<project>/` | The repositories themselves — an original, not a copy |
| `state/pins/<project>/<slug>` | Operator intent, stamped with the instance it applies to |

`SANDBOXR_HOME` is deliberately never inside a repository, so `git clean -xdf` cannot destroy your
seed cache or your certificates.

## Reading the labels yourself

```bash
docker ps --filter label=sandboxr.project=acme \
  --format '{{.Names}}\t{{.Label "sandboxr.slug"}}\t{{.Label "sandboxr.branch"}}'
```

```
sandboxr-acme-tkt-4821	tkt-4821	tkt-4821
sandboxr-acme-fix-nav	fix-nav	fix/nav-overflow
```

If `sandboxr ls` and `docker ps` ever disagree, that is a bug in the listing code, because there is
nothing else it could be.

## The names

| Thing | Name |
|---|---|
| Container | `sandboxr-<project>-<slug>` |
| Network | `sandboxr` — one, shared |
| Per-sandbox volumes | `sandboxr-<purpose>-<project>-<slug>`, purpose one of `data`, `blob`, `bin`, `www` |
| Shared volumes | `sandboxr-deps-<lockfile hash>`, `sandboxr-gocache`, `sandboxr-gomod` |

`gc` reads the sandbox list and the volume list, reaps a sandbox whose `sandboxr.worktree` no
longer exists on disk, and removes any `sandboxr-` volume no surviving sandbox has mounted. It does
**not** prune Docker's build cache; `docker builder prune` is what does that.

## Related

- [How a request arrives](request-path.md) — the router reading these labels
- [Start, stop, list, clean up](../guides/lifecycle.md)
