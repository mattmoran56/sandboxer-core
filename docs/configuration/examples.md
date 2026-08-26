---
title: Two worked examples
description: A MySQL monorepo, and a Worker on D1 — the hard case and the easy one, with the reasoning in the comments.
sidebar:
  order: 4
---

Both live in `examples/` in the repository and are copied here as they are. `acme` and `demo` are
fictional projects used throughout these pages.

| | The monorepo | The Worker |
|---|---|---|
| Database | MySQL 8.4, seeded from a running container or a dump | D1 — a file |
| Backends | three Go services | none: the worker *is* the app |
| Front-ends | two SPAs, a static site, a component library, a CMS dev server | one served app |
| Startup | tens of seconds | close to instant |
| Ways it goes wrong | disk, character sets, grants, replication state | one: two writers |

## A MySQL monorepo

The hard case. If the schema can express this project, it can express most.

```yaml
project: acme
sandboxr: ">=0.1.0"

database:
  driver: mysql
  # Not the version a developer happens to run locally. A migration is only meaningfully
  # tested against the version it will really run on, so declare the one production uses.
  version: "8.4"
  seed_from:
    # On a laptop: fork a database container the developer already runs. Read-only — every
    # destructive operation targets a copy.
    local:
      container: acme_db
      database: acme
    # On a server: restore a dump instead. Must be anonymised if apps are public.
    file: /var/sandboxr/seeds/acme.sql.zst
    # Applied after migrations. Non-fatal: a fixture that no longer matches the schema is
    # a useful signal, not a reason to refuse to start.
    fixtures: db/seeds/fixtures.sql
  migrate:
    workdir: services
    command: go run ./cmd/migrate --dir ../db/migrations --non-interactive
    # An empty `since` selects every file on disk. If a project adopted migration tracking
    # part-way through its life, the files that predate it will fail on columns that
    # already exist — so pin the cutoff the project's own runner uses.
    since: "20240101"

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
  # `npx vite build` rather than `npm run build`, which is typically `tsc -b && vite build`:
  # a branch that does not typecheck still needs a sandbox, and CI is what enforces types.
  defaults:
    build: npx vite build
    out: dist
  apps:
    - { label: app, package: web }
    - { label: admin, package: admin }
    # A static export of a few thousand pages. At the default limit it is killed part-way
    # through, which npm reports only as "code 137" with no mention of memory.
    - { label: www, package: marketing, build: npm run build, out: out, memory: 6g }
    # A component viewer rather than an app under test, and it costs about as much as all
    # the SPAs together — so it is excluded from "build everything".
    - { label: storybook, package: storybook, build: npm run build-storybook, out: storybook-static, in_build_all: false }
    # A long-running server rather than a static build, and opt-in because a live dev
    # server is the heaviest thing in a sandbox.
    - { label: cms, package: cms, serve: npx next dev --port 3000 --hostname 127.0.0.1, port: 3000, optional: true }

# Same-origin paths rather than absolute URLs, which keeps each bundle free of cross-origin
# requests and takes CORS out of the picture entirely.
routes:
  app:
    "/api": api
    "/cms": cms
  admin:
    # adminApi, not api: every path the admin app requests is an /admin/* route, which the
    # public API does not serve.
    "/api": adminApi

secrets:
  read:
    - services/api/.env
    - web/packages/web/.env
  keep: [AUTH0_DOMAIN, AUTH0_CLIENT_ID, AUTH0_CLIENT_SECRET, JWT_SECRET, MAPS_API_KEY]
  rename:
    # The same value with two spellings across a codebase. Alias rather than duplicate.
    ANALYTICS_API_HOST: ANALYTICS_ENDPOINT
    # Browser-side identity settings kept under their own names. They are genuinely allowed
    # to differ, and mixing the two makes one service reject the other's token as an invalid
    # issuer: login succeeds and every API call comes back 401.
    VITE_AUTH0_DOMAIN: SANDBOXR_AUTH0_SPA_DOMAIN
    VITE_AUTH0_CLIENT_ID: SANDBOXR_AUTH0_SPA_CLIENT_ID
  never:
    # Anything describing WHERE something runs. A sandbox computes these itself; importing
    # them would point it at the developer's own database or at real cloud storage.
    - "DB_*"
    - "MYSQL_*"
    - "S3_*"
    - "*_URL"
    - "PORT"

storage:
  driver: minio
  buckets: [uploads, avatars, exports]

toolchain:
  go: "1.23"
  node: "22"

access:
  apps: public
  controls: password

# The environment every process gets. `${SANDBOXR_*}` placeholders are substituted with
# values the sandbox computes for itself, so nothing here can point at a real service.
env:
  DB_HOST: "${SANDBOXR_DB_HOST}"
  DB_PORT: "${SANDBOXR_DB_PORT}"
  DB_NAME: "${SANDBOXR_DB_NAME}"
  DB_USER: "${SANDBOXR_DB_USER}"
  DB_PASSWORD: "${SANDBOXR_DB_PASSWORD}"
  S3_ENDPOINT: "${SANDBOXR_S3_ENDPOINT}"
  S3_BUCKET: uploads
  VITE_API_URL: /api
  VITE_APP_URL: "${SANDBOXR_URL_APP}"
```

## A Worker on D1

The easy case, and the one that actually runs end to end today. A D1 database is a file, so there
is no server to install, no dump to restore, no version skew and no advisory lock.

```yaml
project: demo
sandboxr: ">=0.1.0"

database:
  driver: d1
  seed_from:
    # No `file:` here on purpose. A fresh checkout has no `.wrangler/state`, so this
    # sandbox starts from an empty database, runs the project's own migrations, and then
    # applies these fixtures.
    fixtures: seeds/fixtures.sql
  migrate:
    # wrangler resolves wrangler.jsonc from the working directory, so it has to run in
    # the project root rather than the isolated empty directory used by default.
    workdir: .
    # The project's own runner, never reimplemented. `--persist-to` is what points
    # wrangler at the sandbox's state directory instead of the worktree.
    command: npx wrangler d1 migrations apply demo --local --persist-to "$SANDBOXR_D1_DIR"
  # A D1 database admits one writer, so exactly one service may open it.
  owner: app

# No backends. The worker *is* the app: a long-running dev server, on its own hostname.
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

The fixtures use fixed ids and `INSERT OR IGNORE`, because the container applies them on every
boot and a plain `INSERT` would grow a pile of duplicates.

## Related

- [sandboxr.yaml, field by field](sandboxr-yaml.md)
- [Databases](../databases.md)
- [Three runtime kinds](runtime-kinds.md)
