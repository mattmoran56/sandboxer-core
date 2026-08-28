---
title: plan.json
description: The single boundary between the host and the container — what is in it, why it exists, and where it lives.
---

`plan.json` is the container's **entire** view of the project. Nothing inside a sandbox ever reads
`sandboxr.yaml`.

The host does all the thinking. It reads the config, applies every default, decides what kind each
service is, works out the addresses, and enforces the access rules. What reaches the container is a
flat document of statements of fact.

That is why one generic image can run a five-service database-backed monorepo and a single-worker
project on a file database. Nothing in the container names a service, a port, a package or a route.

## Why the boundary is here

| If the container parsed YAML | With a resolved plan |
|---|---|
| The schema, the defaults and the version rules live in the image | The image knows nothing about any project |
| Changing a default means rebuilding every image | Changing a default is a host-side change |
| Shell scripts would need a YAML parser | `jq` reads a flat, already-decided document |
| Two implementations of "what does this config mean" | One, on the host, with a schema and a type checker |

The container **hard-fails** if the plan is missing or is not valid JSON. It never guesses.

## The whole plan

A complete plan for the fictional project **acme**: a Go backend, a bundled front-end, a CMS dev
server, MySQL and object storage.

```jsonc
{
  "project": "acme",                    // required

  "database": {
    "driver": "mysql",                  // mysql | d1 | sqlite | none
    "version": "8.4",
    "name": "acme",                     // the project name; absent for driver "none"
    "owner": "app",                     // file drivers: the one service that may open it
    "fixtures": "db/seeds/fixtures.sql",         // repo-relative
    "seed": { "path": "/sandboxr/cache/acme-3f2a1b.sql.zst", "anonymised": true },
    "migrate": {
      "workdir": "services",            // repo-relative; omitted means run in an empty directory
      "command": "go run ./cmd/migrate --env local",
      "since": "20260209",              // exported as SANDBOXR_MIGRATE_SINCE
      "failure_pattern": "[0-9]+ failed",
      "file_pattern": "[0-9]{8}-[^ ]+\\.sql",
      "error_pattern": "Error [0-9]+ \\([0-9A-Z]+\\):.*"
    }
  },

  "storage": { "driver": "minio", "buckets": ["uploads", "avatars", "exports"] },

  "toolchain": { "go": "1.26", "node": "24" },

  "deps": {                             // omitted entirely if there is no Node tree
    "root": "web",
    "lockfile": "package-lock.json",
    "install": "npm ci --no-audit --no-fund"
  },

  "services": [
    { "kind": "backend", "name": "api", "label": "api", "port": 8001,
      "health": "/health", "workdir": "services",
      "build": "go build -o {out} ./{name}" },

    { "kind": "static", "label": "app", "package": "web", "root": "web/packages",
      "build": "npx vite build", "out": "dist", "static_mode": "spa" },

    { "kind": "server", "label": "cms", "package": "cms", "root": "web/packages",
      "serve": "npx next dev --port 3000 --hostname 127.0.0.1", "port": 3000,
      "prepare": "npm run codegen", "optional": true }
  ],

  "routes": { "app": { "/api": "api", "/cms": "cms" } },

  "env": { "DB_HOST": "${SANDBOXR_DB_HOST}", "S3_BUCKET": "uploads" }
}
```

> [!TIP] An absent field is absent, not null
> The emitter drops keys whose value is undefined rather than writing `null` or `false`. The
> container reads the plan with `jq`, where a missing key is the natural idiom and a `null` would
> have to be special-cased at every read.

## The eight keys

| Key | What it is |
|---|---|
| `project` | The project's name. Required. Appears in the container name, the volume names and every hostname |
| `database` | The sandbox's **own** database: driver, version, name, owner, fixtures, seed, migrate |
| `storage` | `{ driver }`, plus `buckets` when the list is non-empty |
| `toolchain` | `{ go?, node? }`. Decides which blocks the project's image layer includes |
| `deps` | The Node tree: `root`, `lockfile`, `install`. Omitted when there is none |
| `services` | One flat array — backends first, then front-ends — each with an explicit `kind` |
| `routes` | Copied from the config verbatim |
| `env` | Copied verbatim. The container expands `${SANDBOXR_*}` placeholders, not the host |

