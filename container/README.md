# The sandbox container

Everything that runs *inside* a sandbox, and the images it runs from — plus the
workstation image a session's agent runs in, which is not a sandbox. The host side
— config parsing, docker orchestration, the dashboard — is TypeScript and lives in
`packages/`. This directory is the one part of the repository that is deliberately
shell: it runs under s6 as PID 1's children, before and sometimes without any
project toolchain, so it can only depend on what the base image guarantees.

Read [`docs/architecture/contracts.md`](../docs/architecture/contracts.md) first.
Everything below implements it.

## Layout

| Path | What it is |
|---|---|
| `base/Dockerfile` | The generic base image: s6, Caddy, MinIO, `git`, `gh`, `claude`, these scripts |
| `base/s6/` | The s6 bundle skeleton, copied in at boot and then added to |
| `project/Dockerfile.template` | The per-project layer, rendered by the host |
| `scripts/` | Everything the services actually run |
| `scripts/with-env` | An argv prefix that gives any command the computed environment |
| `scripts/db/<driver>.sh` | One file per database driver |
| `examples/*.plan.json` | Two worked plans, used to exercise the generators |
| `workstation/Dockerfile` | The image a *session's agent* runs in — not a sandbox. See below |
| `workstation/idle.sh` | Its whole runtime: one process, so `docker exec` has something to exec into |

## Two images, not one

The image is split in two, and the split is the main structural difference from
the implementation this is ported from.

That implementation baked one project's toolchains **and** its whole dependency
tree into a single ~4.5 GB base. It worked, and it could never serve a second
project: the toolchain versions, the database engine and the `node_modules` were
all facts about one repository.

- **`base/Dockerfile`** — Debian bookworm, s6-overlay, Caddy, MinIO, `jq`,
  `envsubst`, `git`, `gh`, `claude`, and these scripts. Nothing project-specific.
  Shared by every sandbox of every project on the machine, and it stays small so
  that adding a project costs one thin layer rather than another few gigabytes.
  `claude` and `gh` are the two deliberate exceptions to "small": they are there
  because the point of a sandbox is that the branch in it can be *finished*, and
  a sandbox that can run the tests but not open the pull request sends you back
  to the host for the last step — the step you were trying to delegate.
- **`project/Dockerfile.template`** — rendered per project into a layer on top,
  adding exactly what that project's `toolchain:` and `database:` blocks declare,
  plus its dependency install.

```
sandboxr/base:<version>            generic, one per machine
    └── sandboxr/<project>:<hash>  toolchains + database engine + deps
            └── one container per worktree
```

### Building them

```bash
# base — context is this directory
docker build -f base/Dockerfile -t sandboxr/base:0.1.0 .

# project — the host renders the template and stages the manifests
docker build -f <rendered Dockerfile> -t sandboxr/<project>:<hash> <staged context>
```

### Rendering the project template

The template is a normal Dockerfile with two kinds of hole in it, and the header
comment inside the file is the authoritative description. In short:

1. **Blocks.** Everything between `# >>> sandboxr:block <name>` and
   `# <<< sandboxr:block <name>` is kept when that block is enabled and deleted
   otherwise, guard lines included. Blocks are `go`, `node`, `mysql`, `sqlite`,
   `gomod`, `deps`.
2. **Values.** Every `{{NAME}}` becomes a string. A missing value is an error, not
   an empty string — a silently empty version pin produces an image that builds
   and then cannot run.

The blocks live in the template rather than in the host code on purpose. Installing
a toolchain is a container concern, full of arch switches and vendor-specific
traps, and it belongs next to the other container concerns where the next person
to hit one of those traps will find it.

The build context holds only **manifests**, never source: a source change must
never re-run a dependency install. The worktree itself is bind-mounted at run
time.

## The workstation image

A **session** is one agent working on one branch, and the container that agent runs
in is its **workstation** — `sandboxr-ws-<session>`, built from
`workstation/Dockerfile`, with the session's work volume `sandboxr-work-<session>`
at `/work` holding clones laid out `/work/<repo>/<branch>/`. It is not a sandbox and
does not run a project: the copies of a project that actually serve traffic are
*runtimes*, and they are containers of their own.

```bash
docker build -f workstation/Dockerfile -t sandboxr/workstation:<version> .
```

> [!NOTE]
> Nothing builds or runs this image yet. The host side of a session — building it,
> starting the container, creating the volume, cloning into it — is a later step,
> and until it lands the image is only buildable by hand.

What is in it is Node 22, `git`, `gh` and `claude`, and what is *not* in it matters
as much:

