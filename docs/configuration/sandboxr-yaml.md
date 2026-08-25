---
title: sandboxr.yaml, field by field
description: How to build a project's sandboxr.yaml one block at a time — what each block is for, a small real example of each, and the complete field list for every one.
sidebar:
  order: 1
---

> **Written, never run** — The schema and the loader are written and covered by unit tests in packages/core. No project's sandboxr.yaml has yet been used to start a real sandbox.

`sandboxr.yaml` is how a project tells sandboxr what it is made of: what to run, how to build
it, where its data comes from, and which credentials it is allowed to have.

It lives at the **root of the project being sandboxed** — not in the sandboxr repository. That
is the whole design. The file is versioned with the project's own code, so a branch that adds a
service also adds the four lines that run it, and a reviewer who checks that branch out gets a
sandbox that works with nothing to configure.

This page walks through the file in the order you would actually write it. The main text is the
explanation and a small real example of each block; the **complete field list for that block —
every field, its type, whether it is required, and what it defaults to — is in the collapsed
block underneath it.**

## Start with two lines

This is a legal config:

```yaml title="sandboxr.yaml"
project: acme
sandboxr: ">=0.1.0"
```

It describes a project with no database, nothing to run and no credentials, which is not useful
— but everything else in the file is optional, and you add blocks as the project needs them.

`project` is the name that goes into every hostname, every container name and every Docker
volume name, so it has to be lowercase letters, digits and dashes. Changing it later orphans
every sandbox that is currently running: they were named after the old value and nothing will
go looking for them.

`sandboxr` is the minimum version of the tool this file needs. If the tool is older, you get one
sentence at parse time naming the constraint, instead of a confusing failure three steps later.
Raise it the moment you use a field an older version did not have.

<details>
<summary><b>Details for an agent:</b> the top-level fields, their types, and what each one defaults to when you leave it out</summary>

Only two fields are required. Everything else has a default that means "this project does not
have one of those".

| Field | Type | Required | Default when absent |
|---|---|---|---|
| `project` | string matching `^[a-z0-9]([a-z0-9-]*[a-z0-9])?$` | **yes** | — |
| `sandboxr` | string, a version constraint such as `">=0.1.0"` | **yes** | — |
| `database` | mapping | no | `driver: none` |
| `backends` | mapping or list | no | no backends |
| `frontends` | mapping or list | no | no front-ends |
| `routes` | mapping | no | no path routes |
| `secrets` | mapping | no | every list empty, so nothing is imported |
| `storage` | mapping | no | `driver: none` |
| `deps` | mapping | no | found on disk, if there is a lockfile |
| `toolchain` | mapping | no | unset |
| `access` | mapping | no | `apps: public`, `controls: password`, `credentials: dummy` |
| `env` | mapping of `NAME` to string | no | empty |

The schema is **strict**: an unknown key is an error naming the key, not a setting that
silently does nothing. In a file that decides what a sandbox serves, a typo that is ignored is
worse than a typo that stops you.

Three filenames are accepted, in this order: `sandboxr.yaml`, `sandboxr.yml`, `.sandboxr.yaml`.
Commands walk up from the current directory until they find one, so `sandboxr up` works from
anywhere inside the project.

Authority: `packages/core/src/config/schema.ts` for the shape, `load.ts` for the defaults and
the checks. Where this page and the schema disagree, the schema is right.

</details>

## What to run, part one: `backends`

A **backend** is a long-running process that listens on a port — an API, a worker with an HTTP
interface, anything compiled to a binary. sandboxr builds it once, starts it, and restarts it
if it exits.

```yaml
backends:
  defaults:
    workdir: services
    build: go build -o {out} ./{name}
    health: /health
  services:
    - { name: api, port: 8001, label: api }
    - { name: adminApi, port: 8081, label: admin-api }
    - { name: jobs, port: 8004, label: jobs }
```

Three things are happening there.

**`defaults` saves you from repeating yourself.** Most services in one project build the same
way. Anything in `defaults` applies to every entry that does not set it itself.

