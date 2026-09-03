# Contracts

**This file is the single source of truth for every boundary in sandboxr.** Every package
depends on the names, shapes and paths below. If you need to change one, change it here
first and say so in the commit message — a package that disagrees with this file is a bug.

Read this before writing any code.

---

## 1. What sandboxr is

One container per git worktree, holding a whole project: its services, its front-ends, its
own database, its own file storage. Several run at once on one machine — locally or on a
remote server — each reachable in a browser at its own hostname.

Two audiences, and the split matters:

- **The apps** a sandbox serves are (by default) **public**. Someone who finds one sees a
  preview of unreleased features.
- **The controls** — the dashboard, the terminal, start/stop/rebuild/migrate — are **behind
  a password**. Always.

## 2. Repository layout

```
packages/core      @sandboxr/core     Config, drivers, docker orchestration, lifecycle
packages/cli       @sandboxr/cli      The `sandboxr` command
packages/server    @sandboxr/server   The dashboard's server: auth, JSON API, terminal, actions
packages/web       @sandboxr/web      The dashboard's browser app: React, Tailwind, built by Vite
packages/docs      @sandboxr/docs     The documentation site (MDX)
container/         (no package)       What runs INSIDE a sandbox: Dockerfiles, s6, scripts
examples/          (no package)       Example sandboxr.yaml files
```

Ownership rule: **only `container/` contains bash.** Everything host-side is TypeScript.
The container scripts are deliberately shell because they run under s6 with no toolchain
guarantees, and because they are ported from a working implementation.

The same rule, for the newest package: **`packages/web` holds no logic about what a sandbox
is.** It renders what the API sends and posts actions back. Which actions apply to a stopped
sandbox, what makes one degraded, how a slug is derived — every one of those is decided by
core and reported by the server, and a copy of any of them in the browser is a second
implementation that drifts.

`@sandboxr/server` depends on `@sandboxr/web` and serves its `dist/`. A root
`npm run build` orders the two correctly because of that dependency; building the server
alone leaves it serving an HTML shell with nothing behind it.

## 3. Naming

### 3.1 Slug

A slug identifies one sandbox. Resolved, in order of preference, from:

1. an explicit argument
2. **a slug recorded for this worktree** — see below
3. a ticket-style id anywhere in the worktree directory name (`/[a-z]+-[0-9]+/i`)
4. that same pattern in the branch name
5. the branch name
6. the worktree directory name

Rules 3 to 6 are the *derivation*, and it is a pure function: `deriveSlug` in
`packages/core/src/naming.ts` does no IO. Rule 2 is a file, so the whole order lives in
`slugFor` in `packages/core/src/worktree-slug.ts`. **Every read path goes through
`slugFor`** — `up`, the dashboard's worktree view and the CLI's listing and rename. One of
them deriving while another reads the record is drift: the dashboard would show one slug
and `up` would start a container under another.

Sanitising: lowercase, every character outside `[a-z0-9-]` becomes `-`, runs of `-`
collapse, leading and trailing `-` are stripped. A slug therefore never contains `--`,
which §3.2 depends on.

**The ceiling is `min(31, 63 - len(longest label) - len(project) - 4)`.** Over it, keep
the first `ceiling - 9` characters, append `-` and the first 8 characters of the SHA-256
of the *raw* input.

Two separate limits meet in that expression, and they are not interchangeable:

> **31 is the lock-name budget, and it is a maximum that may never be raised.** A slug ends
> up inside a database advisory lock name, and MySQL's `GET_LOCK` truncates names at 64
> characters. Two long branch names often share a prefix, and truncation would let two
> sandboxes collide on one lock — which is why an over-long slug is *hashed* rather than
> cut. Do not raise 31 without re-checking the lock-name budget of every driver.

> **The subtraction is the DNS-label budget, and it may only lower the ceiling.** §3.2 puts
> the slug, the label and the project in **one** DNS label, and a DNS label is limited to 63
> characters. Two separators of two characters each cost 4, so the slug's share is
> `63 - len(longest label) - len(project) - 4`. When that arithmetic allows more than 31 it
> is ignored: the lock budget still binds. `min` is the whole rule, and getting it the wrong
> way round would produce slugs that fit a hostname and collide on a lock.

Worked: project `redeployable` (12) with a longest label of `company` (7) gives
`63 - 12 - 7 - 4 = 40`, so the ceiling stays **31**. A project named
`redeployable-platform-services` (30) with a longest label of `admin-console` (13) gives
`63 - 30 - 13 - 4 = 16`, and 16 is what binds.

The hashed form survives a lowered ceiling because it is expressed against the ceiling
rather than against a fixed 22: the hash is always the last 9 characters, so the collision
protection is the last thing to be given up rather than the first.

**A ceiling below 12 is refused when the config is read**, naming the project, the longest
label and the budget. Under 12 the hashed form leaves fewer than three characters of
readable prefix, so every branch of any length reduces to a hash — and below 10 the form
does not fit at all. Discovering that as an invalid hostname at `up` time, one sandbox at a
time, is the failure this refusal exists to replace.

The `s3` label counts as a label here. Whenever the project declares object storage that store
answers on a hostname like any other app, so it spends the same budget; a calculation that ignored
it would leave exactly one hostname over the limit and every other one fine.

The ceiling is a property of the project, so **every resolution of a slug for a project has
to use that project's config** — `up`, the CLI's worktree listing, the dashboard's sidebar
and `addWorktree` all pass it, and `slugFor` carries it to the derivation, to the sanitising
of an explicit name, and to the collision token below. `addWorktree` is the awkward one: it
holds a workspace project, which is a directory and a bare clone rather than a resolved
config, so it loads the config of the worktree it has just cut. Anything that can read no
config falls back to 31; that is honest rather than a drift, because a project with no
readable config has no hostnames either.

**A worktree's directory name is not a slug and keeps the plain 31**, because it is a path
and spends none of the hostname budget. The two are already allowed to differ — the order of
preference above derives a slug from the branch before the directory — and for a project
whose budget binds they routinely will.

#### Two worktrees on one ticket, and the slug one of them is given

A ticket id beats the rest of the name because that is what makes a slug readable —
`eng-3941` rather than `feat-eng-3941-labs-answers-page`. The cost is that **two branches
on one ticket derive one slug**:

```
wt/feat-eng-3941-labs-answers-page   feat/eng-3941-labs-answers-page  -> eng-3941
wt/feat-eng-3941-labs-run-selector   feat/eng-3941-labs-run-selector  -> eng-3941
```

Everything is keyed on `<project>-<slug>`, so that is not two sandboxes with a confusing
pair of names — it is **one sandbox**. The container, all four volumes (§3.3), the router's
host rule (§3.2), the migration advisory lock and the `state/name` and `state/attach` files
are shared, and `up` replaces a container it finds rather than refusing, so starting the
second worktree tears the first one's sandbox down and hands its database to a branch that
never wrote it.

The rule: **on collision the worktree is given a slug, not refused.** When `addWorktree`
cuts a worktree, it compares the slug that worktree would derive against the resolved slugs
of the project's other worktrees, and on a match assigns `<base>-<token>` — four random
characters from `[a-z0-9]`, re-rolled if the token is taken. `eng-3941-7k2f`.

Four things about that decision are load-bearing:

- **The token is sized against the project's ceiling, not against 31.** A given slug is
  five characters longer than the one it replaces, and it is the same slug in the same
  hostname, so it spends the same DNS-label budget. `<base>` is trimmed to
  `ceiling - 5` — trailing `-` stripped, so the join never produces the `--` §3.2 reads as
  a separator — and the result is `≤ ceiling` like any derived slug. Sized against a flat
  31 instead, a collision would be the *only* thing in a budget-bound project that pushes a
  hostname past 63 characters, and the symptom of that is a name that does not resolve
  rather than anything that mentions a slug.
- **A short token, never a UUID.** Both ceilings forbid it: a 36-character UUID blows the
  31-character `GET_LOCK` budget outright, and blows a lowered DNS ceiling by more still.
  It would also destroy the readability the ticket-id rule exists to provide: the point is
  that the result is a name somebody can read off a screen and type into a URL.
- **A random token cannot be re-derived, so it is written down** — `state/slug/…`, §4.2.3.
  That file is why rule 2 exists.
- **Refusing would be worse.** A collision is most likely in exactly the case the ticket-id
  rule is most useful, and a refusal at `worktree add` would make the readable-slug rule a
  trap.

Worked, in the second project above — `redeployable-platform-services` with `admin-console`,
ceiling 16. Two branches on one ticket derive the ticket id `platformwork-3941`, hashed to
`platfor-3fb10da9` because 17 is over 16. The second worktree is given
`platfor-3fb-7k2f` — 16 again — and its hostname label is `16 + 2 + 13 + 2 + 30 = 63`
characters. Exactly at the limit, which is the point: the arithmetic has no slack to lose.

**Scope.** The check happens where the collision can be seen: `addWorktree`, which has the
sibling worktrees in hand. It therefore covers worktrees sandboxr cuts, under
`<workspace>/<project>/wt` (§4.1). A worktree somebody keeps in their own `.worktrees/`
directory is not managed by sandboxr, has no record, and can still collide — the fix there
is an explicit slug. **Collisions already on disk are not migrated**: renaming a worktree
that already has a running sandbox would orphan its container and its volumes under the old
name, which is worse than the problem.

### 3.2 Hostnames

```
<slug>--<label>--<project>.<domain>    an app or api inside a sandbox
<domain>                               the dashboard (the control plane)
```

- `label` comes from the project's config (`frontends[].label`, `backends[].label`).
- `project` is `project` in the config file.
- `domain` is `SANDBOXR_DOMAIN`, default `sbx.lcl`.

Example: `feat-123--app--acme.sbx.lcl`

**One DNS label above the domain, and that is a TLS requirement rather than a preference.**
A *DNS* wildcard does match more than one label — RFC 4592's closest-encloser rule, and both
Cloudflare and Route 53 document it — so the older three-label shape resolved perfectly well.
A *TLS* wildcard matches exactly one label, and `*.*.example.com` is not a valid certificate
name; issuers reject it and mkcert refuses it outright. So a sandbox three labels deep could
be covered by no wildcard certificate at all, and the answer was a certificate per sandbox,
issued on `up` and discarded on `down`. Flattened to one label, `*.<domain>` covers every
sandbox that will ever exist — the base certificate `init` already issues — and the whole
per-sandbox certificate mechanism is gone.

**`--` is the separator, and no component may contain it.** Slugs cannot (the sanitiser
collapses runs of `-`), and `project:` and every `label:` are refused by the schema if they
do. That is what makes the flattened label reversible: splitting on `--` yields exactly
three parts, or the host is not a sandbox hostname. Nothing may relax either rule without
also deciding how `a--b--c--d.<domain>` is to be read, because there is no answer.

Two things read a hostname back into its parts and both rely on that. The router's
`HostRegexp` rules have to recognise a sandbox hostname without knowing any sandbox, for the
private-app handshake. And the dashboard's `projectFromForwardedHost` decides which project's
grant a forwarded request is checked against — the permissive direction of a mistake there
grants a session a project it was never given, so it calls **core's `parseHost`** rather than
spelling the pattern out again. Both express a component as `[a-z0-9]+(-[a-z0-9]+)*` —
single hyphens only — so neither can read `a--b` as one label.

`parseHost` is the named reverse of `hostFor` and lives beside it. It answers undefined for
the bare domain, for a host under another domain, for anything more than one label deep, and
for a label that does not divide into exactly three parts.

The dashboard lives on the bare domain and **never** on a per-sandbox hostname. The
terminal is a route *within* the dashboard (`/p/<project>/s/<slug>/terminal`), so it
inherits the dashboard's session automatically. Do not give the terminal its own hostname.

The paths under that one hostname are §7.1.

### 3.3 Docker names

- Container: `sandboxr-<project>-<slug>`
- Network: `sandboxr` (one, shared)
- Volumes: `sandboxr-<purpose>-<project>-<slug>` where purpose is one of
  `data` (database), `blob` (object storage), `bin` (built binaries), `www` (built sites).
- Shared volumes: `sandboxr-deps-<hash>` (node_modules, keyed on lockfile),
  `sandboxr-gocache`, `sandboxr-gomod`, `sandboxr-claude` (an agent session's credential
  store, mounted at `/root/.claude` with `CLAUDE_CONFIG_DIR` pointing at it — see §7.2).

**A shared volume is populated only when it says so itself.** `sandboxr-deps-<hash>` is
filled in by the container on first boot, and *shared*: every sandbox on that lockfile
mounts the same one. A boot interrupted part-way through the copy leaves a directory that is
non-empty and incomplete, so "non-empty" cannot be the test for "installed" — it poisons the
volume permanently, and every sandbox on the lockfile inherits a tree that is silently short
of packages. The container writes `node_modules/.sandboxr-deps` — the lockfile hash it
installed from — as the *last* step, by rename, and treats only that marker as done. Same
shape as a seed artifact's `.partial`, and for the same reason.

`sandboxr-claude` is shared by every sandbox on the machine **on purpose**, and the trade is
part of the contract rather than an implementation detail: sharing it is what makes an MCP
server something you sign into once rather than once per worktree, and it means every sandbox
can read every credential in it. None of these shared volumes is ever reaped by the collector
when a sandbox is deleted (§ garbage collection); reaping this one would silently sign the
machine out of every server it had been given.

One path inside that volume comes from the host rather than from the volume: when
`~/.claude/.credentials.json` exists on the host it is bind-mounted read-write over the volume's
copy, so a login is shared with every sandbox rather than duplicated into each. See §7.2.

Images are named under one namespace, and the split between them decides what may be reclaimed:

- Project layer: `sandboxr/<project>:<12 hex>`, the hash covering the tool version, the rendered
  Dockerfile and every staged manifest. Content-addressed, so every sandbox of a project shares one
  image and a rebuild is triggered by exactly the things the build reads.
- The machine's own: `sandboxr/base` and `sandboxr/dashboard`, tagged by tool version and by
  `latest`. Built by `init`.

**Reclamation is a contract, not a heuristic.** `gc` removes sandboxes and the volumes they owned.
`prune` removes what building left behind, and is bound by three rules:

- The shared volumes above are never removed, by either. Taking `sandboxr-claude` would sign the
  machine out of every MCP server it has been given.
- `sandboxr/base` and `sandboxr/dashboard` are never removed as superseded: they are tagged by
  version rather than by content, so "older tag" does not mean "replaced".
