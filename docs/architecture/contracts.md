# Contracts

**This file is the single source of truth for every boundary in sandboxr.** Every package
depends on the names, shapes and paths below. If you need to change one, change it here
first and say so in the commit message — a package that disagrees with this file is a bug.

Read this before writing any code.

---

## 1. What sandboxr is

One container per git worktree, holding a whole project: its services, its front-ends, its
own database, its own file storage. Several run at once on one machine — locally or on a
remote server — each reachable in a browser at its own hostname.

Two audiences, and the split matters:

- **The apps** a sandbox serves are (by default) **public**. Someone who finds one sees a
  preview of unreleased features.
- **The controls** — the dashboard, the terminal, start/stop/rebuild/migrate — are **behind
  a password**. Always.

## 2. Repository layout

```
packages/core      @sandboxr/core     Config, drivers, docker orchestration, lifecycle
packages/cli       @sandboxr/cli      The `sandboxr` command
packages/server    @sandboxr/server   Web dashboard, auth, terminal, action streaming
packages/docs      @sandboxr/docs     The documentation site (MDX)
container/         (no package)       What runs INSIDE a sandbox: Dockerfiles, s6, scripts
examples/          (no package)       Example sandboxr.yaml files
```

Ownership rule: **only `container/` contains bash.** Everything host-side is TypeScript.
The container scripts are deliberately shell because they run under s6 with no toolchain
guarantees, and because they are ported from a working implementation.

## 3. Naming

### 3.1 Slug

A slug identifies one sandbox. Derived, in order of preference, from:

1. an explicit argument
2. a ticket-style id anywhere in the worktree directory name (`/[a-z]+-[0-9]+/i`)
3. that same pattern in the branch name
4. the branch name
5. the worktree directory name

Sanitising: lowercase, every character outside `[a-z0-9-]` becomes `-`, runs of `-`
collapse, leading and trailing `-` are stripped.

**Length ceiling is 31 characters.** Over that, keep the first 22 characters, append `-`
and the first 8 characters of the SHA-256 of the *raw* input.

> Why hashed rather than truncated: a slug ends up inside a database advisory lock name.
> Two long branch names often share a prefix, and truncation would let two sandboxes
> collide on one lock. This ceiling is load-bearing — do not raise it without checking
> the lock-name budget of every driver.

### 3.2 Hostnames

```
<slug>.<label>.<project>.<domain>      an app or api inside a sandbox
<domain>                               the dashboard (the control plane)
```

- `label` comes from the project's config (`frontends[].label`, `backends[].label`).
- `project` is `project` in the config file.
- `domain` is `SANDBOXR_DOMAIN`, default `sbx.lcl`.

Example: `feat-123.app.acme.sbx.lcl`

The dashboard lives on the bare domain and **never** on a per-sandbox hostname. The
terminal is a route *within* the dashboard (`/p/<project>/s/<slug>/terminal`), so it
inherits the dashboard's session automatically. Do not give the terminal its own hostname.

### 3.3 Docker names

- Container: `sandboxr-<project>-<slug>`
- Network: `sandboxr` (one, shared)
- Volumes: `sandboxr-<purpose>-<project>-<slug>` where purpose is one of
  `data` (database), `blob` (object storage), `bin` (built binaries), `www` (built sites).
- Shared volumes: `sandboxr-deps-<hash>` (node_modules, keyed on lockfile),
  `sandboxr-gocache`, `sandboxr-gomod`.

### 3.4 Container labels

State lives **only** in Docker labels. There is no manifest file, no database of sandboxes.
`list` and `gc` are pure functions of `docker ps`, so nothing can drift out of sync.

| Label | Meaning |
|---|---|
| `sandboxr.project` | project name from the config |
| `sandboxr.slug` | the slug |
| `sandboxr.branch` | branch name, or `?` if it cannot be resolved |
| `sandboxr.commit` | short commit sha |
| `sandboxr.dirty` | `true` / `false` — uncommitted changes present |
| `sandboxr.worktree` | absolute path on the host |
| `sandboxr.driver` | database driver in use |
| `sandboxr.created` | ISO 8601 UTC |
| `sandboxr.access` | `public` / `private` — whether app hostnames need auth |

