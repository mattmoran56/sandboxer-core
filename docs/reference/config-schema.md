---
title: Config schema
description: Every field sandboxr.yaml accepts, in tables — type, whether it is required, its default, its pattern, and the cross-field rules that are checked after parsing.
sidebar:
  order: 3
---

> **Partly verified** — The schema is `packages/core/src/config/schema.ts` and it has unit tests, as do the cross-field checks. No config has yet been loaded as part of a sandbox that actually started.

This is the lookup page: every field, what it accepts, and what happens if you leave it out.
It is deliberately dry. The version with reasoning and worked examples is
[sandboxr.yaml, field by field](../configuration/sandboxr-yaml.md).

Two things are worth knowing before you read a single table.

**Every object is strict.** A key sandboxr does not recognise is an error naming that key, not
a setting that quietly does nothing. So a typo in `sandboxr.yaml` fails immediately and tells
you exactly where — which, in a file that decides what a sandbox serves, is much better than
finding out from a browser three hours later.

**Two blocks accept two shapes.** `backends` and `frontends` can be written as a mapping with a
`defaults:` block, or as a plain list when there is nothing to default:

```yaml
# The mapping form. Canonical, because a `defaults:` block cannot legally sit
# inside a YAML list.
backends:
  defaults:
    workdir: services
    build: go build -o {out} ./{name}
  services:
    - { name: api, port: 8001, label: api }

# The list form. Identical meaning, for a project with nothing to default.
backends:
  - { name: api, port: 8001, label: api, build: go build -o {out} ./api }
```

The authoritative source is `packages/core/src/config/schema.ts`. Where this page and that file
disagree, the file wins.

## Shared value types

Four patterns recur across the schema. Each is checked at parse time.

| Type | Rule | Why |
|---|---|---|
| Project name | `^[a-z0-9]([a-z0-9-]*[a-z0-9])?$` | It becomes part of a hostname, a container name and every volume name. |
| Hostname label | `^[a-z0-9]([a-z0-9-]*[a-z0-9])?$`, at most **63** characters | It is one label of a DNS name, and 63 is the DNS limit. |
| Port | Integer, **1–65535** | |
| Memory | `^[0-9]+(b\|k\|m\|g)?$`, case-insensitive — e.g. `6g`, `512m` | A Docker memory limit. A bare number is bytes. |

## Top level

