---
title: Symptom to cause
description: Failures whose symptom looks nothing like the cause — a full disk reported as a corrupt database, a memory kill reported as a broken build. Find the message you saw, and read what it really means.
sidebar:
  order: 1
---

> **Written, never run** — Every cause below is a failure that really happened while building the tool sandboxr generalises. None of the sandboxr commands prescribed as the fix has been run against a real project.

Ordered by how misleading the symptom is, not by how common it is. The entries near the top
are the ones that waste an afternoon, because the message you get names the wrong thing
entirely.

Every entry is the same shape: **what you see**, then **what it actually is**, in one line. If
a fix needs exact commands or exact detail, that part is folded away underneath — the symptom
and the cause are always in the open, so you can scan for your error message without opening
anything.

## The ones that waste hours

### MySQL will not start, and reports a corrupt database

**What you see**

```
InnoDB: Operating system error number 28
InnoDB: Error number 28 means 'No space left on device'
InnoDB: ... probably out of disk space
[ERROR] [MY-012574] [InnoDB] Unable to open data file
```

Or, part-way through a restore, a message about a corrupt tablespace.

**What it actually is: the Docker disk is full.**

InnoDB running out of space mid-write reports it as a data-file problem, and the phrasing
reads as a *corrupt database* rather than a full one. People spend an afternoon on recovery
procedures for a disk problem.

Check the disk before you believe anything else a failing database tells you.

```bash
docker system df
```

<details>
<summary><b>If it goes wrong:</b> what actually takes the space, and which command reclaims each part of it</summary>

Three things grow, and only one of them is sandboxr's to clean up.

| What | Roughly | Reclaimed by |
|---|---|---|
| The shared base image | 400 MB, once per machine | `docker image rm sandboxr/base:latest` |
| One project image layer | its toolchains and its dependency tree | `docker image prune` |
| One sandbox's volumes | a few hundred MB each — database, uploads, built output | `sandboxr down <slug>` |
| **Docker's build cache** | **the thing that actually fills the disk** | `docker builder prune` |

```bash
sandboxr gc --dry-run     # what it would reap, and nothing else
sandboxr gc               # reap sandboxes whose worktree is gone, and orphaned volumes
docker builder prune      # the build cache — sandboxr does not touch this
```

`sandboxr gc` reaps a sandbox whose worktree no longer exists on disk, and removes volumes no
surviving sandbox owns. **It does not prune Docker's build cache**, and the build cache is
usually the biggest single thing on the disk. That is a separate `docker` command and always
will be — sandboxr deletes what it created, not what Docker created.

</details>

### A build died with `code 137`

**What you see**

```
   Collecting page data ...
Killed
npm ERR! Lifecycle script `build` failed with error:
npm ERR! code 137
```

Nothing about memory. Nothing about limits. It reads like a broken build.

**What it actually is: the kernel's out-of-memory killer.** `137` is `128 + 9` — killed by
`SIGKILL`.

A static site generator rendering a few thousand pages spreads the work over many worker
processes, so no single Node memory flag bounds it. What the kernel measures is the **total
for the whole container**, and that total is what a sandbox has a limit on.

The fix is to say what that app really needs, in the project's own `sandboxr.yaml`:

```yaml
frontends:
  apps:
    - { label: www, package: marketing, build: npm run build, out: out, memory: 6g }
```

Then start the sandbox again. There is **no per-run override flag** — the limit is a fact
about the project, so it lives in the project's file.

<details>
<summary><b>If it goes wrong:</b> how the whole-sandbox memory limit is worked out, and why one app's number decides it</summary>

The container gets **one** memory limit, because a cgroup is one budget shared by everything
inside it. sandboxr computes it as the **largest `memory:` value any single app or service in
the project declares**, with a **floor of 4 GB**.

So in the example above, the whole sandbox runs with 6 GB — not 6 GB for the marketing build
and 4 GB for everything else. Declaring `memory: 6g` on one app raises the ceiling for the
sandbox it lives in.

