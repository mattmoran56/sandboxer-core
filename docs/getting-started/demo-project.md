---
title: Run the demo project
description: Take the one project proven end to end from clone to a page over HTTPS, then read its config line by line.
---

`examples/demo-worker` is a real, tiny application: a guestbook on a Cloudflare Worker with a
SQLite-backed D1 database. It has a migration, a fixture file and a page that renders only if every
part of the chain works.

Two reasons to run it. It is the honest check that your machine is set up, because it is **the only
path that has been taken all the way through** — see [What is built](../reference/status.md). And
its config is short enough to read every line of, which is the fastest way to understand the file
you will write for your own project.

```prompt
Run the sandboxr demo project and confirm it serves a page.

Read docs/getting-started/demo-project.md and follow it. From the sandboxr checkout, cd into
examples/demo-worker, run `sandboxr up demo1`, then fetch
https://demo1--app--demo.sbx.localhost/api/notes and confirm it returns two seeded notes. Report the
JSON you got back.

Stop and ask me if:
- `sandboxr init` has not been run on this machine yet.
- `sandboxr up` exits with code 3, meaning the migrations failed. Show me `sandboxr logs demo1`.
- The URL returns anything other than 200, or the notes array is empty.

Leave the sandbox running when you are done unless I ask you to remove it.
```

## Run it

You need a machine that has had [`sandboxr init`](install.md) run on it. You already have the demo
if you installed from the repository checkout.

```bash
cd sandboxr/examples/demo-worker
sandboxr up demo1
```

```
==> Seeding: empty, then migrations and seeds/fixtures.sql
==> Building sandboxr/demo:9d41f0c37a58
==> demo has no GitHub token: git commit works in this sandbox, gh and git push do not.
      Set projects.demo.github: token in /home/you/.sandboxr/config.yaml, and allow the
      session git push and gh — neither is in its default allowlist.
==> Starting demo1 from main@a1b2c3d
==> Applied fixtures from seeds/fixtures.sql
  ok Sandbox demo1 is running

  app          https://demo1--app--demo.sbx.localhost
```

Open that URL. You get a guestbook with two notes in it. Leave one — it goes into this sandbox's
own database and nowhere else.

There is also a machine-readable answer, which is what makes this a good check for an agent:

```bash
curl -s https://demo1--app--demo.sbx.localhost/api/notes
```

```json
{ "sandbox": "demo1", "notes": [ { "id": 2, "body": "This row proves the migration ran against the sandbox's own database.", "created_at": "2026-01-01 09:01:00" }, { "id": 1, "body": "First note, from the fixtures.", "created_at": "2026-01-01 09:00:00" } ] }
```

If that returns two notes, everything worked: the image built, the container started, the database
was created, your migration ran against it, the fixtures applied, the dev server came up, and the
shared router put it on a hostname.

> [!TIP] Pass the slug explicitly here
> `demo1` is given by hand on purpose. Left to itself, sandboxr derives the slug from the git
> repository the directory belongs to — which for the demo is the *sandboxr* checkout, so you would
> get a sandbox named after whatever branch you have out. Naming it keeps the URL predictable.

Throw it away when you are done:

```bash
sandboxr down demo1
```

That deletes the container and the database. The files in `examples/demo-worker` are untouched.

## Now read the config

Here is `examples/demo-worker/sandboxr.yaml` in full, then one block at a time.

```yaml
project: demo
sandboxr: ">=0.1.0"

database:
  driver: d1
  seed_from:
    fixtures: seeds/fixtures.sql
  migrate:
    workdir: .
    command: npx wrangler d1 migrations apply demo --local --persist-to "$SANDBOXR_D1_DIR"
  owner: app

frontends:
  apps:
    - label: app
      package: .
      serve: npx wrangler dev --port 8787 --ip 127.0.0.1 --persist-to "$SANDBOXR_D1_DIR"
      port: 8787
      health: /health

deps:
  root: .

toolchain:
  node: "22"

access:
  apps: public
  controls: password

env:
  SANDBOXR_SLUG: "${SANDBOXR_SLUG}"
  WRANGLER_SEND_METRICS: "false"
```

### `project` and `sandboxr`

```yaml
project: demo
sandboxr: ">=0.1.0"
```

