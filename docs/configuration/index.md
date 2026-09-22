---
title: Build your config, step by step
description: Start from an empty file and add one block at a time, until your project can run in a sandbox.
---

This page builds a `sandboxer.yaml` from nothing. Each step adds one block, says what that
block buys you, and says what breaks if you leave it out. By the end you have a working
config you understand.

```prompt
Write a sandboxer.yaml for this project.

Read docs/configuration/index.md, then docs/configuration/rules.md, then work through
the steps in order. Inspect the repository to find the real build commands, ports and
package directories — do not guess them. Show me the file after each block you add and
tell me what it buys.

Stop and ask me if: the project has a database and you cannot tell which engine; a
front-end has no build command you can find; or the project keeps secrets in .env files
and you cannot tell which of them are third-party credentials.
```

The file lives at the root of the project you want to sandbox — not in sandboxer's own
repository. It is committed with that project's code, so a branch that adds a service adds
it to the config in the same commit.

> [!TIP] Check the file as you go
> `sandboxer config` reads the config, resolves it, and prints what it resolved to. It
> creates nothing. Every error names the file and the field, so a mistake is a sentence
> rather than a puzzle.

## Step 1: say who you are

Two lines. Both are required, and nothing else is.

```yaml
project: acme
sandboxer: ">=0.1.0"
```

`project` is the project's name. It goes into every
[hostname](../reference/glossary.md), every container name and every volume name, so it
uses the hostname alphabet: lowercase letters, digits and dashes.

`sandboxer` is the minimum version of the tool this file needs. It exists so that a config
using a newer field fails with a sentence about versions rather than a confusing schema
error.

**What this buys you.** A sandbox that starts. The container comes up with your worktree
mounted inside it and nothing running. That is genuinely useful once — for checking the
plumbing — and useless after that.

**What breaks without it.** Both fields are required, so the config is refused. Leave out
`sandboxer` and the error names `sandboxer` as the missing field.

<details class="agent">
<summary><b>Details for an agent</b> — the two required fields, exactly</summary>

`project` must match `^[a-z0-9]([a-z0-9-]*[a-z0-9])?$`. `sandboxer` must be a non-empty
string and a parseable constraint: the accepted comparators are `>=`, `<=`, `>`, `<`, `^`,
`~` and `=`; a space or a comma between terms means AND; `||` separates alternatives; `*`
or an empty string accepts anything.

Every object in the schema is a Zod `strictObject`. A misspelled key is an error naming
the key, never a setting that silently does nothing.

The file may be called `sandboxer.yaml`, `sandboxer.yml` or `.sandboxer.yaml`, tried in that
order. See [The rules a config must obey](rules.md) for where the file is looked for.

</details>

## Step 2: add a front-end

Most projects have something with a user interface. Declare it under `frontends`, and it
gets a hostname of its own.

```yaml
project: acme
sandboxer: ">=0.1.0"

frontends:
  root: web/packages
  defaults:
    build: npx vite build
    out: dist
  apps:
    - { label: app, package: web }
```

Three things are happening here.

`root` says where the front-end packages live, relative to the repo root. `package` is one
package inside it — so this app's code is at `web/packages/web`.

`label` is the app's own name in a hostname. This app will answer on
`<slug>--app--acme.sbx.localhost`. The [hostname shape](../how-it-works.md) is explained
elsewhere; here it is enough to know that the label is the part you choose.

`defaults` applies to every app in the list, so a project with six apps that build the
same way says it once. `build` produces the files, and `out` is the directory they land in.

**What this buys you.** A URL that serves your app. sandboxer builds it, copies the output
where its file server can find it, and serves it.

**What breaks without a `build` or an `out`.** The config is refused, naming the app. A
static app needs both — one command to produce files, one directory to find them in.

> [!TIP] Point `build` at the bundler, not at the npm script
> A project's `npm run build` is often `tsc -b && vite build`. That means a branch that
> does not typecheck cannot be sandboxed at all — which is backwards, because a branch
> mid-refactor is exactly when you want to look at it. Call the bundler directly and let
> CI stay the thing that enforces types.