**`{name}` and `{out}` in a build command are filled in for you.** `{name}` becomes the
service's name and `{out}` becomes the path sandboxr wants the binary written to. Nothing else
is substituted, and both values are checked against a strict character set before they go
anywhere near a command line.

**`port` is a port inside the container, and `label` is a name in a hostname.** Nothing is
published to your machine, so ports only have to be unique within the sandbox. The label is
what turns into an address: `api` becomes `feat-123.api.acme.sbx.localhost`.

> [!TIP] Leave out a service that cannot possibly work here
> If a service needs a database that exists on no developer's machine and that no migration
> creates, declaring it produces nothing but a crash-loop and a red tile. Leave it out, and leave
> a comment where the entry would go saying why — otherwise somebody adds it back in six months.

<details>
<summary><b>Details for an agent:</b> every field of a backend entry, both accepted shapes of the block, and the errors it can raise</summary>

Two shapes are accepted. The mapping form is canonical, because a `defaults:` key cannot legally
sit inside a YAML sequence:

```yaml
backends:
  defaults: { ... }        # optional
  services: [ ... ]        # required
```

A project with nothing to default may write the bare list instead, and it is treated as if it
had been written as `services:` with no `defaults`:

```yaml
backends:
  - { name: api, port: 8001, label: api }
```

| Field | Type | Required | Settable in `defaults` | Default |
|---|---|---|---|---|
| `name` | string | **yes** | no | — |
| `port` | integer 1–65535 | **yes** | no | — |
| `label` | hostname label, max 63 chars | **yes** | no | — |
| `build` | string | **yes**, here or in `defaults` | yes | — |
| `workdir` | string, relative to the repo root | no | yes | the repo root |
| `health` | string, a path such as `/health` | no | yes | none, so the service counts as up once the process is running |
| `memory` | string such as `6g`, `512m` | no | yes | none |
| `optional` | boolean | no | yes | `false` |

`name` is the service's identity everywhere else in the file: it is what `routes` points at, what
`database.owner` may name, and what `sandboxr reload --go <name>` takes.

Errors raised while resolving this block:

- an entry with no `build` and no `backends.defaults.build`
- two backends with the same `name`
- two runtimes — backend or front-end — with the same `label`

The build runs inside the container, and its output goes to that service's log. A backend that
fails to build does not crash-loop silently: the run script pauses ten seconds so the compiler
output stays readable before the supervisor retries.

</details>

## What to run, part two: `frontends`

A **front-end** is either built into a directory of files, or run as a long-running server.
Which one it is depends on a single field: `out:` means built, `serve:` means run. Both live in
the same block because both answer on an app hostname.

```yaml
frontends:
  root: web/packages
  defaults:
    build: npx vite build
    out: dist
  apps:
    - { label: app, package: web }
    - { label: admin, package: admin }
    - { label: www, package: marketing, build: npm run build, out: out, memory: 6g }
    - { label: cms, package: cms, serve: npx next dev --port 3000 --hostname 127.0.0.1, port: 3000, optional: true }
```

`root` is a prefix for every `package` path, so a monorepo does not repeat `web/packages/`
five times. `package: .` means the repo root itself, which is what a single-app project uses.

The first two apps inherit everything. `www` overrides its build and its output directory and
asks for more memory. `cms` is the odd one out: it has `serve:` instead of `out:`, so it is a
running process rather than a directory of files, and `optional: true` keeps it switched off
until somebody asks for it with `sandboxr up --with cms`.

The difference between those two kinds is worth understanding properly before you write this
block, because getting it wrong is the most common way to end up with a config that half-works:
[three runtime kinds](./runtime-kinds.md).

<details>
<summary><b>Details for an agent:</b> every field of a front-end entry, which ones apply to which kind, and how the kind is decided</summary>

The block takes the same two shapes as `backends` — a mapping with `root`, `defaults` and `apps`,
or a bare list of entries.

