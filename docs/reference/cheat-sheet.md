---
title: Cheat sheet
description: One dense page of the facts a returning reader looks up — commands, names, paths, labels, states and defaults.
---

Everything you look up rather than read. No explanations here; every row links somewhere that has
one.

```prompt
Give me a summary of the sandboxes on this machine and whether anything is wrong with them.

Read docs/reference/cheat-sheet.md first, then run the read-only commands from the "One command
per intent" table — sandboxr ls, sandboxr status, sandboxr doctor — with --json, and tell me what
you found. Do not start, stop or remove anything. Stop and tell me if Docker is not running or if
`sandboxr` is not on the PATH.
```

## One command per intent

| I want to | Command |
|---|---|
| Set this machine up | `sandboxr init` |
| Check this machine | `sandboxr doctor` |
| Start a sandbox from this worktree | `sandboxr up` |
| Start one from a branch of a managed project | `sandboxr up --project acme --branch tkt-4821` |
| See everything running | `sandboxr ls` |
| See one sandbox in detail | `sandboxr status <slug>` |
| Read the log | `sandboxr logs <slug> -f` |
| Get a shell inside | `sandboxr shell <slug>` |
| Run one command inside | `sandboxr shell <slug> -- go test ./...` |
| Rebuild a front-end | `sandboxr reload <slug> --web=app` |
| Rebuild every front-end | `sandboxr reload <slug> --web` |
| Rebuild a backend | `sandboxr reload <slug> --go` |
| Re-run the migrations | `sandboxr reload <slug> --migrate` |
| Open the database | `sandboxr db shell <slug>` |
| Print the schema | `sandboxr db snapshot <slug> > before.sql` |
| See a project's credentials, by name | `sandboxr secrets list` |
| Set one without it reaching the shell history | `printf '%s' "$KEY" \| sandboxr secrets set NAME` |
| Deliver a changed credential to a running sandbox | `sandboxr stop <slug>` then `sandboxr start <slug>` |
| Stop it, keep everything | `sandboxr stop <slug>` |
| Start it again | `sandboxr start <slug>` |
| Exempt it from the idle clock | `sandboxr keep <slug>` |
| Throw it away | `sandboxr down <slug>` |
| Throw away the container, keep the data | `sandboxr down <slug> --keep` |
| Finish with a branch: its sandbox, then its worktree | `sandboxr worktree delete <project> <branch>` |
| Stop everything that has gone idle | `sandboxr expire` |
| Clean up after deleted worktrees | `sandboxr gc` |
| Get disk back | `sandboxr prune` then `sandboxr prune --yes` |
| See what a config resolved to | `sandboxr config --json` |
| Stop the router, and whatever is on the bare domain | `sandboxr teardown` |

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
| Domain | `SANDBOXR_DOMAIN` | `sbx.localhost` |
| Slug | `[a-z0-9-]`, at most 31 characters | `tkt-4821` |
| Container | `sandboxr-<project>-<slug>` | `sandboxr-acme-tkt-4821` |
| Network | `sandboxr` — one, shared | |
| Database volume | `sandboxr-data-<project>-<slug>` | |
| Uploads volume | `sandboxr-blob-<project>-<slug>` | |
| Binaries volume | `sandboxr-bin-<project>-<slug>` | |
| Built sites volume | `sandboxr-www-<project>-<slug>` | |
| Dependencies volume | `sandboxr-deps-<16 hex of the lockfile hash>` | |
| Machine-wide volumes | `sandboxr-gocache`, `sandboxr-gomod` | |
| Project image | `sandboxr/<project>:<12 hex of the build inputs>` | |
| Machine image | `sandboxr/base` — the only one the engine builds | |
| Router container | `sandboxr-router` | |

Slug order of preference: an explicit argument, a slug recorded for the worktree, a ticket id
(`/[a-z]+-[0-9]+/i`) in the worktree directory name, that pattern in the branch name, the branch
name, the directory name. The ceiling is `min(31, 63 - longest label - project - 4)` — the second
half is the one DNS label a hostname is, and may only lower it. Over the ceiling a slug becomes the
first `ceiling - 9` characters plus `-` plus 8 hex of the SHA-256 of the raw input.

Two worktrees of one project that would derive the same slug: the second one sandboxr cuts is given
`<slug>-<4 random characters>` instead, sized against that same ceiling and recorded in
`state/slug/`. Worktrees you cut yourself are not covered — name one explicitly.

## States

| `sandboxr ls` says | Means |
|---|---|
| `starting` | The container is up and has not finished booting |
| `running` | Booted, migrations fine |
| `degraded` | Booted, **migration failed**. Deliberately still serving |
| `stopped` | The container exists and is not running |

Inside the sandbox, `/__sandboxr/status.json` reports `booting`, `ok` or `degraded`.

