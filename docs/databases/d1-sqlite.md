---
title: "D1 and SQLite: the easy case"
description: When the database is a file, seeding is a copy and almost everything MySQL needs disappears — leaving one rule that matters, one writer per file, and one config line that is quiet when you get it wrong.
sidebar:
  order: 3
---

> **Written, never run** — The driver and its container scripts are written and unit-tested. Nothing has provisioned from a real Cloudflare state directory, and whether the owner rule actually prevents the deadlock it exists to prevent has never been tested.

A D1 or SQLite database is a **file**. Almost everything on [the MySQL page](./mysql.md)
stops applying.

| | MySQL | D1 / SQLite |
|---|---|---|
| Install a database server | yes | no |
| Start it and wait for it | yes | no |
| Copy the data | dump it, then restore it | copy the file |
| Pin a server version | yes, and it matters | there is no server |
| A lock so two migrations do not collide | yes | no |
| Users and grants | yes | no |
| **One writer per database** | no | **yes** |

Seeding is a copy. Giving each sandbox its own database is a copy. There is no server, no version
to pin and no lock.

```yaml
database:
  driver: d1
  seed_from:
    file: .wrangler/state
    fixtures: seeds/fixtures.sql
  migrate:
    command: npx wrangler d1 migrations apply DB --local --persist-to $SANDBOXR_D1_DIR
  owner: app
```

Two lines in that block are the entire subject of this page: `owner`, and `--persist-to`.

## Rule one: one writer per file

**Two processes that open the same database file deadlock.** Not "contend", not "run slowly" —
they hang, or fail with a busy error, and each one looks from the outside as if it is working
normally. A slow boot and a permanent hang look identical for the first minute, and nothing is
written to the log.

So the config names the single service allowed to open the database:

```yaml
database:
  owner: app
```

The value is the `label` of a front-end or the `name` of a backend the project already declares. A
project that declares more than one runtime and does not name an owner is **refused** when its
config is read, with the list of names it could have used.

> [!CAUTION] This is a rule of the engine, not a workaround
> It is tempting to treat the deadlock as a bug to be worked around with retries or a longer busy
> timeout. It is not. The local runtime that backs D1 holds the file in a way a second opener cannot
> share, and the correct response is to have exactly one opener.

What follows from the rule:

- **No two sandboxes share a file.** Each gets a private copy — the same isolation a MySQL sandbox
  buys with a whole server, obtained here for the price of a file copy.
- **Every non-owner is denied the database's location.** Not asked nicely to leave it alone: the
  container simply does not tell any other service where the file is, so a second one fails loudly
  on a missing binding instead of quietly hanging on a lock. A loud failure is much better than a
  hang.
- **Migrations run before any service starts.** Database setup gates the supervised processes, so
  it is the one moment when nothing else holds the file.
- **Fixtures are applied with the SQLite client directly**, not through the project's own tooling.
  The project's tooling would open its own runtime against the same file — exactly the two-writer
  situation.
- **A D1 shell is read-only**, because the owning service holds the file while it runs. Read-only is
  the honest offer.
- **Nothing else may open it either.** Not a script you run in a shell while the app is serving, not
  a database browser you left open on Tuesday. If a sandbox hangs during setup, count the openers
  before you look at anything else.

## Rule two: point the runtime at the sandbox's own directory

The sandbox exports the location of its own database as `$SANDBOXR_D1_DIR`. **Both** the migrate
command and the owner's serve command have to be told about it:

```yaml
database:
  driver: d1
  migrate:
    command: npx wrangler d1 migrations apply DB --local --persist-to $SANDBOXR_D1_DIR
  owner: app

frontends:
  apps:
    - label: app
      package: .
      serve: npx wrangler dev --port 8787 --ip 127.0.0.1 --persist-to $SANDBOXR_D1_DIR
      port: 8787
```

Leave it off either one and the runtime falls back to its own default, which is a directory inside
the project — and the project is your worktree, mounted into the sandbox. Three things then go
wrong at once:

1. The sandbox's database lands in your branch and turns up in `git status`.
2. Two sandboxes started from the same worktree share one file, so the one-writer rule is broken by
   construction rather than by accident.
3. `sandboxr down` no longer removes the database, because it is not in the sandbox's volume.

None of that produces an error. It just quietly is not what you asked for.

> [!WARNING] doctor warns about this, and deliberately does not refuse
> `sandboxr doctor` reads both commands and reports any that never mention the variable. It is a
> warning rather than a refusal because it can be wrong: a project may point its runtime at the right
> place through a configuration file that sandboxr cannot read, and refusing to start a project that
> is in fact correct is worse than telling you to check.
>
> A refusal has to be certain. This one cannot be, so it is advice.

<details>
<summary><b>Details for an agent:</b> the variables, the paths inside the container, and exactly what doctor checks</summary>

`locationEnv()` in `packages/core/src/drivers/file.ts` and `container/scripts/db/*.sh` agree on
these:

| Variable | Value | Driver |
|---|---|---|
| `SANDBOXR_DB_DRIVER` | `d1` or `sqlite` | both |
| `SANDBOXR_DB_NAME` | the project name | both |
| `SANDBOXR_DB_DIR` | `/var/lib/sandboxr/data/<driver>` | both |
| `SANDBOXR_D1_DIR` | the same directory | `d1` only |
| `SANDBOXR_DB_FILE` | `/var/lib/sandboxr/data/sqlite/<project>.sqlite` | `sqlite` only |

