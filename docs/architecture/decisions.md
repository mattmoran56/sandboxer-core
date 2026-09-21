---
title: Design decisions
description: For every choice a reader would want to reverse — the obvious approach, why it fails, and what was done instead.
---

Each section lists its decisions in a line each, then opens the full argument in one block: the
obvious approach, why it fails, and what it costs.

They all share a shape. The obvious design fails in the **ordinary** case rather than an exotic
one, and the symptom does not resemble the cause. That is what makes them worth writing down —
the reason an obvious answer was rejected is not visible anywhere in the code.

<details class="agent">
<summary><b>Details for an agent</b> — which of these are contract-level, and what reversing one costs</summary>

Some decisions below are settled in [`docs/architecture/contracts.md`](contracts.md), which outranks every page on
this site. Changing one of those means changing the contract **first**, in its own commit, and
saying so in the commit message. A package that disagrees with the contract is a bug.

| Decision | Fixed by |
|---|---|
| Slug derivation, the 31-character ceiling, and hashing rather than truncation | §3.1 |
| The hostname shape, and the bare domain a control plane may be put on | §3.2 |
| Container, network, volume and image names; which volumes and images are never reclaimed | §3.3 |
| Labels as the only state; labels holding durable state only; no `sandboxr.expires` | §3.4 |
| Host paths under `SANDBOXR_HOME`; the workspace; the keep-alive stamp; `config.yaml` | §4, §4.1, §4.2, §4.3 |
| Three runtime kinds; on-demand static builds; the reserved `/__sandboxr/` prefix; `optional` never reading as a fault | §5.1 |
| The secrets rules | §5.2 |
| Refusing a public sandbox, and `anonymised: true` as an assertion | §5.3 |
| `plan.json` as the only boundary into the container | §5.5 |
| A worktree's own config always winning, and the bounded search | §5.6 |
| The driver interface, and every rule that applies to every driver | §6 |
| Where a seed artifact lives and how the container reaches it | §6.2 |
| The forward-auth handshake, the bare domain it trusts, and that the engine answers none of it | §7 |
| Git mounts, the commit identity, and the GitHub token | §7.1 |
| Claiming the bare domain with `sandboxr.frontend`, and what `init` leaves empty | §7.2 |
| The verbs and their scopes, and that a refusal is the last word | §8 |

Everything else on this page is implementation reasoning. It is still load-bearing, and the
comments in the source carry the same argument beside the code.

</details>


## Images and the container

- **Two images, not one.** A small generic base, plus a thin per-project layer. One image with
  the toolchains baked in could serve only one project.
- **The Docker client is not in the base image.** Keeping it out is what stops a sandboxed
  project driving Docker.
- **Debian, not a vendor database image.** Those images carry a glibc too old for other things
  a sandbox has to run.
- **MySQL from the vendor's generic tarball, not a package repository.** The distribution's
  archive carries a *different* database, and the vendor's repository has an expired key.
- **The object store is in the base image, not behind a flag.** It is a guarantee, not a
  feature: a public sandbox cannot write to production object storage.
- **One container per worktree, not one per service.** The unit you want to throw away is a
  *branch*, not a service.
- **The container reads a resolved plan, not the config file.** The host emits a flat, fully
  resolved [`plan.json`](plan-json.md) and the container reads only that.
- **Bind-mount the worktree, read-write.** Anything else adds a sync step to every edit.
- **Git works through a second mount, at the identical path inside and out.** A linked
  worktree's `.git` names its repository by absolute path, so both have to be there.

<details class="why">
<summary><b>Why it works this way</b> — the obvious design for each of those, why it fails, and what it costs</summary>

**Two images, not one.** *Obvious:* one image with the project's toolchains baked in. *Why not:* it
can only ever serve one project. Toolchain versions, database engine and dependency tree are all
facts about one repository, so a second project means a second multi-gigabyte image. *Instead:* a
small generic base — supervisor, router, object store, `jq`, the container scripts — plus a thin
per-project layer holding exactly what that project's `toolchain:` and `database:` blocks declare.
The project layer's build context holds **only dependency manifests, never source**, so a source
change can never re-run a dependency install.

