---
title: Troubleshooting
description: Symptom, cause, fix — including the failures whose symptom looks nothing like the cause.
---

Find your symptom, in the words you would use for it. Each entry says what causes it and what to
do. Open the block under an entry for the diagnosis and the related failures.

The entries near the top waste an afternoon, because the message names the wrong thing entirely.

```prompt
Something is wrong with a sandbox on this machine. Work out what.

Read docs/troubleshooting.md first. Start with the ladder at the top of that page — sandboxr doctor,
docker system df, sandboxr ls, sandboxr status, sandboxr logs — then match what you find against the
symptom headings. Tell me the symptom, the cause and the fix before you change anything. Stop and
ask me before running anything that removes a container, a volume or an image.
```

## Start here, in this order

Each step is cheap and rules out the one below it.

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
problem. Check the disk before you believe anything else a failing database tells you.

```bash
sandboxr prune          # what could be handed back, and how much. Removes nothing
```

| What grows | Reclaimed by |
|---|---|
| **Project images a newer build replaced** | `sandboxr prune --yes` |
| Volumes no sandbox owns any more | `sandboxr prune --yes`, or `sandboxr gc` |
| A sandbox's volumes (a few hundred MB each) | `sandboxr down <slug>` |
| **Docker's build cache — the thing that actually fills the disk** | `sandboxr prune --build-cache --yes`, or `docker builder prune -a` |
| The base image (~670 MB, once per machine) | `docker image rm sandboxr/base:latest`, then `sandboxr init` to get it back |

<details class="failure">
<summary><b>If it goes wrong</b> — why the message says corrupt, and what <code>prune</code> will and will not touch</summary>

The phrasing reads as a *corrupt* database rather than a full one. People spend an afternoon on
recovery procedures for a disk problem.

`sandboxr prune` reports before it removes, and never offers the shared volumes.
`sandboxr-claude` holds an agent session's credentials, and the Go caches are expensive to rebuild.

The build cache is the one thing it asks about rather than assumes. sandboxr is not its only writer,
so it is included only with `--build-cache`.

[Giving Docker the whole machine](guides/docker-capacity.md) has the rest.

</details>

### An image build fails and the first line is a deprecation notice

```
Start sandbox: docker build -f /tmp/sandboxr-build-Xh39sf/Dockerfile -t sandboxr/acme:40ed880f9db8 … exited 1:
DEPRECATED: The legacy builder is deprecated and will be removed in a future release.
```

**The notice is only the first line, and the real failure is below it.** A build started from the
dashboard runs on Docker's *legacy* builder. That builder refuses the cache mounts a Go module or a
dependency lockfile brings with it.

Until the dashboard image carries buildx, **build that project's image once from the host**:

```bash
sandboxr up --project acme --branch main     # on the host, where buildx is installed
```

The image tag is content-addressed, so the dashboard then finds it already built.

<details class="failure">
<summary><b>If it goes wrong</b> — why the dashboard has no buildx, the architecture half that is fixed, and the cache-mount half that is not</summary>

`docker build` uses BuildKit when the `buildx` plugin is installed, and the *legacy* builder when it
is not. The dashboard's image ships the Docker client on its own — no daemon, no compose, no buildx —
so a build started from a browser always runs on the legacy builder.

**The architecture half is fixed.** The legacy builder sets none of BuildKit's platform arguments.
Every Dockerfile that switches on `TARGETARCH` then fails in whatever way its shell fails:
`TARGETARCH: unbound variable`, or `unsupported arch ` with nothing after it, or a download of
`linux-/…` that comes back 404 and reads like a broken mirror. None of them names the architecture.

sandboxr's Dockerfiles now resolve the architecture themselves and fall back to `uname -m`, and the
host passes `--build-arg TARGETARCH` as well.

**The cache-mount half is not.** The legacy builder refuses `RUN --mount=type=cache` outright:

```
Step 13/19 : RUN --mount=type=cache,target=/go/pkg/mod     cd /gomod && go mod download …
the --mount option requires BuildKit.
```

A project that declares neither a Go module nor a `deps:` block has no cache mount in its layer, and
builds from the dashboard either way.

</details>

### A build died with `code 137`

```
   Collecting page data ...
Killed
npm ERR! code 137
```

**The kernel's out-of-memory killer.** `137` is `128 + 9` — killed by `SIGKILL`. Nothing in the
output mentions memory. Declare what the build needs, then `sandboxr up` again:

```yaml
frontends:
  apps:
    - { label: www, package: marketing, build: npm run build, out: out, memory: 6g }
```

> [!CAUTION] It may not be your build that dies
> On a machine running several sandboxes, a heavy build gets *something* killed. That something can
> be another sandbox, or your own local database container.

