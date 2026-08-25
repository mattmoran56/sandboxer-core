---
title: "Example: a MySQL monorepo"
description: A walkthrough of the acme config — three Go services on MySQL, five front-ends, object storage and a filtered set of credentials — and the decisions in it that are not obvious.
sidebar:
  order: 4
---

> **Written, never run** — This is the real file at examples/monorepo.sandboxr.yaml, and packages/core's tests check that it parses and resolves. No sandbox has ever been started from it.

This is the hard case. `acme` is a fictional project used throughout these docs, and it is
deliberately awkward: **three compiled services on MySQL, four front-ends built three different
ways, a fifth that is a live dev server, object storage, and a set of credentials that has to be
filtered before any of it runs.** If the config format can express this, it can express most
projects.

The file is `examples/monorepo.sandboxr.yaml` in the sandboxr repository. This page walks through
it; the whole annotated file is in the collapsed block at the bottom.

## What it declares, block by block

**The database is MySQL, pinned to 8.4.** The project ships a `migrate` command of its own, which
sandboxr shells out to and never reimplements, and a fixtures file that is applied afterwards.
Three seed sources are listed at once — fork a container, restore a dump, or just fixtures — and
which one is used depends on the machine and on the access rules.

**Three backends, sharing almost everything.** `api`, `adminApi` and `jobs` are one line each,
because `backends.defaults` carries the working directory, the build command and the health path
for all of them. `{name}` in `go build -o {out} ./{name}` is filled in per service.

**Four static front-ends and one server.** `app` and `admin` are ordinary bundled apps and inherit
everything from `frontends.defaults`. `www` is a static export of a few thousand pages and
overrides both its build and its memory. `storybook` is a component viewer with its own output
directory. `cms` is the odd one out: `serve:` rather than `out:`, so it is a live process rather
than a directory of files, and it is opt-in.

**Routes give each app a same-origin `/api`.** Three apps, two different services behind the same
prefix.

**The secrets block is longer than the backends block**, which is the correct proportion. It names
the files to read, the seven credentials worth importing, three identity settings that must be
renamed rather than merged, and six patterns that are refused whatever else the file says.

**Then object storage, toolchain versions, and the access setting** — three lines that decide
whether anybody outside the team can open a link to this sandbox.

## The decisions that are not obvious

### `version: "8.4"` is production's version, not the developer's

The fork is restored into 8.4 whatever the source container happens to be running. A laptop's
`mysql:latest` drifts, and it often resolves to a release line production will never run —
sometimes one that is already end-of-life. A migration tested against the wrong major version has
not really been tested.

### Three seed sources, and access decides which is even eligible

The comments in the file describe the intent — fork a live container on a laptop, restore a dump
on a server, fixtures as a floor. The tool tries them in the order `local`, `file`, `fixtures` and
takes the first that is both permitted and actually available here.

But this config also says `access.apps: public`, and a public sandbox **may only** be seeded from
fixtures or from a dump explicitly marked `anonymised: true`. As written, that leaves exactly one
eligible source: `fixtures`. The `local:` fork becomes reachable by setting `access.apps: private`,
and the dump by adding `anonymised: true` beside it.

That is the rule working, not a mistake — but it is worth seeing, because the comments in the file
read as if the fork happens by default and it does not.

### `npx vite build`, not `npm run build`

A project's own build script is usually `tsc -b && vite build`, so a branch that does not
type-check could not be sandboxed at all. Calling the bundler directly means a branch mid-refactor
still gets a running app, and CI stays the thing that enforces types. That is a deliberate
division of labour: a sandbox is for looking at behaviour.

### Three expensive apps, fenced off three different ways

| App | Field | Problem it solves |
|---|---|---|
| `www` | `memory: 6g` | A static export spreads across many worker processes, and the *total* is what the kernel kills. Under a smaller limit it dies part-way through and reports only exit code 137, which says nothing about memory. |
| `storybook` | `in_build_all: false` | It costs about as much to build as every other app together, and it is a component viewer rather than an app under test. Excluded from "build everything"; still refreshed by "rebuild what is already built". |
| `cms` | `optional: true` | A live dev server holds its whole module graph in memory for as long as the container lives, whether or not anybody opens it. |