`d1` gets a *directory* rather than a file because the local Cloudflare runtime owns the layout
inside it; the driver finds the actual SQLite file by searching for `*.sqlite` under that
directory. No match means "nothing has created it yet", which is a normal first-boot state.

The directory is inside the sandbox's `data` volume, which is what makes `sandboxr down` take the
database with it.

`persistenceAdvice()` in `packages/core/src/config/advice.ts` is the check `doctor` runs. It looks
at `database.migrate.command` and at the `serve` command of the owning front-end, and reports one
finding per command that mentions neither `SANDBOXR_D1_DIR` nor `SANDBOXR_DB_DIR` (or, for
`sqlite`, neither `SANDBOXR_DB_FILE` nor `SANDBOXR_DB_DIR`). It is a plain substring test, so a
project doing something unusual can satisfy it by mentioning the variable.

One trap worth knowing if you run commands by hand: the container exports these before it starts
its services, so every supervised service inherits them — but `docker exec` does not. A command run
from the host has to carry them itself, or `$SANDBOXR_DB_FILE` expands to nothing and `sqlite3 ""`
quietly operates on a temporary in-memory database instead of failing. `sandboxr db shell` and
`sandboxr db snapshot` pass them for you.

</details>

## An empty seed is normal

```yaml
seed_from:
  file: .wrangler/state
```

That path is where the local runtime keeps its SQLite files, and it is almost always ignored by
git. **A fresh worktree therefore has nothing there**, and that is expected rather than an error.

With nothing to copy, the sandbox starts from an empty database, runs the project's migrations and
applies the fixtures. For a project whose migrations build the schema from nothing, that costs you
nothing at all. The driver says so plainly:

```
No database to seed from, so this sandbox starts empty and migrates.
```

If you do want real content in a new sandbox, point `seed_from.file` at a checkout that has state,
or put what you need in `seed_from.fixtures`.

<details>
<summary><b>Details for an agent:</b> how the driver decides a directory holds a real database</summary>

Docker creates a missing bind-mount source as an empty directory rather than failing, so an
aborted start leaves something that looks like a state directory and holds nothing. The driver
therefore does not trust the path's existence: it looks for a `.sqlite`, `.sqlite3` or `.db` file of
at least 1 KB underneath it (`hasDatabase()` in `packages/core/src/drivers/file.ts`).

When there is one, the whole directory is copied — write-ahead log and shared-memory sidecars
included, because they belong to the same database and a copy missing them reads as corrupt. The
cache key is a hash of the content, not the timestamp: a database file's timestamp moves every time
the engine checkpoints, whether or not anything changed.

On the way in, `container/scripts/db/d1.sh` keeps an existing database rather than overwriting it,
so restarting a sandbox does not throw away work you did inside it.

</details>

## `sqlite` versus `d1`

They are separate drivers because they are *found* differently, not because the engine differs.

| | `sqlite` | `d1` |
|---|---|---|
| Where the database is | one file, at a path the sandbox fixes | inside the local runtime's state directory, found by search |
| Migration command | the project's own | usually the platform CLI's migrations command |
| Starting empty | an empty file is created, in write-ahead mode | the first thing to open it creates it |
| `sandboxr db shell` | read-write | **read-only** |

If your project opens a SQLite file directly, use `sqlite`. If it goes through a Workers binding,
use `d1`, because the file layout and the migration command belong to the platform rather than to
you.

<details>
<summary><b>If it goes wrong:</b> telling a deadlock apart from a slow boot, and the other three ways this goes wrong</summary>

The two-writer deadlock has no error message, so recognise it by shape:

| What you see | What it is |
|---|---|
| The sandbox sits at `starting` for ever, and `sandboxr logs <slug>` stops mid-way through database setup with nothing after it | Two openers. Something else has the file. Count the openers before you look at anything else. |
| A service fails immediately, complaining about a missing database binding | The one-writer rule working as intended. That service is not the `owner`, so it was never told where the database is. Either it should not open the database, or it should be the owner. |
| A `.sqlite` file turns up in `git status` | A command is missing `--persist-to $SANDBOXR_D1_DIR`. Run `sandboxr doctor`, which names the command and the field. |
| `no D1 database in <directory> yet` from `db shell` | Nothing has created it. On a fresh worktree with no seed that is normal until the first migration runs. |
| Fixtures did not apply | Non-fatal by design. The sandbox comes up anyway, because a fixture that no longer matches the schema is a signal rather than a reason to refuse to start. |

Two sandboxes of the same project can never deadlock each other, because each has its own copy in
its own volume. The deadlock is always *within* one sandbox, or between a sandbox and something you
ran by hand.

</details>

## Why this is the driver to start with

If you are evaluating sandboxr and you have a file-database project to try it on, use that one. No
dump to manage, no version to pin, no server to wait for. The model is much easier to see when the
database is not the expensive part.

The complete config is [the Workers example](../configuration/example-workers.md).

## Related

- [The driver model](./drivers.md) — the four rules, which apply here too.
- [Testing a migration](../guides/testing-a-migration.md) — the same loop, much faster.
