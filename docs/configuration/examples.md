---
title: Worked examples
description: The three example configs in the repository, side by side — the demo, a Workers project, and a large monorepo.
---

The repository ships three real configs. This page compares them, so you can find the one
closest to your project and start from it. `acme`, `demo` and `worker-thing` are fictional
projects used throughout these pages.

```prompt
Pick the closest example config for this project and adapt it.

Read docs/configuration/examples.md, then open the example file it points at in the
sandboxer repository. Adapt it to this project by reading the project's own build scripts,
ports and package layout. Explain each change you make.

Stop and tell me if this project has a database engine none of the three examples uses.
```

| | `demo-worker/sandboxer.yaml` | `workers.sandboxer.yaml` | `monorepo.sandboxer.yaml` |
|---|---|---|---|
| Project | `demo` | `worker-thing` | `acme` |
| Database | D1, fixtures only | D1, seeded from a state directory | MySQL 8.4, forked or restored |
| Backends | none | none | three Go services |
| Front-ends | one served app | one served app | two SPAs, a static site, a component library, a CMS |
| Object storage | none | none | MinIO, three buckets |
| Secrets | none | one file, two names | three files, nine names, five renames |
| Startup | close to instant | close to instant | tens of seconds |
| Ways it goes wrong | one: two writers | one: two writers | disk, character sets, grants, replication state |
| Proven end to end | **yes** | no | no |

Only the demo has been run all the way through. See [What is built](../reference/status.md).

## The demo: `examples/demo-worker/sandboxer.yaml`

The cheapest thing sandboxer can run, and the fixture its end-to-end check uses. A Cloudflare
Worker on D1.

```yaml
project: demo
sandboxer: ">=0.1.0"

database:
  driver: d1
  seed_from:
    fixtures: seeds/fixtures.sql
  migrate:
    workdir: .
    command: npx wrangler d1 migrations apply demo --local --persist-to "$SANDBOXER_D1_DIR"
  owner: app

frontends:
  apps:
    - label: app
      package: .
      serve: npx wrangler dev --port 8787 --ip 127.0.0.1 --persist-to "$SANDBOXER_D1_DIR"
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
  SANDBOXER_SLUG: "${SANDBOXER_SLUG}"
  WRANGLER_SEND_METRICS: "false"
```

Four things to notice, because they are the ones you would copy.

**`package: .`** — the app is the repository itself. There is no `frontends.root`, so
`package` is relative to the repo root.

**`serve:` and `port:`, not `out:`** — the worker *is* the app, so this is a served
front-end rather than a static build. See [The three runtime kinds](runtime-kinds.md).

**`--persist-to "$SANDBOXER_D1_DIR"` in both commands** — this is what points wrangler at the
sandbox's own state directory instead of the worktree. Leave it out of either one and the
database lands in your branch.

**`owner: app`** — a D1 database admits one writer. `app` is the front-end label declared
below it.

This config is walked line by line, alongside the project's `wrangler.jsonc`, migration and
fixtures, on [Run the demo project](../getting-started/demo-project.md). Start there if you
want the teaching version rather than the comparison.

## A Workers project with data of its own: `examples/workers.sandboxer.yaml`

Almost the same shape, with three additions that a real Workers project needs.

```yaml
project: worker-thing
sandboxer: ">=0.1.0"

database:
  driver: d1
  seed_from:
    file: .wrangler/state
    fixtures: seeds/fixtures.sql
  migrate:
    command: npx wrangler d1 migrations apply DB --local --persist-to $SANDBOXER_D1_DIR
  owner: app

frontends:
  apps:
    - label: app
      package: .
      serve: npx wrangler dev --port 8787 --ip 127.0.0.1 --persist-to $SANDBOXER_D1_DIR
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

env:
  API_TOKEN: dummy
  APP_URL: "${SANDBOXER_URL_APP}"
```

**`seed_from.file: .wrangler/state`** is where the local Cloudflare runtime keeps its SQLite
files. That directory is normally gitignored, so a fresh worktree has nothing in it. sandboxer
snapshots from a checkout that *does* have content, and falls back to migrating an empty
database when it does not. An empty seed here is a normal state, not a failure.

**`secrets`** imports two names from `.dev.vars`, and refuses anything shaped like an
address. See [Secrets](secrets.md).

