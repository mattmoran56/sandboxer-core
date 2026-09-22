---
title: Cheat sheet
description: One dense page of the facts a returning reader looks up — commands, names, paths, labels, states and defaults.
---

Everything you look up rather than read. No explanations here; every row links somewhere that has
one.

```prompt
Give me a summary of the sandboxes on this machine and whether anything is wrong with them.

Read docs/reference/cheat-sheet.md first, then run the read-only commands from the "One command
per intent" table — sandboxer ls, sandboxer status, sandboxer doctor — with --json, and tell me what
you found. Do not start, stop or remove anything. Stop and tell me if Docker is not running or if
`sandboxer` is not on the PATH.
```

## One command per intent

| I want to | Command |
|---|---|
| Set this machine up | `sandboxer init` |
| Check this machine | `sandboxer doctor` |
| Start a sandbox from this worktree | `sandboxer up` |
| Start one from a branch of a managed project | `sandboxer up --project acme --branch tkt-4821` |
| See everything running | `sandboxer ls` |
| See one sandbox in detail | `sandboxer status <slug>` |
| Read the log | `sandboxer logs <slug> -f` |
| Get a shell inside | `sandboxer shell <slug>` |
| Run one command inside | `sandboxer shell <slug> -- go test ./...` |
| Rebuild a front-end | `sandboxer reload <slug> --web=app` |
| Rebuild every front-end | `sandboxer reload <slug> --web` |
| Rebuild a backend | `sandboxer reload <slug> --go` |
| Re-run the migrations | `sandboxer reload <slug> --migrate` |
| Open the database | `sandboxer db shell <slug>` |
| Print the schema | `sandboxer db snapshot <slug> > before.sql` |
| See a project's credentials, by name | `sandboxer secrets list` |
| Set one without it reaching the shell history | `printf '%s' "$KEY" \| sandboxer secrets set NAME` |
| Deliver a changed credential to a running sandbox | `sandboxer stop <slug>` then `sandboxer start <slug>` |
| Stop it, keep everything | `sandboxer stop <slug>` |
| Start it again | `sandboxer start <slug>` |
| Exempt it from the idle clock | `sandboxer keep <slug>` |
| Throw it away | `sandboxer down <slug>` |
| Throw away the container, keep the data | `sandboxer down <slug> --keep` |
| Finish with a branch: its sandbox, then its worktree | `sandboxer worktree delete <project> <branch>` |
| Stop everything that has gone idle | `sandboxer expire` |
| Clean up after deleted worktrees | `sandboxer gc` |
| Get disk back | `sandboxer prune` then `sandboxer prune --yes` |
| See what a config resolved to | `sandboxer config --json` |
| Stop the router, and whatever is on the bare domain | `sandboxer teardown` |

Full surface, with every flag: [CLI commands](cli.md).

> [!TIP] Two output streams
> Human-readable output goes to **stderr**. `--json` puts the result on **stdout**. `logs` and
> `db snapshot` put their real output on stdout either way.

## Exit codes

| Code | Means |
|---|---|
| `0` | Fine |
| `1` | Something failed |
| `2` | A config error, naming the file and the field |
| `3` | The sandbox is `degraded` — up, with a failed migration |

## Names

```
<slug>--<label>--<project>.<domain>     one app or api inside a sandbox
<domain>                              the bare domain — never a sandbox
```

`tkt-4821--app--acme.sbx.localhost`

| Thing | Shape | Example |
|---|---|---|
| Domain | `SANDBOXER_DOMAIN` | `sbx.localhost` |
| Slug | `[a-z0-9-]`, at most 31 characters | `tkt-4821` |
| Container | `sandboxer-<project>-<slug>` | `sandboxer-acme-tkt-4821` |
| Network | `sandboxer` — one, shared | |
| Database volume | `sandboxer-data-<project>-<slug>` | |
| Uploads volume | `sandboxer-blob-<project>-<slug>` | |
| Binaries volume | `sandboxer-bin-<project>-<slug>` | |
| Built sites volume | `sandboxer-www-<project>-<slug>` | |
| Dependencies volume | `sandboxer-deps-<16 hex of the lockfile hash>` | |
| Machine-wide volumes | `sandboxer-gocache`, `sandboxer-gomod` | |
| Project image | `sandboxer/<project>:<12 hex of the build inputs>` | |
| Machine image | `sandboxer/base` — the only one the engine builds | |
| Router container | `sandboxer-router` | |

