---
title: Your first sandbox
description: One worktree, one container, one URL — and throwing it all away again.
sidebar:
  order: 2
---

This walks the demo project in `examples/demo-worker`: a Cloudflare Worker on D1, with its own
migration and its own fixtures. It is the cheapest thing sandboxr can run. If you would rather
use your own project, [describe it first](../configuration/sandboxr-yaml.md) and then follow the
same six steps.

## 1. Make a worktree

A sandbox is built from a directory containing a checkout. A git worktree is the natural one:

```bash
cd /path/to/your/project
git worktree add .worktrees/tkt-4821 -b tkt-4821
```

You now have a second checkout of the project at `.worktrees/tkt-4821`, on its own branch, with
your original checkout untouched.

> [!NOTE] The slug comes from the directory or the branch
> sandboxr looks for a ticket-shaped id (`letters-digits`) in the worktree directory name, then
> in the branch name, then falls back to the branch, then the directory. So
> `.worktrees/feat-tkt-4821-rework-the-thing` still becomes `tkt-4821`. Pass an explicit name to
> override: `sandboxr up my-name`.

## 2. Start it

```bash
cd .worktrees/tkt-4821
sandboxr up
```

The first run on a project builds the project's own image layer — its toolchain and its
dependencies, on top of the base image — which takes a few minutes. Every later run reuses it,
and only rebuilds when the toolchain or the lockfile changes.

```
Seeding: fixtures only
Starting tkt-4821 from tkt-4821@a1b2c3d
✓ tkt-4821 is up

  app   https://tkt-4821.app.demo.sbx.localhost
```

Open the URL. That is your branch, running.

| Flag | What it does |
|---|---|
| `--with cms` | Also start a runtime the project marked `optional: true` |
| `--seed fixtures` | Skip the real data; start from the fixture file |
| `--detach` | Do not wait for it, and skip the database step |
| `--worktree PATH` | Build from a worktree other than the one you are standing in |

Starting a sandbox that already exists is not an error: the container is replaced from the
current config and the current commit, and its volumes carry straight over. That is what makes
`up` the right command after editing `sandboxr.yaml`.

Exit code `3` means it came up **degraded** — running, with failed migrations.

## 3. Check it is healthy

```bash
sandboxr status
```

```
demo/tkt-4821  running
  branch      tkt-4821 (clean)
  driver      d1
  migrations  ok
  access      apps public
  worktree    /home/dev/demo/.worktrees/tkt-4821

  app         up
```

The fastest check of all needs no CLI. Every hostname a sandbox serves answers a small status
surface, even while the database is still restoring:

| Path | Answers |
|---|---|
| `/__sandboxr/live` | `ok`, unconditionally — the container and its router are up |
| `/__sandboxr/status.json` | `booting` / `ok` / `degraded`, plus the migration verdict |
| `/__sandboxr/built.json` | Each app label, and when it was last built |
| `/__sandboxr/health/<service>` | Proxied to that service's own health path |

```bash
curl -s https://tkt-4821.app.demo.sbx.localhost/__sandboxr/live
```

## 4. Build a front-end

**Nothing is built when a sandbox starts.** An app that has never been built answers `503` with a
page naming the command that builds it. That is deliberate: a sandbox has to come up in seconds,
and the heaviest app in a project can cost minutes and gigabytes.

```bash
sandboxr reload --web app     # build one app
sandboxr reload --web all     # build every app in the build-everything set
sandboxr reload --web built   # rebuild only what this sandbox has already built
```

The demo project serves a dev server rather than a static build, so it has nothing to build —
`--web` restarts it instead.

## 5. Look inside

```bash
sandboxr logs -f          # the container's own log stream
sandboxr shell            # a shell inside, starting in /workspace
sandboxr db shell         # an interactive database prompt
```

Inside the shell, `/workspace` **is** your worktree. Edit a file there and it changes on your
host; `git status` in your worktree will show it.

## 6. Throw it away

```bash
sandboxr down
```

That removes the container, the database volume, the file storage, the built binaries and the
built front-ends. It does **not** touch your worktree, your branch, or the database you copied
from. `--keep` removes the container but leaves the volumes, so the next `up` reuses the database.

```bash
git worktree remove .worktrees/tkt-4821
sandboxr gc                # reap sandboxes whose worktree is gone
```

**Next:** [every worktree at once](every-worktree.md) — the case the tool is really for.