- Of each project's images, the newest survives. A content-addressed tag means the next `up` finds
  it and starts rather than rebuilding, and that is the reason the image is kept at all.

`prune` reports by default and acts only when told to, which is the reverse of `gc` and `expire`.
The asymmetry follows from the cost of being wrong: a sandbox removed in error costs a restart, an
image removed in error costs a toolchain rebuild on somebody else's next `up`.

**What "gone" means for one sandbox is this list, and nothing outside it.** `down` removes, in
order: the container (forced, running or not); the four volumes above; `build/<project>/<slug>.env`
and `build/<project>/<slug>.plan.json`; `logs/<project>/<slug>/`; `state/attach/<project>/<slug>`;
and `state/keep/<project>/<slug>`. Every one of those is named `<project>-<slug>` and is generated
— regenerated by the next `up` — and nothing else on the machine can derive that name once the
worktree it came from is gone, so anything left behind is left for good. `--keep` removes the
container and the keep marker and nothing else. There is **no per-sandbox certificate** to remove:
since §3.2 flattened a hostname to one DNS label the machine's `*.<domain>` covers every sandbox,
so `up` issues none and `init` sweeps up any an older version left in `state/dynamic/`.

Two files are deliberately **not** in that list, and for one reason: both are keyed on the
*worktree*, which outlives every sandbox cut from it. `state/name/<project>/<slug>` is a label
somebody typed (§4.2.1). `state/slug/<project>/<worktree dir>` is worse to take — it is what the
slug above was *read from* (§4.2.3), so removing it would hand the next `up` a freshly derived name
and leave every artefact here filed under the old one.

### 3.3.1 Deleting a worktree

Removing a worktree and tearing down its sandbox is **one ordered operation**, `deleteWorktree` in
core, and the order is forced twice over: a volume cannot be removed while its container runs, and
the slug that names every artefact above is resolved *from the worktree* (§3.1) — so removing the
directory first destroys the input needed to find what to clean up, and leaves an orphan for `gc`.
It is `down`, then `git worktree remove --force` and `worktree prune`, then the display name.
`removeWorktree` takes the given slug (§4.2.3) with the directory, which is the other half of why
the sandbox goes first: after that, the name is not recoverable at all.

**Every slug it resolves comes through `slugFor`, never `deriveSlug`.** A worktree that was given a
slug carries a token nothing can re-derive, so a delete that derived would compare a sibling under a
name nothing else uses — finding a collision that is not there, or missing one that is.

Two rules bound it, and both are refusals rather than best efforts:

- **A sandbox two worktrees resolve to is kept.** `addWorktree` stops new collisions and
  deliberately does not migrate the ones already on disk, so an upgraded machine still has two
  branches on one ticket sharing a container, a set of volumes, a host rule and a migration lock.
  Deleting either worktree then removes only the directory, and names the worktree still using the
  sandbox. The display name is kept with it, for the same reason: it is filed under the slug.
  Siblings are matched **by path and never by slug** — the slug is exactly the thing that may not
  be unique, so filtering by it would drop the sibling the check exists to find. A delete addressed
  by a slug that names two worktrees is refused outright rather than guessing between them. The
  check is correct under both regimes and, on a machine with no collisions left, never fires.
- **Work that exists nowhere else stops it.** Uncommitted changes are lost with the directory, and
  the refusal names the files. Commits on no remote are *not* lost — they are in the project's
  clone, which a worktree only borrows — and the refusal says so rather than overstating what it
  protects. `--force` overrides both; a browser cannot (§8.1).

A worktree with no sandbox deletes cleanly, and so does one whose directory is already gone: that
is the stale entry in git's admin files, and clearing it is the point.

### 3.4 Container labels

State lives **only** in Docker labels. There is no manifest file, no database of sandboxes.
`list` and `gc` are pure functions of `docker ps`, so nothing can drift out of sync.

| Label | Meaning |
|---|---|
| `sandboxr.project` | project name from the config |
| `sandboxr.slug` | the slug |
| `sandboxr.branch` | branch name, or `?` if it cannot be resolved |
| `sandboxr.commit` | short commit sha |
| `sandboxr.dirty` | `true` / `false` — uncommitted changes present |
| `sandboxr.worktree` | absolute path on the host |
| `sandboxr.driver` | database driver in use |
| `sandboxr.created` | ISO 8601 UTC |
| `sandboxr.access` | `public` / `private` — whether app hostnames need auth |
| `sandboxr.ttl` | seconds the sandbox may sit unused for, or `never` |
| `sandboxr.env` | digest of the environment the sandbox was created with — see §5.2. A record, not a comparison; empty means *unknown* |

**Labels hold durable state only.** Everything above is fixed when the sandbox is created
and does not change while it runs — and `sandboxr.env` is worth a note, because it is a label
that deliberately records the *past* and must not be mistaken for a live answer.

It says what the environment was when the container was created. It is **not** what decides
whether a running sandbox is out of date, and the difference is a bug that has already been made
once: Docker will not let a label be changed after a container exists, so a sandbox restarted to
pick up a rotated credential kept the label it was created with. The badge stayed lit, the button
appeared to do nothing, and pressing it again did nothing again.

**Whether a running sandbox has read the current credentials is a comparison of times**: the
secrets file's mtime against the container's own `StartedAt`. That answers the question actually
being asked, and it clears itself, because a restart moves `StartedAt`. Runtime state — whether it is starting, running or
degraded — is **derived at read time** from the container and its status surface, never
written back to a label. A label recording "running" would be a second source of truth that
goes stale the moment a process dies, which is exactly the drift this design avoids.

So `Sandbox.state` in §6 is computed, not stored: the container's own state, plus the
migration verdict the sandbox exposes. A failed migration deliberately leaves the container
running, so anything reading only the container's state will report a degraded sandbox as
healthy — the one case where it matters most.

**There is deliberately no `sandboxr.expires` label**, and the reason generalises. `sandboxr.ttl`
is a *duration*, which is durable; a deadline is not. `sandboxr.created` is stamped once and never
moves, so a deadline of `created + ttl` is already in the past the moment the reaper stops a
sandbox — restarting it would get it stopped again on the very next pass, and the button would
look broken.

The deadline is therefore derived at read time, as **`max(startedAt, lastActive) + ttl`**:

- `startedAt` is `State.StartedAt`, which Docker maintains. It gives the semantics anyone expects
  from the Restart button: restarting a sandbox buys it another full ttl.
- `lastActive` is the last time **anybody used the sandbox**. The ttl therefore measures
  **idleness, not uptime**: using a sandbox resets its clock.

**Four things count as use**, and `packages/core/src/sandbox/activity.ts` is the one file that
reads them. Three are derived at read time — §4.2's rule applied to a timer — and the fourth is the
one place that rule cannot hold, for the reason given underneath:

| Signal | Where it is read from | What it covers |
|---|---|---|
| A request to one of the sandbox's own hostnames | the shared router's access log (`accessLog: {}`, one common-log line per request, ending in the router name — which for a sandbox *is* its container name) | somebody using the apps |
| A dashboard route that names the sandbox — `…/p/<project>/[sw]/<slug>/…` (§7.1) | the **same** access log, under `sandboxr-dashboard@docker`, from the request path | opening a worktree, its logs, opening its terminal socket, opening its agent socket |
| An agent run on the sandbox's worktree | `agent/runs.json` for the `project/slug` join, and the transcript's mtime for when it last emitted anything (§7.2) | an agent working while nobody is watching |
| A terminal or agent socket **held open** on the sandbox | the mtime of `state/attach/<project>/<slug>`, re-stamped by the dashboard holding the socket (§4.2.2) | a session somebody is sitting in, longer than the ttl |

**The fourth row exists because a websocket is invisible to the router's log until it ends.**
Traefik writes a request's access line when the request *completes*, and stamps it with the moment
the request **started**. So *opening* a terminal registers — the view fetches
`/api/p/:project/s/:slug` first, and that line is written at once — while *keeping* one open for
longer than the ttl produced no evidence at all, and then produced one line dated to the wrong end
of the session. The container was reaped out from under a live connection, which is the exact
failure this whole mechanism exists to prevent, and the cause did not resemble the symptom: the log
appeared to contain the request.

**A live agent run holds its sandbox open, and the countdown starts when the agent stops.** A run the
index calls `running`, `idle` or `needs-input` reads as activity *now*; an ended one reads as
`endedAt`. This is a timestamp and never a second exemption beside the keep-alive marker, because
only a timestamp remembers when the agent stopped — an "agent is running" flag would drop the
sandbox back to its start time the moment the run ended.

The index is not believed on its own. The server owns the `docker exec` behind a session and it dies
with the server, so a dashboard killed mid-run leaves rows saying `running` for ever. A live row
therefore holds a sandbox open only while the transcript it names has been written to inside a grace
window (`AGENT_LIVE_GRACE_MS`, fifteen minutes); past that the run is credited with its last
transcript line and nothing more. Otherwise a crash would produce sandboxes nothing on the machine
would ever reap.

**A held-open socket is believed on exactly the same terms, and the constant is the same one.** A
heartbeat inside `ATTACH_LIVE_GRACE_MS` — which *is* `AGENT_LIVE_GRACE_MS`, because both answer how
long a claim of liveness is believed without fresh evidence — reads as activity now; an older one
reads as activity when it was written, which is the last moment a socket is known to have been held.
A dashboard killed while somebody had a terminal open therefore stops pinning that sandbox within
the quarter hour. A socket held open but **idle** does keep resetting the clock, deliberately: the
evidence is that a live connection into the container exists, and stopping the container under one
is the failure being fixed. It is bounded by the socket having to keep answering — see §4.2.2.

Three consequences are part of the contract:

- The per-sandbox logs under `logs/<project>/<slug>/` are **not** an activity signal: the dashboard's
  health probes dial containers directly on the Docker network and write to them every few seconds,
  so an idle timer keyed on them would never fire. **The probes going direct rather than through the
  router is load-bearing** for the same reason — routed through Traefik they would write a line per
  sandbox every few seconds and no ttl on the machine would ever fire again.
- **Every failure to read a signal means "no activity seen", never "nobody used anything."** A router
  whose log cannot be read, an agent index that is missing or corrupt, a transcript that cannot be
  stat'd, an attach marker that is absent or unreadable: each yields an absence, and the sandbox
  falls back to its start time. Reading any of them as universal idleness would stop every sandbox
  on the machine at once. The writer fails the same way — a heartbeat that cannot be written is
  swallowed, because a full disk must not be the reason a terminal will not open.
- The request path is the one field of an access-log line an outsider writes, so a crafted path could
  name somebody else's sandbox. That is accepted deliberately: the harm it does is keeping a sandbox
  alive, which is the direction every other rule here already errs in, and only paths naming a
  sandbox the caller already holds are looked up at all. The container name is still matched
  backwards from the end of the line, where Traefik writes it and a request cannot reach.

## 4. Host paths

`SANDBOXR_HOME`, default `~/.sandboxr`. Never inside a repo, so `git clean` cannot destroy it.

```
~/.sandboxr/
  cache/                 database seed artifacts, content-addressed
  logs/<project>/<slug>/ per-sandbox logs, outlive a stop and go with a `down` — see §3.3
  tls/                   certificate and key
  state/                 router config, dashboard session secret
  secrets/<project>.env  third-party credentials, mode 0600 — edited, not generated (§5.2)
  build/<project>/<slug>.env  the generated per-sandbox environment
  bin/                   host-built helper binaries
  config.yaml            the machine's own settings — see §4.3
  state/keep/<project>/<slug>  keeps one sandbox alive past its idle limit — see §4.2
  state/name/<project>/<slug>  what to call one worktree on screen — see §4.2.1
  state/slug/<project>/<worktree dir>  the slug a worktree was given on a collision — see §4.2.3
  state/attach/<project>/<slug>  a socket is being held open on this sandbox — see §4.2.2
  workspace/<project>/   a project the dashboard can start a sandbox for — see §4.1
  workspace/<project>/sandboxr.yaml  optional project-level config — see §5.6
```

### 4.1 The workspace

`SANDBOXR_WORKSPACE`, default `~/.sandboxr/workspace`. Its own variable because the repositories
are the one part of the tree worth putting on a different disk.

```
<workspace>/<project>/
  sandboxr.yaml        optional: the project-level config — see §5.6
  repo.git/            a bare clone
  wt/<branch>/         one worktree per branch, all peers
```

**A project is a directory containing `repo.git`.** There is no registry file, so listing the
projects is a `readdir` — a pure function of the filesystem, for the same reason `list` is a pure
function of `docker ps`. Nothing is written when a project is cloned beyond the clone itself,
there is nothing to reconcile, and `git clean` cannot reach it.

Two rules follow, and both are load-bearing:

- **Bare, never a mirror.** `git clone --mirror` sets a `+refs/*:refs/*` refspec, so every fetch
  force-updates `refs/heads/*` to match the remote — and worktree branches live there. A routine
  fetch would reset a branch that a worktree has checked out and discard local commits. The clone
  is `--bare` with `+refs/heads/*:refs/remotes/origin/*` set explicitly, which a plain `--bare`
  clone does not configure at all.
- **Union with `docker ps`, never a filter.** The dashboard's project list is the workspace
  *unioned* with the projects that have containers. A running sandbox whose project is not in the
  workspace must still appear; a list that could hide something running is the staleness this
  whole design exists to avoid.

The directory name is the key. The `project:` field in that repo's `sandboxr.yaml` is what
hostnames and container names are built from (§3.2, §3.3), and the two need not match.

`<project>/sandboxr.yaml` is the only file sandboxr itself may put in a project directory, and
it is put there by hand. It is a fallback for worktrees that carry no config of their own, and
it never becomes a sandbox's `/workspace` — see §5.6.

#### 4.1.1 What a worktree reports

`Worktree` in `packages/core/src/worktree.ts` is what a listing of `wt/` yields, and it is the
unit the dashboard's sidebar is built from — a worktree is the thing that persists, and a
sandbox is something that comes and goes on top of it.

| Field | Meaning | When it cannot be read |
|---|---|---|
| `path` | Absolute path to the top of the worktree | — |
| `branch` | The branch name — never git's literal `HEAD` | `?` |
| `head` | Short commit sha | `?` |
| `detached` | Checked out detached, which is how a branch open elsewhere is run | — |
| `exists` | Whether the directory is really on disk | — |
| `committed` | ISO 8601 of the **HEAD commit** | `""` |
| `created` | ISO 8601 of the **directory's creation time**, as the filesystem reports it | `""` |