<details class="failure">
<summary><b>If it goes wrong</b> — why no Node flag bounds it, why <code>up</code> and not a rebuild, and what the whole sandbox then gets</summary>

A static site generator spreads rendering over many worker processes, so no single Node memory flag
bounds it. What the kernel measures is the **total for the whole container**.

**It has to be `sandboxr up`.** A memory limit is fixed when the container is created, so a rebuild
inside a running container cannot pick up a new one.

**The whole sandbox then runs with 6 GB** — not 6 GB for that build and 4 GB for everything else.
The container's limit is the **largest** `memory:` any single runtime declares, with a floor of 4 GB
that a smaller declaration cannot lower.

`sandboxr reload --web` watches for `137` or `Killed` and says so in words. Take it at face value.

</details>

### `SANDBOXR_MEMORY=6g sandboxr up` changed nothing

That advice comes from inside the container, and **the host does not read that variable**. There is
no per-run memory override. Declare `memory:` on the runtime that needs it, as in the entry above,
then `sandboxr down` and `sandboxr up`.

### A restart changed nothing

You edit code, restart the service, and the old behaviour persists. Or every restart logs
`address already in use` while the service carries on serving happily.

**The thing being supervised is a shell, not your service.** A run script that *pipes* its output
makes the shell the supervised process:

```bash
exec my-service | tee /var/log/my-service.log     # wrong
exec my-service >> /var/log/my-service.log 2>&1   # right
```

<details class="failure">
<summary><b>If it goes wrong</b> — why <code>exec</code> does not replace the shell in a pipeline</summary>

`exec` replaces the shell only when there is a single command. In a pipeline it does not. The shell
stays alive to manage the pipe, the supervisor watches the shell, and your service is a grandchild
it cannot signal.

The symptom is "my change did nothing", and you will read your own code for a long time before you
read a run script.

</details>

### A credential was changed and the sandbox still uses the old one

**Restart the sandbox.** The project's secrets file is mounted into the container, and the
container reads it when it sets its environment up — which happens at start, not continuously.

```bash
sandboxr stop <slug> && sandboxr start <slug>
```

If the value is one a front-end reads — a `VITE_*`, a `NEXT_PUBLIC_*` — **rebuild it as well**:

```bash
sandboxr reload <slug> --web
```

The dashboard marks running sandboxes that started before the last change and offers both
buttons beside each one.

<details class="failure">
<summary><b>If it goes wrong</b> — the restart worked and the front-end still shows the old value</summary>

A build-time variable is not read at run time. It was substituted into the bundle when the app
was built, so it is in the files on disk and no environment can reach back into them. The
restart applied it to every process that reads its environment, which is every backend and
every served front-end — and to nothing already compiled.

If a rebuild does not fix it either, the name is probably one the project's own `env:` map also
defines. That map is expanded last and wins. `sandboxr secrets list` names those.

</details>

### Login succeeds and then every API call returns 401

**Two identity settings were merged that must not be.** Rename them apart:

```yaml
secrets:
  rename:
    VITE_AUTH0_DOMAIN: SANDBOXR_AUTH0_SPA_DOMAIN
    VITE_AUTH0_CLIENT_ID: SANDBOXR_AUTH0_SPA_CLIENT_ID
```

<details class="failure">
<summary><b>If it goes wrong</b> — why two domains that look identical are not</summary>

An identity provider can serve the same tenant on both a custom domain and a provider-issued
domain. Fold the browser-side domain variable into the server-side one because they look like the
same thing, and one service rejects the other's token as having an **invalid issuer**.

</details>

### Two sandboxes' migrations hang, one at a time

**Two sandboxes collided on one database lock.** Check what the sandboxes are actually called:

```bash
sandboxr ls
```

<details class="failure">
<summary><b>If it goes wrong</b> — the lock-name budget, and why this should not be possible</summary>

A migration takes a named lock containing the sandbox's slug, and MySQL silently cuts a lock name
off at 64 characters. Two long branch names whose slugs match up to that point are one lock, and one
migration waits for ever on the other.

sandboxr caps a slug at 31 characters and **hashes** rather than truncates past it, precisely to
prevent this.

</details>

### A migration "succeeded" and the schema is half-applied

The output ends with `3 applied, 1 failed`, the exit code is 0, and the sandbox reports itself
healthy. **The runner printed its own failure summary and then exited zero.** Declare the pattern
that gives it away:

```yaml
migrate:
  command: go run ./cmd/migrate
  failure_pattern: "[0-9]+ failed"
```

<details class="failure">
<summary><b>If it goes wrong</b> — the related trap, and why the branch under test is often the branch with the bug</summary>