| Field | Type | Required | Applies to | Default |
|---|---|---|---|---|
| `label` | hostname label, max 63 chars | **yes** | both | — |
| `package` | string, relative to `root` | **yes** | both | — |
| `build` | string | **yes** for a static app | static only | — |
| `out` | string, relative to the package | **yes** for a static app | static only | — |
| `serve` | string | **yes** for a served app | server only | — |
| `port` | integer 1–65535 | **yes** for a served app | server only | — |
| `prepare` | string, run once before the server starts | no | server only | none |
| `health` | string, a path | no | server only | none |
| `static_mode` | `spa` \| `files` \| `html` | no | static only | `spa` |
| `in_build_all` | boolean | no | both | `true` |
| `memory` | string such as `6g` | no | both | none |
| `optional` | boolean | no | both | `false` |

And on the block itself:

| Field | Type | Required | Default |
|---|---|---|---|
| `root` | string, prefix for every `package` | no | the repo root |
| `defaults` | any entry field except `label` and `package` | no | — |

**The kind is decided by the entry, before `defaults` is consulted.** An entry with `serve:` is a
server, one with `out:` is static, and only if the entry says neither does the default decide. An
app declared under `defaults: { out: dist }` that sets its own `serve:` must not inherit an output
directory it has no build to fill.

Fields belonging to the other kind are dropped rather than carried: a static app never keeps
`health` or `prepare`, and a served app never keeps `build` or `out`.

Errors raised while resolving this block:

- an entry with both `out` and `serve`
- a static app with no `out`, or with no `build` and no default build
- a served app with no `port`
- a `label` already used by a backend or another front-end

</details>

## How requests reach it: `routes`

Every runtime already has a hostname of its own. `routes` adds a second way in: a **path prefix
on an app's hostname** that is forwarded to a backend.

```yaml
routes:
  app:
    "/api": api
  admin:
    "/api": adminApi
```

The key is an app's `label`. Each line under it maps a path prefix on that app's hostname to a
service. So a request to `https://feat-123.app.acme.sbx.localhost/api/users` reaches the `api` backend,
and every other path on that hostname is served by the app's own files.

**Why bother, when the backend has its own hostname anyway?** Because a same-origin path takes
the browser's cross-origin rules out of the picture completely. No preflight requests, no
allowlist to maintain per sandbox, no cookie surprises. It also means the app's own code needs no
sandbox-specific setting at all: `/api` is `/api` in every environment, including this one.

Notice `admin` pointing at `adminApi` rather than `api` above. Two apps using the same prefix for
two different services is the normal case, not an edge case, and getting it wrong produces 404s
from a service that never had those routes — which looks exactly like a bug in the app.

<details>
<summary><b>Details for an agent:</b> the shape of the routes map, what is validated, and how overlapping prefixes are ordered</summary>

```
routes:
  <app label>:
    "<path prefix>": <backend name or served front-end label>
```

| Position | Must be | Checked when the config is read |
|---|---|---|
| the outer key | the `label` of a declared front-end | yes — an unknown label is an error |
| the inner key | a string starting with `/` | yes — the schema requires the leading slash |
| the value | a backend `name`, or the `label` of a front-end with `serve:` | yes — anything else is an error |

A static front-end cannot be a route target. It has no port and no process, so there is nothing
to forward a request to.

Overlapping prefixes are matched most-specific-first, so `"/api/search"` and `"/api"` can both be
declared and the longer one wins. Write them longest-first anyway: the file then reads in the
order the matching actually happens.

These are checked at parse time on purpose. A typo here produces a 404 in a browser and nothing
at all in any log, which is among the most expensive kinds of mistake to debug.

</details>

## The database

A sandbox's database is **its own private copy**. Nothing here ever points at a real one. The
`database` block says three things: what kind of database, where the copy's initial contents come
from, and how to bring its schema up to date.

```yaml
database:
  driver: mysql
  version: "8.4"
  seed_from:
    local:
      container: acme_db
      database: acme
    file: /var/sandboxr/seeds/acme.sql.zst
    anonymised: true
    fixtures: db/seeds/fixtures.sql
  migrate:
    workdir: services
    command: go run ./cmd/migrate --dir ../db/migrations --non-interactive
    since: "20240101"
```