- **No Docker client, and never the daemon socket.** That is the whole reason the
  agent moved out of the sandbox. A container that can reach the host daemon can
  start another with the host filesystem inside it, so an agent is contained only
  while it has no way to speak to Docker. The build fails if a client ever appears.
  An agent that wants a runtime will ask the control plane for one.
- **No bind mount from the host workspace.** A workstation's code is a clone on its
  own volume — which is also why none of the identical-path mounting `gitMounts`
  does for a sandbox's linked worktree applies here, and why this image does *not*
  copy base's `gc.worktreePruneExpire` pin. A plain clone inside a volume writes
  down only paths that exist inside the container.
- **No browser, no display server, no computer-use tooling.** That is a later step
  and a heavy one; the Dockerfile says where it would go.

## The plan

The container's entire view of the project is one file: `/sandboxr/plan.json`,
written by the host and mounted read-only. Nothing in `scripts/` names a service, a
port, a package or a route — they are all read from the plan. That is what makes
one image serve a multi-service database-backed monorepo and a single-worker
project on a file database.

The plan is a flattened, fully-resolved projection of `sandboxr.yaml`: every
default already merged, every optional field either present or absent, nothing
left to infer. Resolution is the host's job, because the host has a schema and a
type checker and this side has `jq`.

```jsonc
{
  "project": "acme",                    // required

  "database": {
    "driver": "mysql",                  // mysql | d1 | sqlite | none
    "version": "8.4",
    "name": "acme",                     // defaults to the project name
    "owner": "app",                     // file drivers: the one service that may open it
    "fixtures": "migrations/seeds/fixtures.sql",   // repo-relative
    // A path *inside the container*, not on the host: /sandboxr/cache/<name>
    // for a dump sandboxr cached, /sandboxr/seed/<name> for a file the project
    // declared somewhere else and the host bind-mounted. See "The seed artifact".
    "seed": { "path": "/sandboxr/cache/acme-3f2a1b.sql.zst", "anonymised": true },
    "migrate": {
      "workdir": "services",            // repo-relative; omitted means run in /empty
      "command": "go run ./cmd/migrate --env local",
      "since": "20260209",              // exported as SANDBOXR_MIGRATE_SINCE
      "failure_pattern": "[0-9]+ failed",
      "file_pattern": "[0-9]{8}-[^ ]+\\.sql",
      "error_pattern": "Error [0-9]+ \\([0-9A-Z]+\\):.*"
    }
  },

  "storage": { "driver": "minio", "buckets": ["uploads", "avatars"] },

  "toolchain": { "go": "1.26", "node": "24" },

  "deps": {                             // omit entirely if there is no Node tree
    "root": "web",                      // repo-relative dir holding the lockfile
    "lockfile": "package-lock.json",
    "install": "npm ci --no-audit --no-fund"
  },

  "services": [
    { "kind": "backend", "name": "api", "label": "api", "port": 8001,
      "health": "/health", "workdir": "services",
      "build": "go build -o {out} ./{name}", "optional": false },

    { "kind": "static", "label": "app", "package": "app", "root": "web/packages",
      "build": "npx vite build", "out": "dist",
      "static_mode": "spa",             // spa | files | html
      "memory": "6g", "in_build_all": true },

    { "kind": "server", "label": "cms", "package": "cms", "root": "web/packages",
      "serve": "npx next dev --port 3000 --hostname 127.0.0.1", "port": 3000,
      "prepare": "npm run codegen", "optional": true }
  ],

  "routes": { "app": { "/api": "api", "/cms": "cms" } },

  "env": { "DB_HOST": "${SANDBOXR_DB_HOST}", "S3_BUCKET": "uploads" }
}
```

Two fields need explaining because they have no counterpart in the config schema
today, and the container cannot do its job without them:

- **`static_mode`** decides how a built directory is served, and the three cases
  are genuinely different: a single-page app needs every unknown path to fall back
  to `index.html`; a static-site generator that emits `foo.html` needs
  `/blog/foo` to resolve to it; a plain directory of files needs an unknown path
  to be a real 404 rather than silently rendering the home page. One mode cannot
  cover all three, and getting it wrong is not a crash — it is an app that
  half-works.
- **`env`** is the mapping from sandboxr's own variable names to the project's.
  The container computes *where* things are (see below) and the project reads its
  own names for them; something has to join the two, and only the project knows
  its own spelling. Values are expanded with `envsubst`, which substitutes
  `${...}` and does not run a shell, so a value is data and never a command.

### The seed artifact

`database.seed.path` is the path the container opens, and the host has already
resolved it. Two kinds of artifact arrive there and only one of them lives in the
cache:

| Artifact | `seed.path` | How it got there |
|---|---|---|
| a dump sandboxr took and content-addressed | `/sandboxr/cache/<name>` | the cache directory is mounted read-only |
| a `database.seed_from.file` the project declared | `/sandboxr/seed/<name>` | that one file, bind-mounted read-only |

The container does not resolve a bare name against a directory it has to know
about, because the second kind has no name that would work: a declared `file:`
may be anywhere the user keeps it — outside every repo on purpose, so `git clean`
cannot destroy it — and its directory is the only thing locating it. The host used
to take the basename of both, which is right for the cache and left the declared
file being looked for where it had never been; nothing failed loudly, and the
sandbox started from an empty database instead.

The basename is preserved either way because `decompress()` picks zstd, gzip or
`cat` by extension, and the host is the side that knows the name.

When `seed.path` is absent the driver falls back to the newest dump in
`/sandboxr/cache`, so a `sandboxr db refresh` takes effect without regenerating
the plan.

### The environment a sandbox computes for itself

Contracts §5.2 forbids importing anything that describes *where* something runs —
importing a developer's `DB_HOST` would point the sandbox at their own database,
and importing storage credentials would point it at real cloud storage. So the
entrypoint derives them and exports them under a `SANDBOXR_` prefix:

| Variable | When |
|---|---|
| `SANDBOXR_DB_DRIVER`, `SANDBOXR_DB_NAME`, `SANDBOXR_DB_DIR` | always |
| `SANDBOXR_DB_HOST`, `_PORT`, `_USER`, `_PASSWORD` | `mysql` |
| `SANDBOXR_DB_FILE` | `sqlite` |
| `SANDBOXR_D1_DIR`, `SANDBOXR_D1_OWNER` | `d1` |
| `SANDBOXR_S3_ENDPOINT`, `_KEY`, `_SECRET`, `_REGION` | `storage.driver: minio` |
| `SANDBOXR_URL_<LABEL>` | one per app label |
| `SANDBOXR_PORT_<SERVICE>` | one per port-holding service |

`SANDBOXR_URL_<LABEL>` exists because only the container knows both the slug and
the domain at the moment a build runs. Same-origin API calls do not need it — the
router serves `/api` on the app's own hostname, which keeps the bundle free of
cross-origin requests and takes CORS out of the picture entirely — but cross-app
navigation needs an absolute, slug-bearing URL.

#### Four sources, in one order

More than one of them can name the same variable, so the order is fixed.
Contracts §5.2 states it; `env.sh` is where it happens. Weakest first:

1. **The project's secrets**, read line by line out of `/sandboxr/secrets.env`
   (`SANDBOXR_SECRETS` overrides the path). Read first and therefore weakest: a
   name that is **already set is left alone**, whoever set it. Values are read as
   **data** — no `source`, no expansion, so a value containing `$(...)` stays
   literal. Exactly one layer of matching quotes comes off, because the host
   writes every value quoted; the other half of that is `quoteSecret` in
   `packages/core/src/secrets.ts`, and if the two ever disagree every credential
   arrives with the quotes still around it and fails as an authentication error.
2. **What the host passes in** — the generated `--env-file` and the `-e`
   arguments below: the slug, the domain, the git identity, `GH_TOKEN`,
   `CLAUDE_CONFIG_DIR`. The host's own statement about this sandbox, so a file
   the project supplies must not be able to replace one. Nothing on the host side
   guards this: its reserved-name list covers the names the *sandbox* derives and
   has no opinion on `GIT_AUTHOR_EMAIL`. Step 1 skipping a name that is set is
   the whole of the protection.
3. **What the sandbox derives for itself** — the table above. Each one is
   `${X:-default}`, so a value from step 2 stands. A *secret* cannot reach one of
   these names at all: the host refuses to store a name the sandbox derives
   (`isReservedEnvName`). Docker used to settle that argument by layering two
   `--env-file`s, and nothing does now.
4. **The plan's `env` map**, applied last, and therefore the winner. Values go
   through `envsubst`, which can expand a secret as readily as a derived name —
   which is what makes `secrets.rename` worth having: rename a vendor's variable
   to a name of your own, then point the project's own name at it from the plan.
   It is also the way to override one of the names in step 2 on purpose.

Read first also means read *every time*. The secrets are a mounted file rather
than a `docker run --env-file`, so a rotated credential reaches a sandbox on the
next `stop`/`start` — the entrypoint runs again and reads the file again. An
env-file is read once, when the container is created, so the value in the file
and the value in the sandbox could disagree indefinitely with nothing saying so.
A *service* restarted inside the container is a different matter: it inherits the
environment `/init` was given at boot, `SANDBOXR_ENV_READY` included, so it keeps
the values it started with.