**`committed` and `created` answer two different questions and must never be blurred into
"last touched".** `created` is when somebody cut this worktree; `committed` is when work last
landed on the branch in it. A worktree cut this morning off a branch nobody has touched since
March is new by one and old by the other, and both readings are wanted — the dashboard groups
by either. Not every filesystem records a birth time, so `created` is genuinely absent on some
machines.

Both are `""` rather than a substituted value when unreadable, and that is the contract: a
fabricated date sorts a worktree somewhere it does not belong, which is worse than an entry the
reader can see has no date.

**A worktree's *display name* is deliberately not a field of this type.** Every field above is
read out of git or off the filesystem, and the name is not: it is a label somebody typed, kept
on the host, and read by whoever is going to show it (§4.2.1). Putting it here would make a
listing of `wt/` pay a file read per worktree whether or not anybody wanted the name, and would
put an editable string in the same shape as the facts git reports.

#### 4.1.2 A worktree's pull request

A worktree is a branch, and a branch usually has a pull request on it. What became of that pull
request is the fastest thing to say about a worktree — merged work is finished, a draft is
somebody's, a closed one is abandoned — so it is carried beside the worktree rather than left to
the project pane.

**Four states, and `draft` is not a fifth.** GitHub reports two independent things: a state of
open, closed or merged, and a draft flag. The flag only means anything while the pull request is
open, so the two compose in one direction and only one:

| What GitHub says | The state | Drawn | Why |
|---|---|---|---|
| open, draft flag set | `draft` | grey | Waiting for its author |
| open, flag clear | `open` | green | Waiting for a reviewer |
| closed | `closed` | red | Somebody decided against it — whatever the flag says |
| merged | `merged` | purple | It landed. A pull request that was a draft when it merged is `merged` |

The colours are part of the contract rather than a stylistic choice, because they are GitHub's own
and a reader arrives already knowing them. `packages/web` picks the colour from the state and
decides nothing else about it: the state itself is the server's answer (§7.1).

`draft` is kept apart from `open` because it is the one distinction a reader acts on. Core owns the
composition — `PullState` in `packages/core/src/forge.ts` — so the CLI and the dashboard cannot
arrive at different answers.

**No answer is `null`, and `null` is never `closed`.** A machine with no `gh` on it, a `gh` that is
not logged in, a project that is not on GitHub, a private repository the token cannot see, a call
that ran out of time, and a branch nobody has opened a pull request for all arrive as `null` — one
value, because there is nothing to show for any of them. What `null` must never be rendered as is
`closed`: closed says a person rejected this work, and none of those machines rejected anything.
That is the whole reason the field is nullable rather than defaulted.

**One `gh` per repository, not one per worktree.** The question is per branch; the answer is per
repository. `createPullIndex` reads `gh pr list --state all` once for a repository, indexes it by
head ref, and every worktree is a map lookup — so a machine with thirty worktrees makes one
subprocess call per project, not thirty, on a poll that repeats every thirty seconds
(§7.1). Two workspace directories cloned from one repository share the call. Where several pull
requests share a head branch — a closed one and a replacement, or a reused branch — the live one
wins, then the merged one, then the most recent.

**How long an answer is trusted, and how long a call may take**, both fixed in core so nothing else
picks a number:

| | | |
|---|---|---|
| An answer | 5 minutes | A pull request does not change state on a thirty-second clock |
| No answer | 1 minute | So a machine where somebody has just run `gh auth login` recovers quickly |
| One `gh` call | 5 seconds | **A timeout is part of the contract.** A proxy that accepts the connection and never answers leaves `gh` on a socket with no timeout of its own, and a hung subprocess in the sidebar's path is worse than a missing mark |

An expired entry is **served stale while it refreshes behind the caller**, so only the very first
question about a repository ever waits for `gh`. A cached "no answer" is served the same way.

**What gates *reading* pull requests is the host's `gh`, and nothing else.** `github:` in
`config.yaml` (§4.3) decides whether a *sandbox* is handed the machine's token so an agent can push
— it has no bearing on what the dashboard can read, and a project set to `none`, which is the
default and the answer on nearly every machine, still shows its pull requests. This is the same
answer the project pane's open-pull-request list has always given; the index is a second reader of
the same credentials, not a second permission.

The vocabulary is fixed: core's type is `PullState`, its reader is `createPullIndex`, the API field
is `pull` on `WorktreeDto` — an object of `{ number, state, title, url }`, or `null`.

### 4.2 Keep-alive, and where mutable state is allowed to live

A keep-alive marker exempts one sandbox from its idle limit. It cannot be a label — a running
container's labels are immutable, and Docker exposes no way to change one — so it is a file, and it
is the one piece of per-sandbox state that lives on the host.

The rule that makes this legal rather than a second manifest: **the file records operator intent,
not observed reality, and it names the instance it applies to.** It contains the `sandboxr.created`
value of the container it applies to, and a marker whose stamp does not match the live container is
ignored. Slugs are derived from ticket ids (§3.1), so the same `project/slug` is recreated routinely;
without the stamp a leftover marker would silently keep the *next* sandbox to take that name alive.
With it, a stale marker fails closed and needs no reconciliation pass — which matters, because a
pass whose job is to read `docker ps` and believe it is precisely what makes a file a second copy of
the truth.

`down` removes the marker, under `--keep` as well as without it. That is tidiness, not correctness:
`docker rm` by hand cannot be hooked, and the stamp is what covers that case.

The vocabulary is fixed: the file is `state/keep/<project>/<slug>`, the CLI is `keep` / `unkeep`,
the dashboard action is `keep` with a `toggle` of `on` / `off`, and core's functions are
`isKeptAlive` / `writeKeep` / `removeKeep`. `pin` and `unpin` survive only as undocumented CLI
aliases.

#### 4.2.1 A worktree's display name

A worktree is addressed by its slug and shown by its branch, and both are derived (§3.1, §4.1.1).
Neither is a sentence anybody wrote: a row reading `feat-4821` says which ticket it is and nothing
about what is being done in it. A **display name** is a label a person chose — "the checkout flow
rewrite" — stored at `state/name/<project>/<slug>`.

**It is presentation and nothing else.** It never reaches the slug, the hostname, the container
name, a route or a URL. Those are derived from the branch and the directory, they are load-bearing
down to a database lock name (§3.1), and a label somebody can retype at any moment must not be able
to move them. Renaming a worktree changes one line on a screen and no address anywhere. Anything
that built an identifier out of this value would be a bug of exactly the kind §3.1's ceiling exists
to prevent.

It passes §4.2's test — *does this file's correctness depend on a container?* — for a reason worth
stating in full, because it reaches the **opposite** conclusion about the stamp:

- **It records intent, not observed reality.** Nothing derives it, nothing reconciles it, and no
  lifecycle command writes it. `docker ps` has no opinion about what somebody calls a worktree.
- **It names the worktree, and a worktree is what persists.** The keep marker carries a
  `sandboxr.created` because it applies to one *container instance*, and keeping a dead sandbox's
  successor alive would be wrong. A name applies to the directory the sandbox is cut from, which
  outlives every sandbox on it. **Stamping it would be the bug, not the safeguard**: the name would
  be thrown away the moment a sandbox was stopped and recreated, so a rename would quietly undo
  itself the next time somebody pressed Rebuild.
- **A stale file is inert rather than wrong.** A name left behind for a slug nothing has cut is
  only ever read when a worktree of that slug is listed again — where it is a label, not a
  permission or a lifetime. That is the difference that makes the missing stamp safe.

Two rules about the key and the value:

- **`<project>` is the workspace *directory* name** — §4.1's key, the one the worktree's own path is
  built from — and **not** the `project:` a `sandboxr.yaml` declares, which is what `state/keep/`
  beside it is keyed on. The two are allowed to differ (§4.1), and this file names a directory on
  disk rather than a container.
- **The value is validated on the way in and on the way back out.** It is trimmed; the empty string
  means *clear it, go back to the branch*; control characters, `U+2028` and `U+2029` are refused in
  every spelling; and the length is bounded at **60 code points**. The file is plain text in
  somebody's home directory and the value ends up on a page, so a file edited by hand into something
  that is not a name reads as **no name** — the worktree shows its branch again, which is visible and
  undoable — rather than being rendered raw or silently rewritten on disk.

The vocabulary is fixed: the file is `state/name/<project>/<slug>`, core's functions are
`readDisplayName` / `writeDisplayName` / `removeDisplayName` with `normaliseDisplayName` as the
validator, the CLI is `sandboxr worktree name`, the API field is `displayName` (`null` when there is
none, never the branch name), and the route is `PUT /api/p/:project/w/:slug/name` (§7.1). It is
**not** one of the §8 actions: it runs nothing, streams nothing and touches no container.

Removing the worktree removes the name (§3.3.1) — and *only* then, which is the same argument the
paragraphs above make from the other end. `down` leaves it alone because the worktree is still
there; and a delete leaves it alone when a sibling worktree resolves to the same slug, because the
file is filed under the slug and would be that sibling's name too.

The dashboard's control is the pencil beside a worktree's title, which sends that route directly.
**Where the name is shown and where the slug still is, is part of this section**, because the two
answer different questions: the name is shown wherever a worktree is identified to a *person* — the
worktree page's title and breadcrumb, its sidebar row, its row on a project's pane, the home view's
lists — and the slug stays wherever it is the thing that identifies the *sandbox*: under the title,
in the worktree's `Slug` fact, in the Sandbox panel, in the container name and in every hostname. A
page that showed only the name would leave somebody who renamed a worktree "the checkout flow
rewrite" unable to read off the address its apps answer on.

#### 4.2.3 A worktree's given slug

Two branches on one ticket derive one slug (§3.1). When `addWorktree` sees that, it assigns
the new worktree `<base>-<token>` and writes it to `state/slug/<project>/<worktree dir>`.
**A random token cannot be re-derived, so the file is the only place the answer exists** —
which is what makes it state rather than a cache.

It passes §4.2's test — *does this file's correctness depend on a container?* — the same way
§4.2.1's display name does. It records a decision nothing observes, `docker ps` has no
opinion about it, and it names the **worktree**, which outlives every sandbox cut from it,
so there is no `sandboxr.created` stamp and there must not be one: stamping it would move a
live sandbox's name the first time somebody pressed Rebuild.

Three rules about the key and the value:

- **The key is the worktree's *directory* name, never its slug.** The slug is the thing
  being decided, so it cannot also be the key. The directory name is unique by construction
  — `addWorktree` names it `sanitizeSlug(branch)` — where the derived slug is exactly what
  is not.
- **`<project>` is the workspace *directory* name**, like `state/name/` beside it and for
  the same reason (§4.1): this names a directory on disk, not a container.
- **The value is validated on the way in and on the way back out, through one function.**
  It must be what `sanitizeSlug` produces — `[a-z0-9]` in dash-separated runs, at most 31
  characters. **31 and not the project's ceiling, deliberately**: this is an outer bound on
  a file somebody could edit, and a recorded slug written under a lower ceiling is under 31
  already. Reading the file cannot see a config — the whole point of the store is that it is
  consulted before one is loaded — so checking against a per-project number here would mean
  the validator and the writer disagreeing about which project they were talking about.
  Writing something else throws; **reading** something else is *no recorded slug*, so the
  worktree derives its slug again, which is what every worktree that never collided does
  anyway. A file hand-edited into a hostname nobody meant is the failure this
  avoids.

Unlike the display name, this value **is** an identifier: it is the container name, every
hostname and the migration lock name. That is why the validation is strict and why every
read path goes through `slugFor` (§3.1) rather than deriving for itself.

A stale record is inert. `removeWorktree` deletes it, which is tidiness rather than
correctness — a record naming a directory that no longer exists is only read again if a
worktree is cut at that name, and then it is a slug that was free anyway.

The vocabulary is fixed: the file is `state/slug/<project>/<worktree dir>`, core's functions
are `readRecordedSlug` / `writeRecordedSlug` / `removeRecordedSlug` with
`normaliseRecordedSlug` as the validator, `worktreeKey` maps a path to the key, `uniqueSlug`
generates the given slug and `slugFor` is the resolver. There is no CLI command and no API
route for it: a slug is assigned once, when the worktree is cut, and moving it afterwards
would orphan a container and its volumes.

#### 4.2.2 The attach heartbeat: the one activity signal that is written

Every other signal in §3.4 is read out of something that was going to be written anyway. This one
is not, and the exception has to be argued rather than assumed.

**There is nothing to derive it from.** A websocket does not appear in the router's log until it
closes, and the line is stamped when it opened (§3.4), so the log cannot answer "is one open now".
The only process that knows is the dashboard holding the socket — and `sandboxr expire` on the
command line runs somewhere else entirely. A set of open sockets kept in memory would give the CLI
and the dashboard two different answers to "is this in use", which is the drift
[state.md](state.md) exists to forbid. So the dashboard re-stamps
`state/attach/<project>/<slug>` while it holds one, and the file is read by whoever is deciding.

It passes §4.2's test — *does its correctness depend on a container?* — and it reaches the same
conclusion as §4.2.1 about the stamp, for a different reason:

- **It records observation, not permission, and a timestamp is all it records.** A keep marker
  carries a `sandboxr.created` because it is an exemption: a stale one would silently keep the next
  sandbox to take that name alive. This says only "at time T a live process held a connection to
  this name", and the deadline is `max(startedAt, lastActive)` — so a marker older than the
  container it now names contributes nothing at all. There is nothing for a stale one to get wrong,
  so nothing reconciles it. `down` removes it with the rest of what the sandbox was named after
  (§3.3), which is tidiness and not correctness — the file has no reader once the container is
  gone, and one naming a container that is not there is what the next person reads as a mechanism.

  **The holder is told, rather than left to race.** Removing the container closes the sockets on
  it, and releasing a socket stamps the file once more on the way out — right for every other
  reason a socket closes, and exactly wrong for this one, because it rewrites the marker seconds
  after the sandbox it names stopped existing. The dashboard's delete action tells its tracker to
  forget that name (`forget` in `packages/server/src/attached.ts`), and the suppression is lifted
  the moment something holds the name again.
- **The mtime is the signal.** The text inside is a stamp for whoever reads the directory by hand
  and nothing parses it: the filesystem maintains an mtime for free, it is the same field the agent
  transcripts are read by, and a second spelling of one moment inside the file would be a thing that
  can disagree with the file.

