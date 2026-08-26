---
title: Design decisions
description: For every choice a reader would want to reverse — the obvious approach, why it fails, and what was done instead.
sidebar:
  order: 5
---

Every entry names the obvious approach first, because that is the one you will reach for.

They share a shape: the obvious design fails in the **ordinary** case rather than an exotic one,
and the symptom does not resemble the cause. That is what makes them worth writing down — anyone
re-deriving this design from first principles reaches the obvious answer first, and the reason it
was rejected is not visible anywhere in the code.

## Images and the container

**Two images, not one.** *Obvious:* one image with the project's toolchains baked in. *Why not:* it
can only ever serve one project — toolchain versions, database engine and dependency tree are all
facts about one repository, so a second project means a second multi-gigabyte image. *Instead:* a
small generic base — supervisor, router, object store, `jq`, the container scripts — plus a thin
per-project layer holding exactly what that project's `toolchain:` and `database:` blocks declare.
The project layer's build context holds **only dependency manifests, never source**, so a source
change can never re-run a dependency install.

**Debian, not a vendor database image.** *Obvious:* base on the official image for whichever
database the project needs. *Why not:* those images are built on a distribution whose glibc is too
old for other things a sandbox has to run — Cloudflare's `workerd`, which anything running
`wrangler dev` needs, fails with `GLIBC_2.35 not found`, and no configuration helps. *Instead:*
Debian bookworm, and install the database engine separately, which is a per-project concern anyway.

**MySQL from the vendor's generic tarball, not a package repository.** *Obvious:* install from the
distribution's archive or the vendor's repository. *Why not:* the distribution's archive carries a
*different* database, which is not a drop-in substitute for a project depending on MySQL collation
names or advisory-lock semantics — and the vendor's own repository has an expired signing key, so
the package manager refuses it outright. *Instead:* the vendor's generic tarball, pinning an exact
version. *The cost:* the download host publishes no machine-readable release list, so a version
series resolves through a small pinned table. Go and Node both publish an index and are resolved
from it; this one cannot be.

**The object store is in the base image, not behind a flag.** *Obvious:* install it only when a
project declares `storage:`; it is the largest thing in the base. *Why not:* a public sandbox
driven by a stranger must not be able to write to production object storage, and the only reliable
way to guarantee that is for the endpoint the code sees to be **local** — which means the stand-in
has to be present whether or not the project remembered to ask for it. It is a guarantee, not a
feature, so it does not belong behind a config flag.

**One container per worktree, not one per service.** *Obvious:* a compose file, one container per
service, like production. *Why not:* the unit you want to throw away is a *branch*, not a service.
Per-service containers mean a database that is either shared — so two branches with different
migrations cannot coexist — or itself per-branch, at which point you have re-invented the sandbox
with more moving parts. *The cost:* a sandbox is a fat container and is not how the project is
deployed. It is not meant to be; testing deployment topology is a different job.

**The container reads a resolved plan, not the config file.** *Obvious:* mount `sandboxr.yaml` and
let the container read it. *Why not:* the container would have to merge defaults, validate
combinations and compute addresses — in shell, with no schema and no type checker — and agree with
the host's implementation of the same rules for ever. *Instead:* the host emits a flat, fully
resolved [`plan.json`](plan-json.md) and the container reads only that.

**Bind-mount the worktree, read-write.** *Obvious:* copy the source in, or build it into an image.
*Why not:* either adds a sync step to every edit. An image rebuild is minutes, which kills the
loop; a copy needs a watcher, which is a second thing to get wrong and which will get it wrong
during a rebase. *The cost:* anything in the container can rewrite your branch. The container is
disposable; the mount is not.

## Building and serving

**Static front-ends are built on demand, never at startup.** *Obvious:* build everything when the
sandbox starts, so it is ready. *Why not:* a sandbox has to come up in seconds and building six
apps takes minutes — and you almost always want one of them. The other five are pure waiting, every
time, for everyone. *Why an unbuilt hostname answers with a page and not a 404:* a 404 at a sandbox
hostname is indistinguishable from broken DNS or a misconfigured router, so you would debug the
wrong layer entirely.