**`env: API_TOKEN: dummy`** is the other half of that. The project's apps are `public`, so
real credentials are refused — a harmless placeholder comes through `env` instead.

Note also `APP_URL: "${SANDBOXER_URL_APP}"`. Only the container knows both the slug and the
domain at the moment a build runs, so a slug-bearing URL has to come from a computed
variable.

## The hard case: `examples/monorepo.sandboxer.yaml`

A large monorepo on MySQL: several Go services, several Vite apps, a static site, a component
library and a CMS. If the schema can express this project, it can express most.

It is long, so here it is in pieces. The whole file is in the repository, with its reasoning
in the comments.

### The database

```yaml
database:
  driver: mysql
  version: "8.4"
  seed_from:
    local:
      container: acme_db
      database: acme
    file: /var/sandboxer/seeds/acme.sql.zst
    fixtures: db/seeds/fixtures.sql
  migrate:
    workdir: services
    command: go run ./cmd/migrate --dir ../db/migrations --non-interactive
    since: "20240101"
```

Three sources are listed on purpose. A laptop forks the container the developer already
runs; a server restores the dump; neither source exists on the other machine. Precedence is
`local`, then `file`, then `fixtures`.

`version: "8.4"` is the version production runs, not the one on anybody's laptop. `since`
pins the cutoff the project's own runner uses, because files predating its migration tracking
would fail on columns that already exist.

