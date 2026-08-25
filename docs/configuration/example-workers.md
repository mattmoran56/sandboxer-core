---
title: "Example: Workers on D1"
description: A walkthrough of the worker-thing config — no backends block, a database that is a single file, and the one flag without which every sandbox of the project shares it.
sidebar:
  order: 5
---

> **Written, never run** — This is the real file at examples/workers.sandboxr.yaml, and packages/core's tests check that it parses and resolves. No sandbox has ever been started from it.

The easy case, and much cheaper to run than [the monorepo](./example-monorepo.md).
`worker-thing` is a Cloudflare Workers project: one process, one database that is a file on disk,
and about twenty-five lines of config.

The file is `examples/workers.sandboxr.yaml` in the sandboxr repository. This page walks through
it; the whole annotated file is in the collapsed block at the bottom.

## What it declares

**A D1 database, which is a file rather than a server.** There is nothing to install, nothing to
dump and restore, no version to pin, and no lock to take. Seeding is a copy. Forking is a copy.
The project's own `wrangler` command runs the migrations, and a fixtures file is applied after
them.

**No `backends` block at all.** The worker *is* the app. It is declared as a front-end with
`serve:` and a `port:` — the third runtime kind — because `wrangler dev` is a long-running server
rather than a build that leaves files behind.

**One app, at the repo root.** `package: .` says the package is the repository itself, so there is
no `frontends.root` to prefix it with.

**A short secrets block and no storage block.** Two credentials to import, two patterns refused,
and no object storage because the project has none.

> [!CAUTION] `--persist-to $SANDBOXR_D1_DIR` is the one thing you must not leave out
> Both commands that touch the database carry it:
>
> ```yaml
> migrate:
>   command: npx wrangler d1 migrations apply DB --local --persist-to $SANDBOXR_D1_DIR
> ```
>
> ```yaml
> serve: npx wrangler dev --port 8787 --ip 127.0.0.1 --persist-to $SANDBOXR_D1_DIR
> ```
>
> Without it, `wrangler` uses its own default location — which is **inside your worktree**. Three
> things then go wrong at once, and none of them announces itself:
>
> 1. Sandbox data lands in your checkout, where it can be committed.
> 2. Every sandbox of that project writes to the same file, so branches contaminate each other.
> 3. Two of them opening it at once do not error, they deadlock.
>
> `sandboxr doctor` reports it as a finding when it cannot see the variable in the command. It does
> **not** refuse to start, because a project can legitimately point its runtime at the right place
> through a config file the tool cannot read — so being unable to see the flag is a strong signal
> rather than a certainty.

## The decisions that are not obvious

### `owner: app` is not optional, and it is not a workaround

Two processes opening the same D1 or SQLite file deadlock on a busy lock. So the config has to
name the single service allowed to open it — here, the only service there is.

This is a property of the storage engine, not a limitation of sandboxr, and it is the reason each
sandbox gets a **private copy** of the file rather than sharing one.

The container enforces it in a way that looks unhelpful and is not: every server that is *not* the
owner has the database's location removed from its environment, so it fails loudly on a missing
binding instead of quietly hanging on a lock.

> [!WARNING] The symptom of getting this wrong is a hang, not an error
> Two writers produce no useful message. Migrations hang, or fail with a busy error, and whichever
> process you look at seems to be behaving perfectly. If a D1 project hangs while its database is
> being prepared, count the processes that open the file before you look at anything else.

### The seed points at a directory that is usually empty, and that is fine

`.wrangler/state` is where the local runtime keeps its SQLite files, and `.wrangler/` is normally
in `.gitignore` — so a fresh worktree has nothing there at all.

That is expected. The snapshot is taken from a checkout that does have state; with nothing to seed
from, the driver falls back to migrating an empty database. A project whose migrations build the
schema from nothing loses precisely nothing.

The `fixtures:` line matters more than it looks. This config says `access.apps: public`, and a
public sandbox may only be seeded from fixtures or from a dump explicitly marked
`anonymised: true`. Fixtures are what makes this config legal as a public sandbox at all.

### A served front-end needs no rebuild command

Because it is a live dev server, it recompiles as it serves and it sees your edits through the
mounted worktree. Edit a file, refresh the browser. There is no `reload` to run.