Three different problems. None of them is "just performance", and none of the three fields would
do the other two's job.

> [!WARNING] `www` leaves `static_mode` at its default, and probably should not
> No entry in this file sets `static_mode`, so all four static apps are served as `spa` — every
> unknown path renders `index.html`. That is right for `app` and `admin`. For a site generator
> emitting `about.html` it means deep links quietly render the home page instead of the page you
> asked for, which is the classic half-working failure that mode exists to prevent. Check what your
> generator actually emits and set `html` if it emits extensions.
> [The three modes](./runtime-kinds.md).

### Two apps, the same prefix, two different services

```yaml
routes:
  app:
    "/api": api
  admin:
    "/api": adminApi
```

This is the normal case rather than an edge case. Getting it wrong sends the admin app's requests
to a service that never had those routes, and the 404s look exactly like a bug in the app.

### One service is missing on purpose

There is a comment where a fourth backend would go, saying why it is not there: it needs a
database that exists on no developer's machine and that no migration creates, so declaring it
would produce nothing but a permanent crash-loop and a red tile. Leaving the comment is what stops
somebody adding it back next quarter.

## The hostnames it produces

```
feat-123.api.acme.sbx.localhost          api
feat-123.admin-api.acme.sbx.localhost    adminApi
feat-123.jobs.acme.sbx.localhost         jobs
feat-123.app.acme.sbx.localhost          web
feat-123.admin.acme.sbx.localhost        admin
feat-123.www.acme.sbx.localhost          marketing
feat-123.storybook.acme.sbx.localhost    storybook
feat-123.cms.acme.sbx.localhost          cms — only with `sandboxr up --with cms`
```

Eight hostnames, one container, one database.

> [!WARNING] Nothing yet maps a hostname to a container
> Containers are labelled so that a machine-wide router could find them, but no code starts or
> configures one, and there is no command that installs DNS or a certificate. Reaching a sandbox by
> hostname is [not built yet](../reference/status.md); today a sandbox is reachable through
> `sandboxr shell` and the dashboard.

<details>
<summary><b>Details for an agent:</b> what this config would actually do on `sandboxr up` today, including the refusal it hits</summary>

Two things about the interaction between `access` and the rest of this file are worth having
straight, because they are refusals rather than warnings.

**Seeding.** `chooseSeed` filters the declared sources through the access rules before choosing.
With `apps: public` and a dump that is not marked anonymised, `fixtures` is the only survivor. If
the config had no `fixtures:` line, `up` would fail with a message naming §5.3 and both fixes.

**Credentials.** `access.credentials` is absent, so it defaults to `dummy`. The check in
`packages/core/src/sandbox/index.ts` is:

```
if a secrets file exists for this project, and the config does not allow real
credentials, refuse to start
```

It tests for the **existence of the file**, not for whether the values in it are real — the tool
cannot tell a dummy key from a live one. So once `sandboxr secrets import` has been run for
`acme`, this config as written refuses to start, and names both ways out: set
`access.credentials: real` and accept it, or set `access.apps: private`.

That is the design working as intended for a project with real Auth0 secrets in its `keep` list.
A public project that genuinely wants those credentials has to say so in the file.

</details>

<details>
<summary><b>Details for an agent:</b> the complete annotated file, exactly as it is in examples/monorepo.sandboxr.yaml</summary>