Slug order of preference: an explicit argument, a slug recorded for the worktree, a ticket id
(`/[a-z]+-[0-9]+/i`) in the worktree directory name, that pattern in the branch name, the branch
name, the directory name. The ceiling is `min(31, 63 - longest label - project - 4)` — the second
half is the one DNS label a hostname is, and may only lower it. Over the ceiling a slug becomes the
first `ceiling - 9` characters plus `-` plus 8 hex of the SHA-256 of the raw input.

Two worktrees of one project that would derive the same slug: the second one sandboxer cuts is given
`<slug>-<4 random characters>` instead, sized against that same ceiling and recorded in
`state/slug/`. Worktrees you cut yourself are not covered — name one explicitly.

## States

| `sandboxer ls` says | Means |
|---|---|
| `starting` | The container is up and has not finished booting |
| `running` | Booted, migrations fine |
| `degraded` | Booted, **migration failed**. Deliberately still serving |
| `stopped` | The container exists and is not running |

Inside the sandbox, `/__sandboxer/status.json` reports `booting`, `ok` or `degraded`.

## Container labels

All durable state, and there is no manifest file anywhere.

`sandboxer.project` · `sandboxer.slug` · `sandboxer.branch` · `sandboxer.commit` · `sandboxer.dirty` ·
`sandboxer.worktree` · `sandboxer.driver` · `sandboxer.created` · `sandboxer.access` · `sandboxer.ttl` ·
`sandboxer.env`

`sandboxer.env` is a digest of the environment the sandbox was **created** with. Whether a running
one has read the current credentials is a comparison of the secrets file's mtime against the
container's start time, never that label.

Runtime state is derived at read time and never written back. [Why](../architecture/state.md).

## Host paths

Everything under `SANDBOXER_HOME`, default `~/.sandboxer`.

```
cache/                            seed artifacts, content-addressed
logs/<project>/<slug>/            per-sandbox logs — survive `down`
tls/                              certificate and key
state/                            router config, and the dynamic config directory
state/keep/<project>/<slug>       keep-alive marker
state/name/<project>/<slug>       what to call one worktree on screen
state/slug/<project>/<wt dir>     the slug a worktree was given on a collision
state/attach/<project>/<slug>     when a socket was last held open on one sandbox
secrets/<project>.env             third-party credentials, mode 0600 — you edit this
build/<project>/<slug>.env        the generated per-sandbox environment
build/<project>/<slug>.plan.json  the plan for one sandbox
bin/                              host-built helper binaries
host.env                          what only this machine can look up, mode 0600
config.yaml                       the machine's own settings — you edit this
workspace/<project>/              a managed project: repo.git/ and wt/<branch>/
```

Full list, including inside a container: [Paths](paths.md).

## Inside a sandbox

| Path | What |
|---|---|
| `/workspace` | your worktree, read-write |
| `/sandboxer/plan.json` | the plan, read-only |
| `/sandboxer/secrets.env` | the project's credentials, read-only |
| `/sandboxer/cache`, `/sandboxer/seed` | seed artifacts, read-only |
| `/var/lib/sandboxer/{data,blob,bin}` | database, uploads, binaries |
| `/srv/www` | built sites, one directory per label |
| `/var/log/sandboxer` | per-service logs |
| `/run/sandboxer` | marker files the status document is built from |
| `/opt/sandboxer/scripts` | the container scripts |

## Status surface

Answers on **every** hostname a sandbox serves, and is not gated on the database.

| Path | Answers |
|---|---|
| `/__sandboxer/live` | `ok`, unconditionally |
| `/__sandboxer/status.json` | state, database, migration verdict, timestamps |
| `/__sandboxer/built.json` | label → last build time |
| `/__sandboxer/health/<service>` | that service's own health path |
| anything else under `/__sandboxer/` | 404 |

## Environment variables that matter

| Variable | Default | What |
|---|---|---|
| `SANDBOXER_DOMAIN` | `sbx.localhost` | Hostname suffix |
| `SANDBOXER_HOME` | `~/.sandboxer` | Everything sandboxer keeps on the host |
| `SANDBOXER_WORKSPACE` | `$SANDBOXER_HOME/workspace` | Where managed projects live |
| `SANDBOXER_TTL_HOURS` | `12` | Idle limit. `config.yaml` beats it |
| `SANDBOXER_HTTP_PORT` / `_HTTPS_PORT` | `80` / `443` | Where the router publishes |
| `SANDBOXER_CACHE_TTL_HOURS` | `24` | How long a cached seed is reused before it is taken again |