- The floor is 4 GB. A project that declares no `memory:` anywhere gets 4 GB.
- Declaring `memory: 2g` does **not** lower it. The floor wins.
- Accepted units are `b`, `k`, `m`, `g`, matching `^[0-9]+(b|k|m|g)?$`. A bare number is bytes.
- Code: `memoryFor()` in `packages/core/src/sandbox/run.ts`.

> [!CAUTION] And it may not be your build that dies
> On a machine running several sandboxes, a heavy build gets *something* out-of-memory-killed,
> and that something can be another sandbox — or your own local database container. Stop what
> you are not using before a big build.

</details>

### `www was killed — that is the kernel taking it for memory, not a code error`

**What you see:** a rebuild fails, and sandboxr prints exactly that, naming the app.

**What it actually is: the same out-of-memory kill as above, already diagnosed for you.**

`sandboxr reload --web` watches the build's output for `137` or `Killed` and, when it sees
either, says so in words rather than leaving you with an exit code:

```
Building www (types are not checked here; CI does that)
www was killed — that is the kernel taking it for memory, not a code error.
  Give the sandbox more: set `memory` on that app in sandboxr.yaml and start it again.
```

Take it at face value. Set `memory:` on that app, then `sandboxr down` and `sandboxr up` so
the container is recreated with the new limit — a limit is fixed when the container is
created, so a rebuild inside the running container cannot pick up a new one.

### A restart changed nothing

**What you see:** you edit code, restart the service, and the old behaviour persists. Or
every restart logs `address already in use` while the service carries on serving quite
happily.

**What it actually is: the thing being supervised is a shell, not your service.**

A "supervisor" is the small program inside the sandbox that starts each service and restarts
it when it dies. It can only signal the process it started. If that process is a shell that
started your service as a child, restarting kills the shell and leaves your service running —
holding its port, answering requests, running the old code.

<details>
<summary><b>If it goes wrong:</b> the one-character difference in a run script that causes it, and how to spot it</summary>

A run script that **pipes** its output makes the shell the supervised process:

```bash
exec my-service | tee /var/log/my-service.log     # wrong
```

`exec` replaces the shell only when there is a single command. In a pipeline it does not: the
shell stays alive to manage the pipe, the supervisor is watching the shell, and your service
is a grandchild it cannot signal.

Redirect instead:

```bash
exec my-service >> /var/log/my-service.log 2>&1   # right
```

Redirect with `>>`. Never pipe. The symptom is "my change did nothing", and you will read your
own code for a long time before you read a run script.
[The startup graph](./architecture/startup.md) has the rest of the rules for supervised services.

</details>

### Login succeeds and then every API call returns 401

**What you see:** the login flow completes, the app loads, and every single request to the API
comes back 401. Nothing points at configuration.

**What it actually is: two identity settings were merged that must not be.**

An identity provider can serve the same tenant on both a custom domain and a provider-issued
domain. Fold the browser-side domain variable into the server-side one because they "look like
the same thing", and one service rejects the other's token as having an **invalid issuer**.

Keep them separate, by giving the browser-side ones their own names as they are imported:

```yaml
secrets:
  rename:
    VITE_AUTH0_DOMAIN: SANDBOXR_AUTH0_SPA_DOMAIN
    VITE_AUTH0_CLIENT_ID: SANDBOXR_AUTH0_SPA_CLIENT_ID
```

[The full explanation](./configuration/secrets.md).

### Two sandboxes' migrations hang, one at a time

**What you see:** a migration in one sandbox sits there doing nothing. Another sandbox
migrated fine ten minutes ago. There is no error and nothing in the log.

**What it actually is: two sandboxes collided on one database lock.**

A migration takes a named lock in the database so two runs cannot overlap. The name contains
the sandbox's short name — its **slug**. MySQL silently cuts a lock name off at 64 characters,
so if two long branch names produce slugs that are the same up to that point, they are one
lock, and one migration waits for ever on the other.

<details>
<summary><b>If it goes wrong:</b> the exact ceiling, the hash that avoids the collision, and how to check a slug</summary>

sandboxr caps a slug at **31 characters**. Over that, it keeps the first 22 characters, adds a
`-`, and appends the first 8 characters of a SHA-256 of the *raw* input. So
`feature/checkout-part-one` and `feature/checkout-part-two` end in different hashes and can
never be the same lock, where plain truncation would have made them identical.

