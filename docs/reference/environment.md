---
title: Environment variables
description: Every SANDBOXR_ variable, in the three groups that matter — the ones you set, the handful the host passes into a container, and the ones a sandbox works out for itself.
sidebar:
  order: 2
---

> **Partly verified** — Every variable on this page was found by reading the code that reads it. The host-side set has not been exercised by a full `sandboxr up`; the container-side set is what the entrypoint scripts export.

There are a lot of variables here, and they are not one list. They fall into three groups, and
knowing which group a variable is in tells you almost everything about it.

| Group | Who sets it | Example |
|---|---|---|
| **1. You set it** | A person, on the machine | `SANDBOXR_HOME` |
| **2. The host passes it in** | sandboxr, on `docker run` | `SANDBOXR_SLUG` |
| **3. The sandbox works it out** | The container, at boot | `SANDBOXR_DB_HOST` |

Group 3 is the interesting one, and the reason for the whole design: a sandbox never *imports*
where its database is, because that would point a disposable copy at somebody's real database.
It computes it. [Why that split exists](#why-group-3-exists).

## 1. Variables you set

These are the only ones a person ever types. Nothing else on this page is yours to set.

### On any machine

| Variable | Default | What it does |
|---|---|---|
| `SANDBOXR_HOME` | `~/.sandboxr` | Where sandboxr keeps everything it writes: the seed cache, per-sandbox logs, certificates, secrets and generated files. Deliberately outside every repository, so `git clean -xdf` cannot destroy it. |
| `SANDBOXR_DOMAIN` | `sbx.localhost` | The suffix every sandbox hostname ends in. An app is `<slug>.<label>.<project>.<domain>`; the dashboard is the bare domain. |
| `SANDBOXR_IMAGE` | `sandboxr/base:latest` | The Docker image a sandbox runs. Set it to point at a project image layer you have built yourself. |

> [!WARNING] `SANDBOXR_IMAGE` is the whole story for project images today
> A sandbox is meant to run a thin per-project layer holding that project's toolchains and
> dependencies, built from `container/project/Dockerfile.template`. **Nothing renders or builds
> that template yet** — there is no `sandboxr` command for it. Until there is, sandboxr runs the
> generic base image, and `SANDBOXR_IMAGE` is how you point it at a layer you built by hand.
> [What is built](./status.md).

<details>
<summary><b>Details for an agent:</b> how SANDBOXR_HOME propagates, and the one place it must not be set in a shell profile</summary>

`SANDBOXR_HOME` overrides the root and everything else is derived from it, in
`packages/core/src/paths.ts` — there is no second variable to set.

```bash
export SANDBOXR_HOME=/var/lib/sandboxr
```

| Derived path | Contents |
|---|---|
| `$SANDBOXR_HOME/cache/` | Database seed artifacts, named by content |
| `$SANDBOXR_HOME/logs/<project>/<slug>/` | Per-sandbox logs — these survive `down`, on purpose |
| `$SANDBOXR_HOME/tls/` | Reserved for the certificate and key the machine-wide router will serve |
| `$SANDBOXR_HOME/state/` | Router config, and the dashboard's session key (mode 0600) |
| `$SANDBOXR_HOME/secrets/<project>.env` | Third-party credentials, mode 0600 |
| `$SANDBOXR_HOME/build/<project>/<slug>.env` | The generated environment for one sandbox |
| `$SANDBOXR_HOME/build/<project>/<slug>.plan.json` | The plan for one sandbox |
| `$SANDBOXR_HOME/bin/` | Helper binaries built on the host |

On a server, set this **in the service definition**, not in a login shell. A service started at
boot has no login shell, so it would silently fall back to `~/.sandboxr` under a service
account — somewhere nobody thinks to look. The dashboard reads the same variable and keeps its
session-signing key at `$SANDBOXR_HOME/state/session.key`.

Full layout: [where everything lives](../orientation/where-things-live.md).

</details>

### For a MySQL project

These are read on the **host**, by the MySQL driver, when it takes a seed from a database you
already run and when it creates the copy inside a sandbox. A project on `d1`, `sqlite` or
`none` never touches them.

| Variable | Default | What it does |
|---|---|---|
| `SANDBOXR_SOURCE_DB_USER` | `root` | The user the driver reads your **source** database with. Read-only work: nothing destructive ever touches the source. |
| `SANDBOXR_SOURCE_DB_PASSWORD` | *(empty)* | Its password. Empty means the `-p` flag is omitted entirely. |
| `SANDBOXR_DB_USER` | `sandboxr` | The user the sandbox's **own** database is created with. |
| `SANDBOXR_DB_PASSWORD` | `sandboxr` | Its password. |
| `SANDBOXR_DB_ROOT_PASSWORD` | `sandboxr` | The root password inside the sandbox's own MySQL. |
| `SANDBOXR_DB_NAME` | the project name | The database name inside the sandbox. Non-alphanumeric characters become `_`. |
| `SANDBOXR_MYSQL_IMAGE` | `mysql:<database.version>`, else `mysql:8.4` | The MySQL image a dump is restored into. |
| `SANDBOXR_CACHE_TTL_HOURS` | `24` | How stale a cached seed may get before it is taken again, whatever its content fingerprint says. |

The version comes from the project's `database.version`, not from an environment variable, on
purpose: a migration is only meaningfully tested against the version it will really run on.
Code: `mysqlSettings()` in `packages/core/src/drivers/mysql.ts`.

### For the dashboard

The dashboard is a separate process, and it reads its own set. The one that matters is the
password.

> [!CAUTION] `SANDBOXR_PASSWORD` is a root credential for the machine
> The dashboard talks to the Docker socket, because that is how it starts and stops containers.
> Anyone who has the password can run every action it offers. Generate it with
> `openssl rand -base64 32`, keep it in a secret manager, and keep it out of shell history.
> Without at least one password set, every action endpoint refuses.
> [Why this is not negotiable](../security/two-tiers.md).

<details>
<summary><b>Details for an agent:</b> every environment variable the dashboard reads, with its default</summary>

| Variable | Default | What it does |
|---|---|---|
| `SANDBOXR_PASSWORD` | — | Grants **every** project. Without at least one password, every action endpoint refuses. |
| `SANDBOXR_PASSWORD_<NAME>` | — | Grants the project `<name>` (lower-cased, `_` becomes `-`). Several may be set. |
| `SANDBOXR_PROJECTS_<NAME>` | — | Comma-separated projects that `SANDBOXR_PASSWORD_<NAME>` grants, when it should be more than one. |
| `SANDBOXR_DOMAIN` | `sbx.localhost` | The domain sandbox hostnames hang off. |
| `SANDBOXR_HOME` | `~/.sandboxr` | Where the session key lives (`state/session.key`, mode 0600). |
| `SANDBOXR_PORT` / `PORT` | `8080` | Listen port. |
| `SANDBOXR_HOST` | `127.0.0.1` | Bind address. Loopback by default. |
| `SANDBOXR_DOCKER_SOCKET` | `/var/run/docker.sock` | The daemon socket. |
| `SANDBOXR_SESSION_HOURS` | `168` | Session lifetime. |
| `SANDBOXR_SESSION_SECRET` | — | Signing secret, if you would rather not use the file. 32 bytes or more. Lets several replicas share sessions. |
| `SANDBOXR_INSECURE_COOKIES` | `0` | Drops `Secure` from the session cookie. Plain-HTTP localhost only, and the server says so at startup every time. |
| `SANDBOXR_TRUST_PROXY` | `1` | Read the client address from the right-most `X-Forwarded-For` hop, for rate limiting. |
| `SANDBOXR_LOGIN_MAX_ATTEMPTS` | `5` | Login attempts per client per window. |
| `SANDBOXR_LOGIN_WINDOW_SECONDS` | `60` | The window. |
| `SANDBOXR_CONTAINER_SCRIPTS` | `/opt/sandboxr/scripts` | Where the container keeps its scripts. |

Every `SANDBOXR_PASSWORD*` variable is **deleted from the environment** once it has been
hashed, so the processes an action spawns cannot inherit it. Code: `packages/server/src/env.ts`.
More: [the dashboard](../guides/dashboard.md).

</details>

## 2. Variables the host passes into a container

This list is short on purpose. The host tells a sandbox only the handful of facts it cannot
work out for itself: which worktree this is, which domain it answers on, and the credentials
its own services should be created with.

| Variable | Passed when | What it is |
|---|---|---|
| `SANDBOXR_SLUG` | **always** | The sandbox's short name. The one thing the container genuinely cannot derive — it knows its project from the plan, but only the host knows which worktree this is. |
| `SANDBOXR_PROJECT` | always | The project name, from the config. |
| `SANDBOXR_DOMAIN` | always | The hostname suffix the sandbox's own router builds its matchers from. |
| `SANDBOXR_ACCESS` | always | `public` or `private`, from `access.apps`. |
| `SANDBOXR_DB_USER`, `SANDBOXR_DB_PASSWORD` | driver is `mysql` | Credentials the sandbox creates its **own** database with. |
| `SANDBOXR_S3_KEY`, `SANDBOXR_S3_SECRET` | `storage.driver` is `minio` | Credentials the sandbox creates its **own** object store with. |
| `SANDBOXR_WITH` | `up --with a,b` was used | Comma-separated labels of `optional:` runtimes to start. |
| `SANDBOXR_SEED` | a seed source was chosen | Which cached seed artifact to provision from. |

That is the whole set. Nothing else crosses the boundary as an environment variable — the rest
of what a container knows comes from `plan.json`, the one file the host writes and the
container reads.

<details>
<summary><b>Details for an agent:</b> the exact conditions, the defaults inside the container, and the extra variable the unbuilt router needs</summary>

`containerEnv()` in `packages/core/src/sandbox/env.ts` builds this map, and it is the only
place that decides what crosses. The conditions above are literal `if` statements in that
function: the database pair is written only for `driver: mysql`, the storage pair only for
`storage.driver: minio`, `SANDBOXR_WITH` only when the list is non-empty, `SANDBOXR_SEED` only
when a source was chosen.

Defaults, if the host does not supply them: database user and password both `sandboxr`,
storage key and secret both `sandboxr`, domain `sbx.localhost`. `SANDBOXR_SLUG` has no default and
is required.

The map is rendered to `$SANDBOXR_HOME/build/<project>/<slug>.env` and given to
`docker run --env-file`. Values are written **unquoted**, because `--env-file` does not
interpret quotes and would carry them into the value.

The project's secrets file is layered *underneath* it as a second `--env-file`, which is what
makes the ordering a security property: a credential may be supplied from outside, but nothing
outside can redirect a sandbox's database or storage at something that is not its own.

`env.ts` also carries `SANDBOXR_SCHEME` (`https` unless told otherwise), which exists so the
container can build `SANDBOXR_URL_<LABEL>` with the right scheme once something in front of the
sandboxes terminates TLS. **Nothing in front of the sandboxes exists yet**, so today it is
always the default. [What is built](./status.md).

</details>

## 3. Variables the sandbox works out for itself

At boot, the container's entrypoint computes where everything inside the sandbox is and
exports it under the `SANDBOXR_` prefix. **Never import any of these** — that is what
[`secrets.never`](../configuration/secrets.md) is for.

| Variable | Present when |
|---|---|
| `SANDBOXR_DB_DRIVER`, `SANDBOXR_DB_NAME`, `SANDBOXR_DB_DIR` | always |
| `SANDBOXR_DB_HOST`, `SANDBOXR_DB_PORT`, `SANDBOXR_DB_USER`, `SANDBOXR_DB_PASSWORD` | `driver: mysql` |
| `SANDBOXR_DB_FILE` | `driver: sqlite` |
| `SANDBOXR_D1_DIR`, `SANDBOXR_D1_OWNER` | `driver: d1` |
| `SANDBOXR_S3_ENDPOINT`, `SANDBOXR_S3_KEY`, `SANDBOXR_S3_SECRET`, `SANDBOXR_S3_REGION` | `storage.driver: minio` |
| `SANDBOXR_URL_<LABEL>` | one per app label |
| `SANDBOXR_PORT_<SERVICE>` | one per port-holding service |
| `SANDBOXR_MIGRATE_SINCE` | `database.migrate.since` is set |

Your project's code does not read these names. It reads its own — `DB_HOST`, `S3_BUCKET`,
whatever it already calls them. The top-level `env:` block in `sandboxr.yaml` is the mapping
between the two:

```yaml
env:
  DB_HOST: "${SANDBOXR_DB_HOST}"
  DB_PORT: "${SANDBOXR_DB_PORT}"
  DB_NAME: "${SANDBOXR_DB_NAME}"
  S3_ENDPOINT: "${SANDBOXR_S3_ENDPOINT}"
  S3_BUCKET: uploads
  VITE_APP_URL: "${SANDBOXR_URL_APP}"
```

Only the project knows its own spelling, which is why the project states it. Values are
expanded with `envsubst`, which substitutes `${...}` and **does not run a shell**, so a value
is always data and can never become a command.

### Two you have to consume yourself

sandboxr exports these; it does not apply them for you.

- **`SANDBOXR_MIGRATE_SINCE`** is exported, not added to your migration command as a flag —
  sandboxr cannot guess a runner's flag spelling. Your command has to reference it:
  `go run ./cmd/migrate --since "$SANDBOXR_MIGRATE_SINCE"`.
- **`SANDBOXR_D1_DIR`** must be passed to wrangler's `--persist-to` by **both** the `serve`
  and the `migrate` command. Miss it and the runtime writes its database into your worktree
  instead of into the sandbox — a file that then shows up in `git status`, and is shared by
  every sandbox made from that worktree.

<details>
<summary><b>Details for an agent:</b> why a per-label URL variable exists at all, and when a same-origin path is better</summary>

Only the container knows both the slug and the domain at the moment a build runs, so an
absolute, slug-bearing URL cannot be written into the config by hand.

Most calls do not need one. The sandbox's router serves `/api` on the app's **own** hostname,
so a front-end calling `/api/things` makes a same-origin request: no absolute URL, no
cross-origin preflight, and CORS is out of the picture entirely. Prefer that.

`SANDBOXR_URL_<LABEL>` is for the case that genuinely needs an absolute address — a link from
one app to another, in a sandbox whose slug the code cannot know. The label is upper-cased and
every character outside `A-Z0-9` becomes `_`, so a front-end labelled `admin-api` is
`SANDBOXR_URL_ADMIN_API`. Same rule for `SANDBOXR_PORT_<SERVICE>`.

Specification: the "environment a sandbox computes for itself" section of `container/README.md`.

</details>

## Why group 3 exists

Because importing a developer's variables would quietly point a disposable copy at real things.

A `.env` file on somebody's laptop says `DB_HOST=127.0.0.1` and `S3_BUCKET=acme-uploads-prod`.
Import those and the sandbox appears to work perfectly — while writing to that developer's own
database, and uploading to the real bucket. Nothing fails. Nothing warns. That is the worst
possible failure mode, so the rule is absolute: **anything describing *where* something runs is
computed, never imported.**

| The sandbox computes | Because |
|---|---|
| Database host, port, user, password, name | The database is inside the sandbox |
| Object storage endpoint, credentials, region | Storage is inside the sandbox |
| Each app's own URL, and each service's port | Derived from the slug, the labels and the domain |
| Whether apps are public or private | The sandbox is told, and enforces it |

That is also why a new sandbox needs no configuration anywhere else. The only external system
that has to know a sandbox hostname exists is your **identity provider**, and one wildcard per
app label covers every slug for ever.

What you *do* import is the other half — real third-party credentials, which a sandbox cannot
invent. Those come through `secrets`, with a `never` list holding the patterns above so they
can never sneak back in. [Secrets, in full](../configuration/secrets.md).

## Setting them

**On a laptop** — a shell profile, so they survive a reboot:

```bash
# SANDBOXR_DOMAIN defaults to sbx.localhost, which is fine locally.
export SANDBOXR_PASSWORD='a long random string'
```

**On a server** — whatever that machine already uses for service configuration, never a login
shell:

```bash
export SANDBOXR_HOME='/var/lib/sandboxr'
export SANDBOXR_DOMAIN='sbx.example.com'
export SANDBOXR_PASSWORD="$(openssl rand -base64 32)"
```

Check what a command actually resolved:

```bash
sandboxr config      # where the config is, and what it resolved to
sandboxr doctor      # Docker, the config, credentials, and where SANDBOXR_HOME is
```

[The deployment guide](../running-on-a-server.md) has the rest — and is honest about how much of a
real remote deployment is still a plan rather than a feature.
