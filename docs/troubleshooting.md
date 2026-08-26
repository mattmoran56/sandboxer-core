---
title: Troubleshooting
description: Failures whose symptom looks nothing like the cause — a full disk reported as a corrupt database, a memory kill reported as a broken build.
sidebar:
  order: 9
---

Ordered by how misleading the symptom is, not by how common it is. The entries near the top waste
an afternoon, because the message names the wrong thing entirely.

**Start here, in this order.** Each step is cheap and rules out the one below it.

```bash
sandboxr doctor              # is the local setup sane at all?
docker system df             # disk, because a full disk lies about what it is
sandboxr ls                  # is it running, and is it degraded?
sandboxr status <slug>       # one sandbox in detail, including the migration verdict
sandboxr logs <slug>         # the container's own stream
sandboxr db shell <slug>     # the database, if the symptom is a data one
sandboxr shell <slug>        # inside, and look for yourself
```

Add `--json` to any of them for a machine-readable result on stdout.

## The ones that waste hours

### MySQL will not start, and reports a corrupt database

```
InnoDB: Operating system error number 28
InnoDB: Error number 28 means 'No space left on device'
InnoDB: ... probably out of disk space
```

**The Docker disk is full.** InnoDB running out of space mid-write reports it as a data-file
problem, and the phrasing reads as a *corrupt* database rather than a full one. People spend an
afternoon on recovery procedures for a disk problem.

Check the disk before you believe anything else a failing database tells you.

| What grows | Reclaimed by |
|---|---|
| The base image (~400 MB, once per machine) | `docker image rm sandboxr/base:latest` |
| Project image layers | `docker image prune` |
| A sandbox's volumes (a few hundred MB each) | `sandboxr down <slug>` |
| **Docker's build cache — the thing that actually fills the disk** | `docker builder prune` |

`sandboxr gc` reaps sandboxes whose worktree is gone and removes orphaned volumes. It does **not**
prune the build cache, and never will: sandboxr deletes what it created, not what Docker created.

### An image build fails and the first line is a deprecation notice

```
Start sandbox: docker build -f /tmp/sandboxr-build-Xh39sf/Dockerfile -t sandboxr/acme:40ed880f9db8 … exited 1:
DEPRECATED: The legacy builder is deprecated and will be removed in a future release.
```

**The builder set no `TARGETARCH`, and the notice is only the first line of the output.**

`docker build` uses BuildKit when the `buildx` plugin is installed and the *legacy* builder when it
is not. The dashboard's image ships the Docker client on its own — no daemon, no compose, no
buildx — so a build started from a browser always runs on the legacy builder, and the legacy
builder sets none of BuildKit's built-in platform arguments. Every Dockerfile that switches on
`TARGETARCH` then fails in whatever way its shell fails: `TARGETARCH: unbound variable`, or
`unsupported arch ` with nothing after it, or a download of `linux-/…` that comes back 404 and
reads like a broken mirror. None of them names the architecture.

sandboxr's Dockerfiles resolve the architecture for themselves and fall back to `uname -m`, and the
host passes `--build-arg TARGETARCH` as well, so the architecture is no longer the problem. What
remains is the cache mounts: a project with a Go module or a dependency lockfile gets a
`RUN --mount=type=cache` in its image layer, which the legacy builder refuses outright —

```
Step 13/19 : RUN --mount=type=cache,target=/go/pkg/mod     cd /gomod && go mod download …
the --mount option requires BuildKit.
```

Until the dashboard image carries buildx, **build that project's image once from the host**, where
buildx is present:

```bash
sandboxr up --project acme --branch main     # on the host, where buildx is installed
```

The image tag is content-addressed, so the dashboard finds it already built and starts the sandbox
without building anything. A project that declares neither a Go module nor a `deps:` block has no
cache mount in its layer and builds from the dashboard either way.

### A build died with `code 137`

```
   Collecting page data ...
Killed
npm ERR! code 137
```

**The kernel's out-of-memory killer.** `137` is `128 + 9` — killed by `SIGKILL`. Nothing in the
output mentions memory, so it reads like a broken build.

A static site generator spreads rendering over many worker processes, so no single Node memory flag
bounds it. What the kernel measures is the **total for the whole container**.