The lock name is `sandboxr_migrate_<project>_<slug>`, with anything outside `[A-Za-z0-9_]`
replaced by `_`. `lockName()` in `packages/core/src/naming.ts` throws rather than returning a
name over 64 characters, so the collision is a loud error and not a hang.

See what a sandbox is actually called:

```bash
sandboxr ls
sandboxr status feat-123
```

This ceiling is load-bearing. [Why](./databases/mysql.md).

</details>

### A migration "succeeded" and the schema is half-applied

**What you see:** the migration output ends with something like `3 applied, 1 failed`, the
exit code is 0, and the sandbox reports itself healthy.

**What it actually is: the runner prints its own failure summary and then exits zero.**

And the sandbox builds that runner **from the branch under test**, so the branch may be
exactly the one with that bug. Tell sandboxr to read the output as well as the exit code:

```yaml
migrate:
  command: go run ./cmd/migrate
  failure_pattern: "[0-9]+ failed"
```

> [!WARNING] The related trap, if you are writing this code
> `cmd | tee log` exits with `tee`'s status, and `tee` always succeeds. Testing the pipeline's
> status reports **every** failed migration as a success. Read the first element of the
> pipeline's status array instead.

## Reaching a sandbox

### Nothing resolves

**What you see**

```
curl: (6) Could not resolve host: feat-123.app.acme.sbx.localhost
```

**What it actually is: nothing on your machine answers that name yet, and sandboxr does not
set that up for you.**

Two separate pieces are needed to turn a sandbox hostname into a running container, and
**neither is built today**:

1. Something has to resolve `*.sbx.localhost` to your machine. There is no `sandboxr` command that
   installs a resolver — setup is manual.
2. Something has to accept the request and hand it to the right container. **This does not
   exist.** sandboxr labels every sandbox container `sandboxr.router=true`, so a machine-wide
   router *could* find them, but no code starts or configures one.

So a fresh install cannot be reached by hostname at all. That is a missing feature, not a
misconfiguration, and no amount of DNS debugging will fix it. Do not spend time on
`/etc/resolver`, `dscacheutil` or certificates until the piece that answers the request
exists. [What is built](./reference/status.md).

<details>
<summary><b>If it goes wrong:</b> what does work today — talking to a sandbox from inside it — and what the hostname layer is designed to become</summary>

A sandbox publishes no ports to the host, deliberately: several sandboxes run at once and
would otherwise fight over the same port numbers. Every request is meant to arrive by
hostname. Until that layer exists, get inside and ask from there:

```bash
sandboxr shell feat-123
```

```bash
# The status surface answers regardless of which hostname was asked for.
curl -s localhost/__sandboxr/status.json
curl -s localhost/__sandboxr/live

# An app needs its own hostname in the Host header, because the sandbox's
# internal router matches on it exactly.
curl -s -H 'Host: feat-123.app.acme.sbx.localhost' localhost/
```

Note that there are **two** routers in this system, and only the inner one is real:

- The **sandbox's own router** runs inside every container. It is generated at each boot from
  the plan, and it is what splits `feat-123.app.acme.sbx.localhost` from
  `feat-123.api.acme.sbx.localhost` once a request has arrived. This works.
- The **machine-wide router** would sit in front of every sandbox, terminate TLS, and pick a
  container by hostname. This is designed and not written.

The design, for when it lands: a wildcard DNS record or a local resolver pointing
`*.<domain>` at the machine, one certificate covering the wildcard, and a proxy reconciling
from the `sandboxr.router=true` label as containers come and go. On a server that means real
certificates via ACME with a **DNS-01** challenge — HTTP-01 cannot issue a wildcard — and a
DNS wildcard matches exactly one label, so `*.sbx.example.com` does **not** cover
`feat-123.app.acme.sbx.example.com`. You would need `*.acme.sbx.example.com`.

</details>

### The browser warns about the certificate

**What it actually is: whatever is terminating TLS is serving a certificate your machine has
no reason to trust.**