> [!WARNING] These apps are `public`, so two of those three sources are unusable
> A `public` project may not fork a live database, and may only restore a dump marked
> `anonymised: true`. This example lists both — and the config still loads, because a config
> is refused only when *none* of its sources is permissible, and `fixtures` is. What this
> project actually gets on a public machine is the fixtures. Force one of the other two with
> `sandboxer up --seed local` and it is refused at that point instead.
> [The rules a config must obey](rules.md#public-projects-the-two-refusals) has the table.

### The runtimes

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

frontends:
  root: web/packages
  defaults:
    build: npx vite build
    out: dist
  apps:
    - { label: app, package: web }
    - { label: admin, package: admin }
    - { label: www, package: marketing, build: npm run build, out: out, memory: 6g }
    - { label: storybook, package: storybook, build: npm run build-storybook, out: storybook-static, in_build_all: false }
    - { label: cms, package: cms, serve: npx next dev --port 3000 --hostname 127.0.0.1, port: 3000, optional: true }
```

Five front-ends, and each one shows a different field earning its place:

| Entry | What it demonstrates |
|---|---|
| `app`, `admin` | `defaults` doing all the work — two lines each |
| `www` | `memory: 6g`, because a static export of thousands of pages is otherwise killed with nothing but exit code 137 |
| `storybook` | `in_build_all: false`, because it costs about as much as all the SPAs together and is a component viewer rather than an app under test |
| `cms` | `serve:` and `optional: true` — the third runtime kind, and the heaviest thing in a sandbox |

The `defaults.build` is `npx vite build` rather than `npm run build`, which is typically
`tsc -b && vite build`. A branch that does not typecheck still needs a sandbox.

Note what is **not** there: a comment in the file marks the place where a service was
deliberately left out, because its database exists on no developer machine and no migration
creates it. Such a service can only crash-loop.

### The routes

```yaml
routes:
  app:
    "/api": api
    "/cms": cms
  admin:
    "/api": adminApi
  www:
    "/api": api
```

Same-origin paths rather than absolute URLs, which keeps each bundle free of cross-origin
requests and takes CORS out of the picture entirely.

`admin` points at `adminApi`, not `api`. Every path the admin app requests is an `/admin/*`
route, which the public API does not serve. Two apps can map the same prefix to different
services.

`"/cms": cms` shows the one case where a route target is not a backend: `cms` is a front-end
that runs as a server, so it has a port and can be proxied to.

### Secrets, storage and env

```yaml
secrets:
  read:
    - services/api/.env
    - services/adminApi/.env
    - web/packages/web/.env
  keep: [AUTH0_DOMAIN, AUTH0_AUDIENCE, AUTH0_CLIENT_ID, AUTH0_CLIENT_SECRET,
         ANALYTICS_API_KEY, ANALYTICS_ENDPOINT, EMAIL_API_KEY, MAPS_API_KEY, JWT_SECRET]
  rename:
    ANALYTICS_API_HOST: ANALYTICS_ENDPOINT
    VITE_AUTH0_DOMAIN: SANDBOXER_AUTH0_SPA_DOMAIN
    VITE_AUTH0_CLIENT_ID: SANDBOXER_AUTH0_SPA_CLIENT_ID
    VITE_AUTH0_AUDIENCE: SANDBOXER_AUTH0_SPA_AUDIENCE
  never: ["DB_*", "MYSQL_*", "S3_*", "*_URL", "PORT", "ENV"]

storage:
  driver: minio
  buckets: [uploads, avatars, exports]
```

The three browser-side `VITE_AUTH0_*` renames are the interesting part. They are kept under
their own names rather than folded into the server-side ones, because an identity provider
can serve one tenant on both a custom domain and a provider domain. Mix the two across
services and one rejects the other's token as an invalid issuer: login succeeds and every
API call comes back 401.

`never` catches the shape of an address rather than a list somebody remembered. The `env`
block then supplies every address from the sandbox's own computed values:

```yaml
env:
  DB_HOST: "${SANDBOXER_DB_HOST}"
  DB_PORT: "${SANDBOXER_DB_PORT}"
  DB_NAME: "${SANDBOXER_DB_NAME}"
  DB_USER: "${SANDBOXER_DB_USER}"
  DB_PASSWORD: "${SANDBOXER_DB_PASSWORD}"
  S3_ENDPOINT: "${SANDBOXER_S3_ENDPOINT}"
  S3_KEY: "${SANDBOXER_S3_KEY}"
  S3_SECRET: "${SANDBOXER_S3_SECRET}"
  S3_BUCKET: uploads
  VITE_API_URL: /api
  VITE_APP_URL: "${SANDBOXER_URL_APP}"
  VITE_ADMIN_URL: "${SANDBOXER_URL_ADMIN}"
```

`VITE_API_URL: /api` is a same-origin path, so a built bundle makes no cross-origin request
at all. The two `SANDBOXER_URL_*` values are for cross-app navigation, which does need an
absolute, slug-bearing URL.

<details class="agent">
<summary><b>Details for an agent</b> — the three files, and what each one exercises</summary>

| Path in the repository | Copy it to | Blocks it uses |
|---|---|---|
| `examples/demo-worker/sandboxer.yaml` | already in place; it is a runnable project | `database` (`d1`, fixtures, `migrate`, `owner`), `frontends` (served), `deps`, `toolchain`, `access`, `env` |
| `examples/workers.sandboxer.yaml` | the repo root, as `sandboxer.yaml` | the above plus `secrets`, and `seed_from.file` |
| `examples/monorepo.sandboxer.yaml` | the repo root, as `sandboxer.yaml` | every block the schema has except `deps` — `database` (`mysql`, three seed sources, `since`), `backends` with `defaults`, `frontends` with `root` and `defaults`, `routes`, `secrets` with `rename`, `storage`, `toolchain`, `access`, `env` |

The demo also ships `wrangler.jsonc`, `package.json`, `migrations/0001_create_notes.sql`,
`seeds/fixtures.sql` and `src/index.js`, so it is the only one of the three you can run
without adapting anything.

Its fixtures use fixed ids and `INSERT OR IGNORE`, because the container applies them on
every boot and a plain `INSERT` would grow a pile of duplicates.

Fields none of the three uses: `frontends.prepare`, `static_mode`,
`access.credentials`, `seed_from.anonymised`, `deps.lockfile`, `deps.install`, and
`migrate.failure_pattern` with its two companions. All of them are in
[sandboxer.yaml, field by field](sandboxer-yaml.md).

</details>

## Which one to start from

| Your project | Start from |
|---|---|
| A Cloudflare Worker, no data of your own yet | the demo |
| A Cloudflare Worker with local D1 state and secrets | `workers.sandboxer.yaml` |
| Anything with a compiled service, several apps, or MySQL | `monorepo.sandboxer.yaml` |
| Something in between | the demo, then add blocks with [Build your config, step by step](index.md) |

**Next:** [Run the demo project](../getting-started/demo-project.md) walks the first of
these line by line on a machine. [The rules a config must obey](rules.md) is what to read
before adapting the third.