## Container labels

All durable state, and there is no manifest file anywhere.

`sandboxr.project` · `sandboxr.slug` · `sandboxr.branch` · `sandboxr.commit` · `sandboxr.dirty` ·
`sandboxr.worktree` · `sandboxr.driver` · `sandboxr.created` · `sandboxr.access` · `sandboxr.ttl` ·
`sandboxr.env`

`sandboxr.env` is a digest of the environment the sandbox was **created** with. Whether a running
one has read the current credentials is a comparison of the secrets file's mtime against the
container's start time, never that label.

Runtime state is derived at read time and never written back. [Why](../architecture/state.md).

## Host paths

Everything under `SANDBOXR_HOME`, default `~/.sandboxr`.

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
| `/sandboxr/plan.json` | the plan, read-only |
| `/sandboxr/secrets.env` | the project's credentials, read-only |
| `/sandboxr/cache`, `/sandboxr/seed` | seed artifacts, read-only |
| `/var/lib/sandboxr/{data,blob,bin}` | database, uploads, binaries |
| `/srv/www` | built sites, one directory per label |
| `/var/log/sandboxr` | per-service logs |
| `/run/sandboxr` | marker files the status document is built from |
| `/opt/sandboxr/scripts` | the container scripts |

## Status surface

Answers on **every** hostname a sandbox serves, and is not gated on the database.

| Path | Answers |
|---|---|
| `/__sandboxr/live` | `ok`, unconditionally |
| `/__sandboxr/status.json` | state, database, migration verdict, timestamps |
| `/__sandboxr/built.json` | label → last build time |
| `/__sandboxr/health/<service>` | that service's own health path |
| anything else under `/__sandboxr/` | 404 |

## Environment variables that matter

| Variable | Default | What |
|---|---|---|
| `SANDBOXR_DOMAIN` | `sbx.localhost` | Hostname suffix |
| `SANDBOXR_HOME` | `~/.sandboxr` | Everything sandboxr keeps on the host |
| `SANDBOXR_WORKSPACE` | `$SANDBOXR_HOME/workspace` | Where managed projects live |
| `SANDBOXR_TTL_HOURS` | `12` | Idle limit. `config.yaml` beats it |
| `SANDBOXR_HTTP_PORT` / `_HTTPS_PORT` | `80` / `443` | Where the router publishes |
| `SANDBOXR_CACHE_TTL_HOURS` | `24` | How long a cached seed is reused before it is taken again |

Every variable, all three groups: [Environment variables](environment.md).

## The machine's own settings

`~/.sandboxr/config.yaml`, written commented by `sandboxr init` and never touched again.

```yaml
ttl: 12h          # 30m | 12h | 3d | a number of seconds | never
github: none      # none | token
projects:
  acme-monorepo: { ttl: 3d, github: token }
```

A `projects:` key is the project's **workspace directory** — the name `sandboxr project ls` prints
— or the `project:` its `sandboxr.yaml` declares. Either works; the directory wins if both are keyed.
A key matching neither does nothing, and `sandboxr doctor` names it.

ttl precedence, most specific first: `--ttl`, the project's entry, the file's top-level `ttl`,
`SANDBOXR_TTL_HOURS`, then the built-in `12h`.

## `sandboxr.yaml` skeleton

Two required fields, and everything else optional.

```yaml
project: acme                 # required. lowercase, digits, dashes
sandboxr: ">=0.1.0"           # required. the minimum tool version this config needs

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
  DB_HOST: "${SANDBOXR_DB_HOST}"

secrets:
  read: [.env]
  keep: [STRIPE_PUBLISHABLE_KEY]
  rename: { VITE_API_URL: SANDBOXR_URL_API }
  never: [STRIPE_SECRET_KEY]

access:
  apps: public                # public | private
  credentials: dummy          # dummy | real
```

Field by field, with types and defaults:
[sandboxr.yaml, field by field](../configuration/sandboxr-yaml.md). The constraints a config must
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
| The database's name | the project name. `sandboxr.yaml` has no field for it |
| Container memory | the largest `memory:` any runtime declares, floor 4 GB |
| `up` wait | 180 seconds |
| `logs --tail` | 200 |

## Five things that surprise people

- **There is no hot reload.** Front-ends are built on demand and answer 503 until they are.
- **A failed migration leaves the sandbox up and `degraded`.** That is deliberate.
- **One writer per file-backed database.** `database.owner` names it.
- **Nothing enforces a lifetime on its own.** `sandboxr expire` is the whole mechanism, and no
  timer runs it for you.
- **Remote deployment does not exist.** mkcert is the only certificate issuer.
  [What is built](status.md) is the honest inventory.

---

**Next:** [CLI commands](cli.md) for the flags this page left out, or
[Troubleshooting](../troubleshooting.md) when something here did not behave.