Nothing is built when the sandbox starts. Until you build it, the app's hostname answers
with a page saying so and naming the command. That is deliberate, and it is why a sandbox
comes up in seconds. See [The three runtime kinds](runtime-kinds.md).

## Step 3: add a backend

A backend is a program that listens on a port: an API, a compiled service, a worker with an
HTTP interface.

```yaml
backends:
  defaults:
    workdir: services
    build: go build -o {out} ./{name}
    health: /health
  services:
    - { name: api, port: 8001, label: api }
    - { name: adminApi, port: 8081, label: admin-api }
```

`name` is the service's own name. `port` is where it listens **inside** the container.
`label` is its hostname, exactly as a front-end's is.

In the build command, `{name}` becomes the service's name and `{out}` becomes the path the
binary has to land at. They are the only two placeholders.

`health` is a path the sandbox can request to ask "is this working", rather than only "is
the process alive". Without it, a service that started and immediately wedged still counts
as up.

**What this buys you.** A compiled service, built and supervised. If it exits, it starts
again.

**What breaks without a `build`.** The config is refused, naming the backend. There is no
default build command, because sandboxer has no way to guess how your project compiles.

### Let the app call the API on its own hostname

Your app and your API now have separate hostnames. A browser request from one to the other
is cross-origin, which brings preflight requests and cookie rules with it. `routes` removes
all of that.

```yaml
routes:
  app:
    "/api": api
  admin:
    "/api": adminApi
```

Now `/api/orders` on the app's own hostname reaches the `api` backend as `/orders`. The
prefix strips itself. Your code can say `/api` in every environment, and there is no CORS
to reason about.

<details class="agent">
<summary><b>Details for an agent</b> — how routes are matched and checked</summary>

The outer key must be a declared **front-end label**. The inner key must start with `/`.
The value must be a backend `name`, or the `label` of a front-end that runs as a server.
Both are checked when the config is read, because a typo here is a 404 in a browser with
nothing in any log.

Prefixes are emitted longest-first by the container's router generator, so the order you
write them in does not matter. Each prefix is stripped before proxying
(`uri strip_prefix`).

A backend's own hostname still exists and still works. `routes` is an addition, not a
replacement.

</details>

## Step 4: add a database

This is the block that makes a sandbox worth having. Each sandbox gets its own database, so
a branch with a migration in it can be run for real.

```yaml
database:
  driver: mysql
  version: "8.4"
  seed_from:
    local: { container: acme_db, database: acme }
    file: /var/sandboxer/seeds/acme.sql.zst
    fixtures: db/seeds/fixtures.sql
  migrate:
    workdir: services
    command: go run ./cmd/migrate --dir ../db/migrations --non-interactive
```

`driver` is one of `mysql`, `d1`, `sqlite` or `none`.

`version` is the version production runs — not the one you happen to have installed. A
migration is only meaningfully tested against the version it will really run on.

`seed_from` says where the data comes from. Listing several sources is normal: a laptop
forks a database container the developer already runs, a server restores a dump, and
neither source exists on the other machine. `fixtures` is a script applied after the
migrations, whichever source was used.

`migrate.command` is **your project's own migration runner**. sandboxer never reimplements
migration logic; it runs the command you give it.

**What this buys you.** A copy of real structure and real volume, per sandbox. Getting the
migration wrong costs one `sandboxer down`.

**What breaks without it.** Nothing, if the project has no database — leave the block out
and the driver is `none`, which costs nothing. But a `driver` other than `none` with
neither a seed nor a migration is refused: there would be nothing for the driver to do.

> [!IMPORTANT] A file-backed database needs an owner
> With the `d1` or `sqlite` driver the database is a single file, and two processes that
> open it deadlock. If your project declares more than one runtime, name the one that owns
> the database:
>
> ```yaml
> database:
>   driver: d1
>   owner: app
> ```
>
> Leave it out and the config is refused, with the list of names you could have used.
> [Databases](../databases.md) has the whole picture.

