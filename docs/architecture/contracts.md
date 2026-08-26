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
projects:
  acme: { ttl: 3d }
```

The schema is `packages/core/src/config/machine.ts` (Zod, `strictObject`), so a misspelled key is an
error naming the key. Precedence, most specific first, and this order is the contract:

1. `--ttl` on the command (or the dashboard's field)
2. the project's entry in `config.yaml`
3. the file's top-level `ttl`
4. `SANDBOXR_TTL_HOURS` — what a service unit sets
5. the built-in default, **12h**

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