**The Docker client is not in the base image.** *Obvious:* one image with the Docker client in it,
used both for sandboxes and for whatever drives them. *Why not:* the two have opposite needs.
Something driving sandboxes does nothing but reach the daemon; a sandbox runs a project and must
never be able to reach it at all. *Instead:* the base image carries no Docker client, and anything
that needs one builds its own image on top. That is what stops a sandboxed project — or an agent
inside one — driving Docker.

**Debian, not a vendor database image.** *Obvious:* base on the official image for whichever
database the project needs. *Why not:* those images are built on a distribution whose glibc is too
old for other things a sandbox has to run. Cloudflare's `workerd`, which anything running `wrangler
dev` needs, fails with `GLIBC_2.35 not found`, and no configuration helps. *Instead:* Debian
bookworm, and install the database engine separately — which is a per-project concern anyway.

**MySQL from the vendor's generic tarball, not a package repository.** *Obvious:* install from the
distribution's archive or the vendor's repository. *Why not:* the distribution's archive carries a
*different* database. It is not a drop-in substitute for a project depending on MySQL collation
names or advisory-lock semantics. And the vendor's own repository has an expired signing key, so
the package manager refuses it outright. *Instead:* the vendor's generic tarball, pinning an exact
version. *The cost:* the download host publishes no machine-readable release list, so a version
series resolves through a small pinned table. Go and Node both publish an index and are resolved
from it; this one cannot be.

**The object store is in the base image, not behind a flag.** *Obvious:* install it only when a
project declares `storage:`. It is the largest thing in the base. *Why not:* a public sandbox driven
by a stranger must not be able to write to production object storage. The only reliable way to
guarantee that is for the endpoint the code sees to be **local**. So the stand-in has to be present
whether or not the project remembered to ask for it. It is a guarantee, not a feature, so it does
not belong behind a config flag.

**One container per worktree, not one per service.** *Obvious:* a compose file, one container per
service, like production. *Why not:* the unit you want to throw away is a *branch*, not a service.
Per-service containers mean a database that is either shared — so two branches with different
migrations cannot coexist — or itself per-branch, at which point you have re-invented the sandbox
with more moving parts. *The cost:* a sandbox is a fat container and is not how the project is
deployed. It is not meant to be. Testing deployment topology is a different job.

**The container reads a resolved plan, not the config file.** *Obvious:* mount `sandboxr.yaml` and
let the container read it. *Why not:* the container would have to merge defaults, validate
combinations and compute addresses — in shell, with no schema and no type checker. It would then
have to agree with the host's implementation of the same rules for ever. *Instead:* the host emits a
flat, fully resolved [`plan.json`](plan-json.md) and the container reads only that.

**Bind-mount the worktree, read-write.** *Obvious:* copy the source in, or build it into an image.
*Why not:* either adds a sync step to every edit. An image rebuild is minutes, which kills the loop.
A copy needs a watcher, which is a second thing to get wrong and which will get it wrong during a
rebase. *The cost:* anything in the container can rewrite your branch. The container is disposable;
the mount is not.

**Git works through a second mount, at the identical path inside and out.** *Obvious:* mount the
worktree and be done. *Why not:* a linked worktree's `.git` is a *file* naming its repository by
absolute path. A container with only the worktree fails every git command with one `fatal: not a git
repository` naming a host path. *Instead:* the worktree **and** the repository it points at are both
bind-mounted, at the same paths the host calls them. *The cost:* the repository mount is read-write,
because `git commit` writes objects and refs. So every sandbox of a project shares one object store
with the host. Read-only was the alternative and is worse — status and log would work, and only the
commit would fail, from inside git, on a permission error.

</details>

## Building and serving

- **Static front-ends are built on demand, never at startup.** Building six apps takes minutes.
- **An unbuilt hostname answers with a page, not a 404.** A 404 there is indistinguishable
  from broken name resolution.
- **A static build, not a dev server, for a component library.** A dev server holds the whole
  library in memory, permanently, once per sandbox.
- **`all` and `built` are different rebuild sets.** One command would be wrong for the
  expensive members.
- **Three runtime kinds, not two.** A long-running dev server has a port but no build artefact.
  [In full](../configuration/runtime-kinds.md).
- **`static_mode` is explicit, with no clever default.** The wrong guess does not crash — it
  half-works.
- **One memory limit for the whole sandbox**, the largest any single app declares, floored at
  4 GB. The kernel enforces the container's total.
- **A memory requirement is refused up front.** Otherwise the answer is a bare `Killed` and
  exit code 137, neither of which mentions memory.
- **A service that cannot start is omitted, not supervised.** A crash-loop makes a working
  sandbox look broken.
- **A dormant service is never reported as a fault.** `optional: true` means dormant by choice.

<details class="why">
<summary><b>Why it works this way</b> — the obvious design for each of those, why it fails, and what it costs</summary>

**Static front-ends are built on demand, never at startup.** *Obvious:* build everything when the
sandbox starts, so it is ready. *Why not:* a sandbox has to come up in seconds and building six apps
takes minutes. You almost always want one of them, so the other five are pure waiting, every time,
for everyone. *Why an unbuilt hostname answers with a page and not a 404:* a 404 at a sandbox
hostname is indistinguishable from broken name resolution or a misconfigured router. You would debug
the wrong layer entirely.

**A static build, not a dev server, for a component library.** *Obvious:* run its dev server and get
hot reload. *Why not:* that is a long-lived process holding the whole component library in memory —
commonly several hundred megabytes, permanently, whether or not anyone opens it — paid once per
sandbox. *The cost:* stories do not hot-reload. This is the general trade behind
[there being no hot reload](../guides/edit-and-reload.md).

**`all` and `built` are different rebuild sets.** *Obvious:* one "rebuild the front-ends" command.
*Why not:* the expensive members make one command wrong. "Rebuild everything" on a component tweak
would start a multi-gigabyte site build as a side effect. *Instead:* `--web=all` builds the
project's main apps, excluding anything marked `in_build_all: false`. `--web=built` refreshes exactly
what this sandbox has already built, so it never *starts* a first build of an excluded app by
accident.

**Three runtime kinds, not two.** *Obvious:* things with a port, and things that produce files. *Why
not:* a long-running dev server has a port but no build artefact and no meaningful rebuild command.
Fold it into "backend" and it loses its app hostname. Fold it into "static" and there is nothing to
serve. [In full](../configuration/runtime-kinds.md).

**`static_mode` is explicit, with no clever default.** *Obvious:* work out how to serve a built
directory by looking at what is in it. *Why not:* the three cases are genuinely different and the
wrong guess does not crash. Pick one mode for all three and two of them **half-work**, which is much
worse than failing, because you find out from a user rather than from a build.

**One memory limit for the whole sandbox.** *Obvious:* give each app the limit it declares. *Why
not:* the kernel enforces the container's total, not a per-app number. An app declaring `memory: 6g`
inside a 2 GB container is killed at 2 GB, and the message says nothing about memory. *Instead:* the
container's limit is the largest any single app declares, with a floor of 4 GB. No per-run override:
a build that needs 6 GB needs it every time, and that belongs in the config where a reviewer sees
it.

**A memory requirement is refused up front.** *Obvious:* let the build run and report what happens.
*Why not:* what happens is a bare `Killed` and exit code 137. Neither mentions memory, so people
debug their own code. *Instead:* compare the declared `memory` against the container's actual limit
and refuse in one second, naming the limit and the fix. The build also gets a single-process heap
ceiling at about 75% of the limit — which bounds one process, not their sum, and that is exactly why
the up-front check has to exist as well.

**A service that cannot start is omitted, not supervised.** *Obvious:* declare every service and let
supervision deal with failures. *Why not:* a service needing a database no migration creates can
only crash-loop. It fills the log, shows red in anything watching, and makes a working sandbox look
broken. *Instead:* leave it out of the plan, or mark it `optional` — and leave a comment where the
entry would go, saying why, otherwise somebody adds it back next quarter.

**A dormant service is never reported as a fault.** *Obvious:* a service that is not answering is
down. *Why not:* `optional: true` means dormant by choice. A deliberate choice displayed as a failure
is a bug, and it is the kind that trains people to ignore the panel that tells them what is wrong.
*Instead:* `optional` is carried out of the plan all the way to the screen, and a dormant service
gets its own state — never `down`.

</details>

## Routing and state

- **The router is not gated on the database.** A service not up yet answers **502**, which is
  truthful. A refused connection is not an answer.
- **The router's domain comes from the environment, in one place.** Written many times, a
  domain override silently does nothing.
- **The domain ends in `.localhost`.** Every current browser and macOS's own resolver answer
  any name under it with the loopback address, per RFC 6761.
- **TLS is used when it is already trusted, and skipped when it is not.** Installing mkcert's
  root needs an administrator password.
- **Nothing is published beyond loopback.** `--bind` is how somebody says otherwise on purpose.
- **One router entry per sandbox, not per app.** A `HostRegexp` rule with the label wildcarded, inside the one DNS label a hostname is.
  The container is the right thing to resolve a label.
- **The handshake router's priority is explicit.** Traefik would otherwise order rules by their
  length.
- **`/__sandboxr/` is reserved and answers before any app.** A path under it that names nothing
  is a 404 from the router itself. [In full](request-path.md).
- **State lives only in Docker labels.** A manifest file goes wrong in the ordinary case.
  [In full](state.md).
- **There is no `sandboxr.expires` label.** A stored deadline is already in the past when the
  reaper acts on it, so the ttl is stored as a *duration*.
- **The status document is derived, never asserted.** There is no state field for anyone to set
  wrongly.
- **Per-service log files, trimmed rather than rotated.** One interleaved stream cannot be
  filtered after the fact.
- **`SANDBOXR_HOME` is never inside a repository.** `git clean -xdf` is a normal thing to run.

<details class="why">
<summary><b>Why it works this way</b> — the obvious design for each of those, why it fails, and what it costs</summary>

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

**The domain ends in `.localhost`.** *Obvious:* a made-up local TLD, or a wildcard DNS service.
*Why not:* a made-up TLD needs a resolver file and therefore an administrator password. A wildcard
resolver such as sslip.io needs the internet to be up to reach a sandbox on your own machine. *Why
`.localhost` works:* every current browser and macOS's own resolver answer any name under it with
the loopback address, per RFC 6761 — no resolver file, no `/etc/hosts` line, no DNS container.

**TLS is used when it is already trusted, and skipped when it is not.** *Obvious:* always serve
https. *Why not:* installing mkcert's root is the one step in the whole setup that needs an
administrator password, and doing it implicitly is not acceptable. *Instead:* `init` checks, and
either serves https or serves http and prints the single command that upgrades it.

**Nothing is published beyond loopback.** *Obvious:* bind the router to every interface, like a
server would. *Why not:* a "public" sandbox is then public to the network. *Instead:* the router
binds `127.0.0.1`, and `--bind` is how somebody says otherwise on purpose.

**One router entry per sandbox, not per app.** *Obvious:* one route per hostname, so the shared
router knows exactly what exists. *Why not:* the set of labels is a fact about the plan, so adding a
front-end would require the router to be told about it. *Instead:* a `HostRegexp` rule with the
label wildcarded. The container is the right thing to resolve a label, and it already answers an
unknown one with a 404 that explains itself. An outer router doing the same split would answer "no
such host" for an app the inner one could have explained.

**The handshake router's priority is explicit.** *Obvious:* let the router order its own rules. *Why
not:* Traefik defaults priority to the **length of the rule**, so which of two rules wins would
depend on how long somebody's branch name is. *Instead:* a fixed high number, so the reserved prefix
wins every time.

**`/__sandboxr/` is reserved and answers before any app.** *Obvious:* let the status routes sit
alongside an app's routes. *Why not:* a host matcher matches every path, so a status path that named
nothing fell through to whichever front-end the request arrived on. A dormant service's health probe
came back as that app's own 503 while the app was unbuilt. Once it was built the same probe came back
as its `index.html` with a 200. So one dead service read as `down` and then as `up`. *Instead:* a
path under the prefix that names nothing is a 404 from the router itself. [In full](request-path.md).

**State lives only in Docker labels.** *Obvious:* a manifest file listing sandboxes. *Why not:* it
goes wrong in the ordinary case — interrupted `up`, reboot mid-`down`, someone running `docker rm`
by hand, two `up`s racing. Each is fixable with a reconciliation pass whose job is to compare the
file with `docker ps` and believe `docker ps`. At that point the file is a cache of the thing you
already have to read. *The cost:* labels are immutable strings, so runtime state is derived at read
time instead. [In full](state.md).

**There is no `sandboxr.expires` label.** *Obvious:* store the deadline. *Why not:* `created + ttl`
is a fixed instant, and it is already in the past the moment the reaper stops a sandbox. Restarting
one would get it stopped again on the very next pass, and the button would look broken. *Instead:*
store the ttl as a *duration* and derive the deadline from the container's current start time and
its last request.

**The status document is derived, never asserted.** *Obvious:* have whatever finishes last write
`state: "ok"`. *Why not:* two writers can then disagree and the last one wins regardless of which
was right. A sandbox reporting `ok` while its migration failed is worse than one reporting nothing.
*Instead:* every writer records a *fact* in its own marker file and a composer derives the state.
There is no state field for anyone to set wrongly.

**Per-service log files, trimmed rather than rotated.** *Obvious:* let everything write to stdout
and read `docker logs`. *Why not:* it interleaves every process and cannot be filtered after the
fact — unreadable for a person, and for an agent trying to find its own failure. *Trimmed rather
than rotated* because these are development logs, and a sandbox left up for days must not be able to
fill its own disk.

**`SANDBOXR_HOME` is never inside a repository.** *Obvious:* keep state next to the project, in
`.sandboxr/`. *Why not:* `git clean -xdf` is a normal thing to run, and it would destroy the seed
cache, the certificates and every sandbox's logs.

</details>

## The workspace, and the machine's own settings

- **A project is a directory containing `repo.git`. There is no registry file.** Listing the
  projects is a directory listing.
- **Bare, never a mirror.** A mirror's refspec would reset a branch a worktree has checked out.
- **The project list is a union with `docker ps`, never a filter.** A running sandbox whose
  project is not in the workspace must still appear.
- **A project-level config is a fallback, never an override.** A worktree's own config always
  wins, and `root` is always the worktree.
- **The config search is bounded at the top of a managed worktree.** An unbounded walk would
  leave the checkout.
- **The machine's settings live in `~/.sandboxr/config.yaml`, not in `sandboxr.yaml`.** A
  setting that lives in a repository is a setting a repository can *ask for*.
- **The GitHub token has no flag and no environment variable.** It decides which code may act
  as the person running it. **The default is off.**
- **Claude Code's credential store is one volume, shared by every sandbox.** *The cost, stated
  plainly:* every sandbox on the machine can read every credential in it.
- **The host's Claude credential is one file, bind-mounted, not the directory around it.** That
  directory holds a `settings.json` which can define hooks.

<details class="why">
<summary><b>Why it works this way</b> — the obvious design for each of those, why it fails, and what it costs</summary>

**A project is a directory containing `repo.git`. There is no registry file.** *Obvious:* keep a
list of projects. *Why not:* the same reason there is no list of sandboxes — a list is a second copy
of something a `readdir` already answers. *Instead:* listing the projects is a directory listing.
Nothing is written when a project is cloned beyond the clone itself.

**Bare, never a mirror.** *Obvious:* `git clone --mirror`, which is what you reach for when you want
every ref. *Why not:* a mirror sets a `+refs/*:refs/*` refspec, so every fetch force-updates
`refs/heads/*` to match the remote — and worktree branches live there. A routine fetch would reset a
branch a worktree has checked out and discard local commits. *Instead:* `--bare`, with
`+refs/heads/*:refs/remotes/origin/*` set explicitly, which a plain `--bare` clone does not
configure at all.

**The project list is a union with `docker ps`, never a filter.** *Obvious:* show the projects in
the workspace. *Why not:* a running sandbox whose project is not in the workspace must still appear.
A list that could hide something running is the staleness this whole design exists to avoid.

**A project-level config is a fallback, never an override.** *Obvious:* if a project has a config
beside its mirror, use it. *Why not:* a repository that describes itself must not be silently
overruled by a file outside it that its authors cannot see. *Instead:* a worktree's own config always
wins, and `root` is always the worktree — never the workspace project directory, which holds
`repo.git` and every sibling worktree.

**The config search is bounded at the top of a managed worktree.** *Obvious:* walk up until you find
a config, as every tool does. *Why not:* an unbounded walk leaves the checkout and lands on the
project-level file on its own, with `root` set to that file's directory. That would mount every
sibling worktree into the sandbox and resolve every declared path one directory too high. *Instead:*
inside a managed worktree the walk stops at the worktree top, and the explicit fallback is the only
sanctioned way to reach the project-level file.

**The machine's settings live in `~/.sandboxr/config.yaml`, not in `sandboxr.yaml`.** *Obvious:* put
the lifetime and the GitHub setting where the rest of the project's configuration is. *Why not:* a
setting that lives in a repository is a setting a repository can *ask for*. Clone something, start a
sandbox, and its committed config would have helped itself to a credential reaching every repository
you can push to. *Instead:* the machine decides which projects it trusts with its own credentials. A
project never votes on that.

**The GitHub token has no flag and no environment variable.** *Obvious:* let a run override it, the
way `--ttl` overrides a lifetime. *Why not:* a lifetime is a scheduling preference. This is a
decision about which code may act as the person running it, and a decision like that belongs in one
file somebody can read — not in whatever started the process. *The default is off.*

**Claude Code's credential store is one volume, shared by every sandbox.** *Obvious:* one per
sandbox, isolated. *Why not:* an MCP server would then have to be signed into once per worktree
rather than once per machine, which is most of the value. *The cost, stated plainly:* every sandbox
on the machine can read every credential in it. That is a decision, not an oversight, and this is
the line to revisit if isolation is ever needed. The volume is never reaped, by `gc` or `prune` —
removing it would sign the machine out of every server it had been given.

**The host's Claude credential is one file, bind-mounted, not the directory around it.** *Obvious:*
mount `~/.claude`. *Why not:* that directory holds a `settings.json` which can define hooks —
commands the host's own Claude Code then executes — so a sandbox could put a command on the person's
machine. *Why shared rather than copied:* an OAuth refresh token rotates and is single-use, so two
copies invalidate each other the first time either side refreshes.

</details>

## Databases and migrations

- **A failed migration does not stop the sandbox.** You cannot get a shell into a container
  that exited. The sandbox is marked `degraded`, never silently.
- **The schema baseline is only re-taken after a success.** Re-snapshotting a half-migrated
  schema would overwrite the last known-clean copy.
- **A migration runner's exit code is not always trusted.** A runner can print its own failure
  and then exit zero.
- **Migrations run from a directory where no config file resolves.** A runner that backfills
  from relative paths can find a production config in the tree.
- **Restore into the declared database version, not the developer's.** A `latest` tag drifts.
- **The source database is only ever read.** Every destructive operation targets a copy.
- **Migration bookkeeping repair was deliberately not ported.** Repairing it means
  reimplementing the project's migration logic.
- **One writer per file-backed database.** Two processes opening the same D1 file deadlock.
- **Slugs are hashed past 31 characters, not truncated.** Truncation lets two sandboxes collide
  on one advisory lock.

<details class="why">
<summary><b>Why it works this way</b> — the obvious design for each of those, why it fails, and what it costs</summary>

**A failed migration does not stop the sandbox.** *Obvious:* fail fast — a container whose database
is wrong should not serve. *Why not:* inspecting a failed migration is one of the main reasons the
sandbox exists, and you cannot get a shell into a container that exited. *Instead:* record the
failure, mark the sandbox `degraded`, boot everything anyway. Never silently.

**The schema baseline is only re-taken after a success.** *Obvious:* snapshot before each attempt.
*Why not:* schema changes are not transactional in every engine, so a failed migration leaves a
half-migrated schema, and re-snapshotting overwrites the last-known-clean baseline with it. The next
comparison then reports **no change** — at exactly the moment the question matters most, in a form
that reads as reassurance.

**A migration runner's exit code is not always trusted.** *Obvious:* the exit status is the answer.
*Why not:* a runner that prints its own failure summary and then exits zero reports success while
the schema is half applied. And a sandbox builds that runner **from the branch it is testing**. *The
related trap:* `cmd | tee log` exits with `tee`'s status, and `tee` always succeeds.

**Migrations run from a directory where no config file resolves.** *Obvious:* run from the project
root, like a developer would. *Why not:* a runner that resolves its config from relative paths, and
loads it without overriding what is already set, silently backfills a *partially* set environment
from whichever file it finds. A production config anywhere in the tree can supply the missing half.

**Restore into the declared database version, not the developer's.** *Obvious:* use whatever the
source is running; it is the same data. *Why not:* a laptop's `latest` tag drifts, and often lands
on a release line production will never run. A migration is only meaningfully tested against the
version it will really run on.

**The source database is only ever read.** *Obvious:* nothing — this one is not controversial, and
it is stated because it is what makes the rest safe. Every destructive operation targets a copy,
which is the property that makes it safe to point a half-written migration at real data.

**Migration bookkeeping repair was deliberately not ported.** *Obvious:* heal rows a copied database
inherited unfinished, so the project's runner will proceed. *Why not:* that means reading and
writing the project's own bookkeeping schema, which is reimplementing the project's migration logic
— the one thing the driver contract forbids. And it only ever works for the one project whose
schema you encoded. *Instead:* the repair belongs in the project's own runner, under two rules: heal
a row by completing it, never by deleting it; and never heal a row whose migration file is still
present.

**One writer per file-backed database.** *Obvious:* let the services share the file, as they share a
server. *Why not:* two processes opening the same D1 file deadlock. *Instead:* each sandbox gets a
private copy, and the config names the single service that owns it.

**Slugs are hashed past 31 characters, not truncated.** *Obvious:* truncate a long name to fit. *Why
not:* the slug ends up inside a database advisory lock name with a length budget, and two long
branch names very often share a prefix. Truncation lets two sandboxes collide on one lock, and one
migration silently waits on the other.

</details>

## Embedding the engine

The engine ships one face, the command line. These are the decisions that bind anything else
built on it, and they are here because each one was paid for once.

- **An embedder calls core in process, never the `sandboxr` command.** A second implementation
  of a core rule drifts within a week.
- **Whatever holds the Docker socket offers a closed table of commands, never a generic one.**
  A "run this command" endpoint behind a password is a remote shell with an extra step.
- **Core answers with facts, never rendered sentences.** An expiry is an instant, not
  `"3h 20m left"`.
- **A control plane lives on the bare domain, never on a sandbox hostname.** App hostnames are
  `public` by default. [contracts](contracts.md) §7.2.
- **Public sandboxes are refused, not warned.** Familiar warnings are invisible.
  [In full](../access.md).
- **The `anonymised: true` flag is an assertion, not a check.** The tool cannot verify it.

<details class="why">
<summary><b>Why it works this way</b> — the obvious design for each of those, why it fails, and what it costs</summary>

**An embedder calls core in process, never the `sandboxr` command.** *Obvious:* implement start,
stop and rebuild in the thing that needs them; it is a few functions. *Why not:* it is not. Volume
names keyed on a lockfile hash, seed cache invalidation, plan resolution, the worktree cases — a
second implementation drifts within a week, and then the two disagree about what a sandbox is.
*Instead:* call `@sandboxr/core`, and reach it through exactly one file of your own, so a renamed
export is a compile error in one place rather than a surprise at run time. Two things core does not
express, and an embedder that wants them holds the Docker socket itself: streaming an exec line by
line, and hijacking a connection for a terminal.

**Whatever holds the Docker socket offers a closed table of commands, never a generic one.**
*Obvious:* one endpoint that runs a command, with the command in the request. *Why not:* the thing
holding the socket can start any container on the machine. A generic command endpoint behind a
password is a remote shell with an extra step, and a credential-stealing bug becomes total
compromise instead of a bounded one. *Instead:* a fixed table, every command an argument array
rather than a shell string — which is also the rule core follows for every `docker` call it makes
(contracts §7).

**Core answers with facts, never rendered sentences.** *Obvious:* have core write the words, where
the data is. *Why not:* anything that changes on a timer then has the same wording twice. Once
where it was first rendered, once in whatever re-renders it every second — and the two have to be
kept identical by hand. That was literally the case for the lifetime countdown, and both copies
carried a comment warning about the other. *Instead:* an expiry is an instant and a state is
`degraded`, and the face writes the sentence. *The line this does not cross:* deciding is still
core's. Which verbs apply to a sandbox now, and whether a refusal can be forced at all, are
answers core gives (contracts §8).

**A control plane lives on the bare domain, never on a sandbox hostname.** *Obvious:* give a
terminal, or any other control surface, its own sandbox hostname like everything else. *Why not:*
app hostnames are `public` by default, so a terminal on a per-sandbox hostname is one config
mistake away from an interactive shell, on the internet, in a container with your worktree mounted.
*Instead:* the bare domain, which the engine leaves empty for exactly this, and which is the one
address the forward-auth middleware trusts — [contracts](contracts.md) §7.2.

**Public sandboxes are refused, not warned.** *Obvious:* print a warning and let the developer
decide. *Why not:* neither failure is recoverable — leaked records cannot be un-leaked, spend cannot
be un-spent. And warnings appear during `up`, a command you run dozens of times a day while thinking
about something else. They scroll, they become familiar, and familiar warnings are invisible.
[In full](../access.md).

**The `anonymised: true` flag is an assertion, not a check.** *Obvious:* have the tool verify a dump
carries no real data. *Why not:* it cannot. *Instead:* make somebody state it explicitly, in a
reviewed file, rather than imply a guarantee that does not exist.

</details>

## Where each decision lives

| Decision | Implemented in |
|---|---|
| Two images | `container/base/Dockerfile`, `container/project/Dockerfile.template`, `packages/core/src/image.ts` |
| The resolved plan | `packages/core/src/config/plan.ts`, spec in `container/README.md` |
| Labels as the only state | `packages/core/src/sandbox/labels.ts` |
| Run arguments, mounts, memory | `packages/core/src/sandbox/run.ts` |
| The shared router and certificates | `packages/core/src/access/` |
| Names, slugs, hostnames | `packages/core/src/naming.ts` |
| The workspace and its clones | `packages/core/src/workspace.ts`, `packages/core/src/worktree.ts` |
| The machine's own settings | `packages/core/src/config/machine.ts` |
| Git mounts and identity | `packages/core/src/git.ts` |
| The service graph | `container/scripts/gen-services.sh` |
| The sandbox's own router config | `container/scripts/gen-caddyfile.sh` |
| The derived status document | `container/scripts/status.sh` |
| Migration verdicts and patterns | `container/scripts/migrate-run.sh`, `packages/core/src/drivers/migrate.ts` |
| The memory check before a build | `container/scripts/build-static.sh` |
| The forward-auth middleware, and the bare domain's labels | `packages/core/src/access/router.ts`, `packages/core/src/access/frontend.ts` |

**Next:** [Package by package](packages.md) for where each of these belongs, or
[What is built](../reference/status.md) for which of them has actually been run.