Since sandboxr does not run anything in front of a sandbox yet, that certificate is coming
from a proxy you set up yourself, and it is yours to fix — either by trusting its development
certificate authority, or by issuing a real one. There is no sandboxr command that creates,
installs or renews a certificate.

`~/.sandboxr/tls/` is reserved for the certificate and key the machine-wide router will serve.
Nothing writes to it today.

### Reading the response you got

Once a request is actually arriving, the status code tells you which layer to look at.

| Response | Means |
|---|---|
| Nothing answers at all | Nothing is in front of the sandboxes. See above — that layer is not built. |
| **404 naming the host it was asked for** | You reached a sandbox and its internal router does not serve that hostname. A wrong label, or a domain mismatch. |
| **502** | The label is right and the service behind it is not up yet. A truthful answer during a first boot. |
| **503 with build instructions** | The app simply is not built. `sandboxr reload --web <label>`. |
| A 404 from something that is clearly an API | A `routes` prefix pointing at the wrong service, or prefixes in the wrong order. |

The fastest single check is the status surface, which answers on **every** hostname a sandbox
serves and is deliberately not gated on the database — so it answers during a first boot too,
which is exactly when you need it:

```bash
curl https://feat-123.app.acme.sbx.localhost/__sandboxr/live         # `ok` means the request arrived
curl https://feat-123.app.acme.sbx.localhost/__sandboxr/status.json  # booting / ok / degraded
```

### A domain override appears to do nothing

Every request lands on a catch-all 404 and nothing explains why.

The sandbox's internal router config is generated at every boot and reads the domain from
`SANDBOXR_DOMAIN` in exactly one place. If you have hand-edited a *static* router config
somewhere, or hardcoded the domain, the override cannot take effect — the tool sandboxr
generalises had its domain written into thirteen places, and its override silently did
nothing.

Ask the sandbox what domain it thinks it has:

```bash
sandboxr status feat-123
```

`status.json` carries the same answer in its `domain` field.

### An API request 404s, and the route definitely exists

You reached the wrong service. `routes` maps a path prefix on one app's hostname to one
service, and two apps commonly use the same prefix for different services:

```yaml
routes:
  app:
    "/api": api
  admin:
    "/api": adminApi      # not `api` — the admin app's paths are /admin/*
```

Also check the ordering: prefixes match most-specific-first, so `"/api/admin"` must be
declared before `"/api"`, or `/api` swallows it.

## Front-end builds

### The build fails with `code 127` naming a binary that is definitely installed

`127` is command-not-found.

An image that installs dependencies from manifests alone will skip linking a workspace command
whose target file does not exist at install time. The script that calls it then fails with a
bare `127`, naming a binary that is plainly in the dependency tree.

The dependency-seeding step inside the container has to re-link workspace commands after
seeding. [Context](./architecture/startup.md).

### An app "works" but deep links are wrong

Three variants, all decided by one field, `static_mode`:

| What happens | Cause | Fix |
|---|---|---|
| Every route except `/` is a 404 | A single-page app being served as `files` | `static_mode: spa` |
| A deep link renders the home page instead of the page | A static-site generator being served as `spa` | `static_mode: html` |
| A typo'd asset filename returns HTML with a 200 | An asset directory being served as `spa` | `static_mode: files` |

None of these is a crash, which is why the mode is declared rather than guessed. Otherwise you
find out from a user. [The three modes](./configuration/runtime-kinds.md).

### Every app says "not built yet", even ones you just built

If you are working on the sandbox's internal router config: a file matcher resolves against
the **document root**. Testing for `index.html` before setting the root always misses, so
every built app reports itself as unbuilt.

Set the root first, then test.

### A dependency change did not take effect

`sandboxr reload` rebuilds code. It does not touch dependencies.

The installed dependencies live in a volume shared between every sandbox whose lockfile
matches, and that volume is named after a hash of the lockfile. A lockfile change therefore
needs a new container, pointed at a new volume:

```bash
sandboxr up
```

Running `up` on a sandbox that already exists replaces the container and **keeps its volumes**,
so the database and uploads survive. Only `down` and `gc` remove volumes.

## Databases

### `Error 1044: Access denied ... to database 'acme_...'`