**Never test a pipeline's exit status.** `cmd | tee log` exits with `tee`'s status, and `tee` always
succeeds. Testing the pipeline's status reports **every** failed migration as a success.

The sandbox builds the migration runner from the branch under test, so the branch may be exactly the
one with that bug. That is why the pattern is declared in the config rather than fixed in the runner.

</details>

## Reaching a sandbox

### Nothing answers at all

```
curl: (7) Failed to connect to tkt-4821--app--acme.sbx.localhost port 443
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

### An `https://` app hostname says the site cannot be reached

Nothing is listening on 443. Check what the router serves:

```bash
docker port sandboxr-router          # 80 alone, or 80 and 443
ls ~/.sandboxr/state/dynamic         # cert-<domain>.yml exists only when TLS is configured
```

Either drop the `s` for now, or set TLS up properly — see the next entry.

> [!NOTE] Why the examples say `https://`
> The examples on these pages are written for a machine with a certificate. A machine without one
> serves the same hostnames over `http://`.

<details class="failure">
<summary><b>If it goes wrong</b> — why the browser blames the site, and how the scheme fixes itself</summary>

The router terminates TLS only when a trusted certificate exists on the machine. On one that has
never run `mkcert` it listens on port 80 alone. An `https://` URL for it fails to connect before any
of sandboxr is involved, which is why the browser blames the site rather than the certificate.

The dashboard reads the scheme off the router rather than assuming one. So once `sandboxr init` has
written a certificate, the links it prints become `https://` on their own.

</details>

### The browser warns about the certificate

The router is serving a certificate your machine has no reason to trust.

```bash
mkcert -install     # asks for your password once
sandboxr init       # re-issue and restart the router
```

`sandboxr init` will not install a trust root implicitly. It is the one step that needs an
administrator password.

### 404 from Traefik

The router is up and no sandbox matched the hostname. Check the slug and the project against
`sandboxr ls`, and the domain against `SANDBOXR_DOMAIN`.

### 404 naming the host it was asked for

You reached a sandbox, and its own router serves no such hostname. Three causes: the label is
wrong, the domain does not match the one the sandbox was started with, or the service is `optional`
and was not started.

<details class="failure">
<summary><b>If it goes wrong</b> — telling the three causes apart</summary>

- **A wrong label.** A label is sanitised the way a slug is, so a label with an underscore or a
  capital in the config is not the label in the URL.
- **A wrong domain.** `sandboxr status <slug>` prints the one the sandbox was started with.
- **A dormant service.** A service marked `optional` that nobody asked for has no site block at all,
  so its hostname 404s exactly as a misspelling would. Start it with `sandboxr up --with <label>`.

</details>

### Reading the response you got

| Response | Means |
|---|---|
| **502** | The label is right and the service behind it is not up yet. A truthful answer during a first boot |
| **503 with build instructions** | The app is not built. `sandboxr reload --web=<label>` |
| **404 from something that is clearly an API** | A `routes` prefix pointing at the wrong service, or none matched and the request fell through to the static files |

The fastest single check answers on **every** hostname a sandbox serves, and is not gated on the
database:

```bash
curl https://tkt-4821--app--acme.sbx.localhost/__sandboxr/live         # ok = the request arrived
curl https://tkt-4821--app--acme.sbx.localhost/__sandboxr/status.json  # booting / ok / degraded
```

### A domain override appears to do nothing

Every request lands on a catch-all 404 and nothing explains why. Ask the sandbox what domain it
thinks it has: `sandboxr status <slug>`, or the `domain` field of `status.json`.

<details class="failure">
<summary><b>If it goes wrong</b> — why a hand-edited router config does not survive</summary>

The sandbox's router config is generated at every boot, and it reads the domain from
`SANDBOXR_DOMAIN` in exactly one place. So a hand-edited generated config loses the edit on the next
restart.

</details>

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

`127` is command-not-found. The dependency step re-links workspace commands on every boot, so check
`deps-init.log`.

<details class="failure">
<summary><b>If it goes wrong</b> — why a linked workspace command goes missing</summary>

An image that installs dependencies from manifests alone skips linking a workspace command whose
target file does not exist at install time. The script that calls it then fails naming a binary that
is plainly in the dependency tree.

</details>

### An app "works" but deep links are wrong

Three variants, all decided by `static_mode`:

| What happens | Cause | Fix |
|---|---|---|
| Every route except `/` is a 404 | A single-page app served as `files` | `static_mode: spa` |
| A deep link renders the home page instead of the page | A generator served as `spa` | `static_mode: html` |
| A typo'd asset filename returns HTML with a 200 | An asset directory served as `spa` | `static_mode: files` |