Three rules bound what an open socket may mean:

- **A socket is evidence only while it answers.** A laptop that sleeps with the tab open does not
  close its connection, and the server may never find out. The holder pings every
  `ATTACH_HEARTBEAT_MS` (thirty seconds) and a socket that has not ponged for three intervals stops
  counting — browsers answer a ping frame at the protocol level, so this asks nothing of the app.
  Without it, one abandoned tab would disable a sandbox's idle clock permanently, which is a worse
  failure than the one being fixed.
- **A silent socket is dropped, not closed.** Terminating it would put a shell down over a network
  hiccup, and a laptop waking up simply starts counting again on the next tick.
- **The last thing a holder does is stamp once more**, when the last socket on the sandbox is
  released. The mtime is then *when the session ended*, which is where the countdown belongs and is
  exactly what the router's start-stamped line cannot supply.

The vocabulary is fixed: the file is `state/attach/<project>/<slug>` keyed on the container's
`sandboxr.project` (like `state/keep/`, unlike `state/name/`), core's functions are `markAttached` /
`attachFileFor` / `attachedActivity`, and the server's holder is `createAttachedTracker` in
`packages/server/src/attached.ts`, whose `forget` is the one thing that stops it writing. It is not
an action, not a route and not a field of any DTO: it only ever reaches a reader as part of
`lastActive`.

### 4.3 `config.yaml`: the machine's own settings

`sandboxr.yaml` (§5) belongs to the project being sandboxed and is versioned with its code.
`~/.sandboxr/config.yaml` belongs to the machine, and holds what is a property of the machine rather
than of any project:

```yaml
ttl: 12h
github: none
projects:
  acme-monorepo: { ttl: 3d, github: token }
```

**A `projects:` key is either of a project's two names** — its workspace directory (§4.1) or the
`project:` its own `sandboxr.yaml` declares (§5) — and the directory is tried first. The example
above spells the two differently on purpose. It used to read `acme:`, with both names the same
string, and that is precisely how the trap stayed invisible: the lookup matched the *declared*
name alone, so an operator whose workspace held `acme-monorepo` wrote down the only name the
dashboard, the URLs and the disk had ever shown them and got nothing. Not an error — the entry
matched no project, every project fell through to the machine-wide value, and the first symptom
was an agent unable to push, hours later. `projectFor` in `packages/web/src/lib/group.ts` already
resolved a project by either name, so matching on one here made the product disagree with itself.

**When two projects disagree about a name, the directory wins.** `acme` can be one project's
directory *and* another project's declared `project:`. The key then belongs to the project whose
**directory** it is and never reaches the other one, for two reasons: the operator who typed it
was reading a list of directories, and the cost of guessing wrong is not symmetric — guessing
wrong about `github:` hands one project's opt-in to a repository nobody opted in. `projectEntry`
is given the workspace's directory names by any caller that can see them (`up`, the dashboard) and
enforces this; a caller that cannot see the workspace takes the plain directory-then-declared
two-step.

**An entry naming no project is reported, not refused.** It is the same class of mistake as a
malformed file and cannot take the same remedy: this file is machine-wide, so refusing to load it
over one stale entry — a project somebody deleted last month — would stop every *other* project on
the machine starting, and the loader has no view of the workspace to check against anyway. So it
surfaces where both halves are already in hand:

| Where | What it says |
|---|---|
| `sandboxr doctor` | names each unmatched key, and lists every name that *would* match |
| `sandboxr config` | what this project's `ttl` and `github` resolved to, and the key that decided |
| `sandboxr up` | when the token is off, the key that would turn it on |
| the dashboard | `ProjectDto.github`, resolved server-side, per project |

`reviewProjectEntries` answers the first two against `projectIdentities` in
`packages/core/src/workspace.ts`, which reads both names of every workspace project without running
git. A project run from a checkout *outside* the workspace cannot be enumerated, so a key naming
one reads as unmatched; the finding therefore says "rename it or remove it" rather than asserting
the project does not exist.

The schema is `packages/core/src/config/machine.ts` (Zod, `strictObject`), so a misspelled key is an
error naming the key. Precedence for `ttl`, most specific first, and this order is the contract:

1. `--ttl` on the command (or the dashboard's field)
2. the project's entry in `config.yaml`, under either of its names
3. the file's top-level `ttl`
4. `SANDBOXR_TTL_HOURS` — what a service unit sets
5. the built-in default, **12h**

`github` is `none` or `token`, and decides whether that project's sandboxes are handed this
machine's GitHub token (§7). It says nothing about what the *host* may read: the dashboard lists a
project's pull requests, and marks each worktree with the state of its own (§4.1.2), using the
`gh` on the machine it runs on — a project left at `none` still shows all of it. Its ladder is
deliberately shorter — the project's entry, then the
file's top-level value, then the built-in **`none`** — with **no flag and no environment
variable**. A lifetime is a scheduling preference worth overriding per run; this is a decision
about which code may act as the person running it, and a decision like that belongs in one file
somebody can read, not in whatever started the process.

**It lives here and not in `sandboxr.yaml`, and that is a rule rather than a convenience.** The
token is the operator's, not the project's, and a setting that lives in a repository is a setting a
repository can ask for: clone something, start a sandbox, and its committed config would have
helped itself to a credential reaching every repository you can push to. The machine decides which
projects it trusts with its own credentials. A project never votes on that.

A **missing** file is not an error: it means the defaults. A **malformed** one is, reported by name
with the path, because silently falling back to a default lifetime after somebody has edited the
file is how work gets destroyed. `sandboxr init` writes a commented example if there is none, and
never touches an existing one.

## 5. The config file: `sandboxr.yaml`

Lives at the **root of the project being sandboxed**, not in this repo. It is versioned
with that project's code, so a new service and its config land in the same commit. That is
still the rule; **§5.6 is its one exception**, for a project in the workspace that has not
committed a config yet.

The authoritative schema is `packages/core/src/config/schema.ts` (Zod). This section is
the human description; if the two disagree, the schema wins and this file gets fixed.

```yaml
project: acme                  # required, [a-z0-9-] with no `--`, used in hostnames
sandboxr: ">=0.1.0"            # minimum tool version; a mismatch is a clear error

database:
  driver: mysql                # mysql | d1 | sqlite | none
  version: "8.4"               # driver-specific
  seed_from:
    local:  { container: acme_db, database: acme }           # fork a running container
    file:   /var/sandboxr/seeds/acme.sql.zst                 # or restore a dump
    fixtures: db/migrations/seeds/fixtures.sql               # applied after migrations
  migrate:
    workdir: services
    command: go run ./cmd/migrate --env local --dir ../db/migrations
    since: "20260209"

backends:                      # long-running processes with a port
  - { name: api, port: 8001, label: api }
  - { name: adminApi, port: 8081, label: admin-api }
  defaults:
    build: go build -o {out} ./{name}
    workdir: services
    health: /health

frontends:                     # either built to a directory, or a long-running server
  - { label: app, package: web, out: dist }
  - { label: www, package: marketing, out: out, memory: 6g }
  - { label: cms, package: cms, serve: npx next dev --port 3000 }

routes:                        # path prefixes per app hostname -> backend name
  app:     { "/api": api }
  billing: { "/api/billing": billingApi, "/api": api }

secrets:
  read: [services/api/.env]
  keep: [AUTH0_DOMAIN, LLM_API_KEY]
  rename: { ANALYTICS_API_HOST: ANALYTICS_ENDPOINT }
  never: ["DB_*", "S3_*", "*_URL"]

toolchain: { go: "1.26.6", node: "24.18" }

access:
  apps: public                 # public | private
  controls: password           # password (only option today)
  credentials: dummy           # dummy | real — see §5.3

env:                           # the project's own names for what the sandbox computes
  DB_HOST: "${SANDBOXR_DB_HOST}"
  VITE_API_URL: "${SANDBOXR_URL_API}"
```

The `env:` map is the join between the two halves of a sandbox's environment, and it is the
half a project cannot do without. The sandbox works out *where* everything is — its own
database, its own object storage, each app's own hostname — and exports those under a
`SANDBOXR_` prefix; only the project knows what its own code calls the same things, so it says
so here. Values are expanded by **substitution, never by a shell**, so a value is data.

It is also the last word. The map is exported after everything else inside the container, so a
name it defines wins over the same name from the secrets file — see §5.2.

### 5.1 Three runtime kinds, not two

Everything a sandbox runs is one of:

| Kind | Declared as | How it runs | Served at |
|---|---|---|---|
| **backend** | `backends[]` | build once to a binary, supervised, listens on a port | `<slug>--<label>--…` proxied |
| **static** | `frontends[]` with `out:` | build on demand into a directory | `<slug>--<label>--…` file server |
| **server** | `frontends[]` with `serve:` | long-running process, listens on a port | `<slug>--<label>--…` proxied |

The third kind is what Cloudflare Workers projects need (`wrangler dev`). Do not collapse
it into the other two.

**Static builds are on demand, never at startup.** A sandbox must come up in seconds; an
app that has not been built yet answers with a page saying which command to run.

**A declared thing is visible before it exists.** Every service in the plan appears in the
dashboard's view of a sandbox whether or not it has been built or started — a static app that
has never been built is listed, marked as such, and carries the control that builds it. This
is not a display preference: the per-app build button is the only place a *first* build starts,
so a tile that appeared only once the app was built could never be the thing that built it.

**`optional: true` means dormant by choice, not broken.** An optional service is written into
the plan and its supervisor entry, and is left disabled unless it is named in `SANDBOXR_WITH`
(`container/README.md`, "Three runtime kinds"). It exists for the things that are expensive to
run and rarely wanted. Two consequences bind everything downstream:

- **The router does not advertise a dormant service.** No app hostname, no
  `/__sandboxr/health/<service>` route. The status surface answers the missing health route
  with a 404 (§5.1 note below), which is the router saying it has no route at all — not a
  service answering "no".
- **Nothing may report a dormant service as a fault.** `optional` is carried out of the plan
  and all the way to the screen, and the state derived for a dormant service is its own value
  — never `down`. A deliberate choice displayed as a failure is a bug, and it is the kind that
  trains people to ignore the panel that tells them what is wrong.

**The status surface is reserved, and answers before any app.** `/__sandboxr/*` belongs to
sandboxr on every hostname the sandbox serves, and a path under it that names nothing answers
**404** — it must never fall through to an app's own site block. This was learnt the hard way:
the health probe of a dormant service fell into the front-end's catch-all, so an unbuilt app
answered it with its own 503 "not built yet" page and the dashboard read every dormant service
as `down`; once that app *was* built the same route answered the SPA's `index.html` with a 200
and the same dead service read as `up`. The reachability of a service must not depend on
whether an unrelated front-end has been built.

### 5.2 Secrets rules

`~/.sandboxr/secrets/<project>.env`, mode 0600, is the one file sandboxr keeps that holds real
values. **It is a file people edit.** Two things write it and they must not fight:

- `secrets import` reads the `.env` files the config names and **merges** them in. A name it
  imports replaces that name and touches nothing else. It used to rewrite the whole file, which
  silently dropped every credential that came from anywhere else.
- The dashboard and `secrets set` author it directly. That route is not a convenience: a project
  whose `.env` files are all `.env.example` has nothing to import from, so without it nothing
  reaches a sandbox at all.

There is deliberately **one** file, and no second hand-edited one layered over the imported one.
Two files holding the same name is two answers to "what is this project's API key", and the one
that loses is invisible.

- **Names only, never values, are printed or logged**, with exactly one exception. Every listing
  reports names, a short tail of the value, and its length — enough to tell two keys apart and to
  spot a truncated paste — so it is safe to run with someone watching, to paste into a ticket, or
  to hand to an agent. The exception is the dashboard's *reveal*, which is a request of its own,
  about one variable, made by a person who is looking at the file's own project. **No command-line
  verb prints a value.**
- Anything describing *where* something runs — `DB_*`, object storage, inter-service URLs — is
  **never** imported. A sandbox computes those itself. Importing them would point a sandbox at the
  developer's own database or at real cloud storage.
- **The names a sandbox derives for itself are refused outright**, whoever typed them, whatever the
  project's own rules say. That set is `SANDBOXR_SLUG`, `SANDBOXR_PROJECT`, `SANDBOXR_DOMAIN`,
  `SANDBOXR_ACCESS`, `SANDBOXR_SCHEME`, `SANDBOXR_PUBLIC_PORT`, `SANDBOXR_WITH`, `SANDBOXR_SEED`,
  `SANDBOXR_PLAN`, `SANDBOXR_SCRIPTS`, `SANDBOXR_SANDBOX`, `SANDBOXR_ENV_READY`, and the whole of
  `SANDBOXR_DB_*`, `SANDBOXR_S3_*`, `SANDBOXR_D1_*`, `SANDBOXR_URL_*` and `SANDBOXR_PORT_*`. A
  project's *own* `SANDBOXR_`-prefixed names are fine, and are the reason this is a list rather than
  the prefix: `rename` legitimately carries a browser-side Auth0 domain across to
  `SANDBOXR_AUTH0_SPA_DOMAIN`, which is a value only the project can supply.
- `rename` exists because the same value legitimately has two names in different files, and
  because some pairs must **not** be merged (a browser-side Auth0 domain and a server-side one can
  differ, and merging them makes every API call 401).

#### The file format

`NAME="value"`, one per line. **Values are written quoted, always, with nothing escaped.** Written
raw they do not survive being read back: the reader trims a value and strips a trailing ` #`
comment from an unquoted one — both right for a `.env` somebody wrote by hand, and wrong for a
credential, because a password containing ` #` came back truncated at the hash with nothing
reporting it. Quoting unconditionally is lossless for any single-line value, so **a value may not
contain a newline** and one is refused by name.

Every reader strips exactly one layer of matching quotes. There are two of them — the host's and
`container/scripts/env.sh` — and if they ever disagree, every credential reaches the application
with quotes around it, which fails as an authentication error and looks nothing like a parsing
problem.

#### How it reaches a sandbox, and what wins

The file is **bind-mounted read-only** at `/sandboxr/secrets.env`. It must not be passed to
`docker run` as an `--env-file`: an env-file is read once and baked into the container's
configuration, so an edited credential cannot reach a running sandbox at all — `restart` and
`stop`/`start` keep the environment the container was created with, and only recreating it picks
up a new value. Mounted, `env.sh` re-reads it every time it is sourced, so a restart applies a
rotated credential and a rebuild applies a changed build-time one. The values also stop appearing
in `docker inspect`.

The container reads it **first**, before it derives anything, which fixes the order of precedence
for the whole environment — lowest to highest:

1. the project's secrets file;
2. what the host passes in (`--env-file` for the generated per-sandbox environment, and `-e` for
   the git identity and any GitHub token);
3. what the sandbox derives for itself — `SANDBOXR_DB_*`, `SANDBOXR_S3_*`, `SANDBOXR_URL_*`;
4. the project's `env:` map, expanded with `envsubst` against all of the above.

Two consequences worth stating plainly, because each one has a failure mode that does not resemble
its cause. Nothing outside a sandbox can redirect it at something that is not its own, which is
what (3) beating (1) is for. And a credential typed under a name the `env:` map also defines is
**overwritten** by the map: nothing fails, the variable has a value, and it is the wrong one. A
tool must say which names those are rather than leaving it to be discovered.

#### What a project needs, and what it has

`keep` does double duty and both jobs matter. It is the allow-list an import filters against, and
it is the project's statement of which credentials it needs at all. The second is what makes
"declared, and not set" a thing a person can be shown — and it has to be shown, because a
front-end built without its API key does not fail. It falls back to whatever its code defaults to,
and a default is often a production URL.

### 5.3 Public sandboxes have two hard requirements

If `access.apps` is `public`, the tool **must refuse to start** unless both hold:

1. The database seed is a fixture or an explicitly-marked anonymised dump — never a fork of
   a live database. A public URL backed by real records is a data leak.
2. Third-party credentials are dummies unless explicitly opted in. Anyone who can drive a
   public app can otherwise make it send real email and spend real LLM credit.

This is a refusal, not a warning. `access: private` is the escape hatch.

For the first requirement to be checkable, `sandboxr.yaml` must be able to say so. A
`seed_from` entry takes an optional `anonymised: true`, and that flag is the only thing the
refusal accepts as marking a dump safe:

```yaml
database:
  seed_from:
    file: /var/sandboxr/seeds/acme.sql.zst
    anonymised: true      # asserts this dump carries no real personal data
```

A `fixtures` seed is safe by definition and needs no flag. A `local` seed — a fork of a
running database — can never satisfy the requirement, because it is by definition live data.
Absent the flag, a `public` project with a `file` seed is refused.

The flag is an assertion by the person who wrote the config, not something the tool can
verify. That is deliberate: the tool cannot tell an anonymised dump from a real one, so the
honest design is to make someone state it explicitly in a reviewed file rather than to
imply a guarantee that does not exist.

### 5.4 Fields the container layer requires

These were missing from the schema above and are needed for a sandbox to actually run. They
are part of the contract.

| Field | Where | Meaning |
|---|---|---|
| `static_mode` | a `frontends` entry with `out:` | `spa` \| `files` \| `html`. How a built directory is served. A single-page app needs a catch-all rewrite to `index.html`; a generator emitting `about.html` needs extensionless lookup; a plain directory needs neither. One mode makes two of the three half-work rather than fail, so it is explicit. Default `spa`. |
| `in_build_all` | a `frontends` entry | Whether "rebuild everything" includes this app. Default `true`. Set `false` for something consulted occasionally and expensive to build, such as a component-library viewer. |
| `database.owner` | `database` | For a file-backed driver, the single service permitted to open the database file. Required when the driver is `d1` or `sqlite` — see §6.1. |
| `storage` | top level | `driver: minio \| none` and a `buckets` list. Object storage inside the sandbox, so uploads never reach a real bucket. Default `none`. |

Two driver-specific notes:

- `migrate.since` is passed to the project's migration command as the environment variable
  `SANDBOXR_MIGRATE_SINCE`. The tool cannot guess a runner's flag spelling, so the command
  in the config must consume it if it wants it.
- For file-backed drivers, both the `serve` and `migrate` commands must direct the runtime
  at the sandbox's own state directory (`$SANDBOXR_D1_DIR` for wrangler's `--persist-to`),
  or the runtime writes into the worktree instead of the sandbox.

