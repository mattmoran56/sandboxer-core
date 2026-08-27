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
packages/server    @sandboxr/server   The dashboard's server: auth, JSON API, terminal, actions
packages/web       @sandboxr/web      The dashboard's browser app: React, Tailwind, built by Vite
packages/docs      @sandboxr/docs     The documentation site (MDX)
container/         (no package)       What runs INSIDE a sandbox: Dockerfiles, s6, scripts
examples/          (no package)       Example sandboxr.yaml files
```

Ownership rule: **only `container/` contains bash.** Everything host-side is TypeScript.
The container scripts are deliberately shell because they run under s6 with no toolchain
guarantees, and because they are ported from a working implementation.

The same rule, for the newest package: **`packages/web` holds no logic about what a sandbox
is.** It renders what the API sends and posts actions back. Which actions apply to a stopped
sandbox, what makes one degraded, how a slug is derived — every one of those is decided by
core and reported by the server, and a copy of any of them in the browser is a second
implementation that drifts.

`@sandboxr/server` depends on `@sandboxr/web` and serves its `dist/`. A root
`npm run build` orders the two correctly because of that dependency; building the server
alone leaves it serving an HTML shell with nothing behind it.

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

The paths under that one hostname are §7.1.

### 3.3 Docker names

- Container: `sandboxr-<project>-<slug>`
- Network: `sandboxr` (one, shared)
- Volumes: `sandboxr-<purpose>-<project>-<slug>` where purpose is one of
  `data` (database), `blob` (object storage), `bin` (built binaries), `www` (built sites).
- Shared volumes: `sandboxr-deps-<hash>` (node_modules, keyed on lockfile),
  `sandboxr-gocache`, `sandboxr-gomod`, `sandboxr-claude` (an agent session's credential
  store, mounted at `/root/.claude` with `CLAUDE_CONFIG_DIR` pointing at it — see §7.2).

`sandboxr-claude` is shared by every sandbox on the machine **on purpose**, and the trade is
part of the contract rather than an implementation detail: sharing it is what makes an MCP
server something you sign into once rather than once per worktree, and it means every sandbox
can read every credential in it. None of these shared volumes is ever reaped by the collector
when a sandbox is deleted (§ garbage collection); reaping this one would silently sign the
machine out of every server it had been given.

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
| `sandboxr.ttl` | seconds the sandbox may sit unused for, or `never` |

**Labels hold durable state only.** Everything above is fixed when the sandbox is created
and does not change while it runs. Runtime state — whether it is starting, running or
degraded — is **derived at read time** from the container and its status surface, never
written back to a label. A label recording "running" would be a second source of truth that
goes stale the moment a process dies, which is exactly the drift this design avoids.

So `Sandbox.state` in §6 is computed, not stored: the container's own state, plus the
migration verdict the sandbox exposes. A failed migration deliberately leaves the container
running, so anything reading only the container's state will report a degraded sandbox as
healthy — the one case where it matters most.

**There is deliberately no `sandboxr.expires` label**, and the reason generalises. `sandboxr.ttl`
is a *duration*, which is durable; a deadline is not. `sandboxr.created` is stamped once and never
moves, so a deadline of `created + ttl` is already in the past the moment the reaper stops a
sandbox — restarting it would get it stopped again on the very next pass, and the button would
look broken.

The deadline is therefore derived at read time, as **`max(startedAt, lastActive) + ttl`**:

- `startedAt` is `State.StartedAt`, which Docker maintains. It gives the semantics anyone expects
  from the Restart button: restarting a sandbox buys it another full ttl.
- `lastActive` is the last request that reached the sandbox through the shared router, read from
  that router's access log (`accessLog: {}`, one common-log line per request, ending in the router
  name — which for a sandbox *is* its container name). The ttl therefore measures **idleness, not
  uptime**: using a sandbox resets its clock.

`lastActive` is derived, never stored — §4.2's rule applied to a timer. Two consequences are part
of the contract. The per-sandbox logs under `logs/<project>/<slug>/` are **not** an activity signal:
the dashboard's health probes dial containers directly on the Docker network and write to them every
few seconds, so an idle timer keyed on them would never fire. And a router whose log cannot be read
yields **no** last-activity times rather than "nobody has used anything" — every sandbox falls back
to its start time. Reading a missing router as universal idleness would stop every sandbox on the
machine at once.

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
  config.yaml            the machine's own settings — see §4.3
  state/keep/<project>/<slug>  keeps one sandbox alive past its idle limit — see §4.2
  workspace/<project>/   a project the dashboard can start a sandbox for — see §4.1
  workspace/<project>/sandboxr.yaml  optional project-level config — see §5.6
```