None of these is a crash, which is why the mode is declared rather than guessed. [In
full](configuration/runtime-kinds.md).

### `sandboxr reload --web app` rebuilt everything, or named a sandbox called `app`

**The space is the problem.** `--web` and `--go` do not take the next word as their value, so `app`
is read as the *slug*. Use the `=` form whenever you name a target:

```bash
sandboxr reload --web=app        # one front-end
sandboxr reload tkt-4821 --web=app
sandboxr reload --web            # bare: every front-end in the build-everything set
```

[CLI commands](reference/cli.md) lists the flags that do take a following word.

### A dependency change did not take effect

`sandboxr reload` rebuilds code. It does not touch dependencies. A lockfile change needs
`sandboxr up`, which replaces the container and **keeps its volumes**, so the database and uploads
survive.

<details class="failure">
<summary><b>If it goes wrong</b> — why a lockfile change needs a new container</summary>

Installed dependencies live in a volume named after a hash of the lockfile. A changed lockfile
therefore names a different volume, and only a new container can be pointed at it.

</details>

### An import that exists cannot be resolved, in every sandbox on the branch

**A dependency volume was filled in by a boot that was interrupted part-way.** The next boot
repairs it on its own. To be rid of it outright, delete the volume — it is rebuilt from the lockfile
and nothing else, so that is always safe:

```bash
docker volume rm sandboxr-deps-<hash>     # `docker volume ls` to find it
```

<details class="failure">
<summary><b>If it goes wrong</b> — the completion marker, and what the repair says in the log</summary>

A dependency volume is shared by every sandbox whose lockfile matches, and it is filled in on the
first boot that mounts it. A boot interrupted part-way through that copy leaves a tree that is
non-empty and short of packages.

sandboxr treats only `node_modules/.sandboxr-deps` — written last, by rename — as "installed". So
the next boot repairs a volume without one, and `deps-init.log` says
`node_modules is not marked complete -- repairing it`.

A volume filled in by an older version has no marker and is repaired the same way, once.

</details>

## Databases

### `no usable seed source`

`up` could not use any of the seed sources the config names, and the message says, per source,
which of the two reasons applied.

**Not available here** names the thing that is missing:

```
acme: no usable seed source. database.seed_from.local is permitted here but not available:
the container "taxonomy_db" is not running. Make one of them available here, or add
database.seed_from.fixtures
```

Start the container, or fetch the dump to the path the config gives. Nothing about access needs
changing.

**Not permitted** is a §5.3 refusal, and only a public project ever sees it:

```
acme: no usable seed source. database.seed_from.local is not permitted: public apps may only
be seeded from fixtures or an anonymised dump (contracts §5.3). Set access.apps to private, or
add database.seed_from.fixtures
```

<details class="failure">
<summary><b>If it goes wrong</b> — why the two reasons are separate, and what it looks like when both apply</summary>

The two tests are independent. **Access** decides what a sandbox is *allowed* to be seeded from — a
public app may only use fixtures or a dump marked `anonymised: true`. **Availability** decides what
this machine can *reach* right now — whether the source container is running, whether the dump is on
this disk.

They used to be one check, so every refusal read as an access refusal. A private project whose only
source was a `local:` container that had exited was told to set `access.apps` to private — which it
already was — with the only other suggestion being to make the sandbox public. That is the one change
that would have made things worse.

When both apply, both are reported, in one message:

```
acme: no usable seed source. database.seed_from.local is not permitted: public apps may only be
seeded from fixtures or an anonymised dump (contracts §5.3). database.seed_from.file is permitted
here but not available: the dump "/seeds/acme.sql" was not found here. Set access.apps to private,
or add database.seed_from.fixtures
```

`--seed local|file|fixtures` forces one source, and its refusal names the permitted set instead.

</details>

### `no seed artifact in /sandboxr/cache`, and you declared a `file:`

The container found nothing to restore, so it started from an empty database. Check that the plan
actually names your file:

```bash
jq .database.seed ~/.sandboxr/build/<project>/<slug>.plan.json
```

<details class="failure">
<summary><b>If it goes wrong</b> — what the plan should say, and how to make the choice fail loudly</summary>

A declared `seed_from.file` should appear as `/sandboxr/seed/<name>`. A dump sandboxr cached itself
appears as `/sandboxr/cache/<name>`.

If yours is missing entirely, the source was not usable at start time. `sandboxr up` prints which
source it chose. `--seed file` forces the question and fails loudly rather than falling through to
the next source.

A project whose migrations assume an existing schema fails on its first file when this happens, which
is usually how you find out.

</details>