### 5.5 `plan.json` — the container's view of a project

`sandboxr.yaml` is the human-facing file. Nothing inside a container ever reads it.

`packages/core` **must** emit a flattened, fully-resolved projection of it to
`/sandboxr/plan.json`: defaults merged into every entry, one `services` array carrying all
three runtime kinds with an explicit `kind`, computed addresses, and the resolved
environment. Nothing in the container names a service, port, package or route — the
container is a generic runtime and the plan is its only input.

**The authoritative specification of `plan.json` is `container/README.md` ("The plan"),
with two worked examples in `container/examples/*.plan.json`.** Treat those as the contract
for this boundary and keep the emitter in step with them.

The plan is not the container's *only* mounted input, and the distinction is about secrecy. The
plan is written at ordinary permissions and carries addresses, never values — so the project's
credentials arrive as a second, 0600 file mounted at `/sandboxr/secrets.env` (§5.2), and the
plan's `env:` map refers to them by name. Both are read-only: a container that could rewrite
either could change what it claims to be running or what it is authorised to reach.

### 5.6 The project-level config, and why `file` is not always inside `root`

A worktree is a separate checkout, so an **uncommitted** `sandboxr.yaml` in one worktree does
not exist in any other. A project being brought onto sandboxr for the first time therefore has
to have the file hand-copied into every worktree, for as long as committing it upstream is
blocked. That is the case this exception exists for, and nothing else.

**A project in the workspace may keep a config beside its mirror**, and every worktree of that
project that does not carry its own uses it:

```
<workspace>/<project>/sandboxr.yaml   applies to every worktree of this project
<workspace>/<project>/repo.git
<workspace>/<project>/wt/<branch>/    a worktree; its own sandboxr.yaml still wins
```

Three rules, and all three are load-bearing:

1. **A worktree's own config always wins.** The project-level file is a fallback, never an
   override. A repository that describes itself must not be silently overruled by a file
   outside it that its authors cannot see.
2. **`root` is always the worktree.** The project-level file is read for its *content*; the
   tree it governs is unchanged. `<workspace>/<project>` holds `repo.git` and every sibling
   worktree, so mounting it as `/workspace` would put all of them inside the sandbox and
   resolve every declared path one directory too high. Loading a config whose `root` would be
   a workspace project directory is refused outright.
3. **The search is bounded at the top of the worktree.** Config lookup walks *up* from the
   directory it starts in, and an unbounded walk leaves the checkout and lands on the
   project-level file on its own — with `root` set to that file's directory, which is rule 2's
   failure exactly. Inside a managed worktree the walk stops at the worktree top, and the
   fallback below it is the only sanctioned way to reach the project-level file.

This is the one place `ResolvedConfig.file` and `ResolvedConfig.root` may name different trees,
and the invariant `root === dirname(file)` no longer holds anywhere. Code that wants the
directory a declared path resolves against wants `root`, or `projectPath()`.

`ResolvedConfig` carries `origin`: `repo` when the file is inside `root`, `project` when it is
the workspace fallback. `sandboxr config` prints it, because a project running from a config
that is not in its own repository is a thing a user must be able to see rather than deduce.

Nothing here changes a repository outside the workspace: its walk-up is unbounded exactly as
before, and its `root` is still the directory the config sits in.

## 6. The database driver interface

```ts
export interface DriverContext {
  project: string;
  slug: string;
  config: ResolvedConfig;
  home: string;             // SANDBOXR_HOME
  worktree: string;
  exec(cmd: string[]): Promise<ExecResult>;   // inside the sandbox container
  log(line: string): void;
}

export interface DatabaseDriver {
  readonly name: "mysql" | "d1" | "sqlite" | "none";

  /** Host-side: produce a reusable seed artifact and say where it is. Idempotent. */
  prepareSeed(ctx: DriverContext): Promise<SeedArtifact>;

  /** Inside the container, first boot: get from empty to seeded-and-migrated. */
  provision(ctx: DriverContext, seed: SeedArtifact): Promise<void>;

  /** Run the project's own migration command. Never reimplement the project's logic. */
  migrate(ctx: DriverContext): Promise<MigrateResult>;

  /** Structure-only snapshot, for diffing before/after a migration. */
  snapshot(ctx: DriverContext): Promise<string>;

  /** An interactive shell against this sandbox's database. */
  shell(ctx: DriverContext): Promise<void>;
}
```

Rules that apply to every driver:

- **The source database is only ever read.** Every destructive operation targets a copy.
  This is the property that makes it safe to point a half-written migration at real data.
- **A failed migration does not stop the sandbox.** Record the failure, mark the sandbox
  `degraded`, and let the services boot anyway — inspecting a failed migration is a reason
  the sandbox exists.
- **The schema baseline survives a failed run.** Snapshot before migrating, and only
  re-take the baseline after a *success*. Re-snapshotting on every attempt would overwrite
  the last-known-clean schema with the half-migrated state, and the diff would then show
  nothing exactly when it matters most.
- **Never reimplement the project's migration logic.** Shell out to the command in the
  config. The tool may *read* migration state to display progress, but what actually runs
  is always the project's own program.

### 6.1 Driver notes

**mysql** — the hard case. A running server: install, start, wait, dump, restore, and an
advisory lock so two migrations cannot collide. Restore into the version the project
declares, not whatever the developer happens to run locally.

**`provision` runs twice and must be idempotent.** The container's own `db-init` oneshot
provisions at boot, and `up` calls the driver's `provision` once the container is answering —
both are wanted (the container has to come up on its own; the host has to be able to report
what happened), but it means the second one can meet a database the first one already seeded.
A `mysqldump` carries `CREATE TABLE` and no `DROP TABLE IF EXISTS`, so replaying it over a
populated schema fails on Error 1050. **An already-populated database is kept, on both sides**;
`provision` means *first boot*, and the table count is what decides whether this is one.