```yaml
frontends:
  apps:
    - { label: www, package: marketing, build: npm run build, out: out, memory: 6g }
```

Then `sandboxr up` again — a memory limit is fixed when the container is created, so a rebuild
inside a running container cannot pick up a new one. There is no per-run override flag; the limit
is a fact about the project.

The whole sandbox then runs with 6 GB, not 6 GB for that build and 4 GB for everything else. The
container's limit is the **largest** `memory:` any single runtime declares, with a floor of 4 GB
that a smaller declaration cannot lower.

> [!CAUTION] It may not be your build that dies
> On a machine running several sandboxes, a heavy build gets *something* killed, and that something
> can be another sandbox — or your own local database container.

`sandboxr reload --web` watches for `137` or `Killed` and says so in words. Take it at face value.

### A restart changed nothing

You edit code, restart the service, and the old behaviour persists — or every restart logs
`address already in use` while the service carries on serving happily.

**The thing being supervised is a shell, not your service.** A run script that *pipes* its output
makes the shell the supervised process:

```bash
exec my-service | tee /var/log/my-service.log     # wrong
exec my-service >> /var/log/my-service.log 2>&1   # right
```

`exec` replaces the shell only when there is a single command. In a pipeline it does not: the shell
stays alive to manage the pipe, the supervisor watches the shell, and your service is a grandchild
it cannot signal.

The symptom is "my change did nothing", and you will read your own code for a long time before you
read a run script.

### Login succeeds and then every API call returns 401

**Two identity settings were merged that must not be.** An identity provider can serve the same
tenant on both a custom domain and a provider-issued domain. Fold the browser-side domain variable
into the server-side one because they look like the same thing, and one service rejects the other's
token as having an **invalid issuer**.

```yaml
secrets:
  rename:
    VITE_AUTH0_DOMAIN: SANDBOXR_AUTH0_SPA_DOMAIN
    VITE_AUTH0_CLIENT_ID: SANDBOXR_AUTH0_SPA_CLIENT_ID
```

### Two sandboxes' migrations hang, one at a time

**Two sandboxes collided on one database lock.** A migration takes a named lock containing the
sandbox's slug, and MySQL silently cuts a lock name off at 64 characters — so two long branch names
whose slugs match up to that point are one lock, and one migration waits for ever on the other.

sandboxr caps a slug at 31 characters and **hashes** rather than truncates past it, precisely to
prevent this. If you are seeing it, check what the sandboxes are actually called:

```bash
sandboxr ls
```

### A migration "succeeded" and the schema is half-applied

The output ends with `3 applied, 1 failed`, the exit code is 0, and the sandbox reports itself
healthy.

**The runner prints its own failure summary and then exits zero** — and the sandbox builds that
runner from the branch under test, so the branch may be exactly the one with that bug.

```yaml
migrate:
  command: go run ./cmd/migrate
  failure_pattern: "[0-9]+ failed"
```

> [!WARNING] The related trap, if you are writing this code
> `cmd | tee log` exits with `tee`'s status, and `tee` always succeeds. Testing the pipeline's
> status reports **every** failed migration as a success.

## Reaching a sandbox

### Nothing answers at all

```
curl: (7) Failed to connect to tkt-4821.app.acme.sbx.localhost port 443
```

Work outwards:

```bash
sandboxr doctor      # is the router running? on which ports? http or https?
sandboxr ls          # does the sandbox exist and is it running?
```

Common causes, in order:

| Cause | Fix |
|---|---|
| `sandboxr init` has never been run on this machine | `sandboxr init` |
| The router is publishing on non-default ports | The URL needs the port. `sandboxr status` prints the real one |
| The router is serving HTTP and you asked for HTTPS | `mkcert -install`, then `sandboxr init` again |
| The sandbox was started while the router was down | `sandboxr up` again — it warns when the router is not running |

### The browser warns about the certificate

The router is serving a certificate your machine has no reason to trust.

```bash
mkcert -install     # asks for your password once
sandboxr init       # re-issue and restart the router
```

`sandboxr init` will not install a trust root implicitly: it is the one step that needs an
administrator password.

### 404 from Traefik

