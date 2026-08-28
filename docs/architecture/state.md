---
title: State lives in labels
description: Why there is no list of sandboxes anywhere, and how runtime state is derived rather than stored.
---

There is no manifest file and no database of sandboxes. Nothing on the machine keeps a list.

`sandboxr ls` asks Docker which containers exist, and reads every column off a label on the
container. `sandboxr gc` does the same. Both are pure functions of `docker ps`, so neither can drift
out of sync with what is running.

This page explains why that is the design, what it costs, and the two places where something is
allowed to live on the host after all.

## The labels

```
sandboxr.project    the project's name
sandboxr.slug       the sandbox's short name — the filter that finds every sandbox
sandboxr.branch     the branch it started from, or "?"
sandboxr.commit     the commit it started from, or "?"
sandboxr.dirty      "true" or "false" — the worktree's state when it started
sandboxr.worktree   the absolute path on the host it was built from
sandboxr.driver     the database driver
sandboxr.created    ISO 8601, UTC
sandboxr.access     public or private
sandboxr.ttl        seconds it may sit unused for, or "never"
sandboxr.env        a digest of the environment it was created with — a record, not a comparison
```

The shared router and the dashboard carry `sandboxr.role=router` and `sandboxr.role=dashboard`
instead. Neither has a slug label, so neither can ever appear in a sandbox listing.

<details class="agent">
<summary><b>Details for an agent</b> — the label scheme's exact behaviour</summary>

`LABELS` in `packages/core/src/sandbox/labels.ts` is the authority.

- **The filter that finds every sandbox is `label=sandboxr.slug`**, whatever project it belongs to.
- **A branch or commit that cannot be resolved is recorded as `?`**, never omitted. A missing label
  and an unknown branch would otherwise read the same, and only one of them is a bug.
- **`sandboxr.env` records the past and must not be read as a live answer.** It is a digest of
  the project's credentials and its `env:` map as they were when the container was created. An
  empty one means *unknown*, never *unchanged*.
- **An absent `sandboxr.ttl` reads as `never`.** Anything the expiry planner cannot parse has to
  fail closed. A sandbox started before this label existed and coming out as "already expired"
  would be stopped the first time the reaper ran.
- **A container with no slug label yields nothing**, rather than a sandbox with invented fields. A
  stray container on the same daemon can never appear in the list.
- `deriveState` is the whole of the state machine: not running is `stopped`; running with a failed
  migration is `degraded`; running with a successful one is `running`; running and having said
  neither yet is `starting`, which is what a sandbox spends its first seconds as.

</details>

## Labels hold durable state only

A label is fixed when the container is created, and Docker offers no way to change one while it
runs. So anything that changes at runtime is **derived at read time** instead.

| Changes at runtime | Where it actually lives |
|---|---|
| Which front-ends have been built | `/srv/www/.built.json`, inside the container |
| Whether the last migration succeeded | a marker file in `/run/sandboxr`, inside the container |
| Whether a backend is healthy right now | asked, live, over `/__sandboxr/health/<service>` |
| `running` / `degraded` / `stopped` / `starting` | computed from Docker's state plus those markers |
| When a sandbox expires | `max(startedAt, lastActive) + sandboxr.ttl`, computed per read |
| When a sandbox was last used | the shared router's access log and the agent index, read at the moment they are asked for |
| Whether it has read the current credentials | the secrets file's mtime against the container's `StartedAt` |

A label recording "running" would be a second source of truth that goes stale the moment a process
dies. That is exactly the drift this design exists to avoid.

The last row is `sandboxr.env`'s twin, and the difference between them is a bug that has already
been made. The label says what the environment *was* when the container was created, and Docker
will not let a label be changed after that — so a sandbox restarted to pick up a rotated credential
kept the label it started life with. The badge stayed lit, the button appeared to do nothing, and
pressing it again did nothing again. Comparing times answers the question actually being asked, and
it clears itself, because a restart moves `StartedAt`.

The case that matters most is `degraded`. A failed migration deliberately leaves the container
running, so anything reading only Docker's state reports a degraded sandbox as healthy.

### There is deliberately no `sandboxr.expires` label

A deadline label is the obvious design and it is wrong.