```yaml title="sandboxr.yaml"
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
    # On a server: restore a dump instead. Must be anonymised if apps are public (§5.3).
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
    # A service whose database exists on no developer machine, and that no migration
    # creates, should be left out rather than declared — otherwise it can only crash-loop.

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
    # A Next.js static export of a few thousand pages. At the default 2 GB limit it is
    # killed part-way through, which npm reports only as "code 137" with no mention of
    # memory — so declare what it actually needs.
    - { label: www, package: marketing, build: npm run build, out: out, memory: 6g }
    # A component library has no `build` script and emits no dist/: `storybook build`
    # renders a static site into storybook-static. Excluded from "build everything" — it is
    # a component viewer rather than an app under test, and it costs about as much as all
    # the SPAs together.
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
  www:
    "/api": api

secrets:
  read:
    - services/api/.env
    - services/adminApi/.env
    - web/packages/web/.env
  keep:
    - AUTH0_DOMAIN
    - AUTH0_AUDIENCE
    - AUTH0_CLIENT_ID
    - AUTH0_CLIENT_SECRET
    - ANALYTICS_API_KEY
    - ANALYTICS_ENDPOINT
    - EMAIL_API_KEY
    - MAPS_API_KEY
    - JWT_SECRET
  rename:
    # The same value sometimes has two spellings across a codebase: one name in the .env
    # files, another in the code that reads it. Alias rather than duplicate.
    ANALYTICS_API_HOST: ANALYTICS_ENDPOINT
    # Browser-side identity settings are kept under their own names rather than folded into
    # the server-side ones. They are genuinely allowed to differ — an identity provider can
    # serve one tenant on both a custom domain and a provider domain, and mixing the two
    # across services makes one reject the other's token as an invalid issuer: login
    # succeeds and every API call comes back 401.
    VITE_AUTH0_DOMAIN: SANDBOXR_AUTH0_SPA_DOMAIN
    VITE_AUTH0_CLIENT_ID: SANDBOXR_AUTH0_SPA_CLIENT_ID
    VITE_AUTH0_AUDIENCE: SANDBOXR_AUTH0_SPA_AUDIENCE
  never:
    # Anything describing WHERE something runs. A sandbox computes these itself; importing
    # them would point it at the developer's own database or at real cloud storage.
    - "DB_*"
    - "MYSQL_*"
    - "S3_*"
    - "*_URL"
    - "PORT"
    - "ENV"

storage:
  # Object storage inside the sandbox, so uploads never reach a real bucket.
  driver: minio
  buckets: [uploads, avatars, exports]

toolchain:
  go: "1.23"
  node: "22"

access:
  apps: public
  controls: password

# The environment every process in the sandbox gets. `${SANDBOXR_*}` placeholders are
# substituted with values the sandbox computes for itself — its own database, its own
# object storage, its own hostnames — so nothing here can point at a real service. Anything
# genuinely secret comes from the secrets block above instead, and never appears here.
env:
  DB_HOST: "${SANDBOXR_DB_HOST}"
  DB_PORT: "${SANDBOXR_DB_PORT}"
  DB_NAME: "${SANDBOXR_DB_NAME}"
  DB_USER: "${SANDBOXR_DB_USER}"
  DB_PASSWORD: "${SANDBOXR_DB_PASSWORD}"
  S3_ENDPOINT: "${SANDBOXR_S3_ENDPOINT}"
  S3_KEY: "${SANDBOXR_S3_KEY}"
  S3_SECRET: "${SANDBOXR_S3_SECRET}"
  S3_BUCKET: uploads
  # Same-origin paths, so a built bundle makes no cross-origin request.
  VITE_API_URL: /api
  VITE_APP_URL: "${SANDBOXR_URL_APP}"
  VITE_ADMIN_URL: "${SANDBOXR_URL_ADMIN}"
```

Two notes where the file's comments have drifted from the code:

- The comment on `www` says "the default 2 GB limit". The floor in
  `packages/core/src/sandbox/run.ts` is **4 GB**, and a sandbox's limit is the largest `memory:`
  any one of its runtimes asks for — so this config runs with a 6 GB limit throughout, not only
  during that build.
- There is no `deps:` block, so the Node dependency tree is found on disk: the repo root, then
  `web` (the first segment of `frontends.root`), then `web/packages`, for the first recognised
  lockfile.

</details>

## Compare with the easy case

[A Cloudflare Workers project on D1](./example-workers.md) is about twenty-five lines, has
no backends block at all, and its database is a file.
