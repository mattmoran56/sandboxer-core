---
title: Start, stop, list, clean up
description: The ten commands that create, inspect and remove sandboxes, what each one really removes, and why only one of them can reach your worktree.
---

Ten commands do almost everything: `up`, `ls`, `status`, `stop`, `start`, `down`, `expire`,
`gc`, `prune` and `worktree delete`. This page says what each one does and, more
importantly, what each one removes.

Start with the reassuring part. **Deleting a sandbox cannot lose your work.** Your
[worktree](../reference/glossary.md) — your branch, your commits, the file you have not
saved yet — lives on your own disk and is only *mounted* into the container. Removing the
container removes a copy of a running system. The code was never in there.

One command is the exception, and it is the one directly below `down`: `worktree delete`
removes the sandbox *and* the directory. It asks first, and it refuses while there is
anything in that directory nothing else has a copy of.

```prompt
Show me the sandboxes on this machine and explain what state each one is in.

Read docs/guides/lifecycle.md first. Run `sandboxer ls`, then `sandboxer status <slug>`
for anything that is not `running`, and tell me in plain words what is wrong with it.

Do not run `sandboxer down`, `sandboxer worktree delete`, `sandboxer gc` or
`sandboxer prune --yes` without asking me first — those four remove things, and
`worktree delete` removes the directory on disk as well. Stop and tell me if Docker is
not running.
```

Every command takes an optional **slug** — the short name a sandbox is known by. You rarely
type it. Standing in the worktree is enough, so `sandboxer down` run from
`.worktrees/tkt-4821` and `sandboxer down tkt-4821` run from anywhere are the same command.

## `up` — start one

`sandboxer up` reads the project's `sandboxer.yaml`, prepares a copy of the database, builds
the project's image layer if it is not already there, starts one container, waits for it to
come up, and prints one URL per app.

```bash
cd .worktrees/tkt-4821
sandboxer up
```

**Starting a sandbox that already exists is not an error.** The container is replaced from
the current config and the current commit. Its volumes are untouched, so the database, the
uploads and anything already built carry over. That makes `up` the right command after you
edit `sandboxer.yaml`, and after a dependency change — the shared dependency volume is named
after a hash of the lockfile, so a new lockfile means a different volume, and only a fresh
container can pick it up.

> [!NOTE] The source database is only ever read
> Wherever the data comes from, sandboxer copies it first and works on the copy. Nothing a
> sandbox does can reach back into the database it was copied from.

<details class="agent">
<summary><b>Details for an agent</b> — every flag <code>sandboxer up</code> accepts, and its exit codes</summary>

| Flag | Default | What it does |
|---|---|---|
| *(positional)* `slug` | derived | The sandbox's name. `--slug NAME` is the same thing |
| `--worktree PATH` | the current directory | Which worktree to build from |
| `--project NAME` | — | Start from a project in the managed workspace instead of a directory. Requires `--branch` |
| `--branch NAME` | — | Which branch of that project. The worktree is found or cut |
| `--base REF` | — | Create that branch off this ref first |
| `--ttl 12h\|never` | `12h` | How long it may sit **unused** before something stops it |
| `--with a,b` | none | Also start these `optional: true` runtimes |
| `--seed local\|file\|fixtures` | whatever the config allows | Force the seed source |
| `--detach` | off | Do not wait for it, and skip the database provisioning step |
| `--timeout N` | `180` | Seconds to wait for the container. Accepted but not listed in `sandboxer help` |
| `--json` | off | The whole result as JSON on stdout |

| Exit | Means |
|---|---|
| `0` | Started |
| `1` | Anything else |
| `2` | A config error. The message names the file and the field |
| `3` | Started **degraded** — up, with failed migrations |

Order of operations, from `up()` in `packages/core/src/sandbox/index.ts`:

1. Resolve the worktree.
2. Load the config.
3. Derive the slug.
4. Refuse if Docker is not running.
5. Refuse if the project serves public apps and its secrets file holds any credential.
6. Create the host directories and the `sandboxer` network.
7. Warn if the shared router is not running.
8. Produce the seed artifact, **on the host**.
9. Write `~/.sandboxer/build/<project>/<slug>.env`.
10. Write the plan.
11. Replace any existing container.
12. Resolve the ttl.
13. Build or reuse the project image.
14. Issue this sandbox's certificate.
15. `docker run`.
16. Wait for the container to answer.
17. Provision the database and run migrations.

Two refusals happen before any work is done, so a typo costs nothing: an unreadable
`--seed` value, and an unreadable `--ttl`.