> [!WARNING] Two known defects in the host half of the mysql driver. Neither is fixed.
>
> **The host authenticates as `root` with a password the container does not set.**
> `mysql-init.sh` initialises the server with `--initialize-insecure` — root has no password,
> deliberately and for a reason it states — while `mysqlSettings` defaults `rootPassword` to
> `sandboxr` (and `docs/reference/environment.md` documents that default). Every host-side
> `mysql` exec against a sandbox therefore fails with `Error 1045: Access denied`, which is
> why `up` reports "Provisioning did not complete" against a sandbox the container has
> brought up perfectly. The container half does all the work, so nothing is lost — but
> nothing the host driver does to a running MySQL sandbox currently runs at all.
>
> **Nothing orders the two provisioners.** `up` waits only for `/workspace` to exist before
> calling `provision`, which is seconds before `mysqld` is accepting connections, so the host
> half loses the race and fails rather than colliding. Correcting the credentials *without*
> also deciding who owns first boot would turn a harmless failure into two concurrent restores
> of the same dump into the same schema. The two have to be fixed together, and fixing them
> means saying here which half owns first boot — the host (and `db-init` waits for it) or the
> container (and the host's `provision` becomes a report rather than an action).

**d1 / sqlite** — the easy case. The database is a *file*. Seeding is a copy, forking is a
copy, there is no server and no lock. One rule: **one writer per file.** Two processes
opening the same D1 file deadlock, so each sandbox gets a private copy and the config must
name the single service that owns it.

**none** — no database. Valid and should stay cheap.

### 6.2 Where a seed artifact lives, and how the container reaches it

There are two kinds of seed artifact and they are not interchangeable, which is the whole
reason this subsection exists:

- **A cached dump**, which sandboxr produced itself and content-addressed into
  `~/.sandboxr/cache`. The filename is the identity and the directory is fixed on both
  sides, so a bare name is enough to find it.
- **A declared `file:`**, which the project named in `database.seed_from.file` and which may
  live anywhere the user keeps it — deliberately outside every repo, so `git clean` cannot
  destroy it. Its directory is the only thing locating it.

**`plan.json`'s `database.seed.path` is therefore the path *inside the container*, never a
host path and never a bare name to be resolved against a directory the container has to
know about.** The host decides:

| Artifact | Container path | Mount |
|---|---|---|
| inside `~/.sandboxr/cache` | `/sandboxr/cache/<name>` | the cache directory, already mounted read-only |
| anywhere else | `/sandboxr/seed/<name>` | that **one file**, bind-mounted read-only |

The declared file is bind-mounted rather than copied into the cache. A copy would have to be
re-made or re-fingerprinted on every `up` — a dump is routinely tens of gigabytes — and a
copy taken once goes stale silently the next time the file is rebuilt. The mount is the file
itself, not its directory, so pointing `file:` at something in a shared download directory
does not hand the sandbox everything else in it.

The basename is preserved because the container decides how to decompress by extension
(`.zst`, `.gz`, plain); a fixed mount path would have to guess.

## 7. Access control

One mechanism, used twice.

- The dashboard owns sessions. `POST /auth/login` takes a password, sets a signed
  `HttpOnly` `Secure` `SameSite=Lax` cookie. Password is `SANDBOXR_PASSWORD`, compared with
  a **timing-safe** comparison, and stored as a hash — never logged, never echoed.
- The router protects everything else by asking the dashboard. App hostnames belonging to a
  `private` project get a forward-auth middleware pointing at `GET /auth/verify`, which
  returns 200 or 401. `public` projects skip the middleware.
- Per-project access: the session records which projects it may control. A password grants
  the projects it is configured for, so different people get different projects.

Non-negotiables:

- **No action endpoint is reachable without a session.** Not one.
- **Every route declares its auth.** There is no default, so a route added without a
  decision does not compile rather than shipping open.
- The dashboard talks to Docker; treat every request as untrusted input. Slugs, project
  names and branch names are validated against the patterns in this file before they reach
  a command, and commands are executed as argument arrays — never a shell string.
- Rate-limit the login route.
- **A content-security policy with no `unsafe-inline` for script, and no external origin.**
  Nothing executable may be inlined into a page and nothing may be fetched from another host.
  The browser app's build is configured for that — no inlined assets, one stylesheet, fonts
  served from this machine rather than from a font CDN — and it is a constraint on the build,
  not a preference about it.

  There is **no relaxation**, including for the terminal. A dependency that cannot live inside
  this policy is configured differently rather than let out of it: xterm's default renderer draws
  by injecting `<style>` elements, so the browser app loads its canvas renderer instead, which
  injects none. Widening either half of `style-src` needs a reason written down here, and a
  browser's violation message is not one on its own — it names the directive that refused, not
  the mechanism that tripped it.

### 7.1 The dashboard's HTTP surface

The dashboard is a **single-page app**. `@sandboxr/server` answers JSON and serves one HTML
shell; `@sandboxr/web` is the app that shell loads, and it routes in the browser from there.

**The governing rule: the server sends facts and the browser writes sentences.** No field of
any API response is a rendered string. An expiry is an instant, never `"3h 20m left"`; a state
is `degraded`, never `"degraded — something failed during boot"`. A page showing a countdown
has to re-render it every second anyway, so a server-rendered copy of the same wording is only
a second version to disagree with — which is exactly what it was: the words existed once in a
template and once in the script that replaced them, each carrying a comment warning that the
two had to be kept in step.

The corollary is that the *decisions* still belong to the server. Which actions apply to a
sandbox right now is a field on the response, not a filter the browser derives from the action
table; so is the sentence a destructive action confirms with, because the table is where what
is actually lost is known.

**`issues` on a sandbox is that rule's other edge: it holds faults, and never a restatement of
`state`.** A sandbox that is stopped or still coming up carries an empty list, and every reader
spends red on whatever is in it without filtering. It once carried "container is not running"
for every stopped sandbox and "still starting" for every one booting, which is `state` said a
second time in the field that means "go and look": the dashboard painted the quiet half of a
machine as broken, its own attention count counted sandboxes that were merely off, and
auto-start refused every stopped sandbox there had ever been. The browser then learnt to drop
those entries by state — the right colour, from the wrong place, and a second copy of a
judgement out of a wording only the server owned. `issuesFor` in
`packages/server/src/sandboxes/model.ts` is where it is made, once.

The **worktree** is the one fault the browser adds, and it is allowed to because a worktree is
not a sandbox: a directory git still lists that has been deleted has no sandbox and therefore
no `issues`, and it is what explains "Start does nothing". So the sidebar's notion of a row
needing attention is deliberately wider than `summary.needsAttention`, which counts sandboxes
with a fault. The two answer different questions and neither is derived from the other.

**The JSON API.** Every route below requires a session, and every one that names a `:project`
is additionally checked against the session's grant.

| Route | Answers |
|---|---|
| `GET /api/bootstrap` | The domain, the session, the closed action table (§8), and the default lifetime the new-sandbox form offers. What the app needs before it can draw anything |
| `GET /api/workspace` | Every project, every worktree and every sandbox on the machine, plus a summary. The one call the sidebar and the home view are drawn from. Each worktree carries the state of its pull request, from a cached per-repository index rather than a `gh` call per row (§4.1.2) |
| `GET /api/projects/:project` | One project's worktrees, branches and open pull requests. The list is read live, so it is the authoritative one; the state on each worktree beside it comes from the index and may be up to five minutes behind |
| `GET /api/p/:project/s/:slug` | One sandbox in full, with the apps and services its project's config declares |
| `GET /api/repos` | The repositories this machine's `gh` can offer, each marked with whether it is already in the workspace |
| `GET /api/p/:project/s/:slug/agent/runs` | The agent sessions recorded against one sandbox, newest first. The index only — never message content (§7.2) |
| `GET /api/agent/models` | The models a session may run on **and the permission modes it may run in**, with the ones this machine defaults to. Two closed tables, one read, because the browser draws two controls that sit side by side (§7.2, §7.2.2) |
| `GET /api/p/:project/agent/grants` | The standing permissions this project has been granted — the rule as Claude Code will match it, and where it was granted from (§7.2.2) |
| `DELETE /api/p/:project/agent/grants/:id` | Withdraws one. The only `DELETE` in the API; `SameSite=Lax` on the session cookie is what protects it, as it protects every `POST` beside it. Takes effect on the next session (§7.2.2) |
| `GET /api/p/:project/s/:slug/agent/commands` | The slash commands a session on that sandbox can be offered, each marked sendable or not, each refused one carrying the sentence it is refused with, and the one sandboxr answers itself marked `handledBy` (§7.2) |
| `PUT /api/p/:project/w/:slug/name` | Sets what one **worktree** is called, from a body of `{ "name": string }`; an empty name clears it. Answers `{ project, slug, displayName }`. On the `w` form and never the `s` form: the name belongs to the worktree, which persists (§4.2.1). A name that is not one is a `400` that does not repeat what was sent |

`GET /api/workspace` is polled every **thirty seconds**, and three rules about that polling are
part of the contract because each was learnt from the version this replaced: nothing is fetched
while the tab is hidden or while an action is running, a failed poll leaves the last good answer
on screen and says it is stale rather than blanking the page, and returning to the tab refreshes
at once.

**The HTML shell** is served at `/`, `/worktrees`, `/new`, `/settings`, `/repos`,
`/p/:project`, `/p/:project/branches`, `/p/:project/w/:slug` and `/p/:project/s/:slug`. Every
one of them returns the same document; the app decides what to draw. `/assets/*` serves the
built bundle.

`/worktrees` is the sidebar's list as a pane. It exists because the sidebar is not drawn below
the `md` breakpoint and a phone would otherwise have no way to browse the machine at all — so
it is a route with a URL, reachable by bookmark, named in the manifest's shortcuts and given a
tab of its own in the bottom bar, rather than a panel the shell opens over itself. Being a
route is what makes it a history entry, which is what the back gesture has to have.

**Six files are served from the origin root**, and each is there because the name is
referenced from somewhere that cannot be rebuilt with the bundle, so none of them can carry a
content hash: `/manifest.webmanifest`, `/sw.js`, and the four `/icons/*.png`. They are public,
for the same reason `/assets/*` is — build artefacts, no state, nothing that says whether a
project exists — and they are served from a **closed table of six paths**, not a directory,
which is the posture `/assets/*` takes with its filename pattern.

`/sw.js` has to be at the root rather than under `/assets/`: a service worker may only control
paths below the one it was served from, and the app it exists for is at `/`. It and the
manifest are `no-cache`; a held worker script is a worker that cannot be replaced.

`/p/<project>/w/<slug>` and `/p/<project>/s/<slug>` are one view — the sandbox is something
that comes and goes on top of the worktree. The `s` form is kept because it is what an action's
declared destination (§8) and every existing bookmark already use, and because the log and
terminal endpoints hang off it.

**Under `/api`, though, the two forms are not interchangeable, and the rename is the case that
makes it matter.** `PUT /api/p/:project/w/:slug/name` is on the `w` form because what it writes
outlives every sandbox cut on that worktree; the `s` routes beside it all address a container. A
rename posted to an `s` route would read as a fact about an instance, which is precisely the
mistake §4.2.1 exists to rule out.

**Unchanged by the move to a single-page app**, and deliberately so: `/healthz`, `/login`,
`/auth/*`, the three `POST` action routes (`/actions/:action`, `/p/:project/actions/:action`,
`/p/:project/s/:slug/actions/:action`), `GET /p/:project/s/:slug/logs`, the terminal
WebSocket at `/p/:project/s/:slug/terminal`, and the agent WebSocket at
`/p/:project/s/:slug/agent` (§7.2).

**The login page and the private-app handshake pages stay server-rendered.** Two reasons, both
hard requirements rather than preferences. The login form must work with JavaScript off, because
it is the only way back in and a dashboard that cannot be signed into cannot be fixed from
itself. And it must be a real `<form>` with a real `POST` for the browser's password manager to
recognise it as one — a form assembled by script after load frequently is not offered a saved
password at all.

### 7.2 Agent sessions

A sandbox may have a **Claude Code session** running on its worktree. `claude` runs *inside*
the container, on `/workspace`, started by the server over `docker exec`; the host holds no
agent process of its own.

**Three nouns, and every screen and every stored file is one of them.**

| Noun | What it is | Keyed by |
|---|---|---|
| Run | One `claude` session, in one sandbox | `sessionId`, assigned by Claude Code |
| Thread | One conversation inside a run — the main one, or a subagent's | `parent_tool_use_id`; `main` for the one nothing spawned |
| Event | One thing that happened, in order | `uuid`, plus its position in the transcript |

**A run's tree is assembled from two different joins, and only one of them is free.** Inside a
session, every message carries the id of the tool call that spawned it, so subagents nest at any
depth with nothing for sandboxr to remember. Across a session boundary — a session that starts
another session — there is no such field, and the link has to be written down at the moment it
is made or it cannot be recovered. **`forkedFrom` is that link**, and it is the one exception to
"every field in the index is derivable by replaying the transcripts": a forked session's
transcript opens with the conversation it inherited and says nothing about having been forked,
and the parent's says nothing about the fork at all.

**The wire format is Claude Code's, and exactly one file knows it.** `packages/core/src/agent/stream.ts`
turns `--output-format stream-json` into the event model above; nothing downstream sees a raw
line. A Claude Code release that renames a field is a change there and nowhere else. A line this
version does not understand is **dropped, never surfaced** — an unrecognised type is almost
always a newer Claude Code, and rendering it raw would put JSON in the middle of a conversation.

The event kinds are closed, and each one is a thing a reader acts on rather than a line of the
protocol repeated:

| Kind | What it says |
|---|---|
| `session` | The session opened: model, working directory, tools, and which MCP servers **failed**. `failed` only: `pending` is the ordinary state of a cached server, and `needs-auth` means somebody added a server and has not signed into it, which is a choice rather than a fault. Both were drawn in the red of a broken thing on every session, naming servers the reader had deliberately not authorised — which is how a warning stops meaning anything. `/mcp` reports the whole picture on demand |
| `text` | Prose, from either side |
| `thinking` | The model is reasoning. The text is often empty, and the marker is still worth drawing |
| `tool` / `tool-result` | One tool call and its answer, rendered as one card. A call that spawned a subagent says so |
| `result` | The turn ended. The only place cost and duration are stated |
| `compacted` | History was summarised away, with how many tokens were in play and whether anyone asked |
| `ask` / `ask-result` | A permission question and what was decided, rendered as one card — the same pairing `tool`/`tool-result` uses. The one event a reader has to *act* on: the turn is stopped until it is answered (§7.2.2) |
| `retry` | A retryable API failure, on its way to resolving itself or becoming an error |
| `error` | The session failed — not a tool that did |

**A compaction is an event, not a gap.** Claude Code summarises a long conversation and carries on,
and it says so on the stream. Dropping that line as unrecognised — which is what happens to
everything else this version has no opinion about — loses the one fact that explains an agent which
appears to have forgotten what it was told: the transcript would show the conversation continuing
with no sign that most of it had been replaced by a summary. It is therefore the exception to the
paragraph above, and it is read defensively: an unstated token count or trigger becomes null rather
than a compaction this version declines to report.

**Transcripts are files; the index is small.** The raw lines are appended to
`$SANDBOXR_HOME/agent/log/<sessionId>.jsonl` *before* they are interpreted, so a later renderer
can re-read a conversation an earlier one recorded. `$SANDBOXR_HOME/agent/runs.json` holds the
index: which session belongs to which sandbox, its state, and where its transcript is. **Every
field in the index is derivable by replaying the transcripts — except `forkedFrom`**, which is why
that one field is written at the moment the fork is made and can be recovered no other way. What is
left is a cache rather than a system of record — and what makes the storage choice a contained one. It is a JSON
file written by temp-and-rename because the server process is the only writer; the day there are
two, `store.ts` changes and nothing else does.

`sessionId` is the load-bearing field. It is the only thing that makes `claude --resume` possible
after a container restart, and it exists nowhere else.

### 7.2.1 Side questions: `/btw`

**`/btw` is a slash command sandboxr implements itself rather than one it sends or refuses.** In a
terminal it draws a panel beside the conversation, so it is `local-jsx` and a headless session
answers one with "isn't available in this environment". That is a fact about how Claude Code
implements the command, not about what the command is for — which is a conversation that starts
from everything said so far and whose answer never comes back. That is a session flag:

```
claude -p --resume <parent> --fork-session --session-id <fork> --tools "" --strict-mcp-config …
```

A forked session inherits the conversation up to the fork and then diverges. **Nothing is written
to the parent**: its process is not spoken to, its transcript gains no line, and it stays usable
while the fork works — the two are separate processes in the same container and both can be
running at once.

| Decision | What it is, and why |
|---|---|
| Where the process lives | The same registry, under a **suffixed key**: `project/slug` for the sandbox's session, `project/slug#btw:<forkSessionId>` for each fork. One map means one transcript queue, one idle wind-down, one `stopAll`; a second registry would be a second copy of all of it, and the copy that gets forgotten is the one that stops things at shutdown. "One session per worktree" survives as a property the key states: **at most one entry whose key has no fork suffix**, and `running()` only ever answers about that one |
| The fork's id | Chosen by sandboxr and passed as `--session-id`, so it is a fact before the container is touched. One identity covers the browser's handle, the index row and the transcript filename, which is what lets a fork be found again after a reload. Claude Code's own error message documents the combination: `--session-id` may be used with `--resume` **only** when `--fork-session` is |
| What it may do | **Nothing. A fork has no tools at all** — `FORK_TOOLS` is empty, which reaches the command line as `--tools ""`. A `/btw` answers out of the conversation it inherited; a fork that goes and greps the worktree is a second agent doing work on a question somebody asked in passing, and slow, on the one command whose appeal is that it is not. It also closes the older trap more completely than the read-only allowlist it replaces: there is nothing a fork can touch, rather than a list of things it may not |
| How "no tools" is spelled, and why not the obvious way | `--tools` is the **base set**, not a permission rule, and Claude Code turns it into a deny rule for every built-in it does not name. A deny rule is the only thing that outranks a permission mode, so this holds however the session is otherwise configured — including under an operator's `SANDBOXR_CLAUDE_PERMISSION_MODE`, which a fork does not take in any case. An **empty `--allowedTools` would not work**: an allow list only decides what proceeds *without asking*, so an empty one narrows nothing. Two details are load-bearing in the argv. The empty string is an **argument, not an omission** — `--tools ""` narrows to nothing while a bare `--tools` is an empty list Claude Code skips — and because the flag is variadic, whatever follows the empty string must start with `-` or it is read as a tool name. `--strict-mcp-config` goes with it, because `--tools` narrows the *built-in* set and an MCP server configured on the branch would otherwise be the one route left back in |
| The mode it still runs in | `--permission-mode dontAsk`, and it decides nothing today. The set of tools Claude Code ships is not sandboxr's to freeze: if a release adds one `--tools` does not narrow, `dontAsk` refuses it where `acceptEdits` would *perform* it — and on a fork that is a file written into a worktree somebody else is mid-refactor on |
| Its model | The parent's, always. A fork inherits a conversation one model had, and answering on another would make its own transcript misleading — the same promise `/model` is refused to keep |
| Its lifetime | It ends itself when its answer is finished, so a side question is not an idle `claude` left in the container. Dismissing the block does **not** stop it; stopping the parent does, and so does five minutes with nobody watching |
| How many | Three at once per sandbox. The fourth is refused with a sentence rather than by making the conversation everybody is waiting on slower |

**Interrupting is by tag, not by process name.** Every sandboxr-started session carries
`--name sandboxr-<uuid>`, and an interrupt is `pkill -INT -f -- sandboxr-<uuid>` in a second exec.
`pkill -x claude` was precise while a container held one session; with a fork beside it, "stop this
turn" would have put both down at once.

**The socket forks whichever way the text arrives.** `{"t":"send","text":"/btw …"}` is intercepted
and never forwarded, so a client that knows nothing about `handledBy` still gets a fork rather than
a `/btw` posted into a running session. A `/btw` with nothing after it, and one on a session that
has not yet been assigned an id, are each answered with their own sentence and fork nothing.

**Four more frames carry it**, and the design is that a fork's stream *is* a session's stream:

| Direction | Frame | What it is |
|---|---|---|
| server → browser | `{"t":"forks","forks":[…]}` | Every side question of this run: id, parent, question, state, times. Re-sent whole whenever one changes, to **every** socket on the sandbox |
| server → browser | `{"t":"fork","id":…,"message":<frame>}` | One fork's own output, wrapped. `message` is an ordinary server frame, so the browser unwraps it and draws the panel with the components that draw the conversation |
| browser → server | `{"t":"fork-open","id":…}` | Read this one: replay its transcript and subscribe. Only a socket that asks is sent a fork's stream |
| browser → server | `{"t":"fork-interrupt","id":…}` / `{"t":"fork-stop","id":…}` | End that fork's turn, or that fork |

A fork's transcript is readable only through the sandbox it belongs to. A session id is a filename
under `agent/log/`, and uuids being unguessable is not an access rule.

**In the browser a side question replaces the composer, and must be dismissed.** It is a modal
digression, not a second panel: asking one puts the conversation's composer aside and stands a block
in its slot holding the question and the answer, and while that block is open **there is nowhere to
type to the main session at all**. The composer is *removed* rather than disabled, because an
affordance that is present and refuses is a worse answer than one that is not there. Dismissing it —
a button, or Escape — gives the composer back and does **not** stop the fork.

This is deliberately not the subagent idiom, which it was at first. A chip in the tray is something
you come back to while you get on with something else, and that is what a subagent is; a side
question is something you ask, read and are done with. The tray is therefore subagents only.

Three consequences worth stating, because each is a thing that could be got wrong invisibly:

- **The block survives a reconnect.** A fork is a real run with its own transcript, so a dropped
  socket must not be able to lose one. The open fork's id is held across the socket's teardown, and
  the `forks` list that arrives on the new attach is where it is put back — that frame is the first
  moment a fresh socket can know the fork still exists. Its transcript is discarded and asked for
  again with `fork-open`, because a replay appended to what is on screen would draw the answer twice.
  A fork **absent** from that list — its conversation ended, or another browser stopped it — gives
  the composer back instead.
- **One at a time**, which follows from there being one composer. The cap of three concurrent forks
  is still real and still enforced by the server: a fork keeps running after its block is dismissed,
  and a second browser on the same sandbox can ask its own.
- **The block knows which fork is its own without a frame for it.** The server subscribes exactly
  one socket to a fork it did not ask about — the one that asked for it — so a `{"t":"fork","id":…}`
  for an id the browser never opened is the side question somebody there just asked.

The marker left in the conversation is unchanged and is now the only route back into a finished side
question. It is positioned by **clock time and not by `seq`**: a replay and the live stream are
counted by separate counters, so `seq` is not comparable across a reconnect. `forkedFrom.afterSeq`
records the parent's offset anyway, because it is the number a later reader of the two files needs
and it cannot be recovered afterwards.

**A session is keyed by the sandbox, not by the connection watching it.** Sockets subscribe and
unsubscribe; the process underneath carries on. That is the one place an agent session must differ
from the terminal, and it is not a preference: a shell dying with its tab is expected, an agent
dying because somebody looked at another worktree destroys work in progress. It follows that two
browsers can watch one session, and that closing every browser leaves it running — bounded, because
an unwatched session is stopped after thirty minutes rather than held open indefinitely against the
sandbox's own idle reaper.

**What a session does not survive is the dashboard restarting.** The process is a `docker exec`
this server owns, so it dies with it. That is recoverable rather than fatal — the session id and
the transcript are on disk, so the next connection continues the conversation with `--resume` — but
it is a real limit. Removing it means running the agent detached *inside* the container and
attaching to its output instead of owning its process.

**The socket** is `/p/:project/s/:slug/agent`, authenticated before the upgrade completes like
the terminal's (§3.2), with an optional `?resume=<sessionId>`, `?model=<id>` and `?mode=<id>`. A socket opened
on a sandbox that already has a session joins it, and **the running session's model wins over the
one asked for** — a conversation is a thing one model had, and switching mid-way would make its own
transcript misleading. Unlike the terminal there are no binary frames at all — both directions are
JSON text:

| Direction | Frames |
|---|---|
| browser → server | `{"t":"send","text":…}`, `{"t":"interrupt"}` (end the turn), `{"t":"stop"}` (end the session), `{"t":"answer","id":…,"decision":"allow"\|"always"\|"deny"}` and `{"t":"mode","mode":…}` (§7.2.2), and the three fork frames of §7.2.1 |
| server → browser | `{"t":"ready",…}`, `{"t":"session",…}`, `{"t":"event","event":…}`, `{"t":"state",…}`, `{"t":"usage","tokens":…}`, `{"t":"error",…}`, plus `{"t":"forks",…}` and `{"t":"fork",…}` (§7.2.1) and `{"t":"asks",…}` and `{"t":"mode",…}` (§7.2.2) |

A reconnect replays the transcript from disk before the live stream starts, so the socket only
ever carries what happens from now on.

**Slash commands are a list the server owns, and half of it is per sandbox.**
`GET /api/p/:project/s/:slug/agent/commands` answers every command the composer may offer, from
three sources: Claude Code's built-ins, the worktree's own `.claude/commands/`, and its
`.claude/skills/`. The last two belong to the branch rather than to the machine, so they are read
by one exec inside the container — and a worktree with no `.claude` directory is the ordinary case,
so a failure there answers the built-ins rather than an error.

The built-ins are a **closed table** in core, on the same reasoning as the model table: a command
becomes the text of a message sent into a process in a container. Only commands that work without a
terminal are in it — Claude Code's `-p` mode runs skills, custom commands and a documented subset of
the built-ins, and a terminal-only one such as `/login` is not an error the person sees but a turn
spent on nothing. Two free sources say which is which and they agree: the shipped binary marks each
command `supportsNonInteractive`, and a running session announces the resulting set as
`slash_commands` on its `system`/`init` line. Neither costs a turn, and the table is worth
re-checking against them whenever the image's `claude` is upgraded. What `init` does not carry is
descriptions, which is why the table is written out rather than read off the session.

**`sendable: false` marks a command that is listed and must not be sent, and the socket enforces it
too.** A `{"t":"send"}` whose first token is one of them is answered with an error frame and never
forwarded, because a rule enforced only in the browser is not a rule. Three are refused, each for
its own reason: `/clear` starts a *new* Claude Code session while this run's transcript is still
being written against the old id; `/login` only exists in a terminal; and `/model` would change a
run's model after the index has recorded it, which is the same promise a joining socket keeps when
the running session's model wins. Each refused row carries the sentence it is refused with, in
`refusal`, and no other row carries one — the reason a command is stopped is a fact about what a
session does, so the browser says it rather than composing one.

**`handledBy` is a different question from `sendable`, and exactly one row answers it.** `sendable`
asks whether this text may be posted to the session; `handledBy` asks who runs the command at all.
`/btw` is `handledBy: "sandboxr"` — sendable from the composer, never sent to the session, forked
by the socket (§7.2.1). The field is absent on every row the session runs, so an older browser
reading a newer server's list is one that does not know sandboxr answers this one; it posts the
text, and the socket forks anyway.

**The table is a menu, not an allowlist.** Those three refusals and that one interception are the
whole of what the socket does not forward. Every other message beginning with `/` is passed on
verbatim — a command Claude Code gained after this table was written, one of the skills bundled in
the binary, a worktree command added since the pane loaded, a pasted path, a sentence, a bare
slash. A closed table decides what sandboxr *offers*, what it *stops* and what it *answers itself*;
what a person may type is not sandboxr's to decide, and a table one release behind Claude Code has
to degrade into "pass it on" rather than into "you may not type this".

**The exec has no TTY, and that is not an optimisation.** A TTY echoes what is written to it, so
a process exchanging newline-delimited JSON would receive its own input back interleaved with
its output. The cost is that Docker frames the stream, which `demuxer()` already handles.

**A session runs on one of two credentials, and which one decides what it can reach.**
The default is a `claude setup-token` in `CLAUDE_CODE_OAUTH_TOKEN`: it makes model requests and
nothing else, and loads no claude.ai connectors. A **subscription login** placed in the shared
config volume (`sandboxr-claude`, §3.3) reaches every connector on the account instead — including
the Google and Microsoft ones, which no per-server OAuth can authorise from a container, because
this is the login that already authorised them rather than a fresh flow.

**They do not compose, and the token wins.** Claude Code ranks an explicit
`CLAUDE_CODE_OAUTH_TOKEN` above a stored login, so passing both leaves the connectors dark with
nothing on the stream to say why. The server therefore probes for the login — existence only,
never its contents — and withholds the token when one is there. A machine that never places a
login is unaffected.

**Either credential alone is sufficient, and the socket must ask about both before it refuses.**
A sandbox that can read a login is authenticated with no token anywhere on the machine — that is
the arrangement §7.2.1 exists to serve, and the only one that loads connectors — so "no
`SANDBOXR_CLAUDE_TOKEN`" is not the same question as "no credential". The token is checked first
because it costs nothing; the login is a probe inside the container, because `process.env` cannot
see in there. Only the probe's **yes** may be cached: a *no* is the state a person is in the middle
of fixing, and caching it would mean a credential placed by hand needed a dashboard restart rather
than a new session.

Placing one is **opt-in and deliberately not the default**: that credential can mint API keys
against the organisation and reaches the person's mail, files and chat, from a root filesystem in
a container whose job is executing project code, in a volume every sandbox on the machine shares.

#### The host's login, shared rather than copied

**When the host has `~/.claude/.credentials.json`, that one file is bind-mounted read-write into
every sandbox** at `/root/.claude/.credentials.json`, over the volume. It is resolved on the host
by `hostClaudeCredentials` (`packages/core/src/agent/credentials.ts`), which honours the host's own
`CLAUDE_CONFIG_DIR` and never assumes `$HOME` is `/root`.

**Shared, not copied, because an OAuth refresh token rotates and is single-use.** Two copies
invalidate each other the first time either side refreshes: the host refreshes, the sandbox's copy
is dead, and Claude Code blanks its own file rather than reporting a stale token. One file with one
writer at a time has no such state — a refresh inside a sandbox updates the host's login and every
other sandbox's at once. This is why the mount is **read-write**; read-only would work exactly until
the first refresh and then fail the same way the copy did.

**One file crosses the boundary, and the directory deliberately does not.** Binding all of
`~/.claude` would give every sandbox write access to the host's `settings.json`, which can define
**hooks — commands the host's own Claude Code then executes.** That turns a convenience into a
container-to-host escalation: code running in a sandbox writes a hook, and the next thing the person
does on their own machine runs it. The same mount would also expose their history, plans and
per-project state to whatever is running in a sandbox. The credential is the only file that has a
reason to cross, so it is the only one that does.

Three consequences are part of the contract:

- **No file, no mount.** Docker silently creates a *directory* where a bind source is missing, and
  Claude Code then fails in a way that names neither Docker nor the mount. Absent — or present but
  empty, which is what a rotation conflict leaves behind — the sandbox falls back to the volume.
  An empty file is skipped rather than mounted because the login probe above tests existence: a
  blank file would be read as a login, withhold the setup-token, and leave the session with no
  credential at all.
- **On Linux, a host login is therefore shared with every sandbox on the machine**, with all of the
  reach described above. That is the supported arrangement, and it is a decision, not an oversight.
- **On macOS there is no such file** — the credential lives in the login keychain — so nothing is
  mounted unless a person exports one to that path by hand. See the guide.

**The dashboard is given the path at `init`, not left to resolve it.** It runs in a container whose
`$HOME` is not the person's, so resolving from inside it would find nothing while the CLI found the
file, and sandboxes started from the browser would silently differ from sandboxes started from the
terminal — the failure the git-identity note in §7.3 already records. `init` resolves the path on
the host and forwards it as `SANDBOXR_CLAUDE_CREDENTIALS`, which is also the override a deployment
can set directly. A forwarded path is trusted rather than re-checked, because the container it is
read in cannot see the host filesystem; a credential removed after `init` therefore needs another
`init` to be noticed.

**Credentials never reach the worktree.** A session authenticating with an OAuth token from
`claude setup-token` gets it from the server's environment, passed to the exec as
`CLAUDE_CODE_OAUTH_TOKEN`; it is written to no file inside the container. A session running on a
login reads the file the mount or the volume already put at `/root/.claude/.credentials.json`, which
is outside the worktree and stays there. One consequence is
part of the contract because it is invisible otherwise: **a setup-token does not load claude.ai
connectors**, so MCP servers are named to the machine (`SANDBOXR_CLAUDE_MCP`) and passed on the
session's command line rather than inherited from the host's connector list.

**The container is the permission boundary**, and what contains a session is the sandbox: the
worktree, the project's own services, and nothing else. Inside that, §7.2.2 is how a session asks
and how a person answers.

`bypassPermissions` is impossible here rather than merely unwise, and it is therefore not in the
table at all. It is a spelling of `--dangerously-skip-permissions`, Claude Code refuses that
outright when running as root, and sandboxes run as root; a session configured that way exits at
once with the refusal on stderr and nothing on the event stream. It stays in the `PermissionMode`
type for the day a sandbox runs as somebody else, and `SANDBOXR_CLAUDE_PERMISSION_MODE` falls back
to the default rather than honouring it.

**The model is chosen from a closed table**, `AGENT_MODELS` in core, defaulting to Claude Opus 5.
The browser asks for one with `?model=` on the upgrade and an id outside the table is refused
before the handshake completes — the value becomes `--model` on a command line inside the
container, so this is the same rule the action table follows in §8. `SANDBOXR_CLAUDE_MODEL` sets
the machine's default, and `GET /api/agent/models` reports what this machine will actually do
rather than a constant.

### 7.2.2 Permission questions, and the modes that produce them

**A session can ask a person for permission, and the person can answer.** That is a change to this
file rather than an addition to it: the paragraph this replaces said the opposite, and everything
built under it — the wildcard allowlist, `acceptEdits` as the only workable default — was working
around a limit that turned out not to exist.

**The mechanism is `--permission-prompt-tool stdio`, and its name is a trap.** Claude Code
documents the flag as "MCP tool to use for permission prompts", which reads as an instruction to
stand up a server. It is not. The flag takes one magic value, and with it the CLI asks over the
stream it is already speaking on. The binary says so itself, in the sentence it prints when a
cloud session is given anything else: *"--permission-prompt-tool (permission prompts reach the
host over stdio; an MCP tool cannot answer them here)"*. sandboxr already owns both ends of that
pipe, so nothing new runs in the container and nothing has to be reachable from it.