## Step 5: add `deps`

If your project installs Node packages, say where its lockfile is.

```yaml
deps:
  root: .
```

**What this buys you.** Every sandbox whose lockfile matches shares one install, in a
volume outside the worktree. So the second sandbox of a project skips the install
entirely, and a branch that changes its dependencies transparently gets its own copy.

**What breaks without it.** Less than you would think. sandboxer looks for a lockfile
itself — `package-lock.json`, then `pnpm-lock.yaml`, then `yarn.lock`, then `bun.lockb` —
in the repo root, then the first segment of `frontends.root`, then `frontends.root` itself.
Declare the block when the guess would be wrong, which is when the directory holding the
lockfile is not the directory holding the packages.

<details class="agent">
<summary><b>Details for an agent</b> — deps defaults and the search order</summary>

| Field | Required | Default |
|---|---|---|
| `root` | **yes** | — |
| `lockfile` | no | `package-lock.json` |
| `install` | no | `npm ci --no-audit --no-fund` |

An explicit `deps` block always wins; nothing is searched for. Absent it, the candidate
roots are `.`, the first path segment of `frontends.root`, then `frontends.root` in full.
Each candidate is tried against the four lockfiles in the order above, with the install
command that goes with each: `pnpm install --frozen-lockfile`,
`yarn install --immutable`, `bun install --frozen-lockfile`.

A project with no lockfile anywhere gets no dependency volume. That costs an install
rather than breaking.

</details>

## Step 6: add a `toolchain`

Say which language runtimes the project needs.

```yaml
toolchain:
  go: "1.23"
  node: "22"
```

Both are optional and both accept a string or a number. Both are prefixes: `24` picks the
latest 24.x.

**What this buys you.** A smaller image, and a build that works. These two fields decide
what goes into your project's image layer, so a Node-only project carries no Go compiler.

**What breaks without it.** A compiled backend has nothing to compile with. The build
fails inside the container with `go: command not found` in that service's log — a message
that never mentions the config. Declare `toolchain.go` for any project with a compiled
backend, and `toolchain.node` for anything that runs `npm`, `npx` or a bundler.

## Step 7: add `env`

The sandbox works out where everything is: its own database, its own object storage, its
own hostnames. It exports those under names beginning `SANDBOXER_`. Your project reads its
own names for the same things. `env` is the join between the two.

```yaml
env:
  DB_HOST: "${SANDBOXER_DB_HOST}"
  DB_NAME: "${SANDBOXER_DB_NAME}"
  DB_USER: "${SANDBOXER_DB_USER}"
  DB_PASSWORD: "${SANDBOXER_DB_PASSWORD}"
  VITE_API_URL: /api
  VITE_APP_URL: "${SANDBOXER_URL_APP}"
```

**What this buys you.** Your project's own code, unmodified, pointed at the sandbox's own
services.

**What breaks without it.** Your app starts and cannot find its database, because it is
looking for `DB_HOST` and nothing set it.

Nothing here can point at a real service, because the only values available are the ones
the sandbox computed for itself. Anything genuinely secret does not belong here — that is
[Secrets](secrets.md).

<details class="agent">
<summary><b>Details for an agent</b> — how substitution actually works</summary>

Keys must match `^[A-Za-z_][A-Za-z0-9_]*$`. Values are plain strings.

The map is carried into `plan.json` untouched. Substitution happens **inside the
container**, in `container/scripts/env.sh`, through `envsubst` — which expands `${...}`
against what the entrypoint already exported and against the project's mounted secrets file,
and **does not run a shell**. A value is data, never a command.

The map is expanded **last**, so a name it defines beats the same name in the secrets file.
That is worth knowing before you put a credential under a name this map also claims: nothing
fails, the variable has a value, and it is this one. See
[Environment variables](../reference/environment.md).

An unset name expands to the empty string rather than failing.

The full list of what a sandbox computes for itself is in
[Environment variables](../reference/environment.md).