**Labels hold durable state only.** Everything above is fixed when the sandbox is created
and does not change while it runs. Runtime state — whether it is starting, running or
degraded — is **derived at read time** from the container and its status surface, never
written back to a label. A label recording "running" would be a second source of truth that
goes stale the moment a process dies, which is exactly the drift this design avoids.

So `Sandbox.state` in §6 is computed, not stored: the container's own state, plus the
migration verdict the sandbox exposes. A failed migration deliberately leaves the container
running, so anything reading only the container's state will report a degraded sandbox as
healthy — the one case where it matters most.

## 4. Host paths

`SANDBOXR_HOME`, default `~/.sandboxr`. Never inside a repo, so `git clean` cannot destroy it.

```
~/.sandboxr/
  cache/                 database seed artifacts, content-addressed
  logs/<project>/<slug>/ per-sandbox logs, survive the container
  tls/                   certificate and key
  state/                 router config, dashboard session secret
  secrets/<project>.env  third-party credentials, mode 0600
  build/<project>/<slug>.env  the generated per-sandbox environment
  bin/                   host-built helper binaries
```

## 5. The config file: `sandboxr.yaml`

Lives at the **root of the project being sandboxed**, not in this repo. It is versioned
with that project's code, so a new service and its config land in the same commit.

The authoritative schema is `packages/core/src/config/schema.ts` (Zod). This section is
the human description; if the two disagree, the schema wins and this file gets fixed.

```yaml
project: acme                  # required, [a-z0-9-], used in hostnames
sandboxr: ">=0.1.0"            # minimum tool version; a mismatch is a clear error

database:
  driver: mysql                # mysql | d1 | sqlite | none
  version: "8.4"               # driver-specific
  seed_from:
    local:  { container: acme_db, database: acme }           # fork a running container
    file:   /var/sandboxr/seeds/acme.sql.zst                 # or restore a dump
    fixtures: db/migrations/seeds/fixtures.sql               # applied after migrations
  migrate:
    workdir: services
    command: go run ./cmd/migrate --env local --dir ../db/migrations
    since: "20260209"

backends:                      # long-running processes with a port
  - { name: api, port: 8001, label: api }
  - { name: adminApi, port: 8081, label: admin-api }
  defaults:
    build: go build -o {out} ./{name}
    workdir: services
    health: /health

frontends:                     # either built to a directory, or a long-running server
  - { label: app, package: web, out: dist }
  - { label: www, package: marketing, out: out, memory: 6g }
  - { label: cms, package: cms, serve: npx next dev --port 3000 }

routes:                        # path prefixes per app hostname -> backend name
  app:     { "/api": api }
  billing: { "/api/billing": billingApi, "/api": api }

secrets:
  read: [services/api/.env]
  keep: [AUTH0_DOMAIN, LLM_API_KEY]
  rename: { ANALYTICS_API_HOST: ANALYTICS_ENDPOINT }
  never: ["DB_*", "S3_*", "*_URL"]

toolchain: { go: "1.26.6", node: "24.18" }

access:
  apps: public                 # public | private
  controls: password           # password (only option today)
```

### 5.1 Three runtime kinds, not two

Everything a sandbox runs is one of:

| Kind | Declared as | How it runs | Served at |
|---|---|---|---|
| **backend** | `backends[]` | build once to a binary, supervised, listens on a port | `<slug>.<label>...` proxied |
| **static** | `frontends[]` with `out:` | build on demand into a directory | `<slug>.<label>...` file server |
| **server** | `frontends[]` with `serve:` | long-running process, listens on a port | `<slug>.<label>...` proxied |

The third kind is what Cloudflare Workers projects need (`wrangler dev`). Do not collapse
it into the other two.

**Static builds are on demand, never at startup.** A sandbox must come up in seconds; an
app that has not been built yet answers with a page saying which command to run.

### 5.2 Secrets rules

- **Names only, never values, are ever printed or logged.** The import reports a count and
  a list of names, so it is safe to run with someone watching.
- Anything describing *where* something runs — `DB_*`, object storage, inter-service URLs —
  is **never** imported. A sandbox computes those itself. Importing them would point a
  sandbox at the developer's own database or at real cloud storage.