**`driver` picks the whole implementation** — `mysql`, `d1`, `sqlite` or `none`. See
[the driver model](../databases/drivers.md).

**`version` is the version production runs, not the one you happen to have installed.** A
laptop's `mysql:latest` drifts, and it often resolves to a release line production will never
run. A migration tested against the wrong major version has not really been tested, so the copy
is restored into the declared version whatever the source was.

**`seed_from` may name more than one source, and that is deliberate.** A laptop forks the
database container the developer already runs; a server has no such container and restores a
dump instead. Both can be listed, and the tool picks the first one that is both permitted and
actually available on this machine, in the order `local`, `file`, `fixtures`. The flag
`--seed local|file|fixtures` on `sandboxr up` forces a particular one.

**`fixtures` is applied after migrations, and a failure is not fatal.** Fixtures encode
assumptions about the schema. A fixture that no longer matches is a *useful signal* that the
branch changed something, not a reason to refuse to start a sandbox.

**`migrate.command` is the project's own migration program.** sandboxr shells out to it and
never reimplements it. Two migration engines that have to agree for ever would not.

> [!WARNING] `since` arrives as an environment variable, not a flag
> sandboxr cannot guess how your migration runner spells its flags, so `since` is exported as
> `SANDBOXR_MIGRATE_SINCE` and **your command has to read it**:
>
> ```yaml
> migrate:
>   command: go run ./cmd/migrate --since "$SANDBOXR_MIGRATE_SINCE"
>   since: "20240101"
> ```
>
> Setting `since` and never mentioning the variable does nothing at all.

> [!CAUTION] A file database must be pointed at the sandbox, not the worktree
> For `d1` and `sqlite`, both the migrate command and any `serve:` command must direct the runtime
> at the sandbox's own state directory:
>
> ```yaml
> command: npx wrangler d1 migrations apply DB --local --persist-to $SANDBOXR_D1_DIR
> ```
>
> Leave it out and the runtime writes its database **into your checkout**, where every sandbox of
> that project shares one file. `sandboxr doctor` warns when it cannot see the variable in the
> command; it does not refuse. [D1 and SQLite](../databases/d1-sqlite.md).

<details>
<summary><b>Details for an agent:</b> every field of the database block, what each one accepts, and the two rules it enforces</summary>

| Field | Type | Required | Default |
|---|---|---|---|
| `driver` | `mysql` \| `d1` \| `sqlite` \| `none` | **yes**, within the block | — |
| `version` | string or number | no | the driver's own default image |
| `owner` | string naming a declared backend or front-end | **yes** for `d1`/`sqlite` with more than one runtime | the single runtime, if there is only one |
| `seed_from.local.container` | string | **yes**, within `local` | — |
| `seed_from.local.database` | string | no | the driver decides |
| `seed_from.file` | string, a host path | no | — |
| `seed_from.fixtures` | string, a repo-relative path | no | — |
| `seed_from.anonymised` | boolean | no | `false` |
| `migrate.command` | string | **yes**, within `migrate` | — |
| `migrate.workdir` | string, relative to the repo root | no | the repo root |
| `migrate.since` | string or number, exported as `SANDBOXR_MIGRATE_SINCE` | no | unset |
| `migrate.failure_pattern` | string | no | unset |
| `migrate.file_pattern` | string | no | unset |
| `migrate.error_pattern` | string | no | unset |

The three `*_pattern` fields are passed to the container untouched. They are how the container
turns one runner's output into progress and a named failure — every runner prints something
different, and a built-in parser would only ever be right for one project.

`anonymised: true` is an **assertion by whoever wrote the config**, not something the tool can
verify. It is the only thing that lets a project with `access.apps: public` use a `file` seed. A
`fixtures` seed is safe by definition; a `local` seed — a fork of a live database — can never
satisfy that requirement. See [public sandboxes](../security/public-sandboxes.md).

Two rules are enforced when the config is read:

- **A driver other than `none` with neither `seed_from` nor `migrate` is an error.** There would
  be nothing for it to do.