<details class="agent">
<summary><b>Details for an agent</b> — every field of every service kind</summary>

| `kind` | Fields |
|---|---|
| `backend` | `name`, `label`, `port`, `build`, and optionally `health`, `workdir`, `memory`, `optional` |
| `static` | `label`, `package`, `root`, `build`, `out`, `static_mode`, and optionally `memory`, `in_build_all`, `optional` |
| `server` | `label`, `package`, `root`, `serve`, `port`, and optionally `prepare`, `health`, `memory`, `optional` |

- `root` is always present, and is `"."` when the config declared no front-end root. The container
  joins it with the package name unconditionally, and an absent key there would have to be
  defaulted in shell.
- `optional` is written **only when true**. `in_build_all` is written **only when false**. Both
  defaults are the common case, and an absent key is the idiom.
- `static_mode` defaults to `spa`.
- `database.name` defaults to the project name, and is omitted entirely for `driver: none`.
- `database.owner` is resolved into the plan even when the config left it out, if the project has
  exactly one runtime to choose between. `run-server.sh` withholds the database's location from
  every server that is not the owner, so an absent owner would mean no server gets it and the one
  that needed it fails on a missing binding.
- `migrate.workdir` omitted means the migration runs in an empty directory. That is deliberate: a
  runner that resolves its config from relative paths can otherwise backfill a partially-set
  environment from whatever file it finds in the tree.

The emitter is `packages/core/src/config/plan.ts`. The authoritative specification of this boundary
is `container/README.md`, section "The plan", with two worked examples in
`container/examples/*.plan.json`. A test compares what the emitter produces against the shape of
those.

</details>

### `database.seed`

`{ "path": …, "anonymised": … }`, where `path` is the path **inside the container** — never a host
path, and never a bare name the container has to resolve against a directory.

| The artifact | `path` | What the host mounts |
|---|---|---|
| a dump sandboxr took and cached | `/sandboxr/cache/<name>` | the cache directory, read-only |
| a `database.seed_from.file` the project declared | `/sandboxr/seed/<name>` | that one file, read-only |

<details class="why">
<summary><b>Why it works this way</b> — two kinds of seed artifact, and why one is bind-mounted</summary>

A cached dump is content-addressed into `~/.sandboxr/cache`. The filename is the identity and the
directory is fixed at both ends, so a bare name would be enough to find it.

A declared `file:` may be anywhere the user keeps it — deliberately outside every repository, so
`git clean` cannot destroy it. Its directory is the only thing locating it. Taking its basename is
exactly the bug this design avoids: nothing failed loudly, and the sandbox started from an empty
database instead.

The declared file is bind-mounted rather than copied into the cache. A dump is routinely tens of
gigabytes, so a copy would have to be remade on every start or would go stale the next time the file
was rebuilt. The mount is the **file itself, not its directory**, so pointing `file:` at something
in a shared download directory does not hand the sandbox everything else in it.

The basename is kept in both cases, because the container chooses zstd, gzip or plain by extension.
A fixed mount path would have to guess.

`anonymised` reaches the container so it can say what it restored rather than having to work it out.
When `seed.path` is absent altogether the driver falls back to the newest dump in `/sandboxr/cache`,
so a `sandboxr db seed` takes effect without regenerating the plan.

</details>

### `env` is for addresses, not secrets

Anything genuinely secret comes from the project's secrets file, which the host mounts read-only at
`/sandboxr/secrets.env` at mode `0600` and which never appears in the plan. The plan is written at
ordinary file permissions and is readable by anyone who can read the sandbox's configuration, so it
carries addresses and never values — the `env:` map refers to a credential by name. Both mounts are
read-only: a container that could rewrite either could change what it claims to be running or what
it is authorised to reach.

Values are expanded with `envsubst`, which substitutes `${...}` and does not run a shell. A value
is data, and never a command.