</details>

## Step 8: decide who can see it

```yaml
access:
  apps: public
  controls: password
```

`apps: public` is the default, and usually what you want. The point of a sandbox is
sending somebody a link.

`controls: password` is the only accepted value, and there is no setting that removes it.
sandboxer itself serves no controls over http — it is a command-line tool — so the field is a
statement about whatever control plane the machine runs, for that control plane to keep. The
engine parses it and enforces nothing.

**What this buys you.** A link you can send to a designer or a product manager without
giving them an account on your machine.

**What breaks without it.** Nothing — the defaults are these. But `public` brings two hard
refusals with it, and they are the two most common reasons a first `up` stops:

1. A public project may not be seeded from a live database, and may only restore a dump
   that is explicitly marked `anonymised: true`.
2. A public project may not carry real third-party credentials unless it says
   `credentials: real`.

Both are refusals, not warnings, and both name the field and the way out.
[Access and security](../access.md) explains why.

## The finished file

```yaml
project: acme
sandboxer: ">=0.1.0"

database:
  driver: mysql
  version: "8.4"
  seed_from:
    local: { container: acme_db, database: acme }
    file: /var/sandboxer/seeds/acme.sql.zst
    fixtures: db/seeds/fixtures.sql
  migrate:
    workdir: services
    command: go run ./cmd/migrate --dir ../db/migrations --non-interactive

backends:
  defaults:
    workdir: services
    build: go build -o {out} ./{name}
    health: /health
  services:
    - { name: api, port: 8001, label: api }
    - { name: adminApi, port: 8081, label: admin-api }

frontends:
  root: web/packages
  defaults:
    build: npx vite build
    out: dist
  apps:
    - { label: app, package: web }
    - { label: admin, package: admin }

routes:
  app:
    "/api": api
  admin:
    "/api": adminApi

deps:
  root: .

toolchain:
  go: "1.23"
  node: "22"

access:
  apps: public
  controls: password

env:
  DB_HOST: "${SANDBOXER_DB_HOST}"
  DB_NAME: "${SANDBOXER_DB_NAME}"
  DB_USER: "${SANDBOXER_DB_USER}"
  DB_PASSWORD: "${SANDBOXER_DB_PASSWORD}"
  VITE_API_URL: /api
  VITE_APP_URL: "${SANDBOXER_URL_APP}"
```

Four things you have not met yet round out the schema. `secrets` says which of a project's
`.env` file entries may be imported into the one file that holds its credentials. `storage`
runs object storage inside the sandbox. A `frontends` entry can run as a server rather than
building to a directory. And `database` has driver-specific corners.

All four are in [the field-by-field reference](sandboxer-yaml.md).

<details class="failure">
<summary><b>If it goes wrong</b> — the errors a first config usually produces</summary>

| What you see | What it means |
|---|---|
| An error naming a field you did not write | A misspelled key. Every object is strict, so the error names the key it did not recognise |
| `label "app" is already used by …` | Two runtimes share a hostname label. One would be unreachable |
| `has no build command, and frontends.defaults sets none` | A static app needs a `build`, on the entry or in `defaults` |
| `is a server, so it needs the port it listens on` | An entry with `serve:` needs `port:` |
| `a d1 database admits one writer, so it must name the service that owns it` | Add `database.owner` |
| `needs sandboxer >=0.2.0, and this is 0.1.0` | Upgrade the tool, or relax the constraint |
| `a driver with neither a seed nor a migration has nothing to do` | Add `seed_from`, add `migrate`, or set `driver: none` |
| An app's hostname answers "has not been built in this sandbox" | Normal. Nothing is built at startup — run `sandboxer reload <slug> --web=<label>` |

Every one of these, with its exact wording and its cause, is on
[The rules a config must obey](rules.md).

</details>

**Next:** [The rules a config must obey](rules.md) collects every constraint and the
symptom you see when you break it. [sandboxer.yaml, field by field](sandboxer-yaml.md) is
the complete reference for everything this page skipped.