- `rename` exists because the same value legitimately has two names in different files, and
  because some pairs must **not** be merged (a browser-side Auth0 domain and a server-side
  one can differ, and merging them makes every API call 401).

### 5.3 Public sandboxes have two hard requirements

If `access.apps` is `public`, the tool **must refuse to start** unless both hold:

1. The database seed is a fixture or an explicitly-marked anonymised dump — never a fork of
   a live database. A public URL backed by real records is a data leak.
2. Third-party credentials are dummies unless explicitly opted in. Anyone who can drive a
   public app can otherwise make it send real email and spend real LLM credit.

This is a refusal, not a warning. `access: private` is the escape hatch.

For the first requirement to be checkable, `sandboxr.yaml` must be able to say so. A
`seed_from` entry takes an optional `anonymised: true`, and that flag is the only thing the
refusal accepts as marking a dump safe:

```yaml
database:
  seed_from:
    file: /var/sandboxr/seeds/acme.sql.zst
    anonymised: true      # asserts this dump carries no real personal data
```

A `fixtures` seed is safe by definition and needs no flag. A `local` seed — a fork of a
running database — can never satisfy the requirement, because it is by definition live data.
Absent the flag, a `public` project with a `file` seed is refused.

The flag is an assertion by the person who wrote the config, not something the tool can
verify. That is deliberate: the tool cannot tell an anonymised dump from a real one, so the
honest design is to make someone state it explicitly in a reviewed file rather than to
imply a guarantee that does not exist.

### 5.4 Fields the container layer requires

These were missing from the schema above and are needed for a sandbox to actually run. They
are part of the contract.

| Field | Where | Meaning |
|---|---|---|
| `static_mode` | a `frontends` entry with `out:` | `spa` \| `files` \| `html`. How a built directory is served. A single-page app needs a catch-all rewrite to `index.html`; a generator emitting `about.html` needs extensionless lookup; a plain directory needs neither. One mode makes two of the three half-work rather than fail, so it is explicit. Default `spa`. |
| `in_build_all` | a `frontends` entry | Whether "rebuild everything" includes this app. Default `true`. Set `false` for something consulted occasionally and expensive to build, such as a component-library viewer. |
| `database.owner` | `database` | For a file-backed driver, the single service permitted to open the database file. Required when the driver is `d1` or `sqlite` — see §6.1. |
| `storage` | top level | `driver: minio \| none` and a `buckets` list. Object storage inside the sandbox, so uploads never reach a real bucket. Default `none`. |

Two driver-specific notes:

- `migrate.since` is passed to the project's migration command as the environment variable
  `SANDBOXR_MIGRATE_SINCE`. The tool cannot guess a runner's flag spelling, so the command
  in the config must consume it if it wants it.
- For file-backed drivers, both the `serve` and `migrate` commands must direct the runtime
  at the sandbox's own state directory (`$SANDBOXR_D1_DIR` for wrangler's `--persist-to`),
  or the runtime writes into the worktree instead of the sandbox.

### 5.5 `plan.json` — the container's view of a project

`sandboxr.yaml` is the human-facing file. Nothing inside a container ever reads it.

`packages/core` **must** emit a flattened, fully-resolved projection of it to
`/sandboxr/plan.json`: defaults merged into every entry, one `services` array carrying all
three runtime kinds with an explicit `kind`, computed addresses, and the resolved
environment. Nothing in the container names a service, port, package or route — the
container is a generic runtime and the plan is its only input.

**The authoritative specification of `plan.json` is `container/README.md` ("The plan"),
with two worked examples in `container/examples/*.plan.json`.** Treat those as the contract
for this boundary and keep the emitter in step with them.
## 6. The database driver interface