### `up` says "Provisioning did not complete" and the sandbox is fine

**Known, and it is the host's report that is wrong rather than the sandbox.** Check the sandbox itself
before believing the message:

```bash
sandboxr status <slug>       # `ok` and migrations `ok` means the container did its job
sandboxr logs <slug>         # `db-init: done` and `migrate: ok` in the boot log
```

Nothing is lost. The container half has already done the work. Recorded in
[What is built](reference/status.md).

<details class="failure">
<summary><b>If it goes wrong</b> — which half fails, and why</summary>

The container provisions itself at boot, and the host runs the same driver a second time to report
on it. The host half authenticates as `root` with a password the container does not set. The
container initialises the server root password-less on purpose, so the host's first statement fails,
and the driver reports that as a provisioning failure.

</details>

### `Error 1044: Access denied ... to database 'acme_...'`

The grant is missing, or its underscore is not escaped. MySQL treats `_` as a single-character
wildcard in the database part of a `GRANT`:

```sql
GRANT ALL ON `acme\_%`.* TO 'sandboxr'@'%';
```

<details class="failure">
<summary><b>If it goes wrong</b> — the two wrong spellings</summary>

`acme_%` unescaped grants far too widely. `` `acme_%` `` in plain backticks grants on a database
*literally named* `acme_%`, and every sandbox then fails with 1044.

</details>

### `Refusing to run until these are resolved`

**A previous migration died part-way through, and the runner is protecting you.** That is the
project's own runner saying it, not sandboxr.

```bash
sandboxr db shell <slug>        # look
sandboxr db snapshot <slug>     # see what actually landed
sandboxr down <slug> && sandboxr up     # or just start clean
```

<details class="failure">
<summary><b>If it goes wrong</b> — why sandboxr will not clear it for you, and the two rules if you write the repair</summary>

If the sandbox was seeded from a database in that state, it inherits it. sandboxr does not touch the
runner's bookkeeping table, because that would be reimplementing the project's migration logic.

If you write the repair in the project: **complete a row, never delete it**, and never complete a row
whose migration file is still present. [Why](databases.md).

</details>

### A restore succeeded but binary columns are garbage

The dump is missing `--hex-blob`. Binary columns are otherwise written as escaped string literals,
and any character-set mismatch then corrupts them. Silently, because the restore itself succeeds.

### A permissions error on a statement nobody wrote

The dump is missing `--set-gtid-purged=OFF`, so it carries a `SET @@GLOBAL.GTID_PURGED` statement
that needs elevated privileges. Where it does apply, it poisons the target's replication state.

### A D1 or SQLite migration hangs

**Two processes have the same database file open.** Count the openers — including a shell, a
script, or a database browser you left open — before looking at anything else.

```yaml
database:
  driver: d1
  owner: app        # the one service allowed to open the file
```

<details class="failure">
<summary><b>If it goes wrong</b> — why a deadlock looks like a slow boot</summary>

A file-based database admits exactly one writer. Two deadlock on a busy lock, which turns a slow
boot into a hang **with nothing in the log**. Neither process looks like it is misbehaving.

</details>

### A sandbox's database file appears in `git status`

The runtime is not pointed at the sandbox's own state directory, so it is writing into your
worktree. Both the migrate command and the owner's serve command need the variable:

```yaml
database:
  migrate:
    command: npx wrangler d1 migrations apply DB --local --persist-to "$SANDBOXR_D1_DIR"
```

<details class="failure">
<summary><b>If it goes wrong</b> — the hang this also causes, and what <code>doctor</code> can see</summary>

Two sandboxes made from one worktree are then sharing that file, so this is usually the real cause
of a hang as well.

`sandboxr doctor` warns when it can see the variable missing. It cannot always see it, so it warns
rather than refusing.

</details>

### `migrate.since` seems to be ignored

It is exported as `SANDBOXR_MIGRATE_SINCE` rather than added to your command as a flag, because
sandboxr cannot guess a runner's flag spelling. **Your command has to reference it:**

```yaml
migrate:
  command: go run ./cmd/migrate --since "$SANDBOXR_MIGRATE_SINCE"
  since: "20240101"
```

### The pending migration count differs from another worktree

**Expected.** The set comes from *that worktree's* migration directory, which is the "what would
this branch do" question you wanted answered.

## The sandbox itself

### `sandboxr ls` shows `degraded`

**The container is up and the migration failed.** That is intended, because inspecting a failed
migration is one of the reasons the sandbox exists.

```bash
sandboxr status <slug>       # the verdict, the failing file, the error text
sandboxr logs <slug>
sandboxr db shell <slug>
```

`db-init.log` under `~/.sandboxr/logs/<project>/<slug>/` has the whole provisioning run.

