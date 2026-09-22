---
title: State lives in labels
description: Why there is no list of sandboxes anywhere, and how runtime state is derived rather than stored.
---

There is no manifest file and no database of sandboxes. Nothing on the machine keeps a list.

`sandboxer ls` asks Docker which containers exist, and reads every column off a label on the
container. `sandboxer gc` decides which sandboxes to reap the same way. Both are pure functions of
`docker ps`, so neither can drift out of sync with what is running. (`gc` also asks `docker system
df` which images are lying around, but that is disk, not sandbox state — nothing about a sandbox is
read from it.)

This page explains why that is the design, what it costs, and the few places where something is
allowed to live on the host after all.

## The labels

```
sandboxer.project    the project's name
sandboxer.slug       the sandbox's short name — the filter that finds every sandbox
sandboxer.branch     the branch it started from, or "?"
sandboxer.commit     the commit it started from, or "?"
sandboxer.dirty      "true" or "false" — the worktree's state when it started
sandboxer.worktree   the absolute path on the host it was built from
sandboxer.driver     the database driver
sandboxer.created    ISO 8601, UTC
sandboxer.access     public or private
sandboxer.ttl        seconds it may sit unused for, or "never"
sandboxer.env        a digest of the environment it was created with — a record, not a comparison
```

The shared router carries `sandboxer.role=router` instead, and a control plane somebody puts on
the bare domain carries a role of its own. Neither has a slug label, so neither can ever appear in
a sandbox listing. A control plane also carries `sandboxer.frontend`, which says "this container
answers on the bare domain" — it is what *any* container put there carries, and it is how the
engine reads a request *about* a sandbox rather than *to* one.

<details class="agent">
<summary><b>Details for an agent</b> — the label scheme's exact behaviour</summary>

`LABELS` in `packages/core/src/sandbox/labels.ts` is the authority.

- **The filter that finds every sandbox is `label=sandboxer.slug`**, whatever project it belongs to.
- **A branch or commit that cannot be resolved is recorded as `?`**, never omitted. A missing label
  and an unknown branch would otherwise read the same, and only one of them is a bug.
- **`sandboxer.env` records the past and must not be read as a live answer.** It is a digest of
  the project's credentials and its `env:` map as they were when the container was created. An
  empty one means *unknown*, never *unchanged*.
- **An absent `sandboxer.ttl` reads as `never`.** Anything the expiry planner cannot parse has to
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
| Whether the last migration succeeded | a marker file in `/run/sandboxer`, inside the container |
| Whether a backend is healthy right now | asked, live, over `/__sandboxer/health/<service>` |
| `running` / `degraded` / `stopped` / `starting` | computed from Docker's state plus those markers |
| When a sandbox expires | `max(startedAt, lastActive) + sandboxer.ttl`, computed per read |
| When a sandbox was last used | the shared router's access log, the agent index, and the heartbeat a held-open socket leaves in `state/attach/`, read at the moment they are asked for |
| Whether it has read the current credentials | the secrets file's mtime against the container's `StartedAt` |

A label recording "running" would be a second source of truth that goes stale the moment a process
dies. That is exactly the drift this design exists to avoid.

The last row is `sandboxer.env`'s twin, and the difference between them is a bug that has already
been made. The label says what the environment *was* when the container was created, and Docker
will not let a label be changed after that — so a sandbox restarted to pick up a rotated credential
kept the label it started life with. The badge stayed lit, the button appeared to do nothing, and
pressing it again did nothing again. Comparing times answers the question actually being asked, and
it clears itself, because a restart moves `StartedAt`.

The case that matters most is `degraded`. A failed migration deliberately leaves the container
running, so anything reading only Docker's state reports a degraded sandbox as healthy.

### There is deliberately no `sandboxer.expires` label

A deadline label is the obvious design and it is wrong.

`sandboxer.ttl` is a *duration*, which is durable. A deadline is not. `sandboxer.created` is stamped
once and never moves, so a deadline of `created + ttl` is already in the past the moment the reaper
stops a sandbox. Pressing Restart would hand the next pass a sandbox that is still expired, it
would be stopped again, and the button would look broken.