The router is up and no sandbox matched the hostname. Check the slug and the project against
`sandboxr ls`, and the domain against `SANDBOXR_DOMAIN`.

### 404 naming the host it was asked for

You reached a sandbox and its own router serves no such hostname. Either the label is wrong, the
domain does not match the one the sandbox was started with, or the service is `optional` and was
not started — an optional service that was not requested has no site block at all, so its hostname
404s exactly as a misspelling would. `sandboxr up --with <name>`.

A label is also sanitised the way a slug is, so a label with an underscore or a capital in the
config is not the label in the URL.

### Reading the response you got

| Response | Means |
|---|---|
| **502** | The label is right and the service behind it is not up yet. A truthful answer during a first boot |
| **503 with build instructions** | The app is not built. `sandboxr reload --web <label>` |
| **404 from something that is clearly an API** | A `routes` prefix pointing at the wrong service, or none matched and the request fell through to the static files |

The fastest single check answers on **every** hostname a sandbox serves, and is deliberately not
gated on the database:

```bash
curl https://tkt-4821.app.acme.sbx.localhost/__sandboxr/live         # ok = the request arrived
curl https://tkt-4821.app.acme.sbx.localhost/__sandboxr/status.json  # booting / ok / degraded
```

### A domain override appears to do nothing

Every request lands on a catch-all 404 and nothing explains why. The sandbox's router config is
generated at every boot and reads the domain from `SANDBOXR_DOMAIN` in exactly one place — so if
you have hand-edited a generated config, the edit was lost on the next restart.

Ask the sandbox what domain it thinks it has: `sandboxr status <slug>`, or the `domain` field of
`status.json`.

### An API request 404s, and the route definitely exists

You reached the wrong service. Two apps commonly use the same prefix for different services:

```yaml
routes:
  app:
    "/api": api
  admin:
    "/api": adminApi      # not `api` — the admin app's paths are /admin/*
```

Prefix ordering is not the problem: the generator emits them longest-first whatever order you wrote
them in.

## Front-end builds

### `code 127` naming a binary that is definitely installed

`127` is command-not-found. An image that installs dependencies from manifests alone skips linking
a workspace command whose target file does not exist at install time, so the script that calls it
fails naming a binary that is plainly in the dependency tree.

The dependency step re-links workspace commands on every boot. If you are seeing this, check
`deps-init.log`.

### An app "works" but deep links are wrong

Three variants, all decided by `static_mode`:

| What happens | Cause | Fix |
|---|---|---|
| Every route except `/` is a 404 | A single-page app served as `files` | `static_mode: spa` |
| A deep link renders the home page instead of the page | A generator served as `spa` | `static_mode: html` |
| A typo'd asset filename returns HTML with a 200 | An asset directory served as `spa` | `static_mode: files` |

None of these is a crash, which is why the mode is declared rather than guessed.

### A dependency change did not take effect

`sandboxr reload` rebuilds code. It does not touch dependencies.

Installed dependencies live in a volume named after a hash of the lockfile, so a lockfile change
needs a new container pointed at a new volume: `sandboxr up`. That replaces the container and
**keeps its volumes**, so the database and uploads survive.

## Databases

### `Error 1044: Access denied ... to database 'acme_...'`

The grant is missing, or its underscore is not escaped. MySQL treats `_` as a single-character
wildcard in the database part of a `GRANT`:

```sql
GRANT ALL ON `acme\_%`.* TO 'sandboxr'@'%';
```

`acme_%` unescaped grants far too widely. `` `acme_%` `` in plain backticks grants on a database
*literally named* `acme_%`, and every sandbox then fails with 1044.

### `Refusing to run until these are resolved`

**A previous migration died part-way through, and the runner is protecting you.** That is correct
behaviour, and it is the project's own runner saying it, not sandboxr. If the sandbox was seeded
from a database in that state, it inherits it.

```bash
sandboxr db shell <slug>        # look
sandboxr db snapshot <slug>     # see what actually landed
sandboxr down <slug> && sandboxr up     # or just start clean
```

sandboxr does not touch the runner's bookkeeping table — that would be reimplementing the project's
migration logic. If you write the repair in the project: **complete a row, never delete it**, and
never complete a row whose migration file is still present. [Why](databases.md).