#### `docker exec` inherits none of it

The entrypoint's exports reach every *supervised* service, because `/init`
inherits them and `S6_KEEP_ENV=1` hands them on. A `docker exec` gets the
container's **configured** environment instead, which never saw them. Every
script in `scripts/` sources `lib.sh` and so recomputes it for itself; anything
that is not one of those scripts has to be run through `scripts/with-env`:

```bash
docker exec <container> /opt/sandboxr/scripts/with-env npm test
```

An argv prefix and not a shell string, so an argument that is deliberately an
empty string survives being wrapped. The host uses it for an agent session —
whose process is a bare `claude` argv — and for the project's own build commands.
It was not needed for the credentials while they arrived as an `--env-file`,
because an env-file *is* the configured environment; with the mount it is the
only thing that carries them into a command the host reaches in and starts.

### Container inputs

Mounts the host is expected to provide:

| Path | What |
|---|---|
| `/workspace` | the worktree, bind-mounted read-write |
| `/sandboxr/plan.json` | the plan, read-only |
| `/sandboxr/secrets.env` | the project's third-party credentials, read-only — only when the project has a secrets file and the machine lets this project use it |
| `/sandboxr/cache` | the seed artifact cache, read-only |
| `/sandboxr/seed/<name>` | a declared `database.seed_from.file`, that one file, read-only — only when the project has one and it is not in the cache |
| `/var/log/sandboxr` | per-sandbox logs, so they survive the container |
| `/var/lib/sandboxr/data` | the `data` volume |
| `/var/lib/sandboxr/blob` | the `blob` volume |
| `/var/lib/sandboxr/bin` | the `bin` volume |
| `/srv/www` | the `www` volume |
| `/workspace/<deps.root>/node_modules` | the shared `deps-<hash>` volume |
| `/root/.claude` | the machine-wide `sandboxr-claude` volume: Claude Code's state, shared by every sandbox so an MCP server is authorised once per machine rather than once per worktree |
| `/root/.claude/.credentials.json` | the **host's** Claude Code login, one file, bind-mounted read-write over the volume's copy — and only when that file exists on the host |
| `<the worktree's own host path>` | the worktree a second time, at the path the host calls it |
| `<the repository's own host path>` | the bare repo or `.git` the worktree points at, read-write |

**The credential is one file, and the directory around it is deliberately not
mounted.** Binding all of the host's `~/.claude` would give every sandbox write
access to its `settings.json`, which can define hooks — commands the host's own
Claude Code then executes — so a sandbox could put a command on the person's
machine. It is shared rather than copied because an OAuth refresh token rotates
and is single-use: two copies invalidate each other the first time either side
refreshes, which is why the mount is read-write. A host without that file (every
macOS one, where the credential is in the login keychain) gets no mount at all
and the volume alone, exactly as before. The host decides, in
`hostClaudeCredentials` (packages/core/src/agent/credentials.ts).

**The last two are what make `git` work in here, and they are mounted at the
identical path inside and out on purpose.** A linked worktree's `.git` is a file
holding `gitdir: <repo>/worktrees/<name>` — an absolute host path — so a
container with only `/workspace` fails every git command with `fatal: not a git
repository` naming a directory that is not there. The repository mount is
read-write because `git commit` writes objects and refs into it. Neither is
present for a plain checkout, whose `.git` is inside `/workspace` already; the
host decides, in `gitMounts` (packages/core/src/git.ts), which is which.

Environment: `SANDBOXR_SLUG` is required. `SANDBOXR_DOMAIN` (default `sbx.lcl`),
`SANDBOXR_PROJECT`, `SANDBOXR_WITH`, `SANDBOXR_SEED`, `SANDBOXR_DB_USER`,
`SANDBOXR_DB_PASSWORD`, `SANDBOXR_S3_KEY` and `SANDBOXR_S3_SECRET` all have
defaults. `CLAUDE_CONFIG_DIR` is set to `/root/.claude` — Claude Code keeps its
OAuth account and personal MCP servers in `~/.claude.json`, a file *beside* that
directory, so without this the volume persists the session history and loses the
login.

`GIT_AUTHOR_NAME`, `GIT_AUTHOR_EMAIL`, `GIT_COMMITTER_NAME` and
`GIT_COMMITTER_EMAIL` carry the host's commit identity. Both pairs, because git
fails on whichever is missing, and as variables rather than a mounted
`~/.gitconfig`, which would bring a credential helper and a signing key that do
not exist in here. Without them git refuses to commit at all: it tries to invent
an address from the hostname, and a container hostname has no domain.