```ts
export interface DriverContext {
  project: string;
  slug: string;
  config: ResolvedConfig;
  home: string;             // SANDBOXR_HOME
  worktree: string;
  exec(cmd: string[]): Promise<ExecResult>;   // inside the sandbox container
  log(line: string): void;
}

export interface DatabaseDriver {
  readonly name: "mysql" | "d1" | "sqlite" | "none";

  /** Host-side: produce a reusable seed artifact in ~/.sandboxr/cache. Idempotent. */
  prepareSeed(ctx: DriverContext): Promise<SeedArtifact>;

  /** Inside the container, first boot: get from empty to seeded-and-migrated. */
  provision(ctx: DriverContext, seed: SeedArtifact): Promise<void>;

  /** Run the project's own migration command. Never reimplement the project's logic. */
  migrate(ctx: DriverContext): Promise<MigrateResult>;

  /** Structure-only snapshot, for diffing before/after a migration. */
  snapshot(ctx: DriverContext): Promise<string>;

  /** An interactive shell against this sandbox's database. */
  shell(ctx: DriverContext): Promise<void>;
}
```

Rules that apply to every driver:

- **The source database is only ever read.** Every destructive operation targets a copy.
  This is the property that makes it safe to point a half-written migration at real data.
- **A failed migration does not stop the sandbox.** Record the failure, mark the sandbox
  `degraded`, and let the services boot anyway — inspecting a failed migration is a reason
  the sandbox exists.
- **The schema baseline survives a failed run.** Snapshot before migrating, and only
  re-take the baseline after a *success*. Re-snapshotting on every attempt would overwrite
  the last-known-clean schema with the half-migrated state, and the diff would then show
  nothing exactly when it matters most.
- **Never reimplement the project's migration logic.** Shell out to the command in the
  config. The tool may *read* migration state to display progress, but what actually runs
  is always the project's own program.

### 6.1 Driver notes

**mysql** — the hard case. A running server: install, start, wait, dump, restore, and an
advisory lock so two migrations cannot collide. Restore into the version the project
declares, not whatever the developer happens to run locally.

**d1 / sqlite** — the easy case. The database is a *file*. Seeding is a copy, forking is a
copy, there is no server and no lock. One rule: **one writer per file.** Two processes
opening the same D1 file deadlock, so each sandbox gets a private copy and the config must
name the single service that owns it.

**none** — no database. Valid and should stay cheap.

## 7. Access control

One mechanism, used twice.

- The dashboard owns sessions. `POST /auth/login` takes a password, sets a signed
  `HttpOnly` `Secure` `SameSite=Lax` cookie. Password is `SANDBOXR_PASSWORD`, compared with
  a **timing-safe** comparison, and stored as a hash — never logged, never echoed.
- The router protects everything else by asking the dashboard. App hostnames belonging to a
  `private` project get a forward-auth middleware pointing at `GET /auth/verify`, which
  returns 200 or 401. `public` projects skip the middleware.
- Per-project access: the session records which projects it may control. A password grants
  the projects it is configured for, so different people get different projects.

Non-negotiables:

- **No action endpoint is reachable without a session.** Not one.
- The dashboard talks to Docker; treat every request as untrusted input. Slugs, project
  names and branch names are validated against the patterns in this file before they reach
  a command, and commands are executed as argument arrays — never a shell string.
- Rate-limit the login route.

## 8. Actions

Every action the dashboard offers is a **closed table** in the server package. There is no
generic "run this command" endpoint. Each entry names the command, whether progress can be
a real fraction, and how to parse a line into progress.

Actions stream. The transport is Server-Sent Events for one-way output (a build, a
migration) and a WebSocket for the terminal, which is bidirectional. Four event kinds:
`start` (names the action, says whether the bar can be a fraction), `log` (one line),
`step` (progress), `done` (exit code).

## 9. Conventions

- **Commits:** conventional (`feat:`, `fix:`, `docs:`, `refactor:`, `test:`, `chore:`),
  bullet points in the body. No `Co-Authored-By`.
- **Comments document the code, not the change.** Write them as if the code always looked
  this way. Rationale for a decision goes in the commit message, or in this file when it is
  a contract. Never narrate an edit or an incident in a comment.
- **Every non-obvious choice gets a short "why" comment.** The value of the implementation
  this is ported from is that it explains itself; keep that.
- **Tests:** Vitest. Every pure function gets a table-driven test. Every bug fix gets a
  regression test. Test files sit beside their source as `<name>.test.ts`.
- **Formatting:** two-space indent, double quotes, semicolons, trailing commas, 100-char
  lines.