## What the sandbox computes for itself

The container derives its own addresses and exports them under a `SANDBOXR_` prefix. The `env` map
is how a project reaches them under its own names.

| Variable | Present when |
|---|---|
| `SANDBOXR_DB_DRIVER`, `SANDBOXR_DB_NAME`, `SANDBOXR_DB_DIR` | always |
| `SANDBOXR_DB_HOST`, `_PORT`, `_USER`, `_PASSWORD` | `driver: mysql` |
| `SANDBOXR_DB_FILE` | `driver: sqlite` |
| `SANDBOXR_D1_DIR`, `SANDBOXR_D1_OWNER` | `driver: d1` |
| `SANDBOXR_S3_ENDPOINT`, `_KEY`, `_SECRET`, `_REGION` | storage is declared |
| `SANDBOXR_URL_<LABEL>` | one per label, upper-cased with hyphens as underscores |
| `SANDBOXR_PORT_<SERVICE>` | one per port-holding service |
| `SANDBOXR_MIGRATE_SINCE` | `migrate.since` is set |

`SANDBOXR_URL_<LABEL>` exists because only the container knows both the slug and the domain at the
moment a build runs. Same-origin API calls do not need it — the router serves `/api` on the app's
own hostname — but a link from one app to another needs an absolute, slug-bearing URL.

> [!TIP] `migrate.since` arrives as a variable, not a flag
> sandboxr cannot guess a runner's flag spelling, so the command has to consume it:
>
> ```yaml
> migrate:
>   command: go run ./cmd/migrate --since "$SANDBOXR_MIGRATE_SINCE"
> ```

The full list of variables, on both sides, is in
[Environment variables](../reference/environment.md).

## Where it lives, and what else is mounted

The plan is written on the host at `~/.sandboxr/build/<project>/<slug>.plan.json` and mounted
**read-only**. A container that could rewrite its own plan could change what it claims to be
running.

<details class="agent">
<summary><b>Details for an agent</b> — every mount the host provides</summary>

| Inside the container | What it is |
|---|---|
| `/workspace` | the worktree, bind-mounted read-write |
| `/sandboxr/plan.json` | the plan, read-only |
| `/sandboxr/cache` | the host's seed cache, read-only |
| `/sandboxr/seed/<name>` | a declared seed file — that one file, read-only. Only when the project declares one outside the cache |
| `/var/log/sandboxr` | per-sandbox logs, so they outlive the container |
| `/var/lib/sandboxr/data` | the database volume. Only for a driver that needs one |
| `/var/lib/sandboxr/blob` | the object-storage volume. Only when storage is declared |
| `/var/lib/sandboxr/bin` | built binaries |
| `/srv/www` | built websites |
| `/workspace/<deps.root>/node_modules` | the shared dependency volume, keyed on the lockfile hash |
| `/go/cache`, `/go/pkg/mod` | Go's build and module caches, shared machine-wide. Only for a Go toolchain |
| `/root/.claude` | Claude Code's state, shared machine-wide so an MCP server is authorised once per machine |
| `/root/.claude/.credentials.json` | the host's own Claude Code login, one file, read-write — and only when that file exists on the host |
| the worktree's own host path | the worktree a second time, at the path the host calls it |
| the repository's own host path | the bare repo or `.git` the worktree points at, read-write |

The last two are what make `git` work inside a sandbox, and they are mounted at the **identical
path inside and out** on purpose. A linked worktree's `.git` is a *file* naming its repository by
absolute path, so a container with only `/workspace` fails every git command with `fatal: not a git
repository` naming a directory that is not there. Neither mount is present for a plain checkout,
whose `.git` is inside `/workspace` already.

The host-side constants for every path above are in `packages/core/src/sandbox/layout.ts`, which
must agree with `container/README.md` exactly.

`SANDBOXR_SLUG` is the one environment variable the container **requires**. Everything else has a
default.

</details>

**Next:** [The startup graph](startup.md) — what the plan is used to generate. Or
[The three runtime kinds](../configuration/runtime-kinds.md) for the `kind` field in depth.