### The sandbox sits at `starting` for ever

The log stops mid-way through database setup with nothing after it.

For a file database, that is the two-writer deadlock above. For MySQL, check the disk first.

### `sandboxr up` refuses, naming the project directory

```
… is the project-level config for a managed project, so it cannot be run from …
```

You are standing in a managed project's own directory rather than in one of its worktrees. Run from
a worktree under `<project>/wt/`, or use `sandboxr up --project <name> --branch <branch>`.

<details class="failure">
<summary><b>If it goes wrong</b> — why that one directory is refused</summary>

It holds `repo.git` and every worktree of the project, and mounting it as `/workspace` would put all
of them inside one sandbox. [The rules a config must obey](configuration/rules.md) has the full
wording.

</details>

### Every command fails with an error naming `~/.sandboxr/config.yaml`

The machine's settings file is malformed. Fix the key the error names. A *missing* file is always
fine.

<details class="why">
<summary><b>Why it works this way</b> — why a malformed file is an error and not a fallback</summary>

Somebody has just written down the lifetime they wanted. Silently applying a default instead is how
a `3d` that was really `3D` ends up stopping a week of work after twelve hours.

</details>

### `sandboxr keep` refuses

Two messages, and both mean the marker would have been meaningless.

- `no sandbox called <slug> in <project>` — there is nothing to keep. `sandboxr ls`.
- `carries no created label` — the container predates the label. `sandboxr down` and `up` again to
  relabel it.

<details class="failure">
<summary><b>If it goes wrong</b> — what the created label is for</summary>

Without it a keep-alive stamp could not tell one container from a successor with the same slug, so
the marker would outlive the sandbox it was meant for.

</details>

### A worktree's slug has four characters on the end you did not ask for

Another worktree of the same project already answered to the slug this one would have taken —
almost always two branches on one ticket, since a ticket id in the name beats the branch. A slug
names the container, all four volumes and the database lock, so two worktrees cannot share one:
the second one sandboxr cut was given `<slug>-<4 characters>` instead, and `sandboxr worktree add`
said so at the time.

Nothing needs fixing. The name is in
`~/.sandboxr/state/slug/<project>/<worktree directory>` if you want to read it.

<details class="failure">
<summary><b>If it goes wrong</b> — the same two branches without the guard, and why it is not repaired for you</summary>

Without it, both worktrees resolve to one slug, so they are one container and one set of volumes.
`up` replaces a container it finds rather than refusing — that is how a rebuild works — so starting
the second worktree tears the first one's sandbox down and hands its database to a branch that never
wrote it. Nothing downstream can tell the two apart.

The guard runs when sandboxr **cuts** a worktree, so it covers `sandboxr worktree add` and the
dashboard's New worktree, and not a worktree you cut yourself with `git worktree add`. For those,
pass a name: `sandboxr up <name>`.

Collisions already on disk are deliberately left alone. Renaming a worktree that has a running
sandbox would leave its container and its volumes stranded under the old name — `sandboxr down` one
of them and bring it up with an explicit slug instead.

</details>

### sandboxr says a slug belongs to two projects

Slugs come from ticket ids, so two projects sharing a `tkt-4821` is ordinary. `stop`, `start`,
`keep` and `unkeep` refuse rather than pick between them. Say which with `--project <name>`.

### A sandbox exists for a worktree that is gone

```bash
sandboxr gc --dry-run
sandboxr gc
```

Such a sandbox is unreachable anyway. Nothing can be rebuilt in it, because the source it would
build from is gone.

### `fatal: not a git repository` inside a sandbox

```
$ sandboxr shell tkt-4821
# cd /workspace && git status
fatal: not a git repository: /Users/you/.sandboxr/workspace/acme/repo.git/worktrees/tkt-4821
```

sandboxr mounts the worktree and its repository both, so this should not happen. Where it does, the
sandbox predates that fix and `sandboxr up` again is the whole of it.

One case is not fixable that way, and says so instead: a project that is a **subdirectory of a
larger repository**.

<details class="failure">
<summary><b>If it goes wrong</b> — why two mounts are needed, and the one case that cannot be fixed</summary>

A linked worktree's `.git` is a *file* holding an absolute path back to its repository. A container
that has the worktree and not the repository cannot run any git command at all.

For a project inside a larger repository, `/workspace` is the project and git's repository is above
it. Mounting the enclosing repository would make git call every file in the project deleted.

`up` prints one line when it happens — *this tree is not the top of a git checkout, so git will not
work inside the sandbox* — and everything else about the sandbox works normally.

</details>

### `gh` in a sandbox says it is not logged in