`project` is the name that appears in every hostname, every container name and every volume name.
It is why the URL above reads `…app.demo.sbx.localhost`. Change it and every name for this project
changes with it.

`sandboxr` is the version of the tool this config expects. It is a range, and it is checked before
anything else is read. **Without it the config is refused** — both keys are required. That is
deliberate: a config that outlives a breaking change should say so rather than half-work.

### `database.driver`

```yaml
database:
  driver: d1
```

The demo uses `d1`, which underneath is a SQLite file that miniflare owns. That choice is why the
demo is the cheapest thing sandboxr can run: **a file database has no server**. Nothing to install
into the image, nothing to wait for at boot, no version skew, no dump to restore. Seeding is a
directory copy.

The alternatives are `sqlite`, `mysql` and `none`. A `mysql` project gets a real server inside its
own container, which costs a few hundred megabytes and several seconds of boot. See
[Databases](../databases.md).

### `database.seed_from`

```yaml
  seed_from:
    fixtures: seeds/fixtures.sql
```

Where the sandbox's data comes from. Three [seed sources](../reference/glossary.md) are possible:
`local` forks a database container you already run, `file` restores a dump, and `fixtures` starts
empty and applies a SQL file. When a config lists several, precedence is `local`, then `file`, then
`fixtures` — the freshest data first, filtered by what the access rules allow.

The demo deliberately names **only** `fixtures`. A fresh checkout has no local wrangler state to
fork and no dump to restore, so listing either would mean naming something that does not exist. The
result is that every demo sandbox starts from an empty database, builds its schema by running the
project's own migrations, and then applies two rows.

Without this block the sandbox would still come up, with an empty database and no rows. The page
would render and say `Nothing here yet`.

### `database.migrate`

```yaml
  migrate:
    workdir: .
    command: npx wrangler d1 migrations apply demo --local --persist-to "$SANDBOXR_D1_DIR"
```

**sandboxr never reimplements your migration runner.** It runs the command you give it, inside the
sandbox, against the sandbox's own copy of the database, and records whether it succeeded.

Two things in that command are the load-bearing parts:

- `--persist-to "$SANDBOXR_D1_DIR"` points wrangler at the sandbox's own state directory instead of
  wrangler's default, which is a `.wrangler/state` folder inside the worktree. `SANDBOXR_D1_DIR` is
  exported by the sandbox itself. Drop it and the database lands in the worktree — on your host
  disk, outside the volume, surviving `sandboxr down`, and shared with anything else pointed at that
  same directory. The whole point of the sandbox's own volume is that the database is disposable,
  and this flag is what puts it there. The `serve:` command below carries the same flag for exactly
  the same reason.
- `workdir: .` runs the command at the top of the worktree. wrangler finds `wrangler.jsonc` by
  looking in its working directory, so it has to be there. With no `workdir`, the boot-time run
  happens in an empty directory instead — deliberately, so a runner cannot pick up files nobody
  meant it to see. For this project that would fail with wrangler unable to find its config.

The command's exit status decides the sandbox's state. A failure does **not** stop the sandbox: it
comes up `degraded`, `sandboxr up` exits `3`, and you can go and look at what broke.

### `database.owner`

```yaml
  owner: app
```

**One writer only.** Two processes opening the same SQLite file deadlock, and the symptom is a boot
that hangs with nothing in the log. So a file-backed database names the single service allowed to
open it, and everything else either runs before that service starts or does not run at all.

Here `app` is the wrangler dev server. That is also why `sandboxr db shell` on this project gives
you a **read-only** prompt: the owning service is holding the file, and read-only is the honest
offer.

The demo declares exactly one runtime, so it would in fact be accepted without this line — there
is nothing to be ambiguous about. Add a second app or a backend and the config is **refused** until
`owner` names one of them. It is refused rather than defaulted because the rule belongs to the
driver, so guessing would be guessing about correctness. An `owner` naming something the config
does not declare is refused too.

### `frontends`

```yaml
frontends:
  apps:
    - label: app
      package: .
      serve: npx wrangler dev --port 8787 --ip 127.0.0.1 --persist-to "$SANDBOXR_D1_DIR"
      port: 8787
      health: /health
```

There are no backends here. **The worker *is* the app**, which makes it the third of
[The three runtime kinds](../configuration/runtime-kinds.md): a long-running dev server, proxied on
its own hostname.