`GH_TOKEN` is present only when the machine opted this project in (contracts
§4.3). `gh` reads it by itself, and the image's `/etc/gitconfig` points git's
https credential helper at `gh auth git-credential`, so that one variable is what
makes both `gh` and `git push` work. Absent, `gh` reports itself logged out and a
push fails the way an unauthenticated push always did.

## Startup

`entrypoint.sh` is the container's entrypoint, not `/init`. It cannot be `/init`:
s6 compiles its service database **once**, before any service runs, so the set of
services has to be settled first. The entrypoint reads the plan, exports the
computed environment, writes the router config and the service tree, and then
`exec`s `/init`.

```
mysql-init ──→ mysqld ──┐
minio ──────────────────┼──→ db-init ──→ every backend, every server
deps-init ──────────────┘
caddy   (ungated)
```

Oneshots gate longruns, so nothing serves traffic against a database that is not
ready. Which of them exist depends on the plan: `mysql-init` and `mysqld` only for
`driver: mysql`, `minio` only when storage is declared, `deps-init` only when there
is a dependency tree. A `driver: none` project gets `db-init` and `caddy` and its
own services, and nothing else — that is most of why such a sandbox is cheap.

`db-init` provisions the database, runs migrations, creates buckets and applies
fixtures. It exists for every driver, `none` included, because it is also what
writes the status file the dashboard reads: a sandbox with no database still has to
be able to say it finished booting.

**Caddy is deliberately not gated on `db-init`.** It serves the status surface and
the "not built yet" pages, neither of which touches the database, and a first-boot
restore legitimately takes minutes — which is exactly when the dashboard most needs
an answer. A backend that is not up yet is a 502, and a 502 is a truthful answer;
a refused connection is not an answer at all. (The implementation this is ported
from did gate Caddy on database init, and the sandbox was unreachable and
unexplained for the whole of its first boot as a result.)

## Three runtime kinds

| Kind | Declared | Built | Run | Served |
|---|---|---|---|---|
| `backend` | `backends[]` | `build-backend.sh`, on demand | supervised longrun | proxied on its label's hostname |
| `static` | `frontends[]` with `out:` | `build-static.sh`, on demand | not a process | file server on its label's hostname |
| `server` | `frontends[]` with `serve:` | nothing (`build-server.sh` runs an optional `prepare`) | supervised longrun | proxied on its label's hostname |

The third kind is the one the source implementation did not have, and it is not a
variation on the other two. A project whose app *is* a dev server — a Workers
project, a framework with no static export — cannot be expressed as a static build
with a watcher bolted on, and cannot be expressed as a backend because it is the
front-end. It is also the most expensive thing in a sandbox: a dev server holds its
whole module graph in memory for as long as the container lives, whether or not
anyone opens it. That is why a project can mark one `optional`, and why
`SANDBOXR_WITH` exists.

**Static builds are on demand, never at startup.** A sandbox has to come up in
seconds. An app nobody opens should cost nothing, and an app that has not been
built yet answers with a page naming the command to build it.

`build-static.sh` takes a label, or `--all` (everything the plan does not exclude
with `in_build_all: false`), or `--built` (only what this sandbox has already
built, read from `/srv/www/.built.json`). The distinction matters once a sandbox has
built something expensive: `--built` refreshes what is there without ever starting
a first build of something deliberately excluded from `--all`.

## The router

`gen-caddyfile.sh` writes `/run/sandboxr/Caddyfile` at every boot from the plan and
the environment. Host matchers are exact: `<slug>--<label>--<project>.<domain>`.

The domain comes from `SANDBOXR_DOMAIN`. This is worth stating because the source
implementation hardcoded its domain in thirteen places in a static Caddyfile, and
therefore had a domain override that silently did nothing — every request landed on
the catch-all 404 and nothing said why.

The status surface answers on **every** hostname the sandbox serves:

| Path | What |
|---|---|
| `/__sandboxr/live` | `ok`, unconditionally — the container is up |
| `/__sandboxr/status.json` | the composed status document (below) |
| `/__sandboxr/built.json` | label → last build time, for every built app |
| `/__sandboxr/health/<service>` | proxied to that service's declared health path |
| anything else under `/__sandboxr/` | `404` |