- **A `d1` or `sqlite` project with more than one runtime must set `owner`.** Two processes
  opening the same file deadlock, so exactly one service may hold it, and `owner` must name a
  declared backend or front-end. With only one runtime the answer is obvious and the tool fills
  it in.

</details>

## Storage

Object storage that lives inside the sandbox, so an upload in a sandbox can never reach a real
bucket.

```yaml
storage:
  driver: minio
  buckets: [uploads, avatars, exports]
```

The buckets are created the first time the sandbox boots. The sandbox computes its own endpoint
and its own credentials and hands them to your services — which is exactly why anything named
`S3_*` belongs in `secrets.never`. Importing a developer's real storage settings would send a
sandbox's test uploads to a production bucket, and nothing would report a problem.

<details>
<summary><b>Details for an agent:</b> the storage fields, and why the object store is in the base image whether or not you use it</summary>

| Field | Type | Required | Default |
|---|---|---|---|
| `driver` | `minio` \| `none` | **yes**, within the block | `none` when the block is absent |
| `buckets` | list of strings | no | empty |

The object store is present in the shared base image whether or not a project declares
`storage:`, so that a public sandbox driven by a stranger *cannot* reach real cloud storage even
if something is misconfigured. That is a guarantee rather than a feature, which is why it is not
behind a flag. A project that declares no buckets pays no runtime cost, because the service is
never started.

The addresses the sandbox computes for itself are `SANDBOXR_S3_ENDPOINT`, `SANDBOXR_S3_KEY`,
`SANDBOXR_S3_SECRET` and `SANDBOXR_S3_REGION`. You map them to your project's own names in the
`env` block below.

</details>

## Secrets

Which real third-party credentials the sandbox is allowed to have, and which it must never be
given. It has [a page of its own](./secrets.md), because the rules matter far more than the
four fields do.

```yaml
secrets:
  read: [services/api/.env]
  keep: [AUTH0_DOMAIN, JWT_SECRET]
  rename: { ANALYTICS_API_HOST: ANALYTICS_ENDPOINT }
  never: ["DB_*", "S3_*", "*_URL"]
```

In one sentence: `read` says which files to look in, `keep` is the allowlist of names to take,
`rename` says what a name should be called once it is here, and `never` is the list of patterns
that are refused whatever else the file says.

## `env` — your names for what the sandbox computes

The sandbox works out **where** everything is: its own database, its own object storage, its own
hostnames. It exports those under names beginning with `SANDBOXR_`. Your project reads its own
names for the same things. `env` is the mapping between the two, and only the project knows its
own spelling.

```yaml
env:
  DB_HOST: "${SANDBOXR_DB_HOST}"
  DB_NAME: "${SANDBOXR_DB_NAME}"
  DB_USER: "${SANDBOXR_DB_USER}"
  DB_PASSWORD: "${SANDBOXR_DB_PASSWORD}"
  S3_ENDPOINT: "${SANDBOXR_S3_ENDPOINT}"
  S3_BUCKET: uploads
  VITE_API_URL: /api
  VITE_APP_URL: "${SANDBOXR_URL_APP}"
```

This is the block that makes an unmodified application run in a sandbox without knowing it is in
one. Note what is *not* here: no host from your machine, no real endpoint, no credential. A
placeholder can only ever expand to something the sandbox computed for itself, so nothing written
here can point at a real service. Anything genuinely secret comes from `secrets` instead.

<details>
<summary><b>Details for an agent:</b> the placeholder names a sandbox exports, and how a value is expanded</summary>