| Direction | Frame |
|---|---|
| session → host | `{"type":"control_request","request_id":…,"request":{"subtype":"can_use_tool","tool_name":…,"input":{…},"tool_use_id":…,"permission_suggestions":[…],"suppress_always_allow_rule":…,"requires_user_interaction":…}}` |
| host → session | `{"type":"control_response","response":{"subtype":"success","request_id":…,"response":{"behavior":"allow"\|"deny",…}}}` |

**A request blocks the turn, indefinitely.** The tool does not run, the turn does not continue,
and nothing times out at either end — an unanswered question sits until stdin closes and then
fails with `Tool permission stream closed before response received`. Three things follow, and each
is part of the contract:

- **A pending question belongs to the run, not to the socket.** It is held in the registry,
  re-announced to whoever attaches, and answerable by any browser on the sandbox. A closed tab
  must not be able to strand a session mid-turn on a question only it could see.
- **The run's state becomes `needs-input`** — the value in core's `RunState` that nothing could
  previously produce, because nothing could ask.
- **The question travels twice**, and the two say different things. It is an ordinary `ask` event,
  so a replay draws the card the live stream drew; and the socket's `{"t":"asks","asks":[…]}`
  frame — re-sent whole on attach and on every change, like `forks` — says which of those cards
  still has a decision to make. An event cannot carry that: a transcript read next week is all
  closed questions, and one another browser settled a second ago looks identical to an open one.

