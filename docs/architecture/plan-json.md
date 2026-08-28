---
title: plan.json
description: The single boundary between the host and the container — what is in it, why it exists, and where it lives.
sidebar:
  order: 3
---

`plan.json` is the container's **entire** view of the project. Nothing inside a sandbox ever reads
`sandboxr.yaml`.

## Why the boundary is here

| If the container parsed YAML | With a resolved plan |
|---|---|
| The schema, the defaults and the version rules live in the image | The image knows nothing about any project |
| Changing a default means rebuilding every image | Changing a default is a host-side change |
| Shell scripts would need a YAML parser | `jq` reads a flat, already-decided document |
| Two implementations of "what does this config mean" | One, on the host, with tests |

The host resolves everything: defaults applied, kinds decided, paths made absolute-or-relative in
exactly one way, access rules already enforced. What reaches the container is a series of
statements of fact.

The container **hard-fails** if the plan is missing or is not valid JSON. It never guesses.

## The whole plan

A complete plan for the fictional project **acme**: three Go backends, several front-ends, a CMS
dev server, MySQL and object storage.

```jsonc
{
  "project": "acme",                    // required

  "database": {
    "driver": "mysql",                  // mysql | d1 | sqlite | none
    "version": "8.4",
    "name": "acme",                     // defaults to the project name
    "owner": "app",                     // file drivers: the one service that may open it
    "fixtures": "db/seeds/fixtures.sql",         // repo-relative
    "seed": { "path": "acme-3f2a1b.sql.zst", "anonymised": true },
    "migrate": {
      "workdir": "services",            // repo-relative; omitted means run in an empty directory
      "command": "go run ./cmd/migrate --env local",
      "since": "20240101",              // exported as SANDBOXR_MIGRATE_SINCE
      "failure_pattern": "[0-9]+ failed",
      "file_pattern": "[0-9]{8}-[^ ]+\\.sql",
      "error_pattern": "Error [0-9]+ \\([0-9A-Z]+\\):.*"
    }
  },

  "storage": { "driver": "minio", "buckets": ["uploads", "avatars", "exports"] },

  "toolchain": { "go": "1.23", "node": "22" },

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

## The nine keys

| Key | What it is |
|---|---|
| `project` | The project's name. Required. Appears in the container name, the volume names and every hostname |
| `database` | The sandbox's **own** database — driver, version, name, owner, fixtures, seed, migrate |
| `storage` | `{ driver }`, plus `buckets` when non-empty |
| `toolchain` | `{ go?, node? }`. Decides which blocks the project's image layer includes |
| `deps` | The Node tree: `root`, `lockfile`, `install`. Omitted when there is none |
| `services` | One flat array — backends first, then front-ends — each with an explicit `kind` |
| `routes` | Copied from the config verbatim |
| `env` | Copied verbatim. The container expands `${SANDBOXR_*}` placeholders, not the host |

### `database.seed`

`{ "path": …, "anonymised": … }`, where `path` is the path **inside the container** — never a
host path, and never a bare name the container has to resolve against a directory:

| The artifact | `path` | What the host mounts |
|---|---|---|
| a dump sandboxr took and cached | `/sandboxr/cache/<name>` | the cache directory, read-only |
| a `database.seed_from.file` the project declared | `/sandboxr/seed/<name>` | that one file, read-only |

The two cases differ because a cached dump is content-addressed into `~/.sandboxr/cache`, where
the filename is the identity and the directory is fixed at both ends, while a declared file may
be anywhere and its directory is the only thing locating it. The declared file is bind-mounted
rather than copied into the cache: a dump is routinely tens of gigabytes, so a copy would be
either remade on every start or stale the next time the file is rebuilt. The mount is the file
itself and not its directory, so pointing `file:` at something in a shared directory does not
hand the sandbox everything else in it.

The basename is kept in both cases, because the container chooses zstd, gzip or plain by
extension. `anonymised` reaches the container so it can say what it restored rather than having
to work it out.

### `services`

| `kind` | Fields |
|---|---|
| `backend` | `name`, `label`, `port`, `build`, and optionally `health`, `workdir`, `memory`, `optional` |
| `static` | `label`, `package`, `root`, `build`, `out`, `static_mode`, and optionally `memory`, `in_build_all` (written only when `false`), `optional` |
| `server` | `label`, `package`, `root`, `serve`, `port`, and optionally `prepare`, `health`, `memory`, `optional` |

`root` is always present, `"."` when the config declared no `frontends.root`.

### `env` is for addresses, not secrets

Anything genuinely secret comes from the project's secrets file, which the host passes separately
and which never appears in the plan. The plan is written at ordinary file permissions and is
readable by anyone who can read the sandbox's configuration.

## What the sandbox computes for itself

The container derives its own addresses and exports them under a `SANDBOXR_` prefix; the `env` map
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

## Where it lives, and what else is mounted

The plan is written on the host at `~/.sandboxr/build/<project>/<slug>.plan.json` and mounted
**read-only** — a container that could rewrite its own plan could change what it claims to be
running.

| Inside the container | What it is |
|---|---|
| `/workspace` | the worktree, bind-mounted read-write |
| `/sandboxr/plan.json` | the plan, read-only |
| `/sandboxr/cache` | the host's seed cache, read-only |
| `/sandboxr/seed/<name>` | a declared seed file, that one file, read-only — only when the project declares one outside the cache |
| `/var/log/sandboxr` | per-sandbox logs, so they outlive the container |
| `/var/lib/sandboxr/data` | the database volume |
| `/var/lib/sandboxr/blob` | the object-storage volume |
| `/var/lib/sandboxr/bin` | built binaries |
| `/srv/www` | built websites |
| `/workspace/<deps.root>/node_modules` | the shared dependency volume, keyed on the lockfile hash |

The host-side constants for every path above are in `packages/core/src/sandbox/layout.ts`, which
must agree with `container/README.md` exactly.

`SANDBOXR_SLUG` is the one environment variable the container **requires**. Everything else has a
default. [The full list](../reference/environment.md).

## Related

- [The startup graph](startup.md) — what the plan is used to generate
- [How a request arrives](request-path.md) — the router, also generated from it
- [Three runtime kinds](../configuration/runtime-kinds.md) — the `kind` field, in depth