| Name | When it exists | What it holds |
|---|---|---|
| `SANDBOXR_PROJECT` | always | the project name |
| `SANDBOXR_DOMAIN` | always | the domain hostnames hang off |
| `SANDBOXR_DB_DRIVER` | always | the driver name |
| `SANDBOXR_DB_NAME` | any driver but `none` | the database name, which is the project name |
| `SANDBOXR_DB_HOST`, `SANDBOXR_DB_PORT`, `SANDBOXR_DB_USER`, `SANDBOXR_DB_PASSWORD` | `mysql` | loopback, 3306, and a disposable credential pair |
| `SANDBOXR_DB_FILE` | `sqlite` | the database file inside the sandbox's state directory |
| `SANDBOXR_D1_DIR` | `d1` | the directory the runtime persists into |
| `SANDBOXR_S3_ENDPOINT`, `SANDBOXR_S3_KEY`, `SANDBOXR_S3_SECRET`, `SANDBOXR_S3_REGION` | `storage.driver: minio` | the in-sandbox object store |
| `SANDBOXR_URL_<LABEL>` | one per runtime label | that runtime's full URL for this sandbox, e.g. `SANDBOXR_URL_ADMIN_API` |
| `SANDBOXR_PORT_<ID>` | one per port-holding service | its port inside the container |
| `SANDBOXR_MIGRATE_SINCE` | `database.migrate.since` is set | the cutoff, verbatim |

A label becomes a variable name by upper-casing it and turning dashes into underscores, so the
label `admin-api` gives `SANDBOXR_URL_ADMIN_API`.

The keys of `env` must look like environment variable names (`^[A-Za-z_][A-Za-z0-9_]*$`). Values
are expanded by **substitution, not by a shell** — `envsubst`, against the variables above and
against the imported secrets. A value is data and can never be a command.

The exact list the container exports is `container/scripts/env.sh`, and the full reference is
[environment variables](../reference/environment.md).

</details>

## `toolchain` and `deps`

Two blocks about the machine rather than the application.

```yaml
toolchain:
  go: "1.23"
  node: "22"

deps:
  root: web
```

`toolchain` names the language versions installed in this project's own image layer. The shared
base image is generic — a supervisor, a web server, an object store, `jq` and the sandboxr
scripts — and knows nothing about Go or Node, because a toolchain version is a fact about one
repository.

`deps` names the directory holding the Node lockfile. Dependencies are installed once into a
shared volume rather than into your checkout, and that volume is mounted at exactly one path — so
the tool has to know which one. Most projects can leave this out: if there is a lockfile at the
repo root, or at the first segment of `frontends.root`, it is found.

<details>
<summary><b>Details for an agent:</b> both blocks' fields, the lockfiles that are recognised, and what a toolchain change costs</summary>

| Field | Type | Required | Default |
|---|---|---|---|
| `toolchain.go` | string or number | no | no Go installed |
| `toolchain.node` | string or number | no | no Node installed |
| `deps.root` | string, repo-relative directory | **yes**, within the block | searched for |
| `deps.lockfile` | string | no | `package-lock.json` |
| `deps.install` | string | no | `npm ci --no-audit --no-fund` |

When `deps` is absent, the candidate directories are searched in order — the repo root, then the
first segment of `frontends.root`, then `frontends.root` itself — for the first of these:

| Lockfile | Install command used |
|---|---|
| `package-lock.json` | `npm ci --no-audit --no-fund` |
| `pnpm-lock.yaml` | `pnpm install --frozen-lockfile` |
| `yarn.lock` | `yarn install --immutable` |
| `bun.lockb` | `bun install --frozen-lockfile` |

A project with no lockfile at all simply gets no shared dependency volume, which costs an install
rather than breaking anything.

A version given as a prefix is meant to resolve against the vendor's release index, so `node:
"24"` picks the latest 24.x when the layer is built. That has not been verified against a real
build — and neither has the layer build itself, which is
[not implemented yet](../reference/status.md): `packages/core` currently runs `sandboxr/base:latest`,
or whatever `SANDBOXR_IMAGE` names.

</details>

## `access` — who can reach the apps, and what they may touch

This is the smallest block in the file and the one with the largest consequences.

```yaml
access:
  apps: public
  controls: password
  credentials: dummy