Every variable, all three groups: [Environment variables](environment.md).

## The machine's own settings

`~/.sandboxer/config.yaml`, written commented by `sandboxer init` and never touched again.

```yaml
ttl: 12h          # 30m | 12h | 3d | a number of seconds | never
github: none      # none | token
projects:
  acme-monorepo: { ttl: 3d, github: token }
```

A `projects:` key is the project's **workspace directory** — the name `sandboxer project ls` prints
— or the `project:` its `sandboxer.yaml` declares. Either works; the directory wins if both are keyed.
A key matching neither does nothing, and `sandboxer doctor` names it.

ttl precedence, most specific first: `--ttl`, the project's entry, the file's top-level `ttl`,
`SANDBOXER_TTL_HOURS`, then the built-in `12h`.

## `sandboxer.yaml` skeleton

Two required fields, and everything else optional.

```yaml
project: acme                 # required. lowercase, digits, dashes
sandboxer: ">=0.1.0"           # required. the minimum tool version this config needs

database:
  driver: mysql               # mysql | d1 | sqlite | none
  version: "8.4"
  owner: app                  # file drivers only: the one service that may open it
  seed_from:
    local: { container: acme-mysql, database: acme }
    file: ~/dumps/acme.sql.zst
    fixtures: migrations/fixtures.sql
    anonymised: true
  migrate:
    workdir: services
    command: go run ./cmd/migrate
    since: "20260209"
    failure_pattern: "[0-9]+ failed"

storage:
  driver: minio               # minio | none
  buckets: [uploads]

toolchain: { go: "1.26", node: "24" }

deps:
  root: web                   # the directory holding the lockfile
  lockfile: package-lock.json
  install: npm ci --no-audit --no-fund

backends:
  defaults: { workdir: services, build: go build -o {out} ./{name} }
  services:
    - { name: api, label: api, port: 8001, health: /health }

frontends:
  root: web/packages
  defaults: { build: npx vite build, out: dist }
  apps:
    - { label: app, package: app, static_mode: spa }
    - { label: cms, package: cms, serve: npx next dev --port 3000, port: 3000, optional: true }

routes:
  app: { "/api": api }

env:
  DB_HOST: "${SANDBOXER_DB_HOST}"

secrets:
  read: [.env]
  keep: [STRIPE_PUBLISHABLE_KEY]
  rename: { VITE_API_URL: SANDBOXER_URL_API }
  never: [STRIPE_SECRET_KEY]

access:
  apps: public                # public | private
  credentials: dummy          # dummy | real
```

Field by field, with types and defaults:
[sandboxer.yaml, field by field](../configuration/sandboxer-yaml.md). The constraints a config must
obey: [The rules a config must obey](../configuration/rules.md).

## Defaults worth knowing

| Thing | Default |
|---|---|
| `access.apps` | `public` |
| `access.credentials` | `dummy` |
| `access.controls` | `password`, and it cannot be anything else |
| `storage.driver` | `none` |
| `static_mode` | `spa` |
| `in_build_all` | `true` |
| `optional` | `false` |
| `deps.lockfile` | `package-lock.json` |
| `deps.install` | `npm ci --no-audit --no-fund` |
| The database's name | the project name. `sandboxer.yaml` has no field for it |
| Container memory | the largest `memory:` any runtime declares, floor 4 GB |
| `up` wait | 180 seconds |
| `logs --tail` | 200 |

## Five things that surprise people

- **There is no hot reload.** Front-ends are built on demand and answer 503 until they are.
- **A failed migration leaves the sandbox up and `degraded`.** That is deliberate.
- **One writer per file-backed database.** `database.owner` names it.
- **Nothing enforces a lifetime on its own.** `sandboxer expire` is the whole mechanism, and no
  timer runs it for you.
- **Remote deployment does not exist.** mkcert is the only certificate issuer.
  [What is built](status.md) is the honest inventory.

---

**Next:** [CLI commands](cli.md) for the flags this page left out, or
[Troubleshooting](../troubleshooting.md) when something here did not behave.