That is the default. A sandbox has `gh` but no credential until you say otherwise, per project, in
`~/.sandboxr/config.yaml`:

```yaml
projects:
  acme-monorepo: { github: token }
```

**The key is the project's name as sandboxr shows it** — its directory in the workspace, the name in
every dashboard URL — or the `project:` its own `sandboxr.yaml` declares. Either works. A key that
is neither does nothing at all, silently, which is the commonest way this goes wrong: run
`sandboxr doctor` and it names any entry that matches no project, along with the names that would.
`sandboxr config`, run in the worktree, says what this project resolved to.

Then start the sandbox again. See [Access and security](access.md) for what that hands over, because
it is more than the one project.

> [!NOTE] There are two reasons `git push` fails, and the token is only one
> A session also has to be *allowed* to run it. `git push` and `gh` are deliberately not in the
> default set of commands an agent may run without asking, so a sandbox with a perfectly good token
> still stops and asks. See [Agents in a sandbox](guides/agents-in-a-sandbox.md).

<details class="failure">
<summary><b>If it goes wrong</b> — still logged out after turning it on</summary>

Check that the entry matches. `sandboxr config` in the worktree prints the resolved mode and, in
brackets, the `projects:` key that decided it — so an entry keyed on a name no project answers to
shows up as `github none` with no key beside it.

Check that `gh auth token` answers on the *host*. That is where the value comes from, and a host
that is signed out has nothing to pass on.

The token is read at `up` and lives only in the container's environment, so nothing is stored and
nothing is stale.

</details>

### git refuses to create a worktree for a branch

git will not check out one branch in two places, and the branch you want is very often already open
elsewhere.

For a project in the workspace, sandboxr handles this itself: `sandboxr worktree add` and the
dashboard's Start button pick the right form. For a repository you keep yourself, run the commands by
hand and then `sandboxr up` from inside the worktree.

<details class="agent">
<summary><b>Details for an agent</b> — the four forms, and what a detached worktree means</summary>

| Where the branch is | What sandboxr runs |
|---|---|
| A local branch nothing has checked out | `git worktree add <path> <branch>` |
| A local branch checked out somewhere else | `git worktree add --detach <path> <the freshest safe ref>` |
| Only on the remote | `git worktree add -b <branch> <path> origin/<branch>` |
| A new branch off a base | `git worktree add -b <branch> <path> <base>` |

A worktree created the second way is **detached**, which is git working as intended rather than a
failure. sandboxr recovers the branch name from the commit, so the sandbox is still labelled and
still reachable at the hostname you expect.

Every one of those resolves a ref, so sandboxr fetches the project's mirror first and moves the
local branch up to the remote where that is a fast-forward and the branch is checked out nowhere.
A branch checked out elsewhere is never moved — the new worktree is detached at `origin/<branch>`
instead. See [Projects, worktrees and lifetimes](guides/managed-sandboxes.md).

</details>

### A worktree is running old code

The commits are on the remote and the checkout is behind. Pull it, then restart the sandbox:

```bash
sandboxr worktree pull acme feat/tkt-4821
sandboxr stop feat-tkt-4821 && sandboxr start feat-tkt-4821
```

From the dashboard both are buttons on the worktree — **Pull from Git**, then **Restart
services**. A front-end is built rather than merely run, so rebuild those as well: **Rebuild
front-ends**, or `sandboxr reload feat-tkt-4821 --web built`.

<details class="failure">
<summary><b>If it goes wrong</b> — the four things a pull refuses, and what each one wants</summary>

A pull **fast-forwards or refuses**, and a refusal changes nothing on disk. It lists every reason
at once, so there is no fixing one and running it again to be told the next.

| What it says | What to do |
|---|---|
| `N files have uncommitted changes that the incoming commits also change: …` | Commit, stash or discard those files. Only files the incoming commits also touch are in the way |
| `N untracked files would be overwritten by the incoming commits: …` | Move or delete them |
| `<branch> has N commits that origin/<branch> does not` | There is no fast-forward to make. Push them, or drop them |
| `origin has no branch called <branch>` | It was deleted or renamed on the remote |
| `This worktree is on <sha> and no branch points at it` | Check it out on a branch first |

A pull never merges, never rebases and never discards, so none of these can lose work. A file a
sandbox's own build wrote — a generated `.env.local` beside a package — is ignored and does not
block anything.

</details>

### A worktree was created but git exited non-zero

**The tree on disk decides whether it worked, not the exit code.** A repository hook can run
*after* the checkout is already on disk, and fail. A `post-checkout` hook needing a tool the machine
does not have does exactly this.

## The dashboard

### Every dashboard button fails with a strange error