**The `/__sandboxr/` prefix is reserved and answers before any app block.** The
last row is not a tidy-up: without it a path under the prefix that names nothing
fell through to the site block for whatever hostname it arrived on, because a host
matcher matches every path. A health route is written **only** for a service that
is going to run — a service the plan marks `optional` and nobody named in
`SANDBOXR_WITH` gets none, deliberately — so the probe of a dormant service was
the request that landed there. What came back was the front-end's own answer: an
unbuilt app replied with its 503 "not built yet" page, and the dashboard read
every dormant service as `down`; once that app was built the same request got the
SPA's `index.html` and a 200, and the same never-started service read as `up`. A
service's reachability must not depend on whether an unrelated front-end has been
built, which is what the 404 restores — the router saying it has no route, which
is a different answer from a service saying no.

`status.json`:

```json
{
  "project": "acme", "slug": "feat-checkout", "domain": "sbx.lcl",
  "state": "booting | ok | degraded",
  "database": { "driver": "mysql", "name": "acme" },
  "migrations": { "state": "ok | failed | skipped | unknown", "file": "", "error": "" },
  "bootedAt": "2026-08-25T13:41:27Z", "updatedAt": "2026-08-25T13:44:02Z"
}
```

`state` is **derived, never asserted**: every writer records a fact in its own
marker file under `/run/sandboxr` and calls `status.sh`, which composes the answer.
Two writers therefore cannot disagree about whether the sandbox is degraded.

## Why the pieces are the way they are

### Debian bookworm, not a vendor MySQL image

The obvious base for a project that needs MySQL is the official MySQL image with a
toolchain layered on top. It does not work. That image is Oracle Linux 9, whose
glibc is 2.34, and Cloudflare's `workerd` — which anything running miniflare or
`wrangler dev` needs — requires 2.35. It fails with `GLIBC_2.35 not found` and no
amount of configuration helps.

Bookworm has glibc 2.36 and satisfies `workerd`, `sharp` and every other native
Node module. The cost is installing MySQL separately, which is now a per-project
concern anyway.

### MySQL from the vendor's generic glibc tarball

Debian's archive carries MariaDB, which is not a drop-in substitute for a project
that depends on MySQL collation names or MySQL advisory-lock semantics.

The vendor's own APT repository would be the natural alternative, and it cannot be
used: **its signing key is expired**, so `apt-get update` refuses the repository
outright and there is nothing a Dockerfile can do about that. The generic tarball
is built against an older glibc than bookworm's, runs fine here, and pins an exact
version rather than tracking whatever a repository currently serves.

The one cost is that the download host has no machine-readable release list, so a
series (`8.4`) resolves through a small pinned table in the template. Go and Node
both publish an index and are resolved from it; MySQL cannot be.

### Dependencies install to `/opt/deps`, outside the worktree path

The worktree is bind-mounted over `/workspace` at run time, and a bind mount hides
whatever the image put underneath it. A dependency tree installed at its natural
location inside the project would simply vanish the moment the container started.

So the image installs to `/opt/deps` and `deps-init.sh` seeds the `node_modules`
volume from it on first boot. The volume is keyed on the lockfile hash, so every
sandbox with the same dependencies shares one install, and a branch that changes
its dependencies transparently gets its own — `deps-init` compares the worktree's
lockfile hash against the one stamped into the image and runs a real install when
they differ.

`deps-init` also re-links workspace `bin` entries. The image installs from
manifests alone, and npm skips a `bin` whose target file does not exist yet — so a
build script one workspace package exposes to another is missing, and the build
fails with a bare `code 127` that names nothing.

**"Installed" is a marker the script writes last, not a non-empty directory.**
`node_modules/.sandboxr-deps` holds the lockfile hash the install came from, and is
renamed into place only after the copy or the install has finished. The volume is
*shared* — every sandbox on that lockfile mounts the same one — so a boot
interrupted part-way through the copy leaves a tree that is non-empty and short of
packages, which a directory listing cannot tell from a finished install. That
poisons the volume permanently and every sandbox on the lockfile inherits it; the
only symptom is builds failing to resolve imports that plainly exist. A volume
whose marker is missing or names a different lockfile is repopulated over the top
rather than emptied first, because another sandbox may be running against it at
that moment.

### MinIO is in the base, not a project layer

It is the largest thing in the base image by a wide margin, and it is there anyway.
A public sandbox driven by a stranger must not be able to write to production
object storage, and the only reliable way to guarantee that is for the endpoint the
code sees to be local — which means the stand-in has to be present whether or not
the project remembered to ask for it. That is a guarantee, not a feature, so it
does not belong behind a config flag.

### `jq` is not optional

The plan is JSON, the base image deliberately has no Node, and hand-rolling a JSON
parser in shell is how these scripts would start quietly disagreeing with what the
plan actually says. `gettext-base` comes along for `envsubst`, which expands the
plan's environment templates without running a shell.