That is the compensation for a dev server's idle cost — it holds its whole module graph in memory
for as long as the container lives. On a project this size the cost is small enough that the app
is not marked `optional`, which is exactly the judgement `optional` exists to let a project make.

## One hostname

```
feat-123.app.worker-thing.sbx.localhost
```

<details>
<summary><b>Details for an agent:</b> the complete annotated file, exactly as it is in examples/workers.sandboxr.yaml</summary>

```yaml title="sandboxr.yaml"
project: worker-thing
sandboxr: ">=0.1.0"

database:
  driver: d1
  seed_from:
    # miniflare keeps its SQLite files here. `.wrangler/` is normally gitignored, so a
    # fresh worktree has no content — the tool snapshots from a checkout that does, and
    # falls back to migrating an empty database.
    file: .wrangler/state
    fixtures: seeds/fixtures.sql
  migrate:
    command: npx wrangler d1 migrations apply DB --local --persist-to $SANDBOXR_D1_DIR
  # Two processes opening the same D1 file deadlock, so exactly one service may own it.
  # This is a rule of the driver, not a workaround.
  owner: app

# No backends block at all. The worker IS the app.
frontends:
  apps:
    - label: app
      package: .
      serve: npx wrangler dev --port 8787 --ip 127.0.0.1 --persist-to $SANDBOXR_D1_DIR
      port: 8787

secrets:
  read: [.dev.vars]
  keep: [API_TOKEN, SENTRY_DSN]
  never: ["DB_*", "*_URL"]

toolchain:
  node: "24.18"

access:
  apps: public
  controls: password

# The environment every process in the sandbox gets. `${SANDBOXR_*}` placeholders are
# substituted with values the sandbox computes for itself — its own database location, its
# own storage, its own hostnames — so nothing here can point at a real service.
env:
  API_TOKEN: dummy
  APP_URL: "${SANDBOXR_URL_APP}"
```

Two things to notice in the last block.

`API_TOKEN` appears in both `secrets.keep` and `env`. The `env` block is applied last, so the
literal `dummy` wins over whatever the import found — which is how a public project ships a
harmless value while keeping the real one available for a private sandbox.

There is a second, more complete Workers project in the repository at `examples/demo-worker/` —
a whole runnable project (a `wrangler.jsonc`, a migration, fixtures and a handler), described in
its own config as the fixture the end-to-end check uses. It is the one to copy if you want
something that runs rather than something that illustrates.

</details>

<details>
<summary><b>Details for an agent:</b> how this config resolves, and what `up` would refuse today</summary>

| Question | Answer for this file |
|---|---|
| Runtime kinds | one — a served front-end, `kind: server` in the plan |
| Frontend root | none, so the plan writes `root: "."` |
| Seed source chosen | `fixtures` — the `file` seed is not permitted while apps are public and the dump is unmarked |
| Database owner in the plan | `app`, as declared; it would have been filled in anyway, since there is only one runtime |
| Whole-sandbox memory | 4 GB, the floor — no runtime declares a `memory:` |
| Dependency tree | found on disk: the repo root, for the first recognised lockfile |

One refusal worth knowing about before you copy this file. `access.credentials` is absent, so it
defaults to `dummy`, and `sandboxr up` refuses to start a public sandbox once a secrets file
exists for the project — it tests for the file, not for whether the values in it are real, because
it cannot tell a dummy key from a live one. Either set `access.credentials: real` and accept what
that means for a public URL, or set `access.apps: private`.

</details>

## Why this is so much simpler than MySQL

| | MySQL | D1 |
|---|---|---|
| `version` | pin it — the copy is restored into the version production runs | absent; there is no server |
| Seeding | dump and restore | a file copy |
| Forking | dump and restore | a file copy |
| Version skew | a real hazard | does not exist |
| Advisory lock | needed, so two migrations cannot collide | not needed |
| `owner` | not applicable | **required** once there is more than one runtime |

[The driver model](../databases/drivers.md) explains why the two are so different, and
[D1 and SQLite](../databases/d1-sqlite.md) covers this driver specifically.

## It is cheap

No database server, no object storage, no compile step, one process. A sandbox for this project
is a fraction of the monorepo's size, and it starts quickly because there is no dump to restore.

If you are trying sandboxr for the first time and you have a project shaped like this, start here.