**A static build, not a dev server, for a component library.** *Obvious:* run its dev server and
get hot reload. *Why not:* a long-lived process holding the whole component library in memory —
commonly several hundred megabytes, permanently, whether or not anyone opens it — paid once per
sandbox. *The cost:* stories do not hot-reload. This is the general trade behind
[there being no hot reload](../guides/edit-and-reload.md#there-is-no-hot-reload).

**`all` and `built` are different rebuild sets.** *Obvious:* one "rebuild the front-ends" command.
*Why not:* the expensive members make one command wrong — "rebuild everything" on a component tweak
would start a multi-gigabyte site build as a side effect. *Instead:* `--web all` builds the
project's main apps, excluding `in_build_all: false`; `--web built` refreshes exactly what this
sandbox has already built, and never *starts* a first build of an expensive app by accident.

**Three runtime kinds, not two.** *Obvious:* things with a port, and things that produce files.
*Why not:* a long-running dev server has a port but no build artefact and no meaningful rebuild
command. Fold it into "backend" and it loses its app hostname; fold it into "static" and there is
nothing to serve. [In full](../configuration/runtime-kinds.md).

**`static_mode` is explicit, with no clever default.** *Obvious:* work out how to serve a built
directory by looking at what is in it. *Why not:* the three cases are genuinely different and the
wrong guess does not crash — pick one mode for all three and two of them **half-work**, which is
much worse than failing, because you find out from a user rather than from a build.

**One memory limit for the whole sandbox.** *Obvious:* give each app the limit it declares. *Why
not:* the kernel enforces the container's total, not a per-app number. An app declaring `memory: 6g`
inside a 2 GB container is killed at 2 GB, and the message says nothing about memory. *Instead:* the
container's limit is the largest any single app declares, floor 4 GB. No per-run override: a build
that needs 6 GB needs it every time, and that belongs in the config where a reviewer sees it.

**A memory requirement is refused up front.** *Obvious:* let the build run and report what happens.
*Why not:* what happens is a bare `Killed` and exit code 137, neither of which mentions memory, so
people debug their own code. *Instead:* compare the declared `memory` against the container's actual
limit and refuse in one second, naming the limit and the fix. The build also gets a single-process
heap ceiling at about 75% of the limit — which bounds one process, not their sum, which is exactly
why the up-front check has to exist as well.

**A service that cannot start is omitted, not supervised.** *Obvious:* declare every service and let
supervision deal with failures. *Why not:* a service needing a database no migration creates can
only crash-loop. It fills the log, shows red on the dashboard, and makes a working sandbox look
broken. *Instead:* leave it out of the plan, or mark it `optional` — and leave a comment where the
entry would go, saying why, otherwise somebody adds it back next quarter.

## Routing and state

**The router is not gated on the database.** *Obvious:* gate everything on the database being ready.
*Why not:* a first-boot restore legitimately takes minutes, and that is exactly when you most need
to know what is happening. A gated router answers "connection refused" for the whole of its first
boot, and a refused connection is not an answer — you cannot tell a slow restore from a broken one.
*Instead:* the router starts immediately and serves the status surface. A backend that is not up yet
answers **502**, which is truthful: I am here, that service is not.

**The router's domain comes from the environment, in one place.** *Obvious:* write the domain into
the router config. *Why not:* it ends up written many times, and then a domain override *silently
does nothing* — every request lands on the catch-all and nothing says why. *Instead:* the config is
generated at every boot and the domain is read once. An unknown host answers 404 **naming the host
it was asked for**, so a mismatch identifies itself.

**One router entry per sandbox, not per app.** *Obvious:* one route per hostname, so the shared
router knows exactly what exists. *Why not:* the set of labels is a fact about the plan, so adding a
front-end would require the router to be told about it. *Instead:* a `HostRegexp` rule with the
label wildcarded. The container is the right thing to resolve a label, and it already answers an
unknown one with a 404 that explains itself — an outer router doing the same split would answer "no
such host" for an app the inner one could have explained.

**State lives only in Docker labels.** *Obvious:* a manifest file listing sandboxes. *Why not:* it
goes wrong in the ordinary case — interrupted `up`, reboot mid-`down`, someone running `docker rm`
by hand, two `up`s racing. Each is fixable with a reconciliation pass whose job is to compare the
file with `docker ps` and believe `docker ps`, at which point the file is a cache of the thing you
already have to read. *The cost:* labels are immutable strings, so runtime state is derived at read
time instead. [In full](state.md).

**The status document is derived, never asserted.** *Obvious:* have whatever finishes last write
`state: "ok"`. *Why not:* two writers can then disagree and the last one wins regardless of which
was right. A sandbox reporting `ok` while its migration failed is worse than one reporting nothing.
*Instead:* every writer records a *fact* in its own marker file and a composer derives the state.
There is no state field for anyone to set wrongly.

**Per-service log files, trimmed rather than rotated.** *Obvious:* let everything write to stdout and
read `docker logs`. *Why not:* it interleaves every process and cannot be filtered after the fact —
unreadable for a person, and for an agent trying to find its own failure. *Trimmed rather than
rotated* because these are development logs, and a sandbox left up for days must not be able to fill
its own disk.

**`SANDBOXR_HOME` is never inside a repository.** *Obvious:* keep state next to the project in
`.sandboxr/`. *Why not:* `git clean -xdf` is a normal thing to run, and it would destroy the seed
cache, the certificates and every sandbox's logs.

## Databases and migrations

**A failed migration does not stop the sandbox.** *Obvious:* fail fast — a container whose database
is wrong should not serve. *Why not:* inspecting a failed migration is one of the main reasons the
sandbox exists, and you cannot get a shell into a container that exited. *Instead:* record the
failure, mark the sandbox `degraded`, boot everything anyway — never silently.

**The schema baseline is only re-taken after a success.** *Obvious:* snapshot before each attempt.
*Why not:* schema changes are not transactional in every engine, so a failed migration leaves a
half-migrated schema, and re-snapshotting overwrites the last-known-clean baseline with it. The next
comparison then reports **no change** — at exactly the moment the question matters most, in a form
that reads as reassurance.

**A migration runner's exit code is not always trusted.** *Obvious:* the exit status is the answer.
*Why not:* a runner that prints its own failure summary and then exits zero reports success while
the schema is half applied — and a sandbox builds that runner **from the branch it is testing**.
*The related trap:* `cmd | tee log` exits with `tee`'s status, and `tee` always succeeds.

**Migrations run from a directory where no config file resolves.** *Obvious:* run from the project
root, like a developer would. *Why not:* a runner that resolves its config from relative paths, and
loads it without overriding what is already set, silently backfills a *partially* set environment
from whichever file it finds — and a production config anywhere in the tree can supply the missing
half.

**Restore into the declared database version, not the developer's.** *Obvious:* use whatever the
source is running; it is the same data. *Why not:* a laptop's `latest` tag drifts and often lands on
a release line production will never run. A migration is only meaningfully tested against the
version it will really run on.

**Migration bookkeeping repair was deliberately not ported.** *Obvious:* heal rows a copied database
inherited unfinished, so the project's runner will proceed. *Why not:* that means reading and
writing the project's own bookkeeping schema, which is reimplementing the project's migration logic
— the one thing the driver contract forbids — and it only ever works for the one project whose
schema you encoded. *Instead:* the repair belongs in the project's own runner, under two rules: heal
a row by completing it, never by deleting it; and never heal a row whose migration file is still
present.

**Slugs are hashed past 31 characters, not truncated.** *Obvious:* truncate a long name to fit. *Why
not:* the slug ends up inside a database advisory lock name with a length budget, and two long
branch names very often share a prefix — so truncation lets two sandboxes collide on one lock and
one migration silently waits on the other.

## The dashboard

**The dashboard runs the same code as the CLI.** *Obvious:* implement start, stop and rebuild in the
web server; it is a few functions. *Why not:* it is not. Volume names keyed on a lockfile hash, seed
cache invalidation, plan resolution, the worktree cases — a second implementation drifts within a
week, and then the dashboard and the CLI disagree about what a sandbox is. *Instead:* both call
`@sandboxr/core`, and the dashboard reaches it through exactly one file,
`packages/server/src/core/adapter.ts`. It talks to the Docker socket directly for two things core
cannot do: streaming an exec line by line, and hijacking a connection for a terminal.

**Actions are a closed table.** *Obvious:* one endpoint that runs a command, with the command in the
request. *Why not:* the dashboard holds the Docker socket. A generic command endpoint behind a
password is a remote shell with an extra step, and a session-stealing bug becomes total compromise
instead of a bounded one. *Instead:* a fixed table, every command an argument array rather than a
shell string.

**Actions stream over two transports, not one.** *Obvious:* WebSockets for everything. *Why not:*
most actions are one-way, and Server-Sent Events is the simpler tool for that — plain HTTP,
reconnects on its own, works through anything that speaks HTTP. *Instead:* SSE for output, a
WebSocket for the terminal, which is genuinely bidirectional. *The related decision:* the progress
bar is a real fraction only where the output carries one. An invented percentage is worse than none,
because people plan around it.

**The terminal is a route inside the dashboard.** *Obvious:* give it its own hostname, like
everything else. *Why not:* app hostnames are `public` by default, so a terminal on a per-sandbox
hostname is one config mistake away from an interactive shell, on the internet, in a container with
your worktree mounted.

**Public sandboxes are refused, not warned.** *Obvious:* print a warning and let the developer
decide. *Why not:* neither failure is recoverable — leaked records cannot be un-leaked, spend cannot
be un-spent — and warnings appear during `up`, a command you run dozens of times a day while
thinking about something else. They scroll, they become familiar, and familiar warnings are
invisible. [In full](../access.md).

## Where each decision lives

| Decision | Implemented in |
|---|---|
| Two images | `container/base/Dockerfile`, `container/project/Dockerfile.template`, `packages/core/src/image.ts` |
| The resolved plan | `packages/core/src/config/plan.ts`, spec in `container/README.md` |
| Labels as the only state | `packages/core/src/sandbox/labels.ts` |
| Run arguments, mounts, memory | `packages/core/src/sandbox/run.ts` |
| The shared router and certificates | `packages/core/src/access/` |
| The service graph | `container/scripts/gen-services.sh` |
| The sandbox's own router config | `container/scripts/gen-caddyfile.sh` |
| The derived status document | `container/scripts/status.sh` |
| Migration verdicts and patterns | `container/scripts/migrate-run.sh`, `packages/core/src/drivers/migrate.ts` |
| The memory check before a build | `container/scripts/build-static.sh` |
| Slug derivation | `packages/core/src/naming.ts` |
| The closed action table | `packages/server/src/actions/table.ts` |
| Sessions, grants, forward-auth | `packages/server/src/auth/` |