### A run script must `exec` its service

`logged.sh` redirects with `>>`, never a pipe. Writing `exec cmd | tee log` makes
the *shell* the supervised process: `s6-svc -r` then signals the shell, the service
survives the restart still holding its port, and every replacement dies with
`address already in use` while the old code carries on serving. It looks like a
deploy that did nothing.

Per-service log files exist because `docker logs` interleaves every process in the
container and cannot be filtered after the fact, which is what makes a busy sandbox
unreadable — for a person and for an agent. The files are trimmed rather than
rotated: these are development logs, and a sandbox left up for days must not be
able to fill its own disk.

### Caddy's `file` matcher resolves against `root`

`root` is set **before** the matcher in all three static snippets. Testing for
`index.html` first resolves it against Caddy's working directory instead, always
misses, and makes every built app report itself as not built.

### A failed migration does not stop the sandbox

`db-init.sh` and `migrate-run.sh` always exit zero. Inspecting a failed migration is
a reason the sandbox exists, so the failure is recorded, the services boot, and the
sandbox reports `degraded`. Killing the container would destroy the evidence.

`migrate-run.sh` does not trust the runner's exit code alone, when the project tells
it not to: a runner that prints its own summary and then exits zero reports success
while the schema is half-applied — and a sandbox builds that runner from the branch
it is testing, so the branch may be exactly the one with the bug. A project that has
such a runner names a `failure_pattern`.

It also reads `PIPESTATUS[0]` rather than the pipeline's status, because `tee`
always succeeds and testing the pipeline reports every failed migration as a
success.

### The schema baseline survives a failed run

DDL is not transactional in every engine, so a migration can fail with earlier
statements already committed, and "what did that actually change?" is the question
worth answering. For that the baseline has to be the last schema known to be clean,
so it is taken when there is none and re-taken only after a **success**.
Re-snapshotting on every attempt would overwrite it with the half-migrated state
the failure left behind, and the diff would then show nothing exactly when it
matters most.

### One writer per file-backed database

Two processes opening the same SQLite or D1 file deadlock on `SQLITE_BUSY`, which
turns a slow boot into a hang with nothing in the log. `database.owner` names the
single service allowed to open it; `run-server.sh` withholds the database's location
from every other server, so a second one fails loudly on a missing binding instead
of quietly hanging on a lock. Fixtures are applied with the SQLite CLI directly
rather than through the project's own tooling, because `db-init` gates every service
and is therefore the one moment when nothing else holds the file.

### A memory requirement is refused up front

A build that renders many pages across several worker processes is not bounded by
any single heap limit — the cgroup total is what the kernel kills — and from outside
that looks like a bare `Killed` and a package manager's exit code 137, which say
nothing at all about memory. `build-static.sh` compares the app's declared `memory`
against the container's cgroup limit and refuses in a second, naming the limit and
the fix. It *also* sets `--max-old-space-size` to 75% of the limit, so a single
overrunning process gives up with a JS heap error rather than being killed
silently; that bounds one process, not their sum, which is why the check exists as
well.

### A service whose dependencies do not exist is omitted, not left to crash-loop

A project can declare a service that cannot possibly start in a sandbox — most
often because it needs a database that no migration creates and that exists on no
developer machine. Such a service must be left out of the plan, or marked
`optional`. Including it produces a permanent crash-loop that fills the log and
makes the sandbox look broken, and no amount of supervision improves on that.

## What was deliberately not ported

The implementation this comes from had three behaviours that are correct there and
wrong here.

- **Migration bookkeeping repair.** It read the project's `migrations` table,
  identified rows left unfinished by an earlier attempt, and healed the ones whose
  files no longer existed. That encodes one project's bookkeeping schema, and
  contracts §6 is explicit that the tool never reimplements the project's migration
  logic. The reasoning is worth keeping and belongs in the project's own runner:
  heal a row by *completing* it, never by deleting it, because deleting makes the
  runner treat a half-applied file as pending again — and never heal a row whose
  file is still present, because that marks a broken migration as done and the next
  run fails one migration further along, until the database looks fully migrated
  having never run any of it.
- **Per-app environment file generation.** It wrote a `.env.local` into each
  package with a fixed list of framework-prefixed variables. Those names are the
  project's, so the plan's `env` map now carries them and the build reads them off
  the environment. "Inherits" is the word to be careful with: a build under
  supervision inherits them, and a build the host starts with `docker exec` does
  not — that one goes through `scripts/with-env`, and the host's rebuild does.