Field by field:

- `label: app` becomes the second part of the hostname — `demo1.**app**.demo.sbx.localhost` — and
  it is what you name in `sandboxr reload --web=app`.
- `package: .` is where the app lives, relative to the worktree.
- `serve:` is the command. Its presence is what makes this a server rather than a static build. An
  app with `out:` instead is built on demand and served as files.
- `port: 8787` is the port the sandbox's own web server proxies to. It has to match the port in the
  command — nothing infers it.
- `--ip 127.0.0.1` keeps the dev server on loopback inside the container. The sandbox's own web
  server is the only thing that reaches it, and it is the only thing that should.
- `health: /health` is the path probed to decide whether the app is up. The worker answers it with
  `ok`. Without it, "is this up" falls back to whether the process is running.

Because this is a server and not a build, `sandboxr reload --web=app` **restarts** it rather than
building anything, and says so.

### `deps`

```yaml
deps:
  root: .
```

The project has a Node dependency tree, rooted at the top of the worktree — the directory holding
`package.json` and `package-lock.json`.

This is named rather than inferred because the directory holding the lockfile is not always the
directory holding the packages, and because the shared dependency volume has to be mounted at
exactly one path.

What it buys: the project image installs the dependencies once, and every sandbox whose lockfile
matches the same hash shares one `node_modules`. A branch that changes its dependencies
transparently gets its own. That is most of why the second sandbox on a project starts in seconds.

`lockfile` and `install` can be set too. Left out, sandboxr looks for a lockfile it recognises —
`package-lock.json`, `pnpm-lock.yaml`, `yarn.lock` or `bun.lockb` — and uses that package manager's
frozen-install command. The demo has `package-lock.json`, so it gets
`npm ci --no-audit --no-fund`. A project with no lockfile at all gets no shared volume, which costs
an install rather than breaking.

### `toolchain`

```yaml
toolchain:
  node: "22"
```

The base image carries **no language toolchain at all**. This is what puts Node 22 into the
project's own image layer. Remove it and the sandbox starts, and then every `npx` in the config
fails with a command that does not exist.

`go:` is the other option. Both accept a prefix like `"22"` or `"1.26"` and resolve a release from
it.

### `access`

```yaml
access:
  apps: public
  controls: password
```

`apps: public` means anyone whose browser can reach the hostname gets the guestbook with no login.
On a laptop that is your own browsers only — the router binds loopback.

`controls: password` is the other half, and it is **not optional**. Starting, stopping and deleting
sandboxes always sits behind the dashboard's password, because the dashboard holds the Docker
socket. There is no setting that turns that off. [Access and security](../access.md) is the full
picture.

These two are also the defaults, so the block is here to be read rather than because it is needed.
Its real effect shows up elsewhere: because the apps are public, this project may only be seeded
from fixtures or an anonymised dump, and it is refused outright if a real credentials file exists
for it on this machine.

### `env`

```yaml
env:
  SANDBOXR_SLUG: "${SANDBOXR_SLUG}"
  WRANGLER_SEND_METRICS: "false"
```

This is the join between two vocabularies. The sandbox works out **where** everything is — its
database, its object storage, each app's own URL — and exports those under a `SANDBOXR_` prefix.
Your project reads its own names for the same things. Only your project knows its own spelling, so
it says so here.

The demo needs almost none of that, so it uses the block for two small things: passing the slug
through so the page can say which sandbox served it, and turning wrangler's telemetry off.

Values are expanded by **substitution, never by a shell**, so a value is data and cannot become a
command.

<details class="agent">
<summary><b>Details for an agent</b> — every other file in the demo, and what each line is doing</summary>

**`wrangler.jsonc`** — wrangler's own config, not sandboxr's.

```jsonc
{
  "name": "demo-worker",
  "main": "src/index.js",
  "compatibility_date": "2025-05-01",
  "migrations_dir": "migrations",
  "d1_databases": [
    { "binding": "DB", "database_name": "demo", "database_id": "00000000-0000-0000-0000-000000000000" }
  ]
}
```

- `main` is the single source file. No build step, deliberately.
- `migrations_dir` is where `wrangler d1 migrations apply` looks. It is wrangler's setting, not
  sandboxr's — sandboxr only runs the command.