### A restore succeeded but binary columns are garbage

The dump is missing `--hex-blob`. Binary columns are otherwise written as escaped string literals,
and any character-set mismatch corrupts them — silently, because the restore itself succeeds.

### A permissions error on a statement nobody wrote

The dump is missing `--set-gtid-purged=OFF`, so it carries a `SET @@GLOBAL.GTID_PURGED` statement
that needs elevated privileges — and poisons the target's replication state if it does apply.

### A D1 or SQLite migration hangs

**Two processes have the same database file open.** A file-based database admits exactly one
writer; two deadlock on a busy lock, which turns a slow boot into a hang **with nothing in the
log**, and neither process looks like it is misbehaving.

```yaml
database:
  driver: d1
  owner: app        # the one service allowed to open the file
```

Count the openers — including a shell, a script, or a database browser you left open — before
looking at anything else.

### A sandbox's database file appears in `git status`

The runtime is not pointed at the sandbox's own state directory, so it is writing into
`/workspace`, which is your worktree.

```yaml
database:
  migrate:
    command: npx wrangler d1 migrations apply DB --local --persist-to "$SANDBOXR_D1_DIR"
```

Both the migrate command and the owner's serve command need it. Two sandboxes made from one
worktree are then also sharing that file, so this is usually the real cause of a hang as well.
`sandboxr doctor` warns when it can see the variable missing.

### `migrate.since` seems to be ignored

It is exported as `SANDBOXR_MIGRATE_SINCE` rather than added to your command as a flag — sandboxr
cannot guess a runner's flag spelling. **Your command has to reference it:**

```yaml
migrate:
  command: go run ./cmd/migrate --since "$SANDBOXR_MIGRATE_SINCE"
  since: "20240101"
```

### The pending migration count differs from another worktree

**Expected.** The set comes from *that worktree's* migration directory, which is exactly the "what
would this branch do" question you wanted answered.

## The sandbox itself

### `sandboxr ls` shows `degraded`

**The container is up and the migration failed.** Intended: the services boot anyway, because
inspecting a failed migration is one of the reasons the sandbox exists.

```bash
sandboxr status <slug>       # the verdict, the failing file, the error text
sandboxr logs <slug>
sandboxr db shell <slug>
```

`db-init.log` under `~/.sandboxr/logs/<project>/<slug>/` has the whole provisioning run.

### The sandbox sits at `starting` for ever

The log stops mid-way through database setup with nothing after it. For a file database that is the
two-writer deadlock above. For MySQL, check the disk first.

### Every dashboard button fails with a strange error

The dashboard loads the same `@sandboxr/core` the CLI does, so while a source file is half-saved
every button fails in whatever way that file fails. Check the CLI works before debugging the
dashboard.

### git refuses to create a worktree for a branch

git will not check out one branch in two places, and the branch you want is very often already
open in another checkout.

For a project in the workspace, sandboxr handles this itself — `sandboxr worktree add`, and the
dashboard's Start button, pick the right form for you:

| Where the branch is | What sandboxr runs |
|---|---|
| A local branch nothing has checked out | `git worktree add <path> <branch>` |
| A local branch checked out somewhere else | `git worktree add --detach <path> refs/heads/<branch>` |
| Only on the remote | `git worktree add -b <branch> <path> origin/<branch>` |
| A new branch off a base | `git worktree add -b <branch> <path> <base>` |

A worktree created the second way is **detached**, which is git working as intended rather than a
failure. sandboxr recovers the branch name from the commit, so the sandbox is still labelled and
still reachable at the hostname you expect.

For a repository you keep yourself, outside the workspace, run those commands by hand and then
`sandboxr up` from inside the worktree. That path is unchanged.

### A worktree was created but git exited non-zero

A repository hook can run *after* the checkout is already on disk, and fail — a `post-checkout`
hook depending on a tool the machine does not have does exactly this. **The tree on disk decides
whether it worked, not the exit code.**

### A sandbox exists for a worktree that is gone

```bash
sandboxr gc --dry-run
sandboxr gc
```

Such a sandbox is unreachable anyway — you cannot rebuild anything in it, because the source it
would build from is gone.