- **The docker CLI in the image.** It was there because the dashboard ran from the
  same image and shelled out to the CLI. Here the dashboard is a host-side Node
  service, so the sandbox has no reason to talk to Docker at all.

## Verifying without a full build

A real image build is slow and network-heavy. Everything below runs in seconds and
covers the parts most likely to be wrong.

```bash
# syntax. `with-env` has no extension, so it needs naming: it is a script like
# any other, and a check that silently skipped one would be worse than no check.
find container/scripts \( -name '*.sh' -o -name with-env \) -print0 | xargs -0 -n1 bash -n

# lint (follows the sourced library, so LOG_TAG and the helpers resolve)
docker run --rm -v "$PWD/container:/c:ro" koalaman/shellcheck-alpine:stable \
  sh -c 'cd /c && find scripts \( -name "*.sh" -o -name with-env \) | sort | xargs shellcheck -x -S warning'

# the generators, against both example plans, in a scratch directory
#   SANDBOXR_SCRIPTS / _RUN / _LOGS / _STATE / _WWW / _S6_DIR / _S6_SKEL
#   all override their container defaults for exactly this purpose

# the generated router
docker run --rm -v "$PWD/out:/w:ro" caddy:2-alpine \
  caddy validate --config /w/Caddyfile --adapter caddyfile
```

### What has been verified

- `bash -n` and `shellcheck -x -S warning` are clean across every script.
- `env.sh` reads a secrets file exactly as the host writes one, driven from
  `packages/core/src/secrets-container.test.ts`: a value containing ` # `, one
  containing `$(...)`, significant edge spaces and a leading quote all survive the
  round trip; a hand-edited unquoted line works; a comment, a blank line, a line
  with no `=`, an unusable name and a missing final newline are each handled; a
  name the host already set is not replaced; and a plan `env` value can expand a
  secret. Real bash, jq and envsubst, under `set -euo pipefail`.
- Both example plans generate a service tree and a router config, and both
  generated Caddyfiles pass `caddy validate`.
- Served for real: a built app serves, a deep path falls back to `index.html`, an
  unbuilt app answers 503 with instructions, `/__sandboxr/live` answers 200 on any
  hostname, and an unknown host answers 404 naming the host.
- `db-init` → `migrate-run` → `status.sh` produce the right state for each outcome:
  no migration command → `ok`/`skipped`; a command that fails → `degraded`/`failed`
  with the file and error extracted; a command that exits zero while printing its
  own failure summary → `degraded`, via `failure_pattern`; a clean run → `ok`.
- `build-static.sh` refuses a declared memory requirement the container cannot
  meet, and builds and swaps in a directory when it can.
- The project template renders to a lint-clean Dockerfile (`docker build --check`)
  for three block combinations: Go+Node+MySQL, Node+SQLite, and Go alone.
- The base image builds (~400 MB, glibc 2.36) and boots: s6 compiles the generated
  tree, the ungated services start immediately, `db-init` runs the driver dispatch
  and provisions buckets, an on-demand build lands in `/srv/www` and is served
  through the generated router, and every computed and aliased environment variable
  reaches each supervised service.

### What is NOT verified

**No project layer has ever been built, and no project has ever been booted in a
sandbox.** Everything in the list above was exercised against the base image, hand
written plans and stub commands. Assume nothing beyond it works until someone runs
a real project through, and expect to find bugs when they do.

Specifically unverified:

| Area | What a real run would settle |
|---|---|
| `project/Dockerfile.template` | It renders lint-clean, and has never been built. Every download in it is unproven: the Go and Node index queries, the MySQL tarball URL for a real series, the `sqlite3` and `libaio1` installs. |
| Toolchain resolution | That a config prefix (`1.26`, `24`) picks the release a project meant, on both architectures. |
| MySQL | Data-directory initialisation, the app user and grants against a live server, restoring a real dump, and the schema snapshot. |
| Dependency seeding | The `/opt/deps` seed, the lockfile-hash mismatch path that falls back to a real install, and the workspace bin-linking. |
| `d1` / `sqlite` | Provisioning from real miniflare state, locating the SQLite file by glob, and whether the owner rule actually prevents the deadlock it exists to prevent. |
| The s6 graph under load | It boots for a two-service plan. A plan with five backends, a dev server and a first-boot restore has not been started. |
| Backends | No backend has been built or run: `build-backend.sh`'s staleness check and `run-backend.sh`'s build-failure pause are both untested against a real compiler. |

The single highest-value next step is to run one real project end to end. Nothing
in the list above is expected to be structurally wrong; all of it is expected to
have at least one thing wrong in the details.