- `binding: "DB"` is the name the worker code uses: `env.DB.prepare(...)`.
- `database_id` is a zero UUID. wrangler requires the field and nothing here ever talks to
  Cloudflare, because the sandbox's database is a file in its own state directory.

**`package.json`** — one dev dependency, `wrangler` pinned to an exact version. `type: "module"`.
Its `scripts` are convenience for running outside a sandbox; sandboxr uses the commands in
`sandboxr.yaml`, never the scripts. `package-lock.json` beside it is what keys the shared
dependency volume.

**`migrations/0001_create_notes.sql`**

```sql
CREATE TABLE IF NOT EXISTS notes (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  body       TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
```

One table. `IF NOT EXISTS` so re-running is safe. This file is why the migration step has anything
to do, and it is what creates the SQLite file the fixtures then need to find.

**`seeds/fixtures.sql`**

```sql
INSERT OR IGNORE INTO notes (id, body, created_at) VALUES
  (1, 'First note, from the fixtures.', '2026-01-01 09:00:00'),
  (2, 'This row proves the migration ran against the sandbox''s own database.', '2026-01-01 09:01:00');
```

Fixed ids and `INSERT OR IGNORE`, because fixtures are applied on **every** boot. Without both, a
restarted sandbox would accumulate duplicate rows. Fixed timestamps too, so the page is identical
every time.

Fixtures are applied with `sqlite3` directly against the database file rather than through
wrangler. Going through wrangler would open a second miniflare against the same file — the
two-writer deadlock the `owner` rule exists to prevent.

**`src/index.js`** — one file, four routes:

| Route | Answers |
|---|---|
| `GET /` | The HTML page, reading the 50 newest notes |
| `POST /notes` | Inserts a note, then `303` back to `/` so a refresh does not re-post |
| `GET /api/notes` | JSON: the sandbox slug and every note. Assert against this, not the markup |
| `GET /health` | `ok`, which is the `health:` path in the config |
| anything else | `404` |

It reads `env.SANDBOXR_SLUG` to print which sandbox served the page, and escapes every value it
renders.

**The full command sequence, with expected exit codes**

```bash
cd examples/demo-worker
sandboxr up demo1                                            # 0 healthy, 3 degraded
sandboxr status demo1                                        # 0 healthy, 3 degraded
curl -sf https://demo1--app--demo.sbx.localhost/__sandboxr/live # ok
curl -sf https://demo1--app--demo.sbx.localhost/api/notes       # two notes
sandboxr db shell demo1                                      # read-only sqlite prompt
sandboxr logs demo1 --tail 200
sandboxr down demo1
```

If the router is serving plain HTTP rather than HTTPS, every URL above is `http://` instead. Run
`sandboxr doctor` to see which.

</details>

## What this proves, and what it does not

Running the demo proves your machine can do the whole chain: build an image, start a container,
create and migrate a file database, serve an app, and route a hostname. That is a lot.

It does not prove anything about a MySQL server, a compiled backend, or a bundled front-end build.
None of those has been run against a real project. [What is built](../reference/status.md) is the
honest inventory, kept per area.

<details class="failure">
<summary><b>If it goes wrong</b> — the failures specific to the demo</summary>

**`no sandboxr.yaml here or in any parent`** — you are not in `examples/demo-worker`. The demo's
config is in that directory, not at the top of the repository.

**The sandbox is named after your branch, not `demo1`** — you left the slug off. The slug is
derived from the git repository this directory belongs to, which is the sandboxr checkout. Pass it
explicitly.

**`up` exits `3` and the page says `Nothing here yet`** — the migration failed, so no database file
was created, so the fixtures had nothing to apply to. `sandboxr logs demo1` shows the wrangler
output. The usual cause is a `--persist-to` that lost its variable.

**The page loads but shows zero notes and the migration says `ok`** — the fixtures did not apply.
Check the file path in `seed_from.fixtures` is relative to the worktree.

Everything else, by symptom, is in [Troubleshooting](../troubleshooting.md).

</details>

**Next:** [Every worktree at once](every-worktree.md) — run several of these side by side and watch
what is shared and what is not. Or [Build your config, step by step](../configuration/index.md) to
write the same file for your own project.