### 4.1 The workspace

`SANDBOXR_WORKSPACE`, default `~/.sandboxr/workspace`. Its own variable because the repositories
are the one part of the tree worth putting on a different disk.

```
<workspace>/<project>/
  sandboxr.yaml        optional: the project-level config — see §5.6
  repo.git/            a bare clone
  wt/<branch>/         one worktree per branch, all peers
```

**A project is a directory containing `repo.git`.** There is no registry file, so listing the
projects is a `readdir` — a pure function of the filesystem, for the same reason `list` is a pure
function of `docker ps`. Nothing is written when a project is cloned beyond the clone itself,
there is nothing to reconcile, and `git clean` cannot reach it.

Two rules follow, and both are load-bearing:

- **Bare, never a mirror.** `git clone --mirror` sets a `+refs/*:refs/*` refspec, so every fetch
  force-updates `refs/heads/*` to match the remote — and worktree branches live there. A routine
  fetch would reset a branch that a worktree has checked out and discard local commits. The clone
  is `--bare` with `+refs/heads/*:refs/remotes/origin/*` set explicitly, which a plain `--bare`
  clone does not configure at all.
- **Union with `docker ps`, never a filter.** The dashboard's project list is the workspace
  *unioned* with the projects that have containers. A running sandbox whose project is not in the
  workspace must still appear; a list that could hide something running is the staleness this
  whole design exists to avoid.

The directory name is the key. The `project:` field in that repo's `sandboxr.yaml` is what
hostnames and container names are built from (§3.2, §3.3), and the two need not match.

`<project>/sandboxr.yaml` is the only file sandboxr itself may put in a project directory, and
it is put there by hand. It is a fallback for worktrees that carry no config of their own, and
it never becomes a sandbox's `/workspace` — see §5.6.

#### 4.1.1 What a worktree reports

`Worktree` in `packages/core/src/worktree.ts` is what a listing of `wt/` yields, and it is the
unit the dashboard's sidebar is built from — a worktree is the thing that persists, and a
sandbox is something that comes and goes on top of it.

| Field | Meaning | When it cannot be read |
|---|---|---|
| `path` | Absolute path to the top of the worktree | — |
| `branch` | The branch name — never git's literal `HEAD` | `?` |
| `head` | Short commit sha | `?` |
| `detached` | Checked out detached, which is how a branch open elsewhere is run | — |
| `exists` | Whether the directory is really on disk | — |
| `committed` | ISO 8601 of the **HEAD commit** | `""` |
| `created` | ISO 8601 of the **directory's creation time**, as the filesystem reports it | `""` |

**`committed` and `created` answer two different questions and must never be blurred into
"last touched".** `created` is when somebody cut this worktree; `committed` is when work last
landed on the branch in it. A worktree cut this morning off a branch nobody has touched since
March is new by one and old by the other, and both readings are wanted — the dashboard groups
by either. Not every filesystem records a birth time, so `created` is genuinely absent on some
machines.

Both are `""` rather than a substituted value when unreadable, and that is the contract: a
fabricated date sorts a worktree somewhere it does not belong, which is worse than an entry the
reader can see has no date.

### 4.2 Keep-alive, and where mutable state is allowed to live

A keep-alive marker exempts one sandbox from its idle limit. It cannot be a label — a running
container's labels are immutable, and Docker exposes no way to change one — so it is a file, and it
is the one piece of per-sandbox state that lives on the host.