The grant is missing, or its underscore is not escaped. MySQL treats `_` as a single-character
wildcard in the database part of a `GRANT`:

```sql
GRANT ALL ON `acme\_%`.* TO 'sandbox'@'%';
```

`acme_%` unescaped grants far too widely. `` `acme_%` `` in plain backticks grants on a
database *literally named* `acme_%`, and every sandbox then fails with 1044.

### `Refusing to run until these are resolved`

**What it actually is: a previous migration died part-way through, and the runner is
protecting you.** This is correct behaviour, not a bug — and it is the project's own migration
runner saying it, not sandboxr.

A runner that tracks its own runs records a row before each migration and completes it
afterwards. A run that dies in the middle leaves a row with no completion time, and the runner
refuses to continue rather than guess. If the sandbox was seeded from a database in that
state, the sandbox inherits it.

Look first, then decide:

```bash
sandboxr db shell feat-123        # an interactive shell against this sandbox's own database
sandboxr db snapshot feat-123     # print the schema, to see what actually landed
```

If you just want a clean database to work in, throw the sandbox away and start again:

```bash
sandboxr down feat-123
sandboxr up
```

<details>
<summary><b>If it goes wrong:</b> why sandboxr will not repair the bookkeeping for you, and the rule for repairing it yourself</summary>

**sandboxr does not touch the runner's bookkeeping table.** Reading and writing it means
reimplementing the project's migration logic, which the
[driver contract](./databases/drivers.md) forbids, and it would only ever work for the one
project whose table you encoded. The repair belongs in the project's own runner.

The rule, when you do write that repair:

| Option | Consequence |
|---|---|
| **Delete the row** | The runner treats that migration as pending and runs it again. Re-running a migration that already applied half its DDL is exactly the hazard the refusal exists to prevent. |
| **Complete the row** | The runner treats it as done and moves on. Conservative: it may leave a half-applied state, but it applies nothing twice. |

Complete it, never delete it. And never complete a row whose migration genuinely failed on its
own merits — that marks a broken migration as done, so the next run fails one migration
further along, and the one after that further still, until the database looks fully migrated
having never really run any of it.

Remember that everything a sandbox does is against a **copy**. The source database is only
ever read, so nothing you do in `db shell` can reach it.
[The full reasoning](./databases/mysql.md).

</details>

### The pending migration count differs from another worktree

**Expected.** The set is computed from *that worktree's* migration directory, which is exactly
the "what would this branch do" question you wanted answered.

### A restore succeeded but binary columns are garbage

The dump is missing `--hex-blob`. Binary columns are otherwise written as escaped string
literals, and any character-set mismatch along the way corrupts them — silently, because the
restore itself succeeds.

### A permissions error on a statement nobody wrote

The dump is missing `--set-gtid-purged=OFF`, so it carries a `SET @@GLOBAL.GTID_PURGED`
statement that needs elevated privileges — and poisons the target's replication state if it
does apply.

### A D1 or SQLite migration hangs

**What it actually is: two processes have the same database file open.**

A file-based database admits exactly one writer. Two writers deadlock on a busy lock, which
turns a slow boot into a hang **with nothing in the log**, and neither process looks like it
is misbehaving.

Name the single owner in the config, and count the openers — including a shell, a script, or a
database browser you left open — before looking at anything else:

```yaml
database:
  driver: d1
  owner: app        # the one service allowed to open the file
```

[One writer per file](./databases/d1-sqlite.md).

### A sandbox's database file appears in `git status`

The runtime is not being pointed at the sandbox's own state directory, so it is writing into
`/workspace` — which is your worktree, bind-mounted into the container.

Both the migrate command and the app's serve command need `--persist-to $SANDBOXR_D1_DIR`:

```yaml
database:
  migrate:
    command: npx wrangler d1 migrations apply DB --local --persist-to $SANDBOXR_D1_DIR
```

Two sandboxes made from one worktree would then also be sharing that file, so this is usually
the real cause of a hang as well. `sandboxr doctor` warns when it can see the flag missing.
[Details](./databases/d1-sqlite.md).

### `migrate.since` seems to be ignored