`--ttl` is only the first step of a precedence chain that also reads
`~/.sandboxer/config.yaml` and `SANDBOXER_TTL_HOURS`. The rules are in
[Environment variables](../reference/environment.md#the-setting-that-is-a-file-not-a-variable).

The URLs `up` prints are `<slug>--<label>--<project>.<domain>`, with the domain defaulting to
`sbx.localhost` — see [How it works, in five steps](../how-it-works.md). Every field the
config may declare is in [sandboxer.yaml, field by field](../configuration/sandboxer-yaml.md),
and every command's full flag list is in [CLI commands](../reference/cli.md).

</details>

<details class="failure">
<summary><b>If it goes wrong</b> — the three refusals <code>up</code> makes by name</summary>

**"Docker is not running."** Nothing has been done. Start Docker and run it again.

**"`<project>` serves public apps, so it may not carry the real credentials in
`~/.sandboxer/secrets/<project>.env`."** A refusal, not a warning: anyone who can reach a
public app could make it send real email or spend real credit. The two ways out are named
in the message — set `access.credentials` to `real`, or set `access.apps` to `private`. See
[Access and security](../access.md).

**"Cannot read `<x>` as a lifetime."** `--ttl` takes `30m`, `12h`, `7d`, a plain number of
seconds, or `never`. It never guesses, because silently substituting a lifetime nobody asked
for is the one mistake here that destroys work.

A fourth case is not a refusal at all: *"The shared router is not running, so this sandbox
will have no hostname."* The sandbox still starts and is still worth having. Run `sandboxer
init` to fix the hostname.

</details>

## `ls` — every sandbox on the machine

```
PROJECT  SLUG       STATE     TTL    BRANCH             WORKTREE
acme     tkt-4821   running   12h    tkt-4821           /home/dev/acme/.worktrees/tkt-4821
acme     tkt-4907   running   kept   tkt-4907*          /home/dev/acme/.worktrees/tkt-4907
acme     fix-nav    degraded  never  fix/nav            /home/dev/acme/.worktrees/fix-nav

* uncommitted changes when the sandbox started
```

`list` works as well as `ls`, and `--project NAME` narrows it. Every column is read from a
label on the container, so this table is a pure function of `docker ps` and nothing can
drift out of sync with what is actually running. See [State lives in
labels](../architecture/state.md).

| State | Means |
|---|---|
| `starting` | Up, and has not yet said whether its migrations worked |
| `running` | Up, migrations succeeded |
| `degraded` | Up, and its **migrations failed** |
| `stopped` | The container exists but is not running |

`degraded` is a deliberate outcome rather than a half-failure. Looking at a migration that
has just failed is one of the main reasons to have a sandbox at all, so the sandbox stays up
and says so.

The `TTL` column shows one of three things: the sandbox's configured limit, `kept` if
somebody exempted it from the clock, or `-` if the limit cannot be read. It is the limit
itself, not the time remaining — `sandboxer expire --dry-run` is what reports how long each
sandbox has left.

## `status` — one sandbox in detail

```
acme/tkt-4821  running
  branch      tkt-4821@a1b2c3d
  driver      mysql
  migrations  ok
  access      public
  worktree    /home/dev/acme/.worktrees/tkt-4821
  built       app, admin

  up    api              https://tkt-4821--api--acme.sbx.localhost
  up    admin-api        https://tkt-4821--admin--acme.sbx.localhost
  down  jobs             https://tkt-4821--jobs--acme.sbx.localhost
```

`up` here means the process answered its declared health path, not that Docker thinks the
container is alive. `status` exits `3` if the sandbox is degraded, so a script can branch on
it.

`worktree` gains `(GONE)` when the directory it names is no longer on disk. That is the
condition `gc` reaps on, further down this page.

## `stop` and `start` — pause without deleting

```bash
sandboxer stop tkt-4821
sandboxer start tkt-4821
```

`stop` stops the container and nothing else. The labels survive, so the sandbox still
appears in `ls` and can be started again. The volumes survive, so its database is exactly
where it was and coming back costs a start rather than a re-seed.

**Stopping frees memory and CPU. It frees no disk at all.** That surprises people often
enough that it has its own page: [Giving Docker the whole
machine](docker-capacity.md).

<details class="agent">
<summary><b>Details for an agent</b> — the two exit codes, and why they differ</summary>

Both take `<slug>` and an optional `--project NAME`. Both resolve the slug against
`sandboxer ls` first and fall back to the config in the current directory, so they work from
anywhere. A slug that matches sandboxes in two projects is an error naming both; `--project`
is the way out.

`stop` on an already-stopped sandbox exits **0**. That is the state you asked for, so it
succeeded.

`start` on a sandbox that does not exist exits **1**. That state cannot be reached, so it
failed.

</details>

## `down` — remove it

```bash
sandboxer down            # the container and everything it owned
sandboxer down --keep     # the container only; the volumes stay
```

| What `down` removes | What `down` never touches |
|---|---|
| The container | Your worktree, branch, commits and uncommitted changes |
| `sandboxer-data-…` — the database | The database it was seeded from |
| `sandboxer-blob-…` — file storage | The seed cache in `~/.sandboxer/cache` |
| `sandboxer-bin-…` — built binaries | The shared dependency volume |
| `sandboxer-www-…` — built front-ends | The project's image, and Go's caches |
| Its logs in `~/.sandboxer/logs/<project>/<slug>/` | The name you gave the worktree |
| Its generated plan and environment in `~/.sandboxer/build/` | Any other sandbox |
| Its keep-alive marker, if it had one | |

Everything in the left column is named after the sandbox, and nothing else on the machine
can work out that name once the worktree it came from is gone — so a teardown that left any
of it behind would leave it for good.

The name you gave the worktree is the one thing here filed against the *worktree* rather
than the sandbox, and it stays: a name that vanished every time you deleted and restarted a
sandbox would be a name that undid itself.

> [!NOTE] There is no per-sandbox certificate to remove
> There was one, once. Every sandbox now answers on a single hostname label under the
> machine's domain, which the machine's own `*.<domain>` certificate already covers, so
> `up` issues nothing per sandbox and `down` has nothing to take away. `sandboxer init`
> sweeps up any left behind by an older version.

`down` on a sandbox that does not exist is not an error. It says so and returns `0`.

`--keep` is for when you want a fresh container against the same database. The next `up`
restores nothing and starts in seconds. It keeps everything in that left column except the
container and the keep-alive marker — the container is gone either way, and a marker for a
container that is not there means nothing.

## `worktree delete` — remove the sandbox *and* the worktree

`down` deliberately leaves your worktree alone. When you are finished with a branch
altogether, this is the command that removes both — **in that order, which is the whole
point of it being one command**:

```bash
sandboxer worktree delete acme feat/tkt-4821
```

The sandbox goes first because a volume cannot be removed while its container is running,
and because everything a sandbox owns is named after the worktree it was cut from. Remove
the directory first — with `git worktree remove`, or the older `sandboxer worktree rm` — and
the container is left running with nothing left to name it, waiting for `gc`.

**It refuses if there is anything in that worktree nothing else has a copy of**, and says
what it found:

- **uncommitted changes** — they exist only in that directory, and it names the files;
- **commits that are on no remote** — these are *not* lost with the directory (they live in
  the project's clone on this machine), but nothing here will have that branch checked out
  any more.

`--force` goes ahead anyway, and it lives on the command rather than in the library: core
refuses and reports what it found, and the override is typed by somebody at the machine.
An embedder calling core gets the refusal and no way past it, because "ask again, harder" is
not a confirmation.

> [!WARNING] Two branches on one ticket can still share a sandbox
> A slug is taken from a ticket id in the worktree's name, so `feat/eng-3941-answers` and
> `feat/eng-3941-selector` both derive `eng-3941`. Worktrees cut now get a slug of their own
> when that happens, but ones cut before that guard existed are left as they are — renaming a
> worktree whose sandbox is running would strand the container. So a machine that has been
> upgraded can still have two worktrees on one container, and deleting either then **keeps**
> the sandbox and says which other worktree is still using it. Only the directory goes.

<details class="agent">
<summary><b>Details for an agent</b> — what a delete removes, in order, and every refusal</summary>

`sandboxer worktree delete <project> <branch> [--force]`. `<project>` is the workspace
directory name, `<branch>` the branch that worktree has checked out. The verb is scoped to
the *worktree*, not to a sandbox, because a worktree exists whether or not a container does.

The order, and it is fixed:

1. resolve every worktree of the project and the slug each one **answers to** — core's
   `slugFor`, which reads `~/.sandboxer/state/slug/<project>/<worktree dir>` before it
   derives anything, so a worktree that was given a slug is compared under that one
   (contracts §3.1, §4.2.3);
2. keep the sandbox if another worktree answers to the same slug — it is named, and only
   step 4 runs. Siblings are matched by path, never by slug: the slug is the thing that may
   not be unique;
3. `down` on the sandbox: container (forced, running or not), the four volumes,
   `~/.sandboxer/build/<project>/<slug>.plan.json` and `.env`,
   `~/.sandboxer/logs/<project>/<slug>/`, `~/.sandboxer/state/attach/<project>/<slug>` and
   the keep-alive marker;
4. `git -C <workspace>/<project>/repo.git worktree remove --force <path>`, then
   `worktree prune` — which also forgets the given slug, if there was one;
5. `~/.sandboxer/state/name/<project>/<slug>` — the display name — unless a sibling worktree
   shares that slug, in which case it is that sibling's name too and it stays.

Exit codes: `0` when it happened, `1` for every refusal. Nothing is removed before a
refusal. The refusals:

| Refusal | `--force` gets past it |
|---|---|
| `no worktree called <name> in <project>` | no |
| `<slug> is the slug of N worktrees` — name the branch instead | no |
| `<path> has N uncommitted changes` — the first five are listed | yes |
| `<branch> has N commits that is on no remote` | yes |

A worktree with no sandbox deletes cleanly and says `there was nothing to tear down`. A
worktree whose directory is already gone deletes cleanly too — that is the stale entry in
git's admin files, and clearing it is the point.

The dirty check is core's `dirtyFiles` with `DEFAULT_DIRTY_IGNORE`, so a `.env.local` a
sandbox's own build wrote does not count. git's own `worktree remove` is blunter, which is
why the removal passes `--force` to git *after* this check has decided.

</details>

## `expire` — stop whatever has gone idle

```bash
sandboxer expire --dry-run
sandboxer expire
```

Each sandbox carries a lifetime, and the lifetime measures **idleness rather than uptime**.
`expire` stops every sandbox that has sat unused past its own limit.

**`expire` only ever stops a sandbox. It never removes one.** So it hands back memory and
CPU and no disk. `--project NAME` limits it to one project.

Where the ttl comes from is in [Environment
variables](../reference/environment.md#the-setting-that-is-a-file-not-a-variable). How the
deadline is worked out, and what counts as use, is in [State lives in
labels](../architecture/state.md). `keep` and `unkeep` are on [CLI
commands](../reference/cli.md).

## `gc` — reap sandboxes whose work is over

```bash
sandboxer gc --dry-run
sandboxer gc
```

`gc` reaps a sandbox when the worktree it was started from **no longer exists on disk**. You
deleted the branch's directory; the sandbox for it is now pointing at nothing. `gc` runs
`down` on it, which means the database goes too.

It then removes any `sandboxer-` volume that no surviving sandbox owns and nothing has
mounted. The shared volumes are never offered — `sandboxer-gocache` and `sandboxer-gomod` are an
expensive rebuild — and neither is a volume whose name the engine did not mint, so a volume an
embedder shares across sandboxes is out of scope before any list is consulted.

Last, it removes **project images a newer build has replaced**. Each project's image is tagged
with a hash of what went into building it, so rebuilding the base image or upgrading sandboxer
strands the old one: nothing will ever ask for that tag again. They are about six gigabytes
each. The newest image of every project stays, because that is the one your next `sandboxer up`
starts from.

> [!NOTE] `gc` removing images has not been watched on a real machine
> The decision is unit-tested against a fake Docker daemon, including every case where an image
> is kept. What has not been run is `docker image rm` against a live daemon from this command
> path. See [What is built](../reference/status.md).

<details class="why">
<summary><b>Why it works this way</b> — the filesystem is asked, not git</summary>

Whether a worktree still exists is checked on the filesystem, not with `git worktree list`.
A worktree removed with a plain `rm -rf` leaves a stale entry in git's admin files, and that
entry would keep the sandbox looking alive for ever.

Orphaned volumes are found by asking which volumes the *survivors* would have, and removing
what is left over. They are never found by parsing volume names. Both a project name and a
slug may contain dashes, so `sandboxer-data-acme-web-tkt-4821` cannot be split back into its
parts unambiguously — and a wrong split here deletes somebody's database.

Images follow the same doctrine, which is to keep on any doubt. An image survives if it is the
newest of its project, if it is `sandboxer/base`, if it is outside the `sandboxer/` namespace, if
any container references it — running *or* stopped — or if Docker declined to say when it was
built or how many containers hold it. Dangling and untagged images
are not touched at all: they belong to `docker image prune`, and nothing here can tell one
apart from a layer a build running right now is producing.

If `docker system df` will not answer, `gc` offers no image rather than guessing, and still
reaps containers and volumes. "No listing" is not "there is nothing there".

Core can also reap a sandbox whose branch has been merged. No CLI flag exposes that yet, so
from the command line `gc` reaps on the missing worktree alone.

</details>

## `prune` — reclaim what building left behind

```bash
sandboxer prune                      # a report; removes nothing
sandboxer prune --yes                # remove what it listed
sandboxer prune --build-cache --yes  # and Docker's build cache with it
```

`prune` is the whole-machine report. It covers the same ground as `gc` and puts a number
against each item:

- **Orphaned per-sandbox volumes** — the same ones `gc` finds.
- **Superseded project images** — the same ones `gc` finds, with the disk each would return.
- **Docker's build cache**, only with `--build-cache`, because sandboxer is not its only
  writer. Every project on the same Docker daemon built into it. This is the part `gc` does
  not do.

Each project's newest image always survives. Its tag is a content hash, so the next `up`
finds it and starts in seconds instead of rebuilding a toolchain — which is the only reason
to keep an image at all. `sandboxer/base` is never removed as superseded either: it is tagged
by version rather than by content, so "older tag" does not mean "replaced".

```
WOULD REMOVE  NAME                        SIZE    WHY
image         sandboxer/acme:40ed880f9db8  5.3 GB  sandboxer/acme:48273eacdece replaced it
image         sandboxer/demo:664cb3e82b64  452 MB  sandboxer/demo:de1aab947f66 replaced it

About 5.8 GB in total. Add --yes to remove it.
```

> [!IMPORTANT] `sandboxer prune --yes` has never removed anything
> The report has been run against a live Docker daemon and its figures match `docker system
> df`. The removal path is unit-tested only, against a fake daemon. What a real run would
> settle is that `docker image rm` accepts the references the plan builds, and that the space
> the report promised is the space that comes back. See [what is
> built](../reference/status.md).

## The asymmetry, and why it is deliberate

`gc` and `expire` **act by default** and take `--dry-run` to hold back. `prune` **reports by
default** and acts only with `--yes`. That looks like an inconsistency and is not.

It follows from the cost of being wrong.

- A sandbox stopped or removed in error costs you a **restart**. Annoying, seconds to
  minutes, and the worktree it was built from is untouched.
- An image removed in error costs a **toolchain rebuild** — and it is not paid now, it is
  paid on somebody's next `up`, which is the worst possible moment to discover it. On a
  large project that is tens of minutes.

So the command whose mistakes are cheap does the thing and lets you ask it not to. The
command whose mistakes are expensive tells you first.

**Then why does `gc` remove images without asking?** Because a *superseded* image is the one
case where that second cost is zero. Its tag is a hash of a build that no longer exists, so no
`up` will ever look for it again — keeping it buys nothing and costs six gigabytes. The image
whose loss would hurt is the newest one, and neither command will take that. What `--yes`
still guards on `prune` is the build cache, which other projects on the same daemon wrote too,
and the habit of reading a whole-machine reclaim before pointing it at your machine.

Leaving superseded images to `prune` alone is what let a machine reach a full disk with five
of them on it. A command you have to remember to run reclaims nothing on the days you forget.

<details class="facts">
<summary><b>Fact sheet</b> — what each verb removes, in one table</summary>

| Verb | Container | Volumes | Image | Acts by default? |
|---|---|---|---|---|
| `stop` | stopped, kept | kept | kept | yes |
| `start` | started | kept | kept | yes |
| `expire` | stopped, kept | kept | kept | yes — `--dry-run` to preview |
| `down` | removed | **removed** | kept | yes |
| `down --keep` | removed | kept | kept | yes |
| `gc` | removed, if its worktree is gone | **removed** | **superseded ones** | yes — `--dry-run` to preview |
| `prune` | never touched | orphans only | **superseded ones** | **no** — `--yes` to act |
| `prune --build-cache` | never touched | orphans only | superseded ones, plus Docker's build cache | **no** — `--yes` to act |

Never removed by anything sandboxer does: your worktree; the seed cache; `~/.sandboxer/logs`;
`sandboxer-gocache`; `sandboxer-gomod`; `sandboxer-deps-<hash>` while any container has it
mounted; `sandboxer/base`; anything outside the `sandboxer-` and `sandboxer/` namespaces.

Volume names, from `packages/core/src/naming.ts`:
`sandboxer-<data|blob|bin|www>-<project>-<slug>`.

</details>

**Next:** [The edit–reload loop](edit-and-reload.md) is what you do between an `up` and a
`down`. [Giving Docker the whole machine](docker-capacity.md) is the page for when `prune`
was not enough and the disk is still full.