<details class="agent">
<summary><b>Details for an agent</b> — how the deadline is really computed</summary>

The deadline is `max(startedAt, lastActive) + ttl`.

- `startedAt` is Docker's own `State.StartedAt`, which Docker maintains. It gives the semantics
  anyone expects from a Restart button: restarting a sandbox buys it another full lifetime.
- `lastActive` is the last time anybody used it, and four things count: a request that reached the
  sandbox through the shared router, a front end's route that names it (also in the router's log,
  under that front end's own router name), activity the caller reports on its worktree, and a
  socket somebody is holding open, timed by the heartbeat in
  `state/attach/<project>/<slug>`.

The first three are read at the moment they are asked for and none of them is written down for this
purpose. The fourth is the exception, and the section below says why it has to be. Work reported
as running reads as activity *now*, so a sandbox cannot expire under it; work reported as finished
reads as when it finished, so the countdown starts from then. Because a caller killed mid-run
leaves "running" behind for ever, the engine believes a live claim only while its evidence is still
being written to — and a held socket is believed on the same terms, and for the same fifteen
minutes, after its last heartbeat.

Every failure is an *absence*, never an answer: a router that will not answer, a missing or corrupt
index, a transcript that cannot be stat'd, an attach marker that is not there. Each drops one signal
and the sandbox falls back to its start time. The alternative reading — "nobody has used anything" —
would stop every sandbox on the machine at once.