| Field | Type | Required | Default |
|---|---|---|---|
| `project` | Project name | **yes** | – |
| `sandboxr` | string — a semver range, e.g. `">=0.1.0"` | **yes** | – |
| `database` | object | no | driver `none` |
| `backends` | mapping or list | no | none |
| `frontends` | mapping or list | no | none |
| `routes` | mapping | no | empty |
| `secrets` | object | no | empty lists |
| `storage` | object | no | driver `none` |
| `deps` | object | no | – |
| `toolchain` | object | no | – |
| `access` | object | no | see [`access`](#access) |
| `env` | mapping of name to string | no | empty |

`sandboxr` is a version range, and it is required. The tool checks its own version against it
while reading the file, so a project that needs a newer sandboxr says so as a clear error
rather than failing somewhere further in.

## `database`

| Field | Type | Required | Notes |
|---|---|---|---|
| `driver` | `mysql` \| `d1` \| `sqlite` \| `none` | **yes**, if `database` is present | Picks the whole implementation. |
| `version` | string or number | no | For `mysql`, the server version to restore **into** — the one production runs, not the one the developer happens to have. |
| `owner` | string | conditionally — see below | For a file-backed driver, the one service allowed to open the file. |
| `seed_from` | object | no | Omit for a project whose migrations build the schema from nothing. |
| `migrate` | object | no | |

A driver other than `none` must have **at least one** of `seed_from` and `migrate`. A database
with neither has nothing to do, and that is an error rather than an empty sandbox.

### `database.seed_from`

| Field | Type | Required | Notes |
|---|---|---|---|
| `local.container` | string | yes, within `local` | A database container on this machine to copy from. **Read only, always.** |
| `local.database` | string | no | The database inside that container. |
| `file` | string (path) | no | A dump to restore, or a state directory for a file-backed driver. |
| `fixtures` | string (path) | no | SQL applied **after** migrations. A failure here is reported and non-fatal. |
| `anonymised` | boolean | no | Asserts that `file` holds a dump with no real personal data in it. |

`anonymised: true` is an assertion by whoever wrote the config, not something sandboxr can
verify — and it is the only thing that lets a **public** project restore a dump at all. A
`fixtures` seed is safe by definition. A `local` seed can never satisfy the requirement,
because a copy of a live database is by definition live data.
[Public sandboxes](../security/public-sandboxes.md).

### `database.migrate`

| Field | Type | Required | Notes |
|---|---|---|---|
| `command` | string | **yes**, if `migrate` is present | The project's own migration command. sandboxr shells out to it and never reimplements it. |
| `workdir` | string (path) | no | Where to run it, relative to the repository root. |
| `since` | string or number | no | Exported as `SANDBOXR_MIGRATE_SINCE`. **Your command has to reference it** — it is not a flag sandboxr adds. |
| `failure_pattern` | string (regex) | no | Treat output matching this as a failure even when the runner exits zero. |
| `file_pattern` | string (regex) | no | How to pull the failing migration's filename out of the output. |
| `error_pattern` | string (regex) | no | How to pull the error text out of the output. |

The three patterns are passed through untouched. Every runner prints something different, and
a per-project parser guessing at the format is exactly what these avoid.

## `backends`

A backend is something built to a binary and kept running, holding a port. Written either as
`{ defaults, services }` or as a bare list of entries.

| Field | Where | Type | Required | Default |
|---|---|---|---|---|
| `defaults` | block | object of the entry fields below, minus `name`, `port` and `label` | no | – |
| `services` | block | list of entries | **yes**, in the mapping form | – |
| `name` | entry | string | **yes** | – |
| `port` | entry | Port | **yes** | – |
| `label` | entry | Hostname label | **yes** | – |
| `build` | entry or defaults | string | **yes**, from one or the other | – |
| `workdir` | entry or defaults | string (path), relative to the repository root | no | – |
| `health` | entry or defaults | string (path) | no | – |
| `memory` | entry or defaults | Memory | no | – |
| `optional` | entry or defaults | boolean | no | `false` |

`port` is internal to the sandbox — nothing is published to the host. `name` is the identity a
backend has in `reload --go` and in `routes`. `label` is its hostname component; two runtimes
may not share one.

## `frontends`

A front-end is either **built into a directory and served as files**, or a **long-running
process** that serves itself. Which one it is comes from whether it has `out:` or `serve:`.
Written either as `{ root, defaults, apps }` or as a bare list of entries.

| Field | Where | Type | Required | Default |
|---|---|---|---|---|
| `root` | block | string (path) | no | the repository root |
| `defaults` | block | object of the entry fields below, minus `label` and `package` | no | – |
| `apps` | block | list of entries | **yes**, in the mapping form | – |
| `label` | entry | Hostname label | **yes** | – |
| `package` | entry | string (path), relative to `root`; `.` is the root | **yes** | – |
| `build` | entry or defaults | string | **yes** for a built app | – |
| `out` | entry or defaults | string (path) | one of `out` / `serve` | – |
| `serve` | entry or defaults | string | one of `out` / `serve` | – |
| `prepare` | entry or defaults | string | no | – |
| `health` | entry or defaults | string (path) | no | – |
| `port` | entry or defaults | Port | **yes** for a served app | – |
| `memory` | entry or defaults | Memory | no | – |
| `static_mode` | entry or defaults | `spa` \| `html` \| `files` | no | `spa` |
| `in_build_all` | entry or defaults | boolean | no | `true` |
| `optional` | entry or defaults | boolean | no | `false` |

- `out` and `serve` are **mutually exclusive**. Declaring both is an error.
- `prepare` and `health` apply only to a served app; a built directory has no process to
  prepare or probe.
- `in_build_all: false` excludes the app from `reload --web all`. Use it for something
  expensive and consulted occasionally, like a component-library viewer.
- `optional: true` means the app starts only when `up --with <label>` asks for it.

<details>
<summary><b>Details for an agent:</b> how an entry's kind is decided, including the case where defaults would get it wrong</summary>

The entry decides its own kind **before** defaults are consulted, in this order:

1. The entry has `serve:` → **server**.
2. The entry has `out:` → **static**.
3. `defaults` has `out:` → **static**.
4. `defaults` has `serve:` → **server**.
5. Neither → **static**, which then fails for having no `out`.

Steps 1 and 2 come before 3 and 4 deliberately. An app declared with `serve:` under a
`defaults: { out: dist }` must not inherit an output directory it has no build to fill —
otherwise it is silently treated as a static app with an empty `dist`, and serves nothing.

Once the kind is known, only the fields belonging to that kind are read. A static app takes
`build` and `out`; a served app takes `serve`, `prepare`, `health` and `port`, and never
inherits a `build` or an `out` from defaults.

Code: `resolveFrontends()` in `packages/core/src/config/load.ts`.
[The three runtime kinds](../configuration/runtime-kinds.md).

</details>

## `routes`

Maps a path prefix on one app's hostname to the service that should answer it. This is what
keeps a front-end's API calls same-origin, which takes CORS out of the picture entirely.

```yaml
routes:
  app:                    # a frontends label
    "/api": api           # a backends name, or a served front-end's label
    "/cms": cms
  admin:
    "/api": adminApi
```

| Level | Type | Rule |
|---|---|---|
| Outer key | Hostname label | Must be the `label` of a declared front-end. |
| Inner key | string | Must start with `/`. |
| Value | string | Must be a declared backend `name`, or the `label` of a front-end that has `serve:`. |

Prefixes match **most-specific-first**, so `"/api/admin"` has to be declared before `"/api"` or
`/api` swallows it. A wrong name here would otherwise be a 404 in a browser with nothing in any
log, so both sides are checked while the config is read.

## `secrets`

Which of the project's own `.env` files to read, and what may come out of them.

| Field | Type | Required | Default |
|---|---|---|---|
| `read` | list of paths, relative to the repository root | no | empty |
| `keep` | list of names — an allowlist | no | empty |
| `rename` | mapping, `from: to` | no | empty |
| `never` | list of glob patterns — a denylist, applied last | no | empty |

Anything describing *where* something runs belongs in `never`. Values are never printed or
logged; an import reports a count and a list of names.
[Secrets, in full](../configuration/secrets.md).

## `storage`

| Field | Type | Required | Default |
|---|---|---|---|
| `driver` | `minio` \| `none` | **yes**, if `storage` is present | – |
| `buckets` | list of names | no | empty |

Object storage inside the sandbox, so an upload in a sandbox never reaches a real bucket. The
buckets are created at first boot.

## `deps`

The project's Node dependency tree, when it has one. Named rather than guessed, because the
directory holding the lockfile is not always the directory holding the packages, and the shared
dependency volume is mounted at exactly one path.

| Field | Type | Required | Default |
|---|---|---|---|
| `root` | string (path) | **yes**, if `deps` is present | – |
| `lockfile` | string (path) | no | `package-lock.json` |
| `install` | string | no | `npm ci --no-audit --no-fund` |

The lockfile is hashed, and that hash names the volume the dependencies live in — so every
sandbox with the same dependencies shares one install, and a branch that changes its
dependencies transparently gets its own.

## `toolchain`

| Field | Type | Required | Default |
|---|---|---|---|
| `go` | string or number | no | – |
| `node` | string or number | no | – |

These belong to the per-project image layer: the thin layer on top of the shared base image
holding exactly what one project needs.

> [!WARNING] Nothing builds that layer yet
> `container/project/Dockerfile.template` exists and describes the layer these fields fill in.
> **No code renders or builds it**, and there is no `sandboxr` command that does. A sandbox runs
> `sandboxr/base:latest` today, or whatever `SANDBOXR_IMAGE` points at.
> [What is built](./status.md).

## `access`

| Field | Type | Required | Default |
|---|---|---|---|
| `apps` | `public` \| `private` | no | `public` |
| `controls` | `password` | no | `password` |
| `credentials` | `dummy` \| `real` | no | `dummy` |

- **`apps`** decides whether the sandbox's own app hostnames need a login. `public` is the
  default because the point of a sandbox URL is to be sendable to somebody.
- **`controls`** is the *only* value it can take. Everything that controls a sandbox is behind
  a password, always, and that is not configurable away. [The two tiers](../security/two-tiers.md).
- **`credentials: real`** is the explicit opt-in for real third-party credentials reaching a
  public sandbox. Left at `dummy`, anyone who can drive a public app could otherwise make it
  send real email or spend real credit.

## `env`

The mapping from sandboxr's own variable names to the project's own names.

```yaml
env:
  DB_HOST: "${SANDBOXR_DB_HOST}"
  S3_BUCKET: uploads
  VITE_APP_URL: "${SANDBOXR_URL_APP}"
```

| Side | Rule |
|---|---|
| Key | Must match `^[A-Za-z_][A-Za-z0-9_]*$` — a legal environment-variable name. |
| Value | Any string. `${...}` placeholders are substituted; a literal is passed through. |

The sandbox computes *where* everything is and exports it under `SANDBOXR_` names; the
project's code reads its own names for the same things. Only the project knows its own
spelling, so it says so here. Substitution is done with `envsubst`, which expands `${...}` and
**does not run a shell**, so a value is always data and can never become a command.
[Every variable available](./environment.md).

## Rules checked after parsing

The schema catches a wrong type or an unknown key. These are the rules that need more than one
field to check, and they are all errors at load time, naming the field.

| Rule | Message you get |
|---|---|
| The running tool satisfies `sandboxr:` | `needs sandboxr >=0.2.0, and this is 0.1.0 — upgrade the tool, or relax the constraint` |
| A driver other than `none` has a seed or a migration | `a driver with neither a seed nor a migration has nothing to do` |
| Every backend has a `build`, from itself or defaults | `has no build command, and backends.defaults sets none` |
| No front-end declares both `out` and `serve` | `is both a static build (out) and a server (serve) — pick one` |
| Every static front-end has an `out` and a `build` | `needs an out directory or a serve command` |
| Every served front-end has a `port` | `is a server, so it needs the port it listens on` |
| No two runtimes share a `label` | `label "app" is already used by frontend app` |
| No two backends share a `name` | `two backends are called "api"` |
| Every `routes` key names a declared front-end | `no front-end is labelled "wwww"` |
| Every `routes` target is a backend or a served front-end | `"api2" is neither a backend nor a served front-end` |
| A `d1` or `sqlite` project with more than one runtime names an `owner` | `a d1 database admits one writer, so it must name the service that owns it` |
| That `owner` is a declared runtime | `"api" is not a declared backend or front-end` |
| A `public` project's seed is safe | `a public sandbox may only restore a dump that is explicitly marked anonymised` |

<details>
<summary><b>Details for an agent:</b> what the public-sandbox refusal accepts, and the one command that bypasses the check</summary>

`access.apps: public` is a refusal to start, not a warning. `publicAccessViolations()` in
`packages/core/src/config/access.ts` permits exactly:

| Seed | Public project | Private project |
|---|---|---|
| `fixtures` | permitted | permitted |
| `file` with `anonymised: true` | permitted | permitted |
| `file` without the flag | **refused** | permitted |
| `local` (a copy of a running database) | **refused** | permitted |

The refusal names the field and states the fix — add `fixtures`, mark the dump
`anonymised: true`, or set `access.apps: private`.

Only `sandboxr up` enforces it. Read-only commands load the config with the check off, so
`sandboxr config` and `sandboxr doctor` can still tell you what is wrong with a config that
would be refused. `up` is the command that decides to *start* something, so it is where the
refusal belongs. [Public sandboxes](../security/public-sandboxes.md).

</details>

## Substitutions

| Token | Available in | Expands to |
|---|---|---|
| `{name}` | `backends.*.build` | The service's `name` |
| `{out}` | `backends.*.build` | The path the built binary should be written to |
| `${SANDBOXR_*}` | `env` values | Whatever the sandbox computed for that name |
| `$SANDBOXR_MIGRATE_SINCE` | `database.migrate.command` | The value of `migrate.since` |
| `$SANDBOXR_D1_DIR` | `migrate.command`, `apps[].serve` | The sandbox's own database state directory. **Required** for `d1` and `sqlite`. |

`{name}` and `{out}` are substituted only with values matching
`^[A-Za-z0-9._/@-]+$`; anything else is refused, so a config value can never turn into shell
syntax.

## Complete examples

- [A MySQL monorepo](../configuration/example-monorepo.md) — most of this page, in use at once.
- [Workers on D1](../configuration/example-workers.md) — the smallest config that is useful.