**Three answers, and "always" is the one with consequences.** `allow` runs it once. `deny` refuses
it with a message the model sees. `always` runs it *and* remembers, and where it remembers is the
design:

- **Not by writing what Claude Code suggests.** Its own `permission_suggestions` arrive with
  `destination: "localSettings"`, and answering with that verbatim writes
  `<cwd>/.claude/settings.local.json` — a file on somebody's branch, made by clicking a button in a
  dashboard, outliving the sandbox that asked for it. Observed, not feared. sandboxr rewrites the
  destination to `"session"`, which applies the rule for the rest of the run and touches no file.
- **The grant itself is sandboxr's, and it is scoped to the project**, in
  `$SANDBOXR_HOME/agent/grants.json`. Not the session, which ends in minutes. Not the sandbox,
  which is deliberately disposable — a grant you remake on every branch about the same command in
  the same codebase is one people click through without reading. Not the machine, because the same
  command means different things in different repositories.
- **It is applied by going back onto the next session's `--allowedTools`**, which is the mechanism
  the default allowlist already uses. Claude Code proposed the rule and Claude Code matches it, so
  there is no matcher of sandboxr's to drift.
- **It is listed and revocable**, at `GET /api/p/:project/agent/grants` and
  `DELETE /api/p/:project/agent/grants/:id`, drawn in the permission picker beside the composer. A
  permission you cannot withdraw is one you should not have given. **Revoking applies to the next
  session**, not the running one: the rule was handed to Claude Code for the length of that run and
  there is no control request that takes it back. The answer says so rather than letting "revoked"
  quietly mean "revoked in a minute".

**Some tools cannot be pre-approved at all, and for those this is the only route.** An MCP tool
carrying the `anthropic/requiresUserInteraction` annotation asks **even when it is explicitly on
the allowlist** — verified against a stub server declaring it, with the tool named in
`--allowedTools`, on every call. Two consequences: a request is authoritative regardless of what
any rule says, so nothing may suppress a prompt on the grounds that the tool is allowed; and such a
request arrives with `suppress_always_allow_rule: true` and an empty suggestion list, so **"always
allow" is not offered on it** rather than offered and silently ineffective.

**`mcp__*` is gone from `DEFAULT_ALLOWED_TOOLS`, because it never worked.** An allow rule matches
an MCP tool by exact name (`mcp__notion__notion-search`), by server (`mcp__notion`), or by a
trailing wildcard on the server (`mcp__notion__*`). `mcp__*` matches none of them — the name half
of a rule is not glob-matched — so the line sat in every session's argv looking like a blanket
approval that had been granted and granting nothing. Nothing replaces it: a prompt is answerable
now, and per-call consent is the right trade for servers whose scope, with a subscription login in
the volume, includes the person's mail and files. An "always" on an MCP call persists a rule of a
shape Claude Code does match.

**The modes are a closed table**, `PERMISSION_MODES` in core, on the same reasoning as the model
table. `GET /api/agent/models` carries both, because the picker and the validator must be one
table. Each was checked against a real headless run rather than inferred from its name:

| Mode | What happens to a tool call no rule settles |
|---|---|
| `auto` | **The default.** A classifier reviews it and escalates what it will not vouch for. Costs a model call per unruled tool, and a classifier that cannot be reached *denies* rather than falling back to asking |
| `acceptEdits` | File writes and the common filesystem commands proceed; everything else asks |
| `manual` | Everything asks. Announced on the init line as `default` — see the spelling note below |
| `plan` | Claude works out an approach and puts it up first. A real `--permission-mode` value in a `-p` run, which is why it is offered |
| `dontAsk` | Refused outright, with `decision_reason_type: "mode"`. The only mode that never reaches a person |

**One mode has two names.** The command line takes `manual`; the control protocol and the
`system`/`init` line call the same mode `default`. `set_permission_mode` refuses `manual` with
`Cannot set permission mode: must be one of acceptEdits, auto, bypassPermissions, default,
dontAsk, plan`, and the session keeps the mode it had with nothing on the conversation to say so.
`wireMode` is that mapping.

**The mode can be changed on a running session**, which is the one way this picker differs from
the model picker beside it: `{"t":"mode","mode":…}` on the socket becomes a `set_permission_mode`
control request, and the very next unruled call is settled by the new mode. Nothing restarts and
no conversation is lost, so the picker does not borrow "this starts a new session". A socket
joining a run that is already up keeps *its* mode rather than imposing one, so that opening a
second tab cannot quietly widen what an agent already working on somebody's branch may do.

**Setting the flag is also a widening, and that is why it is opt-in per launch.** With
`--permission-prompt-tool stdio` a session is additionally given `AskUserQuestion`, `EnterPlanMode`
and `ExitPlanMode`, which are absent without it. A session gets it; **a side question never does**
— `/btw` has no tools by construction, and three tools whose job is to talk to a person would be
the one route back into a fork being able to do something.

**Both halves of a permission exchange are on the transcript**, which is the one place the
transcript is not purely "what Claude Code said". The request is a line the session wrote; the
response is the line the server wrote back on the same pipe, appended at the moment it was
written. A record holding only the questions replays as a conversation waiting for ever on
somebody who already answered. A question nobody answered is left as a missing response rather
than given a synthetic decision — "denied" is something a person did, "unanswered" is something
that failed to happen, and only one of them was decided by anybody.

### 7.3 Git in a sandbox, and the GitHub token

**Git works inside a sandbox, and making it work is a mount rather than a setting.** A linked
worktree's `.git` is a *file* naming its repository by absolute path, so a container that has the
worktree and not the repository fails every git command — `status`, `diff`, `log`, `commit` — with
one `fatal: not a git repository` naming a host path. The rule, the same one the dashboard's
workspace mount follows: the worktree **and** the repository it points at are bind-mounted at the
**identical path inside and out**, on top of the worktree's mount at `/workspace`. `gitMounts` in
`packages/core/src/git.ts` decides which paths those are; a plain checkout needs neither, and a
project that is a subdirectory of a larger repository gets neither and is told so once.

Three consequences are part of the contract:

- **The repository mount is read-write**, because `git commit` writes objects and refs into it.
  So every sandbox of a project shares one object store and one set of refs with the host: a
  sandbox can move a branch, and a `git gc` in one repacks what all of them read. Read-only was
  the alternative and is worse — status and log would work and only the commit would fail, from
  inside git, on a permission error.
- **The base image pins `gc.worktreePruneExpire` to `never`.** From inside one sandbox every
  *other* worktree of the project looks prunable, because their paths are not mounted, and
  `git commit` runs `gc --auto` on its own. Nothing in a sandbox has the information to make that
  judgement.
- **The commit identity crosses as `GIT_AUTHOR_*`/`GIT_COMMITTER_*`**, resolved from the host's
  `git config` (or forwarded to the dashboard at `init`, which has no gitconfig of its own). The
  host's `~/.gitconfig` is deliberately *not* mounted: it names a credential helper and a signing
  key that do not exist in the container, so the whole file breaks the operations it would enable.

**The GitHub token is a real widening of the blast radius, and it is off by default.** With
`github: token` (§4.3) a sandbox is given the value `gh auth token` prints on the host, as
`GH_TOKEN`, and the base image points git's https credential helper at `gh auth git-credential` —
so both `gh` and `git push` work, and an agent can open a pull request. What that costs, stated
plainly:

- The token is in the environment of **every process in that container**, not just an agent's.
  Project code, a dependency's install script and anything an agent runs can read it.
- Its scope is typically the person's, not the project's — `repo` across every repository they can
  reach, plus `gist` and `workflow`. Pushing to an unrelated repository is inside it.
- Unlike the seed and secret rules in §5.3, this is **not** refused for a `public` project, because
  nothing serves `GH_TOKEN` over http and reading it needs code execution in the container. A
  public sandbox is a dev build of an unfinished branch on an open hostname, though, so `up` says
  once, on the run where it applies, that the two decisions have met.

This is why the switch is the operator's, per project, and defaults to off. It is the same line
`DEFAULT_ALLOWED_TOOLS` draws for a session's commands: inside a sandbox everything is recoverable
by deleting it, and that stops being true the moment a command reaches the network with the
person's credentials. Note that `git push` and `gh` are **not** in that allowlist, so a session
still has to be granted them.

**Off is invisible unless something says so, and something must.** The near miss is exact: `git
status`, `git diff`, `git log`, `git add` and `git commit` all work — the repository is mounted
read-write and the identity crosses in the environment, and `git add`/`git commit` are in
`DEFAULT_ALLOWED_TOOLS`. Nothing is wrong until `git push`, which is the last command of a
session rather than the first. So:

- **`up` says it, once per start, when the mode resolves to `none`** — that this sandbox carries no
  token, that `git commit` will work anyway, and the exact key to write in `config.yaml`, quoted
  with the **workspace directory** name because that is the name somebody can see without opening a
  file (§4.3).
- **Both causes are named in the same breath.** There are two independent reasons `git push` fails
  and a message naming one of them sends the reader to fix the wrong thing: the token may be off,
  and the session may not be allowed to run `git push` or `gh`. Anything written about this symptom
  says both.
- **`sandboxr config` and the dashboard answer it on demand** — the resolved mode, and the
  `projects:` key that decided it. `ProjectDto.github` carries it to the browser as a fact; the
  page writes the sentence.

## 8. Actions

Every action the dashboard offers is a **closed table** in the server package. There is no
generic "run this command" endpoint. Each entry names the command, whether progress can be
a real fraction, and how to parse a line into progress.

Actions stream. The transport is Server-Sent Events for one-way output (a build, a
migration) and a WebSocket for the terminal, which is bidirectional. Four event kinds:
`start` (names the action, says whether the bar can be a fraction), `log` (one line),
`step` (progress), `done` (the exit code, and optionally where to go next).

An action may declare how to read a **destination** out of its own output, the same way it
declares how to read progress — so a clone can send the browser to the project it just made.
Three rules, and all three are load-bearing:

- It is carried **only on a successful `done`**. A failure leaves the reader on the log,
  which is the one place the error exists.
- It is **read from the command's output**, never derived from the request. The names sandboxr
  gives things are computed by core (§3.1), and a second derivation elsewhere would be wrong
  for exactly the awkward inputs the hashing exists for.
- It is **validated as a path on this origin** before it reaches the browser. It is built from
  output that can contain names from a remote repository, and it ends in a navigation. A value
  that does not qualify yields no destination at all rather than a fallback, because sending
  the reader somewhere plausible is a false claim about where the thing is.

### 8.1 Destructive actions, and what a browser may not force

A destructive entry carries a `confirm` sentence, and the sentence **names what is lost**
rather than asking whether you are sure. The wording lives in the table because that is the
only place that knows; a confirmation the browser wrote would be one the browser could get
wrong about an action it does not implement.

**A refusal is not a confirmation to be repeated.** Where core refuses a destructive
operation because something would be lost — `worktree delete` on a dirty worktree — the
action reports the refusal and stops. There is no `force` argument on the closed table, and
adding one would make the confirmation the *second* dialog rather than the last word. The
override is the CLI's `--force`, run by somebody at the machine.

## 9. Conventions

- **Commits:** conventional (`feat:`, `fix:`, `docs:`, `refactor:`, `test:`, `chore:`),
  bullet points in the body. No `Co-Authored-By`.
- **Comments document the code, not the change.** Write them as if the code always looked
  this way. Rationale for a decision goes in the commit message, or in this file when it is
  a contract. Never narrate an edit or an incident in a comment.
- **Every non-obvious choice gets a short "why" comment.** The value of the implementation
  this is ported from is that it explains itself; keep that.
- **Tests:** Vitest. Every pure function gets a table-driven test. Every bug fix gets a
  regression test. Test files sit beside their source as `<name>.test.ts`.
- **Formatting:** two-space indent, double quotes, semicolons, trailing commas, 100-char
  lines.