The dashboard loads the same `@sandboxr/core` the CLI does, so a half-saved source file breaks every
button. Check the CLI works before debugging the dashboard.

### The dashboard signs you in and then shows a blank page

**The browser bundle has not been built.** The browser's network panel settles it: a 404 on
something under `/assets/` means the bundle was never built. Run `npm run build` at the repository
root.

<details class="failure">
<summary><b>If it goes wrong</b> — why a missing build renders as an empty page</summary>

The dashboard is a browser app. The server sends an HTML shell, and the app itself comes from
`@sandboxr/web`'s build under `/assets/`. With that build missing, the shell still arrives and every
asset 404s, which renders as an empty page rather than an error.

`npm run build` at the repository root builds the two packages in the right order, because the server
depends on the app. Building `@sandboxr/server` on its own does not.

</details>

### Opening an agent session fails, saying there is no Claude credential

```
no Claude credential on this machine. Run `claude setup-token` on the host and set
SANDBOXR_CLAUDE_TOKEN before starting the dashboard.
```

That is the whole of it. Mint a token on the host with `claude setup-token`, export
`SANDBOXR_CLAUDE_TOKEN`, and run `sandboxr init` again.

<details class="failure">
<summary><b>If it goes wrong</b> — why the variable has to be set before <code>init</code></summary>

It is forwarded to the dashboard container at `init` and nowhere else. Setting it in a shell after
the dashboard is already running has no effect. See
[Environment variables](reference/environment.md).

</details>

### The repository list is empty, and `gh` works fine on this machine

Settings → Projects lists what the **dashboard's** `gh` can reach, and the dashboard runs in a
container. Your shell's `gh` is not the one being asked. `sandboxr init` again is the usual fix,
because that is when the token is captured.

The dashboard's log says which case you have, because an empty list looks the same either way:

```bash
docker logs sandboxr-dashboard | grep repositories
```

| The line says | What it means |
|---|---|
| `repositories: gh: Requires authentication (HTTP 401)` | The container has no usable token |
| `repositories: there is no gh on this machine` | The dashboard image is not the one sandboxr builds |
| `repositories: HTTP 403 …` | A token whose scopes do not include `repo` |
| `repositories could not be listed: …` | Not `gh` at all — the workspace could not be read |

The box for pasting a remote works throughout, whatever the listing says.

<details class="failure">
<summary><b>If it goes wrong</b> — where the token lives, what <code>init</code> does with it, and why the reason is not on screen</summary>

The usual cause is where the token lives. On macOS `gh auth login` puts it in the login keychain, so
`~/.config/gh/hosts.yml` names your account and holds no credential — and the dashboard mounts that
directory. A keychain does not cross into a container, so the container's `gh` has a username, no
token, and every call comes back `HTTP 401`.

`sandboxr init` handles this. It runs `gh auth token` on the host and passes the value in as
`GH_TOKEN`. Two things follow from *when* it does that:

- **A dashboard started any other way has no token.** Run `sandboxr init` again.
- **The token is captured once, at `init`.** Sign in again, or let it expire, and the container is
  still holding the old one. `sandboxr init` again is the fix there too.

The reason stays in the log and never reaches the browser. It can name a config path or an account,
and any signed-in session could open that pane.

The box for pasting a remote is the only route for a repository the listing could never return.
That covers one in an organisation you can reach but are not a member of, and a remote that is not
GitHub.

</details>

## Config refusals

A config error exits `2` and names the file and the field. The common ones:

| Message | Cause |
|---|---|
| `no sandboxr.yaml here or in any parent directory` | You are not inside a project that describes itself |
| `is empty` / `is not valid YAML` | The file itself |
| `needs sandboxr <range>, and this is <version>` | The `sandboxr:` constraint. Upgrade the tool, or relax it |
| `label "<x>" is already used by <y>` | Two runtimes want one hostname label |
| `two backends are called "<x>"` | Duplicate backend name |
| `is both a static build (out) and a server (serve) — pick one` | One app declared as two runtime kinds |
| `needs an out directory or a serve command` | A front-end that is neither kind |
| `is a server, so it needs the port it listens on` | A `serve:` app with no `port` |
| `has no build command, and defaults sets none` | Nothing to build it with |
| `no front-end is labelled "<x>"` | A `routes:` key naming an app that does not exist |
| `a driver with neither a seed nor a migration has nothing to do` | A `database:` block that would do nothing |

Every constraint, with the symptom you see when you break it, is on
[The rules a config must obey](configuration/rules.md).

---

**Next:** [Cheat sheet](reference/cheat-sheet.md) for the commands used above, or
[What is built](reference/status.md) if the thing you hit may simply not exist yet.