So the lifetime measures **idleness, not uptime**. Using a sandbox resets its clock. The precedence
chain for the ttl itself is in [Environment
variables](../reference/environment.md#the-setting-that-is-a-file-not-a-variable), and the verb
that acts on it is `sandboxer expire` — see [CLI commands](../reference/cli.md).

</details>

## What labels-only buys

- **A listing cannot be stale.** A container that does not exist cannot appear in `sandboxer ls`,
  because the listing *is* the container set.
- **A listing cannot lie.** Every reader reads live, so there is no cache to invalidate.
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

**A label is a string.** No nested structures, no lists, no booleans — `sandboxer.dirty` is the text
`"true"`.

**`sandboxer.commit` and `sandboxer.dirty` go stale.** They are a snapshot from `up`. A commit you
make in the worktree afterwards is not reflected. They answer "what was this started from", not
"what is it now", and the code says so rather than pretending otherwise. That is a genuine wart, and
it is preferable to keeping a second copy of the truth on the host.

**There is no history.** Remove a container and its state goes with it. That is right for a sandbox,
but you cannot ask what existed last week.

## Four things that look like exceptions, and are not

Anything that manages projects needs to know about a project with nothing running. It also needs
a way to say "keep this one", a way to let you call a worktree something other than its branch, and
a way to tell another process that somebody is sitting in a terminal right now. All four put
something on the host, which on a fast read this page forbids. Here is the line.

**The test is not "is it state".** It is the one the argument above actually turns on: *does this
file's correctness depend on a container?*

If it does, it needs a pass that compares it against `docker ps` and believes `docker ps`. At that
point it is a cache of something you had to read anyway. If it does not, it is an original.

<details class="why">
<summary><b>Why it works this way</b> — the workspace is an original, not a copy</summary>

`~/.sandboxer/workspace/<project>/repo.git` is where a repository lives on this machine, and that is
recorded nowhere else that survives the last container. The `sandboxer.worktree` label dies with its
container, and the plan file holds container paths.

Run the six failures above against it and none of them apply. No lifecycle command writes it. A
`docker rm` leaves a project that correctly now has no sandboxes. It is outside every repository.

It is also not a *list*. **A project is a directory containing `repo.git`**, so listing the projects
is a `readdir` — the same shape of answer as `docker ps`.

And it may only ever *add* projects to a listing, never filter one. The workspace answer is the
directory listing **unioned** with what is running, so nothing running can be hidden by
deregistering anything.

</details>

<details class="why">
<summary><b>Why it works this way</b> — the keep-alive marker, and the stamp that makes it legal</summary>

A keep-alive marker exempts one sandbox from its idle limit. It cannot be a label, because a running
container's labels are immutable. So it is a file: `~/.sandboxer/state/keep/<project>/<slug>`. It is
the one piece of per-sandbox state that lives on the host.

It is legal because of one detail. **The file contains that container's `sandboxer.created` value,
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
too: `~/.sandboxer/state/name/<project>/<slug>`.

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

<details class="why">
<summary><b>Why it works this way</b> — the attach heartbeat, the one signal with no original to read</summary>

While something holds a terminal or another socket open on a sandbox, it re-stamps
`~/.sandboxer/state/attach/<project>/<slug>` every thirty seconds. That is a written signal in a page
about not writing signals, so it needs the strongest form of the argument.

**The test this file passes is that there is no original to read.** The router's log is the original
for a request. For an open socket there is nothing:
Traefik does not log a websocket until it *closes*, and stamps the line with when it **opened**. So
a terminal held open all afternoon left no evidence of use, the reaper stopped the container under a
live connection, and the log then recorded a request dated to that morning — a cause that looks
nothing like its symptom.

The one process that knows a socket is open is the one holding it, and `sandboxer expire` on the
command line is a *different process*. Keeping the set in memory would give the two different
answers to "is this in use", which is exactly the drift this page forbids. So the fact is put where
both readers can see it.

**It needs no stamp, and for a different reason than the display name.** All it says is "at time T a
live process held a connection to this name". The deadline is `max(startedAt, lastActive)`, so a
marker older than the container that now has that name contributes nothing at all. A keep marker had
to be stamped because it is a *permission*; a timestamp cannot grant anything.

Two things bound what it may mean, and both exist because an unbounded version would be worse than
the bug. A holder killed with a terminal open leaves a marker nothing will move again, so past
fifteen minutes it is credited with the moment it was last written and nothing more. And a laptop
that sleeps with the tab open never closes its connection, so the holder pings each socket and one
that stops answering stops counting — dropped rather than closed, so a laptop waking up simply
starts counting again.

</details>

## The best example of the argument: last activity

A sandbox is stopped once it has sat unused for its `sandboxer.ttl`, so something has to answer "when
was this last used?".

The obvious design is to store it: a timestamp per sandbox, written whenever a request arrives. Run
the six failures above against that file and it fails every one of them — with the worst possible
consequence. A last-activity time that is wrong in the *early* direction stops a sandbox somebody is
working in.

For almost all of it there is nothing to store, because the answer is already written down. The
shared router logs one line per request, and each line ends with the router's name — which for a
sandbox **is** its container name. So last activity is a `docker logs sandboxer-router --since
<window>` at the moment somebody asks, parsed and thrown away. No file, no writer, no
reconciliation. It cannot disagree with what actually happened, because it *is* what actually
happened.

The exception proves the rule rather than breaking it. A **held-open websocket** is the one thing
the router's log cannot describe — it writes the line when the socket closes, stamped with when it
opened — so a session held open longer than the ttl left no evidence at all. There is no original to
read, so a heartbeat is written; the argument for it is above, under the four exceptions. Note what
it did *not* become: not a stored last-activity time, which would be wrong in the early direction
and stop a sandbox somebody is working in, but a record of a live connection that stops being
believed as soon as it stops being refreshed.

<details class="agent">
<summary><b>Details for an agent</b> — three load-bearing details of the activity signal</summary>

- **The per-sandbox logs are not a substitute.** `~/.sandboxer/logs/<project>/<slug>/` looks like the
  same signal and is not. A control plane's health probes dial containers directly on the Docker
  network, so they write to those logs every few seconds on a sandbox nobody is touching. A timer
  keyed on them would never fire. The router's log is the right one *because* the probes do not go
  through the router.
- **A missing router means no information, never "no activity".** If the log cannot be read, every
  sandbox falls back to its start time. The alternative reading — "nobody has used anything" — would
  stop every sandbox on the machine at once, which is the one failure here that destroys work.
- **A websocket's log line carries the time it *started*, and is written only when it ends.** So the
  router's log proves a terminal was *opened* and can never prove one is still open. That gap is
  what `state/attach/<project>/<slug>` exists to close, and it is the reason the one written signal
  here is written.

The parse is anchored on the format Traefik writes today. If a future Traefik changed it, every
sandbox would fall back to its start time rather than being expired wrongly. The code is
`packages/core/src/sandbox/activity.ts`.

</details>

## What is not in labels

Some things must **outlive** a container. Those live under `SANDBOXER_HOME`, which defaults to
`~/.sandboxer`.

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
| `state/slug/<project>/<worktree dir>` | The slug a worktree was given when two branches on one ticket would have shared one — random, so it cannot be derived again |
| `state/attach/<project>/<slug>` | A socket is open on this sandbox right now — a fact no other process can see |

`SANDBOXER_HOME` is deliberately never inside a repository, so `git clean -xdf` cannot destroy your
seed cache or your certificates. The full list is in [Paths](../reference/paths.md).

## Reading the labels yourself

```bash
docker ps --filter label=sandboxer.project=acme \
  --format '{{.Names}}\t{{.Label "sandboxer.slug"}}\t{{.Label "sandboxer.branch"}}'
```

```
sandboxer-acme-tkt-4821	tkt-4821	tkt-4821
sandboxer-acme-fix-nav	fix-nav	fix/nav
```

If `sandboxer ls` and `docker ps` ever disagree, that is a bug in the listing code, because there is
nothing else it could be.

## The names

| Thing | Name |
|---|---|
| Container | `sandboxer-<project>-<slug>` |
| Network | `sandboxer` — one, shared |
| Per-sandbox volumes | `sandboxer-<purpose>-<project>-<slug>`, purpose one of `data`, `blob`, `bin`, `www` |
| Shared volumes | `sandboxer-deps-<lockfile hash>`, `sandboxer-gocache`, `sandboxer-gomod` |
| Project image | `sandboxer/<project>:<12 hex>` — the hash covers the tool version, the rendered Dockerfile and every staged manifest |
| The machine's own image | `sandboxer/base`, tagged by tool version and `latest` |

<details class="agent">
<summary><b>Details for an agent</b> — what <code>gc</code> and <code>prune</code> may each remove</summary>

Reclamation is a contract, not a heuristic.

`gc` reads the sandbox list, the volume list and `docker system df`. It reaps a sandbox whose
`sandboxer.worktree` no longer exists on disk, removes any `sandboxer-` volume no surviving sandbox
has mounted, and removes any project image a newer build of the same project replaced. Because the
image tag is a content hash, every base image rebuild and every tool version bump strands a
project's previous image — at roughly six gigabytes each, that is where a machine's disk actually
goes, and it is why the reaping happens in the command that gets run routinely rather than only in
the one you have to remember.

`prune` reads `docker system df` too and reports the same volumes and images with sizes against
them, plus — only when asked — Docker's build cache, which sandboxer is not the only writer of.

Four rules bind both:

- **The shared volumes are never removed, by either**, and neither is anything the caller declared
  its own: a machine-wide credential store looks exactly like a volume nobody wants on an evening
  when every sandbox is stopped.
- **`sandboxer/base` is never removed as superseded**, nor are the `sandboxer/` names reserved for a
  product's own machine images. They are tagged by version rather than by content, so "older tag"
  does not mean "replaced".
- **Of each project's images, the newest survives.** A content-addressed tag means the next `up`
  finds it and starts rather than rebuilding, which is the reason the image is kept at all.
- **An image any container references is never removed**, running or stopped, and neither is one
  docker declined to give a creation time or a container count for. Dangling and untagged images are
  out of scope: they belong to `docker image prune`, and nothing here can tell one apart from a
  layer a build running right now is producing.

`prune` reports by default and acts only when told to, which is the reverse of `gc` and `expire`.
The two agree exactly about which images may go, and a superseded tag is one no future `up` can
name, so nothing is weighed against removing it. What `--yes` guards is the build cache and reading
a whole-machine reclaim before running it.

</details>

**Next:** [How a request arrives](request-path.md) — the router reading these labels. Or
[Start, stop, list, clean up](../guides/lifecycle.md) for the commands that act on them.