The rule that makes this legal rather than a second manifest: **the file records operator intent,
not observed reality, and it names the instance it applies to.** It contains the `sandboxr.created`
value of the container it applies to, and a marker whose stamp does not match the live container is
ignored. Slugs are derived from ticket ids (§3.1), so the same `project/slug` is recreated routinely;
without the stamp a leftover marker would silently keep the *next* sandbox to take that name alive.
With it, a stale marker fails closed and needs no reconciliation pass — which matters, because a
pass whose job is to read `docker ps` and believe it is precisely what makes a file a second copy of
the truth.

`down` removes the marker. That is tidiness, not correctness: `docker rm` by hand cannot be hooked,
and the stamp is what covers that case.

The vocabulary is fixed: the file is `state/keep/<project>/<slug>`, the CLI is `keep` / `unkeep`,
the dashboard action is `keep` with a `toggle` of `on` / `off`, and core's functions are
`isKeptAlive` / `writeKeep` / `removeKeep`. `pin` and `unpin` survive only as undocumented CLI
aliases.

### 4.3 `config.yaml`: the machine's own settings

`sandboxr.yaml` (§5) belongs to the project being sandboxed and is versioned with its code.
`~/.sandboxr/config.yaml` belongs to the machine, and holds what is a property of the machine rather
than of any project:

```yaml
ttl: 12h
github: none
projects:
  acme: { ttl: 3d, github: token }
```

The schema is `packages/core/src/config/machine.ts` (Zod, `strictObject`), so a misspelled key is an
error naming the key. Precedence for `ttl`, most specific first, and this order is the contract:

1. `--ttl` on the command (or the dashboard's field)
2. the project's entry in `config.yaml`
3. the file's top-level `ttl`
4. `SANDBOXR_TTL_HOURS` — what a service unit sets
5. the built-in default, **12h**

`github` is `none` or `token`, and decides whether that project's sandboxes are handed this
machine's GitHub token (§7). Its ladder is deliberately shorter — the project's entry, then the
file's top-level value, then the built-in **`none`** — with **no flag and no environment
variable**. A lifetime is a scheduling preference worth overriding per run; this is a decision
about which code may act as the person running it, and a decision like that belongs in one file
somebody can read, not in whatever started the process.

**It lives here and not in `sandboxr.yaml`, and that is a rule rather than a convenience.** The
token is the operator's, not the project's, and a setting that lives in a repository is a setting a
repository can ask for: clone something, start a sandbox, and its committed config would have
helped itself to a credential reaching every repository you can push to. The machine decides which
projects it trusts with its own credentials. A project never votes on that.

A **missing** file is not an error: it means the defaults. A **malformed** one is, reported by name
with the path, because silently falling back to a default lifetime after somebody has edited the
file is how work gets destroyed. `sandboxr init` writes a commented example if there is none, and
never touches an existing one.

## 5. The config file: `sandboxr.yaml`

Lives at the **root of the project being sandboxed**, not in this repo. It is versioned
with that project's code, so a new service and its config land in the same commit. That is
still the rule; **§5.6 is its one exception**, for a project in the workspace that has not
committed a config yet.

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

### 5.6 The project-level config, and why `file` is not always inside `root`

A worktree is a separate checkout, so an **uncommitted** `sandboxr.yaml` in one worktree does
not exist in any other. A project being brought onto sandboxr for the first time therefore has
to have the file hand-copied into every worktree, for as long as committing it upstream is
blocked. That is the case this exception exists for, and nothing else.

**A project in the workspace may keep a config beside its mirror**, and every worktree of that
project that does not carry its own uses it:

```
<workspace>/<project>/sandboxr.yaml   applies to every worktree of this project
<workspace>/<project>/repo.git
<workspace>/<project>/wt/<branch>/    a worktree; its own sandboxr.yaml still wins
```

Three rules, and all three are load-bearing:

1. **A worktree's own config always wins.** The project-level file is a fallback, never an
   override. A repository that describes itself must not be silently overruled by a file
   outside it that its authors cannot see.
2. **`root` is always the worktree.** The project-level file is read for its *content*; the
   tree it governs is unchanged. `<workspace>/<project>` holds `repo.git` and every sibling
   worktree, so mounting it as `/workspace` would put all of them inside the sandbox and
   resolve every declared path one directory too high. Loading a config whose `root` would be
   a workspace project directory is refused outright.
3. **The search is bounded at the top of the worktree.** Config lookup walks *up* from the
   directory it starts in, and an unbounded walk leaves the checkout and lands on the
   project-level file on its own — with `root` set to that file's directory, which is rule 2's
   failure exactly. Inside a managed worktree the walk stops at the worktree top, and the
   fallback below it is the only sanctioned way to reach the project-level file.

This is the one place `ResolvedConfig.file` and `ResolvedConfig.root` may name different trees,
and the invariant `root === dirname(file)` no longer holds anywhere. Code that wants the
directory a declared path resolves against wants `root`, or `projectPath()`.

`ResolvedConfig` carries `origin`: `repo` when the file is inside `root`, `project` when it is
the workspace fallback. `sandboxr config` prints it, because a project running from a config
that is not in its own repository is a thing a user must be able to see rather than deduce.

Nothing here changes a repository outside the workspace: its walk-up is unbounded exactly as
before, and its `root` is still the directory the config sits in.

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
- **Every route declares its auth.** There is no default, so a route added without a
  decision does not compile rather than shipping open.
- The dashboard talks to Docker; treat every request as untrusted input. Slugs, project
  names and branch names are validated against the patterns in this file before they reach
  a command, and commands are executed as argument arrays — never a shell string.
- Rate-limit the login route.
- **A content-security policy with no `unsafe-inline` for script, and no external origin.**
  Nothing executable may be inlined into a page and nothing may be fetched from another host.
  The browser app's build is configured for that — no inlined assets, one stylesheet, fonts
  served from this machine rather than from a font CDN — and it is a constraint on the build,
  not a preference about it.

  There is **no relaxation**, including for the terminal. A dependency that cannot live inside
  this policy is configured differently rather than let out of it: xterm's default renderer draws
  by injecting `<style>` elements, so the browser app loads its canvas renderer instead, which
  injects none. Widening either half of `style-src` needs a reason written down here, and a
  browser's violation message is not one on its own — it names the directive that refused, not
  the mechanism that tripped it.

### 7.1 The dashboard's HTTP surface

The dashboard is a **single-page app**. `@sandboxr/server` answers JSON and serves one HTML
shell; `@sandboxr/web` is the app that shell loads, and it routes in the browser from there.

**The governing rule: the server sends facts and the browser writes sentences.** No field of
any API response is a rendered string. An expiry is an instant, never `"3h 20m left"`; a state
is `degraded`, never `"degraded — something failed during boot"`. A page showing a countdown
has to re-render it every second anyway, so a server-rendered copy of the same wording is only
a second version to disagree with — which is exactly what it was: the words existed once in a
template and once in the script that replaced them, each carrying a comment warning that the
two had to be kept in step.

The corollary is that the *decisions* still belong to the server. Which actions apply to a
sandbox right now is a field on the response, not a filter the browser derives from the action
table; so is the sentence a destructive action confirms with, because the table is where what
is actually lost is known.

**The JSON API.** Every route below requires a session, and every one that names a `:project`
is additionally checked against the session's grant.

| Route | Answers |
|---|---|
| `GET /api/bootstrap` | The domain, the session, the closed action table (§8), and the default lifetime the new-sandbox form offers. What the app needs before it can draw anything |
| `GET /api/workspace` | Every project, every worktree and every sandbox on the machine, plus a summary. The one call the sidebar and the home view are drawn from |
| `GET /api/projects/:project` | One project's worktrees, branches and open pull requests |
| `GET /api/p/:project/s/:slug` | One sandbox in full, with the apps and services its project's config declares |
| `GET /api/repos` | The repositories this machine's `gh` can offer, each marked with whether it is already in the workspace |
| `GET /api/p/:project/s/:slug/agent/runs` | The agent sessions recorded against one sandbox, newest first. The index only — never message content (§7.2) |
| `GET /api/agent/models` | The models a session may run on, and the one this machine defaults to. A closed table (§7.2) |
| `GET /api/p/:project/s/:slug/agent/commands` | The slash commands a session on that sandbox can be offered, each marked sendable or not, and each refused one carrying the sentence it is refused with (§7.2) |

`GET /api/workspace` is polled every **thirty seconds**, and three rules about that polling are
part of the contract because each was learnt from the version this replaced: nothing is fetched
while the tab is hidden or while an action is running, a failed poll leaves the last good answer
on screen and says it is stale rather than blanking the page, and returning to the tab refreshes
at once.

**The HTML shell** is served at `/`, `/new`, `/settings`, `/repos`, `/p/:project`,
`/p/:project/branches`, `/p/:project/w/:slug` and `/p/:project/s/:slug`. Every one of them
returns the same document; the app decides what to draw. `/assets/*` serves the built bundle.

`/p/<project>/w/<slug>` and `/p/<project>/s/<slug>` are one view — the sandbox is something
that comes and goes on top of the worktree. The `s` form is kept because it is what an action's
declared destination (§8) and every existing bookmark already use, and because the log and
terminal endpoints hang off it.

**Unchanged by the move to a single-page app**, and deliberately so: `/healthz`, `/login`,
`/auth/*`, the three `POST` action routes (`/actions/:action`, `/p/:project/actions/:action`,
`/p/:project/s/:slug/actions/:action`), `GET /p/:project/s/:slug/logs`, the terminal
WebSocket at `/p/:project/s/:slug/terminal`, and the agent WebSocket at
`/p/:project/s/:slug/agent` (§7.2).

**The login page and the private-app handshake pages stay server-rendered.** Two reasons, both
hard requirements rather than preferences. The login form must work with JavaScript off, because
it is the only way back in and a dashboard that cannot be signed into cannot be fixed from
itself. And it must be a real `<form>` with a real `POST` for the browser's password manager to
recognise it as one — a form assembled by script after load frequently is not offered a saved
password at all.

### 7.2 Agent sessions

A sandbox may have a **Claude Code session** running on its worktree. `claude` runs *inside*
the container, on `/workspace`, started by the server over `docker exec`; the host holds no
agent process of its own.

**Three nouns, and every screen and every stored file is one of them.**

| Noun | What it is | Keyed by |
|---|---|---|
| Run | One `claude` session, in one sandbox | `sessionId`, assigned by Claude Code |
| Thread | One conversation inside a run — the main one, or a subagent's | `parent_tool_use_id`; `main` for the one nothing spawned |
| Event | One thing that happened, in order | `uuid`, plus its position in the transcript |

**A run's tree is assembled from two different joins, and only one of them is free.** Inside a
session, every message carries the id of the tool call that spawned it, so subagents nest at any
depth with nothing for sandboxr to remember. Across a machine boundary — a session that starts
another session — there is no such field, and the link has to be written down at the moment it
is made or it cannot be recovered. Nothing does that yet; when something does, this is the
sentence it has to satisfy.

**The wire format is Claude Code's, and exactly one file knows it.** `packages/core/src/agent/stream.ts`
turns `--output-format stream-json` into the event model above; nothing downstream sees a raw
line. A Claude Code release that renames a field is a change there and nowhere else. A line this
version does not understand is **dropped, never surfaced** — an unrecognised type is almost
always a newer Claude Code, and rendering it raw would put JSON in the middle of a conversation.

The event kinds are closed, and each one is a thing a reader acts on rather than a line of the
protocol repeated:

| Kind | What it says |
|---|---|
| `session` | The session opened: model, working directory, tools, and which MCP servers will silently have none |
| `text` | Prose, from either side |
| `thinking` | The model is reasoning. The text is often empty, and the marker is still worth drawing |
| `tool` / `tool-result` | One tool call and its answer, rendered as one card. A call that spawned a subagent says so |
| `result` | The turn ended. The only place cost and duration are stated |
| `compacted` | History was summarised away, with how many tokens were in play and whether anyone asked |
| `retry` | A retryable API failure, on its way to resolving itself or becoming an error |
| `error` | The session failed — not a tool that did |

**A compaction is an event, not a gap.** Claude Code summarises a long conversation and carries on,
and it says so on the stream. Dropping that line as unrecognised — which is what happens to
everything else this version has no opinion about — loses the one fact that explains an agent which
appears to have forgotten what it was told: the transcript would show the conversation continuing
with no sign that most of it had been replaced by a summary. It is therefore the exception to the
paragraph above, and it is read defensively: an unstated token count or trigger becomes null rather
than a compaction this version declines to report.

**Transcripts are files; the index is small.** The raw lines are appended to
`$SANDBOXR_HOME/agent/log/<sessionId>.jsonl` *before* they are interpreted, so a later renderer
can re-read a conversation an earlier one recorded. `$SANDBOXR_HOME/agent/runs.json` holds the
index: which session belongs to which sandbox, its state, and where its transcript is. **Every
field in the index is derivable by replaying the transcripts**, which is what makes it a cache
rather than a system of record — and what makes the storage choice a contained one. It is a JSON
file written by temp-and-rename because the server process is the only writer; the day there are
two, `store.ts` changes and nothing else does.

`sessionId` is the load-bearing field. It is the only thing that makes `claude --resume` possible
after a container restart, and it exists nowhere else.

**A session is keyed by the sandbox, not by the connection watching it.** Sockets subscribe and
unsubscribe; the process underneath carries on. That is the one place an agent session must differ
from the terminal, and it is not a preference: a shell dying with its tab is expected, an agent
dying because somebody looked at another worktree destroys work in progress. It follows that two
browsers can watch one session, and that closing every browser leaves it running — bounded, because
an unwatched session is stopped after thirty minutes rather than held open indefinitely against the
sandbox's own idle reaper.

**What a session does not survive is the dashboard restarting.** The process is a `docker exec`
this server owns, so it dies with it. That is recoverable rather than fatal — the session id and
the transcript are on disk, so the next connection continues the conversation with `--resume` — but
it is a real limit. Removing it means running the agent detached *inside* the container and
attaching to its output instead of owning its process.

**The socket** is `/p/:project/s/:slug/agent`, authenticated before the upgrade completes like
the terminal's (§3.2), with an optional `?resume=<sessionId>` and `?model=<id>`. A socket opened
on a sandbox that already has a session joins it, and **the running session's model wins over the
one asked for** — a conversation is a thing one model had, and switching mid-way would make its own
transcript misleading. Unlike the terminal there are no binary frames at all — both directions are
JSON text:

| Direction | Frames |
|---|---|
| browser → server | `{"t":"send","text":…}`, `{"t":"interrupt"}` (end the turn), `{"t":"stop"}` (end the session) |
| server → browser | `{"t":"ready",…}`, `{"t":"session",…}`, `{"t":"event","event":…}`, `{"t":"state",…}`, `{"t":"usage","tokens":…}`, `{"t":"error",…}` |

A reconnect replays the transcript from disk before the live stream starts, so the socket only
ever carries what happens from now on.

**Slash commands are a list the server owns, and half of it is per sandbox.**
`GET /api/p/:project/s/:slug/agent/commands` answers every command the composer may offer, from
three sources: Claude Code's built-ins, the worktree's own `.claude/commands/`, and its
`.claude/skills/`. The last two belong to the branch rather than to the machine, so they are read
by one exec inside the container — and a worktree with no `.claude` directory is the ordinary case,
so a failure there answers the built-ins rather than an error.

The built-ins are a **closed table** in core, on the same reasoning as the model table: a command
becomes the text of a message sent into a process in a container. Only commands that work without a
terminal are in it — Claude Code's `-p` mode runs skills, custom commands and a documented subset of
the built-ins, and a terminal-only one such as `/login` is not an error the person sees but a turn
spent on nothing. Two free sources say which is which and they agree: the shipped binary marks each
command `supportsNonInteractive`, and a running session announces the resulting set as
`slash_commands` on its `system`/`init` line. Neither costs a turn, and the table is worth
re-checking against them whenever the image's `claude` is upgraded. What `init` does not carry is
descriptions, which is why the table is written out rather than read off the session.

**`sendable: false` marks a command that is listed and must not be sent, and the socket enforces it
too.** A `{"t":"send"}` whose first token is one of them is answered with an error frame and never
forwarded, because a rule enforced only in the browser is not a rule. Four are refused, each for
its own reason: `/clear` starts a *new* Claude Code session while this run's transcript is still
being written against the old id; `/login` only exists in a terminal; `/model` would change a
run's model after the index has recorded it, which is the same promise a joining socket keeps when
the running session's model wins; and `/btw` draws a side panel, so a headless session gets a
synthetic "isn't available in this environment" for it and nothing else. Each refused row carries
the sentence it is refused with, in `refusal`, and no other row carries one — the reason a command
is stopped is a fact about what a session does, so the browser says it rather than composing one.

**The table is a menu, not an allowlist.** Those four names are the whole of what the socket
refuses. Every other message beginning with `/` is forwarded verbatim — a command Claude Code
gained after this table was written, one of the skills bundled in the binary, a worktree command
added since the pane loaded, a pasted path, a sentence, a bare slash. A closed table decides what
sandboxr *offers* and what it *stops*; what a person may type is not sandboxr's to decide, and a
table one release behind Claude Code has to degrade into "pass it on" rather than into "you may not
type this".

**The exec has no TTY, and that is not an optimisation.** A TTY echoes what is written to it, so
a process exchanging newline-delimited JSON would receive its own input back interleaved with
its output. The cost is that Docker frames the stream, which `demuxer()` already handles.

**Credentials never reach the worktree.** The session authenticates with an OAuth token from
`claude setup-token`, held in the server's environment and passed to the exec as
`CLAUDE_CODE_OAUTH_TOKEN`. It is written to no file inside the container. One consequence is
part of the contract because it is invisible otherwise: **a setup-token does not load claude.ai
connectors**, so MCP servers are named to the machine (`SANDBOXR_CLAUDE_MCP`) and passed on the
session's command line rather than inherited from the host's connector list.

**The container is the permission boundary**, and a session runs with `acceptEdits` — *not*
`bypassPermissions`, which is impossible here rather than merely unwise. `bypassPermissions` is a
spelling of `--dangerously-skip-permissions`, Claude Code refuses that outright when running as
root, and sandboxes run as root; a session configured that way exits at once with the refusal on
stderr and nothing on the event stream. So the default is `acceptEdits` plus a closed allowlist of
commands (`DEFAULT_ALLOWED_TOOLS`), which is the only arrangement whose behaviour is fully defined
while nothing on the host can answer a permission prompt. `SANDBOXR_CLAUDE_PERMISSION_MODE`
overrides it. What contains a session is the sandbox: the worktree, the project's own services,
and nothing else. When prompts become answerable this paragraph changes.

**The model is chosen from a closed table**, `AGENT_MODELS` in core, defaulting to Claude Opus 5.
The browser asks for one with `?model=` on the upgrade and an id outside the table is refused
before the handshake completes — the value becomes `--model` on a command line inside the
container, so this is the same rule the action table follows in §8. `SANDBOXR_CLAUDE_MODEL` sets
the machine's default, and `GET /api/agent/models` reports what this machine will actually do
rather than a constant.

### 7.3 Git in a sandbox, and the GitHub token

**Git works inside a sandbox, and making it work is a mount rather than a setting.** A linked
worktree's `.git` is a *file* naming its repository by absolute path, so a container that has the
worktree and not the repository fails every git command — `status`, `diff`, `log`, `commit` — with
one `fatal: not a git repository` naming a host path. The rule, the same one the dashboard's
workspace mount follows: the worktree **and** the repository it points at are bind-mounted at the
**identical path inside and out**, on top of the worktree's mount at `/workspace`. `gitMounts` in
`packages/core/src/git.ts` decides which paths those are; a plain checkout needs neither, and a
project that is a subdirectory of a larger repository gets neither and is told so once.

Three consequences are part of the contract:

- **The repository mount is read-write**, because `git commit` writes objects and refs into it.
  So every sandbox of a project shares one object store and one set of refs with the host: a
  sandbox can move a branch, and a `git gc` in one repacks what all of them read. Read-only was
  the alternative and is worse — status and log would work and only the commit would fail, from
  inside git, on a permission error.
- **The base image pins `gc.worktreePruneExpire` to `never`.** From inside one sandbox every
  *other* worktree of the project looks prunable, because their paths are not mounted, and
  `git commit` runs `gc --auto` on its own. Nothing in a sandbox has the information to make that
  judgement.
- **The commit identity crosses as `GIT_AUTHOR_*`/`GIT_COMMITTER_*`**, resolved from the host's
  `git config` (or forwarded to the dashboard at `init`, which has no gitconfig of its own). The
  host's `~/.gitconfig` is deliberately *not* mounted: it names a credential helper and a signing
  key that do not exist in the container, so the whole file breaks the operations it would enable.

**The GitHub token is a real widening of the blast radius, and it is off by default.** With
`github: token` (§4.3) a sandbox is given the value `gh auth token` prints on the host, as
`GH_TOKEN`, and the base image points git's https credential helper at `gh auth git-credential` —
so both `gh` and `git push` work, and an agent can open a pull request. What that costs, stated
plainly:

- The token is in the environment of **every process in that container**, not just an agent's.
  Project code, a dependency's install script and anything an agent runs can read it.
- Its scope is typically the person's, not the project's — `repo` across every repository they can
  reach, plus `gist` and `workflow`. Pushing to an unrelated repository is inside it.
- Unlike the seed and secret rules in §5.3, this is **not** refused for a `public` project, because
  nothing serves `GH_TOKEN` over http and reading it needs code execution in the container. A
  public sandbox is a dev build of an unfinished branch on an open hostname, though, so `up` says
  once, on the run where it applies, that the two decisions have met.

This is why the switch is the operator's, per project, and defaults to off. It is the same line
`DEFAULT_ALLOWED_TOOLS` draws for a session's commands: inside a sandbox everything is recoverable
by deleting it, and that stops being true the moment a command reaches the network with the
person's credentials. Note that `git push` and `gh` are **not** in that allowlist, so a session
still has to be granted them.

## 8. Actions

Every action the dashboard offers is a **closed table** in the server package. There is no
generic "run this command" endpoint. Each entry names the command, whether progress can be
a real fraction, and how to parse a line into progress.

Actions stream. The transport is Server-Sent Events for one-way output (a build, a
migration) and a WebSocket for the terminal, which is bidirectional. Four event kinds:
`start` (names the action, says whether the bar can be a fraction), `log` (one line),
`step` (progress), `done` (the exit code, and optionally where to go next).

An action may declare how to read a **destination** out of its own output, the same way it
declares how to read progress — so a clone can send the browser to the project it just made.
Three rules, and all three are load-bearing:

- It is carried **only on a successful `done`**. A failure leaves the reader on the log,
  which is the one place the error exists.
- It is **read from the command's output**, never derived from the request. The names sandboxr
  gives things are computed by core (§3.1), and a second derivation elsewhere would be wrong
  for exactly the awkward inputs the hashing exists for.
- It is **validated as a path on this origin** before it reaches the browser. It is built from
  output that can contain names from a remote repository, and it ends in a navigation. A value
  that does not qualify yields no destination at all rather than a fallback, because sending
  the reader somewhere plausible is a false claim about where the thing is.

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