```

| Field | Values | Default | Means |
|---|---|---|---|
| `apps` | `public` \| `private` | `public` | Whether an app hostname needs a login |
| `controls` | `password` | `password` | The dashboard and every action are always behind a password |
| `credentials` | `dummy` \| `real` | `dummy` | Whether real third-party credentials may reach this sandbox |

**Public apps are the point.** Somebody who is sent a link sees the branch running, with no
account and no VPN. What makes that safe is two refusals that come with it:

1. A public sandbox may only be seeded from **fixtures**, or from a dump explicitly marked
   `anonymised: true`. A fork of a live database can never satisfy it.
2. A public sandbox gets **dummy credentials** unless it sets `credentials: real`. Anyone who can
   drive a public app could otherwise make it send real email or spend real credit.

Both are refusals to start, not warnings. `apps: private` is the escape hatch: it puts the app
hostnames behind the same session as the dashboard, and both restrictions lift, because now only
people you have given a password to can reach them. [Public sandboxes](../security/public-sandboxes.md)
covers the reasoning.

## When the config is wrong

Every failure names the file and the field. There are no silent ones.

<details>
<summary><b>If it goes wrong:</b> every error the loader raises, and what each one means</summary>

| Message names | Cause |
|---|---|
| `(root)` or a key name | An unknown or misspelled key — the schema is strict |
| `sandboxr` | The constraint is unparseable, or this tool is older than it requires |
| `database` | A driver other than `none` with neither `seed_from` nor `migrate` |
| `database.owner` | A `d1`/`sqlite` project with several runtimes and no owner, or an owner naming nothing |
| `database.seed_from.local` | Public apps, and the only seed source is a fork of a live database |
| `database.seed_from.file` | Public apps, and the dump is not marked `anonymised: true` |
| `backends.<name>` | No `build` on the entry and none in `backends.defaults` |
| `backends` | Two backends with the same `name` |
| `frontends.<label>` | Both `out` and `serve`; or neither; or a static app with no build; or a server with no `port` |
| `backends.<name>` / `frontends.<label>` | A `label` already used by another runtime |
| `routes.<label>` | No front-end has that label |
| `routes.<label>."<prefix>"` | The target is neither a backend nor a served front-end |

Two useful commands:

```bash
sandboxr config      # where the config is, and what it resolved to
sandboxr doctor      # Docker, the config, and every credential the config asks for
```

`sandboxr config` reads the file with the access refusals switched off, so it will still describe
a config that `up` would reject — which is what you want when you are trying to work out why.
`doctor` also prints advice that is not an error: most usefully, a `d1` or `sqlite` command that
never mentions the sandbox's state directory.

</details>

## Adding a service, end to end

1. **Declare it.** One line under `backends.services`, inheriting the defaults:

   ```yaml
   backends:
     services:
       - { name: api, port: 8001, label: api }
       - { name: search, port: 8005, label: search }   # new
   ```

   Pick a port nothing else in the sandbox uses.

2. **Route to it, if an app calls it.**

   ```yaml
   routes:
     app:
       "/api/search": search
       "/api": api
   ```

   More specific prefix first, or `/api` swallows it.

3. **Give it any credentials it needs.** Add its `.env` to `secrets.read` and its variable names
   to `secrets.keep`. Nothing that describes *where* something runs — it will be told that by the
   `env` block.

   ```bash
   sandboxr secrets import
   ```

4. **Bring the sandbox up again.** This replaces the container and keeps its volumes, so the
   database survives.

   ```bash
   sandboxr up
   sandboxr logs feat-123 -f
   ```

5. **Check it.** `https://feat-123.search.acme.sbx.localhost/health` for its own hostname, or
   `https://feat-123.app.acme.sbx.localhost/api/search/...` through the route.

6. **Commit the config with the service.** They belong in one commit. That is the entire reason
   this file lives in your repository rather than in sandboxr's.

## Two complete examples

- [A MySQL monorepo](./example-monorepo.md) — several Go services, several single-page
  apps, a static site generator, a component library, an optional CMS. The hard case.
- [A Cloudflare Workers project on D1](./example-workers.md) — the easy case, and much
  cheaper to run.

For a flat lookup table of every field in one place, see
[the config schema reference](../reference/config-schema.md).