`sandboxr.ttl` is a *duration*, which is durable. A deadline is not. `sandboxr.created` is stamped
once and never moves, so a deadline of `created + ttl` is already in the past the moment the reaper
stops a sandbox. Pressing Restart would hand the next pass a sandbox that is still expired, it
would be stopped again, and the button would look broken.

<details class="agent">
<summary><b>Details for an agent</b> — how the deadline is really computed</summary>

The deadline is `max(startedAt, lastActive) + ttl`.

- `startedAt` is Docker's own `State.StartedAt`, which Docker maintains. It gives the semantics
  anyone expects from a Restart button: restarting a sandbox buys it another full lifetime.
- `lastActive` is the last time anybody used it, and three things count: a request that reached the
  sandbox through the shared router, a dashboard route that names it (also in the router's log,
  under the dashboard's own router name), and an agent run on its worktree — joined through
  `agent/runs.json` and timed by the transcript's mtime.

Every one of those is read at the moment it is asked for, and none of them is written down for this
purpose. A live agent run reads as activity *now*, so a sandbox cannot expire under a working agent;
an ended one reads as when it ended, so the countdown starts from when the agent stopped. Because a
killed dashboard leaves `running` rows behind for ever, a live row is believed only while the
transcript it names is still being written to.

Every failure is an *absence*, never an answer: a router that will not answer, a missing or corrupt
index, a transcript that cannot be stat'd. Each drops one signal and the sandbox falls back to its
start time. The alternative reading — "nobody has used anything" — would stop every sandbox on the
machine at once.

So the lifetime measures **idleness, not uptime**. Using a sandbox resets its clock. The precedence
chain for the ttl itself, and the reaper that acts on it, are in
[Projects, worktrees and lifetimes](../guides/managed-sandboxes.md).

</details>

## What labels-only buys

- **A listing cannot be stale.** A container that does not exist cannot appear in `sandboxr ls`,
  because the listing *is* the container set.
- **The dashboard cannot lie.** It reads live, so there is no cache to invalidate.
- **Crash recovery is free.** Interrupt `up` halfway, reboot, `docker rm` a container by hand —
  nothing is left inconsistent, because there is no bookkeeping.
- **The router needs no configuration file.** It resolves a hostname by matching labels, so starting
  a sandbox makes its hostnames work with nothing to write and nothing to reload.

## The alternative, and why it is worse

A manifest file — a JSON list of sandboxes, updated on `up` and `down` — fails in the **ordinary**
case, not the exotic one. Every one of these leaves it wrong:

- `up` is interrupted after the container starts and before the file is written.
- The machine reboots during a `down`.
- Somebody runs `docker rm` directly, which people do.
- Two `up` commands race on the file.
- The file sits inside a repository and `git clean` removes it.
- Docker's own pruning removes a container.

Each is recoverable with a reconciliation step. That step's job is to compare the file against
`docker ps` and believe `docker ps`. At which point the file is a cache of the thing you already have
to read, and its only remaining function is to be wrong occasionally.

> [!TIP] The general shape of the argument
> When the truth is already stored somewhere durable that you have to read anyway, a second copy is
> not state. It is a bug with a schema.

## What it costs

**A label is a string.** No nested structures, no lists, no booleans — `sandboxr.dirty` is the text
`"true"`.

**`sandboxr.commit` and `sandboxr.dirty` go stale.** They are a snapshot from `up`. A commit you
make in the worktree afterwards is not reflected. They answer "what was this started from", not
"what is it now", and the code says so rather than pretending otherwise. That is a genuine wart, and
it is preferable to keeping a second copy of the truth on the host.

**There is no history.** Remove a container and its state goes with it. That is right for a sandbox,
but you cannot ask what existed last week.

## Three things that look like exceptions, and are not

A dashboard that manages projects needs to know about a project with nothing running. It also needs
a way to say "keep this one", and a way to let you call a worktree something other than its branch.
All three put something on the host, which on a fast read this page forbids. Here is the line.

**The test is not "is it state".** It is the one the argument above actually turns on: *does this
file's correctness depend on a container?*

If it does, it needs a pass that compares it against `docker ps` and believes `docker ps`. At that
point it is a cache of something you had to read anyway. If it does not, it is an original.

<details class="why">
<summary><b>Why it works this way</b> — the workspace is an original, not a copy</summary>

`~/.sandboxr/workspace/<project>/repo.git` is where a repository lives on this machine, and that is
recorded nowhere else that survives the last container. The `sandboxr.worktree` label dies with its
container, and the plan file holds container paths.

Run the six failures above against it and none of them apply. No lifecycle command writes it. A
`docker rm` leaves a project that correctly now has no sandboxes. It is outside every repository.

It is also not a *list*. **A project is a directory containing `repo.git`**, so listing the projects
is a `readdir` — the same shape of answer as `docker ps`.

And it may only ever *add* projects to the dashboard, never filter them. The workspace the dashboard
answers with is the directory listing **unioned** with what is running, so nothing running can be
hidden by deregistering anything.

</details>

<details class="why">
<summary><b>Why it works this way</b> — the keep-alive marker, and the stamp that makes it legal</summary>

A keep-alive marker exempts one sandbox from its idle limit. It cannot be a label, because a running
container's labels are immutable. So it is a file: `~/.sandboxr/state/keep/<project>/<slug>`. It is
the one piece of per-sandbox state that lives on the host.

It is legal because of one detail. **The file contains that container's `sandboxr.created` value,
and a marker whose stamp does not match the live container is ignored.**

That makes a stale marker fail closed, which is what removes the need for a reconciliation pass.
Without the stamp it would be exactly the bug this page describes, and a nasty one. Slugs are
derived from ticket ids, so the same `project/slug` is recreated routinely. A marker outliving its
sandbox would silently keep the *next* sandbox to take that name alive.

`down` removes the marker. That is tidiness, not correctness — `docker rm` by hand cannot be hooked,
and the stamp is what covers that case.

The general form: **a file that records what you want is not a copy of what is true.** It earns its
place by being unable to disagree with reality, not by being written carefully.

</details>

<details class="why">
<summary><b>Why it works this way</b> — a worktree's name, and why this one must <i>not</i> be stamped</summary>

You can call a worktree "the checkout flow rewrite" instead of `feat/tkt-4821`. That name is a file
too: `~/.sandboxr/state/name/<project>/<slug>`.

It passes the same test, and it reaches the **opposite** conclusion about the stamp — which is the
useful part, because it shows the test is about the question being asked and not about the file
format.

A keep-alive marker applies to one *container*, so it has to name one. A name applies to the
*worktree*, which is the thing that persists — a sandbox comes and goes on top of it. **Stamping the
name would be the bug rather than the safeguard**: it would be discarded the moment a sandbox was
stopped and recreated, so a rename would quietly undo itself the next time somebody pressed Rebuild.

A stale name is inert, which is what makes the missing stamp safe. Left behind for a slug nothing
has cut, it is only ever read when a worktree of that slug is listed again — where it is a label, not
a permission and not a lifetime.

And it is only a label. **A display name reaches no identifier**: the slug, the hostname, the
container name and every URL are still derived from the branch and the directory, and renaming a
worktree changes one line on a screen and no address anywhere.

</details>

## The best example of the argument: last activity

A sandbox is stopped once it has sat unused for its `sandboxr.ttl`, so something has to answer "when
was this last used?".

The obvious design is to store it: a timestamp per sandbox, written whenever a request arrives. Run
the six failures above against that file and it fails every one of them — with the worst possible
consequence. A last-activity time that is wrong in the *early* direction stops a sandbox somebody is
working in.

There is nothing to store, because the answer is already written down. The shared router logs one
line per request, and each line ends with the router's name — which for a sandbox **is** its
container name. So last activity is a `docker logs sandboxr-router --since <window>` at the moment
somebody asks, parsed and thrown away. No file, no writer, no reconciliation. It cannot disagree
with what actually happened, because it *is* what actually happened.

<details class="agent">
<summary><b>Details for an agent</b> — two load-bearing details of the activity signal</summary>

- **The per-sandbox logs are not a substitute.** `~/.sandboxr/logs/<project>/<slug>/` looks like the
  same signal and is not. The dashboard's health probes dial containers directly on the Docker
  network, so they write to those logs every few seconds on a sandbox nobody is touching. A timer
  keyed on them would never fire. The router's log is the right one *because* the probes do not go
  through the router.
- **A missing router means no information, never "no activity".** If the log cannot be read, every
  sandbox falls back to its start time. The alternative reading — "nobody has used anything" — would
  stop every sandbox on the machine at once, which is the one failure here that destroys work.

The parse is anchored on the format Traefik writes today. If a future Traefik changed it, every
sandbox would fall back to its start time rather than being expired wrongly. The code is
`packages/core/src/sandbox/activity.ts`.

</details>

## What is not in labels

Some things must **outlive** a container. Those live under `SANDBOXR_HOME`, which defaults to
`~/.sandboxr`.

| Path | Why it is not a label |
|---|---|
| `cache/` | Seed artifacts, shared between sandboxes and expensive to rebuild |
| `logs/<project>/<slug>/` | Survive the container on purpose — the logs from a sandbox you just deleted are the ones you want |
| `tls/`, `state/` | Machine-level, not per-sandbox |
| `secrets/<project>.env` | Per project, mode 0600, edited by hand, and must never be in an image |
| `build/<project>/<slug>.env`, `build/<project>/<slug>.plan.json` | Regenerated on every `up` |
| `bin/` | Host-built helper binaries |
| `workspace/<project>/` | The repositories themselves — an original, not a copy |
| `config.yaml` | The machine's own settings, written by hand |
| `state/keep/<project>/<slug>` | Operator intent, stamped with the instance it applies to |
| `state/name/<project>/<slug>` | What to call one worktree — a label, deliberately not stamped |

`SANDBOXR_HOME` is deliberately never inside a repository, so `git clean -xdf` cannot destroy your
seed cache or your certificates. The full list is in [Paths](../reference/paths.md).

## Reading the labels yourself

```bash
docker ps --filter label=sandboxr.project=acme \
  --format '{{.Names}}\t{{.Label "sandboxr.slug"}}\t{{.Label "sandboxr.branch"}}'
```

```
sandboxr-acme-tkt-4821	tkt-4821	tkt-4821
sandboxr-acme-fix-nav	fix-nav	fix/nav
```

If `sandboxr ls` and `docker ps` ever disagree, that is a bug in the listing code, because there is
nothing else it could be.

## The names

| Thing | Name |
|---|---|
| Container | `sandboxr-<project>-<slug>` |
| Network | `sandboxr` — one, shared |
| Per-sandbox volumes | `sandboxr-<purpose>-<project>-<slug>`, purpose one of `data`, `blob`, `bin`, `www` |
| Shared volumes | `sandboxr-deps-<lockfile hash>`, `sandboxr-gocache`, `sandboxr-gomod`, `sandboxr-claude` |
| Project image | `sandboxr/<project>:<12 hex>` — the hash covers the tool version, the rendered Dockerfile and every staged manifest |
| The machine's own images | `sandboxr/base` and `sandboxr/dashboard`, tagged by tool version and `latest` |

<details class="agent">
<summary><b>Details for an agent</b> — what <code>gc</code> and <code>prune</code> may each remove</summary>

Reclamation is a contract, not a heuristic.

`gc` reads the sandbox list and the volume list. It reaps a sandbox whose `sandboxr.worktree` no
longer exists on disk, and removes any `sandboxr-` volume no surviving sandbox has mounted.

`prune` reads `docker system df` instead, and reclaims what *building* left behind: orphaned
volumes, project images older than that project's newest one, and — only when asked — Docker's build
cache. Because the image tag is a content hash, every base image rebuild and every tool version bump
orphans a project's previous image, which is where a machine's disk actually goes.

Three rules bind both:

- **The shared volumes are never removed, by either.** Taking `sandboxr-claude` would sign the
  machine out of every MCP server it has been given.
- **`sandboxr/base` and `sandboxr/dashboard` are never removed as superseded.** They are tagged by
  version rather than by content, so "older tag" does not mean "replaced".
- **Of each project's images, the newest survives.** A content-addressed tag means the next `up`
  finds it and starts rather than rebuilding, which is the reason the image is kept at all.

`prune` reports by default and acts only when told to, which is the reverse of `gc` and `expire`.
The asymmetry follows from the cost of being wrong: a sandbox removed in error costs a restart, an
image removed in error costs a toolchain rebuild on somebody else's next `up`.

</details>

**Next:** [How a request arrives](request-path.md) — the router reading these labels. Or
[Start, stop, list, clean up](../guides/lifecycle.md) for the commands that act on them.