It is exported as the environment variable `SANDBOXR_MIGRATE_SINCE` rather than added to your
command as a flag — sandboxr cannot guess a runner's flag spelling. **Your command has to
reference it:**

```yaml
migrate:
  command: go run ./cmd/migrate --since "$SANDBOXR_MIGRATE_SINCE"
  since: "20240101"
```

## The sandbox itself

### `sandboxr ls` shows `degraded`

**What it actually is: the container is up and the migration failed.** This is intended. The
services boot anyway, because inspecting a failed migration is one of the reasons the sandbox
exists, and killing the container would destroy the evidence.

```bash
sandboxr status feat-123       # the migration verdict, the failing file, the error text
sandboxr logs feat-123         # the container's whole log stream
sandboxr db shell feat-123     # look at the schema yourself
```

`sandboxr logs` takes no service name. It is the container's own stream, everything
interleaved, and `--tail N` and `-f` narrow it.

### Every dashboard button fails with a strange error

The dashboard runs the same code the CLI does, so while a source file is half-saved every
button fails in whatever way that file fails. Check the CLI works before debugging the
dashboard.

### git refuses to create a worktree for a branch

sandboxr has **no command that creates a worktree** — you make one yourself and point
`sandboxr up --worktree PATH` at it. git will not check out one branch in two places, and the
branch you want is very often already open in your main checkout, so the right command depends
on where the branch is:

| Where the branch is | What to run |
|---|---|
| A local branch nothing has checked out | `git worktree add <path> <branch>` |
| A local branch checked out somewhere else | `git worktree add --detach <path> refs/heads/<branch>` |
| Only on the remote | `git worktree add -b <branch> <path> origin/<branch>` |

Guessing wrong produces a git error that says nothing about what to do next.

### A worktree was created but git exited non-zero

A repository hook can run *after* the checkout is already on disk, and fail. A `post-checkout`
hook that depends on a tool the machine does not have does exactly this.

**The tree on disk decides whether it worked, not the exit code.** Check whether the directory
exists and has content before treating it as a failure.

### A sandbox exists for a worktree that is gone

```bash
sandboxr gc --dry-run
sandboxr gc
```

`gc` reads each container's `sandboxr.worktree` label and reaps the sandboxes whose path no
longer exists, then removes any volume no surviving sandbox owns. Such a sandbox is unreachable
anyway — you cannot rebuild anything in it, because the source it would build from is gone.

## Still stuck?

Work down the layers in this order. Each step is cheap and rules out the one below it.

1. **`sandboxr doctor`** — is the local setup sane at all?
2. **`docker system df`** — disk, because a full disk lies about what it is.
3. **`sandboxr ls`** — is the sandbox running, and is it `degraded`?
4. **`sandboxr status <slug>`** — one sandbox in detail, including the migration verdict.
5. **`sandboxr logs <slug>`** — the container's own stream, everything interleaved.
6. **`sandboxr db shell <slug>`** — the database, if the symptom is a data one.
7. **`sandboxr shell <slug>`** — inside, and look for yourself.

<details>
<summary><b>Details for an agent:</b> what each of these actually checks, so you know what a clean result has ruled out</summary>

- **`doctor`** checks: Docker is running; a `sandboxr.yaml` exists here or in a parent
  directory; it resolves, and which driver it names; whether a file-backed database would be
  written into the worktree; whether any credential the config asks for is missing; where
  `SANDBOXR_HOME` is; and how many sandboxes are on the machine. It does **not** check DNS,
  certificates, the router or the disk — none of those layers exists for it to check yet. It
  exits non-zero if it found a problem.
- **`ls`** is a pure function of `docker ps` — there is no manifest that could be stale.
  `--project NAME` narrows it. `list` is the same command.
- **`status <slug>`** adds the sandbox's own verdict: its state, its hostnames, and the
  migration result with the failing file and the error text.
- **`logs <slug>`** takes **no service name**. `--tail N` limits it and `-f` follows it.
- **`shell <slug>`** puts you in `/workspace`, which is your worktree — anything you edit in
  there is edited on your branch.

Add `--json` to any of them to get the result on stdout as JSON; human-readable output goes to
stderr, so the two never mix.

</details>
