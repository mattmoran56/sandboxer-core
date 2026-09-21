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

**The engine's unit is the worktree, full stop.** A *session* — a workstation, a work volume,
several repositories checked out under one name a person typed — is not an engine noun. It is
**Jef's**, and it is defined in the product's contract. §12 still holds that definition while the
two contracts share one file; it is on its way out of here, and §12.10 is the map. An engine rule
is never bent to suit a session: the engine is handed a workspace and starts a container on it.

## 2. Two repositories, and the one rule between them

This tree is being split in two, and the boundary is the reason this file exists.

- **The engine, `sandboxr`.** `packages/core`, `packages/cli`, `packages/docs`, `container/`,
  `docs/`, `examples/`. It turns a git worktree into a running copy of a project on its own
  hostname. It knows about worktrees, sandboxes, images, volumes, a router and a certificate. It
  knows nothing about agents, sessions or Jef.
- **The product, `Jef`.** `packages/server`, `packages/web`, `packages/sessions`,
  `packages/orchestrator`, `packages/voice`, `packages/telegram`,
  `packages/orchestrator-daemon`, `sidecars/`, `container/jef-base/`, and the dashboard,
  orchestrator and workstation containers. It is an agent you talk to, built on the engine.

```
packages/core      @sandboxr/core     engine   Config, drivers, docker orchestration, lifecycle
packages/cli       @sandboxr/cli      engine   The `sandboxr` command
packages/docs      @sandboxr/docs     engine   The documentation site
container/         (no package)       engine   What runs INSIDE a sandbox: Dockerfiles, s6, scripts — except jef-base/
examples/          (no package)       engine   Example sandboxr.yaml files
packages/server    @jef/server        product  The dashboard's server: auth, JSON API, terminal, actions
packages/web       @jef/web           product  The dashboard's browser app: React, Tailwind, built by Vite
container/jef-base (no package)       product  The agent layer on the base image: claude, and nothing else
sidecars/          (no package)       product  The audio body: Python, by necessity — see §10
docker-compose.yml (no package)       product  The whole constellation, in one file — see §11
.env.example       (no package)       product  The settings that file reads, keys only
```

**The rule, stated once: the engine imports nothing from the product; the product imports the
engine.** Not "should not" — *cannot*, and a test says so. `@sandboxr/core` depends on `yaml` and
`zod` and on nothing else; every import specifier in its source is relative, `node:`-prefixed, or
one of those two. `packages/core/src/boundary.test.ts` walks `src/**/*.ts` and fails with the
file, the line and the specifier, and `packages/cli/src/boundary.test.ts` does the cut-down
version for the CLI. They run under the ordinary `npm test`; there is no linter in this repo and
adding one for this would be disproportionate.

The rule has a direction because dependencies do. A product may name an engine concept — a
sandbox, a slug, a volume. An engine that names a product concept has stopped being an engine,
and the symptom is always the same: a second product cannot use it without pretending to be the
first.

**Where a back-reference looks necessary, invert it.** The engine does not call out to ask what a
session is; it takes a parameter. A workspace somebody else resolved (§12.4), activity somebody
else knows about (§3.4), a file the machine says to share (§4.3), a front end somebody else runs
(§7.5) — each of those is an argument the embedder supplies, never a hook the engine reaches
through.

Ownership rule: **only `container/` contains bash.** Everything host-side is TypeScript.
The container scripts are deliberately shell because they run under s6 with no toolchain
guarantees, and because they are ported from a working implementation.

The same rule, for the newest package: **`packages/web` holds no logic about what a sandbox
is.** It renders what the API sends and posts actions back. Which actions apply to a stopped
sandbox, what makes one degraded, how a slug is derived — every one of those is decided by
core and reported by the server, and a copy of any of them in the browser is a second
implementation that drifts.

`@jef/server` depends on `@jef/web` and serves its `dist/`. A root
`npm run build` orders the two correctly because of that dependency; building the server
alone leaves it serving an HTML shell with nothing behind it.

## 3. Naming

### 3.1 Slug

A slug identifies one sandbox. **A session's runtime is a sandbox and carries a slug like any
other; where that slug comes from is §12.2, and every rule below — the ceiling, both budgets, the
hash form — binds it unchanged.** Resolved, in order of preference, from:

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

**Sessions change nothing here.** A session's runtime answers on exactly this shape, and a
workstation has no hostname at all (§12.2). Nothing in §12 may be read as licence to relax the
one-label rule or the `--` separator.

The dashboard lives on the bare domain and **never** on a per-sandbox hostname. The
terminal is a route *within* the dashboard (`/p/<project>/s/<slug>/terminal`), so it
inherits the dashboard's session automatically. Do not give the terminal its own hostname.

The paths under that one hostname are §7.1.

### 3.3 Docker names

- Container: `sandboxr-<project>-<slug>`
- Session containers and volumes: `sandboxr-ws-<session>` and `sandboxr-work-<session>` — §12.2
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

A path inside that volume may come from the host rather than from the volume, and that is not a
special case any more: it is a `share:` row in the machine's `config.yaml` (§4.3), like any other
host file the operator shares. Jef's `jef init` writes the row that puts
`~/.claude/.credentials.json` over the volume's copy, so a login is shared with every sandbox
rather than duplicated into each. On macOS that file is usually not a login at all, which has a
consequence worth knowing. See §7.2.

Images are named under one namespace, and the split between them decides what may be reclaimed:

- Project layer: `sandboxr/<project>:<12 hex>`, the hash covering the tool version, the rendered
  Dockerfile and every staged manifest. Content-addressed, so every sandbox of a project shares one
  image and a rebuild is triggered by exactly the things the build reads.
- The machine's own: `sandboxr/base`, `sandboxr/dashboard` and `sandboxr/workstation` (§12.3),
  tagged by tool version and by `latest`. **All three are built by `init`**, and all three are on
  the never-reclaimed list.
- **`sandboxr/workstation` used to be built by the first `createSession` instead**, on the argument
  that a machine which never creates a session never needs it. That argument has expired on its own
  stated condition — "revisit when a session is the ordinary way to start work" — and a session now
  *is* the thing the dashboard is organised around. The cost of leaving it where it was is paid in
  the one place it must not be: the first **New session** on a machine took the several minutes of a
  `claude` install, in a request that answers one JSON body and has nowhere to stream a build log to
  (§12.6.2). A build belongs in the verb that sets a machine up, beside the other two, where it is
  expected to take a while and says so. `createSession` still calls `ensureWorkstationImage` and
  must keep doing so: `init` having built it is what makes a create fast, never what makes it
  correct, and the tag carries the tool version — so an upgrade invalidates it, and `init` is the
  verb somebody runs after one.
- `container/workstation/` is excluded from the base image's digest for the same reason the other
  two excluded directories are: it shares not one layer with the base, so including it would
  rebuild the base for a change that cannot affect it.

**Reclamation is a contract, not a heuristic.** `gc` removes sandboxes, the volumes they owned, and
the project images a newer build replaced. `prune` removes the same volumes and images with sizes
against them, and Docker's build cache when it is asked. Both are bound by five rules:

- The shared volumes above are never removed, by either. Taking `sandboxr-claude` would sign the
  machine out of every MCP server it has been given.
- **The engine reclaims only a volume name it can reconstruct, and never one under a reserved
  prefix.** Everything else in the collector reads "no container references it" as "nothing wants
  it". For a name the engine did not mint, that reading is exactly backwards — nothing on the
  machine can say what is in it, so an unrecognised name must read as "something holds it". This
  is §3.4's failure-is-an-absence rule applied where it costs the most.

  **`sandboxr-work-` is the reserved prefix, and it belongs to the embedder.** Jef's work volumes
  live under it (§12.5): a session whose workstation is stopped has no container at all, which is
  the ordinary state of a session somebody comes back to next week, and what would go is every
  clone and every uncommitted change in it. The engine promises never to reclaim one, without
  knowing what a session is. `isWorkVolume` in `packages/core/src/naming.ts` is the test, beside
  `WORK_VOLUME_PREFIX` which is the name it reserves.
- `sandboxr/base` and `sandboxr/dashboard` are never removed as superseded: they are tagged by
  version rather than by content, so "older tag" does not mean "replaced".
- Of each project's images, the newest survives. A content-addressed tag means the next `up` finds
  it and starts rather than rebuilding, and that is the reason the image is kept at all.
- An image any container references — running or stopped — is never removed, and neither is one
  docker would not give a creation time or a container count for. Every absent answer is read as
  "something holds it". Dangling and untagged images are out of scope entirely: they are `docker
  image prune`'s, not addressable by a name sandboxr gave them, and indistinguishable here from the
  layers a build running right now is producing.

**Superseded images belong to the routine command.** They were `prune`'s alone, and the accounting
does not work: a project image is roughly six gigabytes, a base rebuild or a tool version bump
strands the previous one, and a command that has to be asked twice reclaims nothing on a machine
nobody asks. A superseded tag is unreachable by construction — it is a content hash of a build no
future `up` will request — so removing one weighs no rebuild against it, which is what separates it
from every other image on the machine.

`prune` still reports by default and acts only when told to, which is the reverse of `gc` and
`expire`. What that asymmetry now guards is the build cache and the habit of reading a whole-machine
reclaim before running it, rather than the project images the two commands agree about.

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
`list`, and every sandbox decision `gc` makes, are pure functions of `docker ps`, so nothing can
drift out of sync. `gc` reads `docker system df` as well, but only to decide about images — nothing
about a sandbox is read from it.

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

Two more are **opaque group labels**, and that is the whole of what the engine knows about them:

| Label | Meaning to the engine |
|---|---|
| `sandboxr.kind` | what sort of container this is. The engine stamps `runtime` on everything it starts, and **absent reads as `runtime`** — every sandbox created before the label existed has none, and reading one of those as anything else would put a container that mounts a host worktree into somebody's list of something it is not |
| `sandboxr.session` | a group id an embedder supplied. The engine stamps it when a caller hands one over, filters on it in `list`, and never looks inside it |

**The engine does not know what a session is, and these labels do not teach it.** They are how an
embedder — Jef, or anything else built on this — puts several containers under one name and gets
them back with one `docker ps`, without a manifest file the engine would have to keep. `gc` needs
`sandboxr.session` for one thing only: a container carrying it is somebody's, so it is not a
stray. Jef gives both labels a meaning in §12.3, and that meaning is Jef's.

`sandboxr.session` is deliberately **absent** rather than empty on a container belonging to no
group. An empty string is a value something will one day compare against.

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
folds them together. Two are derived at read time — §4.2's rule applied to a timer. The third is
the engine admitting it cannot see everything and taking an argument. The fourth is the one place
the derive-at-read-time rule cannot hold, for the reason given underneath:

| Signal | Where it is read from | What it covers |
|---|---|---|
| A request to one of the sandbox's own hostnames | the shared router's access log (`accessLog: {}`, one common-log line per request, ending in the router name — which for a sandbox *is* its container name) | somebody using the apps |
| A **front end's** request path that names the sandbox — `…/p/<project>/[sw]/<slug>/…` (§7.1) | the **same** access log, under each front end's own router name, from the request path | opening a worktree, its logs, opening its terminal socket, opening its agent socket |
| Activity **somebody else knows about**, keyed `<project>/<slug>` | handed in by the caller — the engine reads nothing of its own for this | an agent working while nobody is watching (§7.2), or anything else an embedder can see and the engine cannot |
| A terminal or agent socket **held open** on the sandbox | the mtime of `state/attach/<project>/<slug>`, re-stamped by whatever holds the socket or the run (§4.2.2) | a session somebody is sitting in, or an agent running in one, for longer than the ttl |

**A front end is a container the embedder put on the bare domain, and the engine is told which
they are.** It carries `sandboxr.frontend` (§7.5) and answers on the domain itself rather than on
a sandbox hostname, so its lines in the access log are *about* sandboxes rather than *to* one:
the router name is the front end's, and the sandbox is named in the request path. The engine has
one route shape of its own here — `…/p/<project>/[sw]/<slug>/…`, which is §7.1's address of a
sandbox, the engine's noun. Any other shape a front end serves is the front end's business, and
`parseAccessLog` hands back every readable front-end request so a caller can apply its own.
Nothing about this asks the engine what a dashboard is.

**The second row is a parameter, not a hook.** The engine cannot see an agent run: it does not
know what an agent is, and the index and transcripts that record one belong to the embedder. So
the embedder passes the map in, keyed `<project>/<slug>`, and it is folded in the same loop as
the router and attach maps. The rules underneath are the embedder's to keep, and they are stated
here because getting them wrong loses work:

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

**A live run re-stamps the same marker, and that is what keeps the engine's own reaper honest.**
The third row is a parameter, so an embedder that forgets to pass it leaves `sandboxr expire`
with no sight of a running agent at all — and the sandbox it would then stop is one with work in
it nobody can get back. The marker closes that hole without teaching the engine anything: whoever
holds a run re-stamps `state/attach/<project>/<slug>` on the same heartbeat and the same grace
window as a held socket, so a live agent is activity in the engine's own signal whether or not
anyone hands the engine a map. **Do not remove the run's heartbeat on the argument that the extra
signal covers it.** The extra signal is the embedder's to pass and the marker is the engine's to
read, and only one of those is still there when the embedder is a cron job somebody wrote.

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
  run/                   the sidecars' unix sockets — see §10.3.1 and §11
  config.yaml            the machine's own settings — see §4.3
  host.env               what only the host can look up, for compose — mode 0600, see §11
  soul.md                the orchestrator agent's character, as prose — see §10.7
  state/keep/<project>/<slug>  keeps one sandbox alive past its idle limit — see §4.2
  state/name/<project>/<slug>  what to call one worktree on screen — see §4.2.1
  state/slug/<project>/<worktree dir>  the slug a worktree was given on a collision — see §4.2.3
  state/attach/<project>/<slug>  a socket is being held open on this sandbox — see §4.2.2
  state/session/<session>/       one session's keep, name and attach files — see §12.6
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

**`repo.git` survives the move to sessions and `wt/` does not** — §12.9 argues both, and the
rules in this section still govern the clone. A session's code lives in a Docker volume (§12.5)
and no host path is bind-mounted into a container any more, so the bare clone is kept as the
machine's local source of objects and refs rather than as the place work happens.

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
unit the dashboard's `/worktrees` pane and every project's own pane are built from — a worktree
is the thing that persists, and a sandbox is something that comes and goes on top of it. It was
the unit the sidebar was built from until the column became the list of sessions (§12).

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

#### 4.1.3 Bringing a worktree up to the remote

A managed worktree is a place a sandbox **runs**, not a place anybody edits: the commits arrive
from a different machine and land on the remote. Two operations bring one up to date, and both
live in `packages/core/src/pull.ts`.

**The remote is talked to in exactly one way: `fetchProject` on the project's mirror.** It
updates `refs/remotes/origin/*` in `repo.git`, which every linked worktree shares, so one fetch
serves all of them. A `git fetch` run inside a worktree would be a second refspec and a second
answer, which is the failure the bare-clone refspec in §4.1 exists to prevent.

**`pullWorktree` fast-forwards a worktree that exists.** It never merges, never rebases and
never discards, because the whole value of the operation is that its failure is visible.

- It works on a **detached** worktree, which is the ordinary state of one whose branch is open
  elsewhere: the branch name comes from `branchOf`, and the target is
  `refs/remotes/origin/<branch>`. A detached fast-forward moves `HEAD` and deliberately leaves
  `refs/heads/<branch>` where it was.
- The preflight reports **every** reason it would fail, never the first: local commits the
  remote does not have, uncommitted changes to files the incoming commits also change, and
  untracked files the incoming commits would overwrite. The dirty check is `dirtyFiles` with
  `DEFAULT_DIRTY_IGNORE`, so a file a sandbox's own build wrote does not block a pull.
- **A divergence is measured by patch, not by sha.** `git cherry -v` against
  `refs/remotes/origin/<branch>` decides it: a commit marked `+` has no equivalent upstream and
  is the only kind that could be lost, and one marked `-` is already there under another sha.
  The refusal counts and names the `+` commits alone. Counting `origin/<branch>..HEAD` instead
  reports the whole pre-rebase history — a branch rebuilt once said `107 local commits` where
  ten were absent, and named five that were already on the remote.
- **A rewritten upstream is moved onto rather than refused.** When no commit is absent from
  origin there is nothing to lose, so the worktree goes to origin's tip even though that is not
  a fast-forward: `git checkout --detach` on a detached worktree, `git checkout -B <branch>` on
  an attached one. The outcome is `replaced`, distinct from `fast-forwarded`. This is the one
  case that moves without a fast-forward, and it is the ordinary shape of a managed worktree
  whose branch somebody rebased — refusing it left no way forward short of a terminal.
- **Never `reset --hard`, in any case.** `checkout` carries an uncommitted change that does not
  collide and refuses outright when one would be overwritten; a reset would not. If `git cherry`
  cannot answer, the sha comparison stands and the pull refuses: an unreadable classification
  refuses, it never assumes.
- A refusal names the branch and the actual files, and **nothing on disk is touched**. `git
  merge --ff-only` and `git checkout` are the only commands that write.

**`freshenBranch` does the same job for a worktree that does not exist yet**, and
`addWorktree` calls it before it resolves any ref. Every creation path in §4.1 starts from a
ref, and a ref is only as fresh as the last fetch, so a worktree cut for a branch — or for a
pull request's head branch, which arrives as an ordinary branch name — used to land on whatever
the mirror happened to hold. After the fetch:

| What is true of the branch | What happens |
|---|---|
| A base was given | The base decides, and the fetch has made it current |
| Only on origin | The worktree is cut from `origin/<branch>` |
| Local, behind origin, checked out nowhere | `refs/heads/<branch>` is fast-forwarded onto origin's tip, compare-and-swap on the sha it had |
| Local, behind origin, **checked out elsewhere** | Nothing is moved; the worktree is detached at `origin/<branch>` |
| Local, with commits origin does not have | Nothing is moved, and the worktree is cut where the branch stands |

**A branch another worktree has checked out is never moved.** `update-ref` will move it and git
does not stop it the way `git branch -f` does, and the other worktree then shows every incoming
change as an uncommitted *reversal* — indistinguishable, on screen, from an editor having eaten
somebody's work.

**A diverged branch is reported, not refused.** The worktree is still created: refusing would be
worse than the staleness, and silently checking out old code is the thing being fixed. So the
lines say which commit it landed on, that it is not the remote's tip, and how far apart the two
are. A fetch that fails costs freshness and a sentence, never the worktree.

**One wording, in core.** `pullReport` turns a result into the lines a person reads, and its
first line is a self-contained headline. The CLI prints them and the dashboard streams them, so
the two cannot describe one refusal two ways.

**Freshening runs before the checkout, claiming a slug (§3.1) runs after it, and the order is
fixed.** Freshening decides which *commit* the worktree lands on, so it has to happen while
there is still a ref to move and no working tree hanging off it. Claiming decides what the
worktree is *called*, which needs the directory to exist and the sibling listing to compare
against. They share nothing: one writes refs in the mirror, the other writes a file under
`SANDBOXR_HOME`, and no slug is ever read out of a ref.

A worktree that already exists is handed back before any of this — starting a sandbox never
pulls a checkout somebody may be working in. That is what the button in §8 is for.

**Resolving which worktree a pull acts on goes through `slugFor` (§3.1), never `deriveSlug`.**
The dashboard posts back the slug on the row somebody clicked, and a worktree that collided
with a sibling was *given* one carrying a random token — which cannot be re-derived. A deriving
match answers a different worktree, or none, for exactly the rows that were renamed, and the
failure is a fast-forward applied to somebody else's checkout. The CLI does not resolve a slug
at all here: `worktree pull` addresses the worktree by path.

### 4.2 Keep-alive, and where mutable state is allowed to live

**A session keeps the same three files with the same arguments, under `state/session/<session>/`
(§12.6).** The test below is what decides where any of them may live, and it is the test §12.6
applies rather than a second one.

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
worktree page's title and breadcrumb, its row on the `/worktrees` pane, its row on a project's pane, the home view's
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
share:
  - host: ~/.claude/.credentials.json
    into: /root/.claude/.credentials.json
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

#### `share:` — one host file, in every sandbox

`share:` is a list of `{ host, into }` rows. Each names a file on the machine and where it is
bind-mounted inside **every** sandbox this machine starts. `~` expands. It is how a login the
operator already has — a Claude credential, an `.npmrc`, an ssh key — reaches the containers
without being copied into an image or typed into a project's secrets.

It lives here for §4.3's own reason, which is the same one `github:` has. These are the
*operator's* credentials, and a setting that lives in a repository is a setting a repository can
ask for. The machine decides what it shares. A project never votes on it.

Two rules, and both are the engine failing closed:

- **A source that does not exist is skipped, and so is a zero-byte one.** Docker answers a
  missing bind source by creating a **directory** at that path on the host — so an unguarded row
  would quietly scatter empty directories where the operator's files are meant to be, and mount
  each one over the container's copy. The zero-byte case is the same failure one step later: on
  macOS `~/.claude/.credentials.json` is usually an empty placeholder, because the real login is
  in the keychain, and mounting that over a container's working credential store replaced a valid
  login with nothing. Claude Code then reported `Not logged in`, which resembles its cause not at
  all.
- **A machine with no `share:` row shares nothing**, and that is a real upgrade note rather than a
  footnote: before this key existed the Claude credential was mounted unconditionally, so a
  machine upgraded without a row written for it loses that login in every sandbox at once. Jef's
  `jef init` writes and repairs the row.

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

The dashboard is a **single-page app**. `@jef/server` answers JSON and serves one HTML
shell; `@jef/web` is the app that shell loads, and it routes in the browser from there.

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

**The `/api/sessions/…` routes are the one family that names no project, and that is the contract
rather than an omission** (§12.6.1): a session belongs to no project, so there is nothing to scope
it to. Everything that reaches *into* a repository of a session — its files, its diff, a runtime of
it — is still checked against that repository's project, which is why those routes spell the
repository as `:project` and go through this same sweep.

**Five of them are the other exception to "every route requires a session"**, and it is a narrowing
rather than a loosening. `GET /api/sessions/:session`, `…/repos`, `POST …/runtimes`,
`POST …/r/:runtime/stop` and `DELETE …/r/:runtime` additionally accept a **workstation token**: the
credential an agent inside that session's own container holds instead of a Docker socket
(§12.6.1.1). The token names one session and the router refuses it on any other path, so the list
above is the entire surface an agent can reach — and it is pinned by a test, because a route added
to it is a capability handed to the least supervised process on the machine.

| Route | Answers |
|---|---|
| `GET /api/bootstrap` | The domain, the session, the closed action table (§8), and the default lifetime the new-sandbox form offers. What the app needs before it can draw anything |
| `GET /api/workspace` | Every project, every worktree and every sandbox on the machine, plus a summary. The one call the home view, the `/worktrees` pane and every project's pane are drawn from — the sidebar is `GET /api/sessions` (§12.6.2). Each worktree carries the state of its pull request, from a cached per-repository index rather than a `gh` call per row (§4.1.2), and the agent session live on it, from the server's own registry (§7.2) |
| `GET /api/projects/:project` | One project's worktrees, branches and open pull requests. The list is read live, so it is the authoritative one; the state on each worktree beside it comes from the index and may be up to five minutes behind |
| `GET /api/p/:project/s/:slug` | One sandbox in full, with the apps and services its project's config declares |
| `GET /api/repos` | The repositories this machine's `gh` can offer, each marked with whether it is already in the workspace |
| `GET /api/p/:project/s/:slug/agent/runs` | The agent sessions recorded against one sandbox, newest first. The index only — never message content (§7.2) |
| `GET /api/agent/models` | The models a session may run on **and the permission modes it may run in**, with the ones this machine defaults to. Two closed tables, one read, because the browser draws two controls that sit side by side (§7.2, §7.2.2) |
| `GET /api/p/:project/agent/grants` | The standing permissions this project has been granted — the rule as Claude Code will match it, and where it was granted from (§7.2.2) |
| `DELETE /api/p/:project/agent/grants/:id` | Withdraws one. The only `DELETE` in the API; `SameSite=Lax` on the session cookie is what protects it, as it protects every `POST` beside it. Takes effect on the next session (§7.2.2) |
| `GET /api/p/:project/s/:slug/agent/commands` | The slash commands a session on that sandbox can be offered, each marked sendable or not, each refused one carrying the sentence it is refused with, and the one sandboxr answers itself marked `handledBy` (§7.2) |
| `GET /api/p/:project/s/:slug/files` | One level of the tree inside the sandbox, or one file's text, at `?path=` — a path relative to the container's `/workspace`. Read-only. The answer's `kind` says which of a directory, a file, a symlink or something else was found, because the caller cannot know before it asks (§7.4) |
| `GET /api/p/:project/s/:slug/diff` | Everything on the branch that is not on its upstream yet — committed, staged, unstaged and untracked — as a list of files with their counts. Never the patches (§7.4) |
| `GET /api/p/:project/s/:slug/diff/file` | One changed file's patch, at `?path=`. Its own request, made when a row is opened (§7.4) |
| `PUT /api/p/:project/w/:slug/name` | Sets what one **worktree** is called, from a body of `{ "name": string }`; an empty name clears it. Answers `{ project, slug, displayName }`. On the `w` form and never the `s` form: the name belongs to the worktree, which persists (§4.2.1). A name that is not one is a `400` that does not repeat what was sent |
| `POST /api/p/:project/w/:slug/session` | Makes a session holding this **worktree's** code — its commits, and its uncommitted work carried across on top (§12.10.1). Takes no body: the branch, the commit and the name are read from the worktree. On the `w` form for the rename's reason, so it works with nothing running. **Takes the machine-wide bar of §12.6.1**, because it creates a session, and inherits the project sweep from `:project` besides. Answers `201` with `{ session, repo, carried }` |
| `GET`, `POST /api/sessions` | Every session on the machine, and making one (§12.6.2) |
| `GET`, `PATCH`, `DELETE /api/sessions/:session` | One session, naming it, and deleting it. The `PATCH` body is `{ "name": string }` and nothing else; an empty or whitespace name **clears** it, and the answer is the whole `SessionDto`. `PATCH` and not a `/name` sub-resource, which is where a *worktree's* rename lives: a worktree's name is filed against a directory that outlives every sandbox cut on it, and a session **is** the thing being named. A name reaches no container, no volume and no URL (§12.2). The delete takes no `force` (§8.1) |
| `POST /api/sessions/:session/start`, `…/stop` | Its workstation. Stopping removes nothing (§12.8) |
| `GET /api/sessions/:session/repos` | What is in its work volume. A read that failed says so rather than answering "none" (§12.5) |
| `POST /api/sessions/:session/repos` | Clones one repository and branch into it — the only way code reaches a work volume. Checked against **that project's** grant, not the machine's (§12.5, §12.6.1) |
| `GET /api/sessions/:session/r/:runtime` | The session's view of one runtime, which is the sandbox answer above reached by the other road (§12.4) |
| `POST /api/sessions/:session/runtimes` | Runs one of that session's checkouts, and answers the URLs. Only a checkout already on the session's own work volume (§12.6.1.1) |
| `POST /api/sessions/:session/r/:runtime/stop`, `DELETE …/r/:runtime` | Stops one, and removes one. The delete takes no `force` (§8.1) |
| `GET /api/sessions/:session/repos/:project/:dir/files`, `…/diff`, `…/diff/file` | The same two read-only views as the three `s` routes above, against the workstation rooted at `/work/<repo>/<dir>` (§7.4, §12.5) |

`GET /api/workspace` is polled every **thirty seconds**, and three rules about that polling are
part of the contract because each was learnt from the version this replaced: nothing is fetched
while the tab is hidden or while an action is running, a failed poll leaves the last good answer
on screen and says it is stale rather than blanking the page, and returning to the tab refreshes
at once.

**The HTML shell** is served at `/`, `/worktrees`, `/sessions`, `/sessions/:session`, `/new`,
`/settings`, `/repos`, `/p/:project`, `/p/:project/branches`, `/p/:project/w/:slug` and
`/p/:project/s/:slug`. Every one of them returns the same document; the app decides what to
draw. `/assets/*` serves the built bundle.

`/worktrees` is the whole list of worktrees as a pane, at every width. It used to be the
sidebar's list given a screen, and it is the only one of the two now: the column lists sessions
(§12). So it is a route with a URL, reachable by bookmark, named in the manifest's shortcuts,
given a tab of its own in the bottom bar and linked from the foot of the session column, rather
than a panel the shell opens over itself. Being a route is what makes it a history entry, which
is what the back gesture has to have.

**`/new` is no longer one of these**, and the app answers it with the not-found pane (§12). The
shell is still served at that path, so a stale bookmark gets a 200 and a page saying nothing
lives there rather than the server's 404 — which is the right way round while the route is only
recently gone.

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

**Under §12 this moves to the workstation and is keyed on the session**, and the three nouns
below are unaffected by that. The phrase "agent session" is retired with the move, because
"session" is now §12's noun: what this section describes is a **Run**.

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

**A worktree carries the session live on it, so a list of worktrees can be sorted by who is
waiting on a person.** `agent` on `WorktreeDto` is `{ state, asks }` or `null`:

| Field | Meaning |
|---|---|
| `state` | The run's state — `running`, `idle`, `needs-input`, `done`, `failed` |
| `asks` | How many permission questions the session is stopped on (§7.2.2). A count, not the questions |

Three properties fix what it may and may not say:

- **It is the live registry, never the run index.** A row's question is "is something happening
  on this branch now", and a run that ended on Tuesday is not an answer to it. The registry is
  in the server's memory, so a dashboard restart empties it and `null` is then the truth: the
  process really is gone (§7.2's note on what does not survive a restart).
- **It is keyed on the worktree's own `<project>/<slug>`** — the pair every agent route takes,
  which is the workspace directory and not the `project:` out of a sandboxr.yaml. Keying it on
  the sandbox would answer `null` for every project that renamed itself.
- **`/btw` forks are not counted.** A side question is a second `claude` in the same container
  with no tools at all (§7.2.1), so it is neither working on the worktree nor able to be waiting
  on a person about it. The registry leaves them out by testing whether an entry *is* a fork,
  not by its key: `activity()` re-keys every live session from its own project and slug, which a
  fork shares with its parent.

**`SandboxDto` carries the same field, keyed on the sandbox's own `<project>/<slug>`.** It is
there for the one row that has no worktree behind it: a sandbox git no longer lists a worktree
for still gets a row, synthesised from the sandbox so the container stays reachable, and without
this it was the one row on which a live session went unreported. The sandbox's key is the
`project:` out of its sandboxr.yaml rather than the workspace directory, so where a project's two
names differ this answers `null` — which is already "no session", so a missed join costs a word
on a row and can never mislabel one.

Facts, like every other field: the browser turns `running` into "agent working" and a turn
stopped on a question into "waiting on you", and it is the browser that groups a list by them.

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

**When the machine's `config.yaml` shares `~/.claude/.credentials.json`, that one file is
bind-mounted read-write into every sandbox** at `/root/.claude/.credentials.json`, over the volume.
It is a `share:` row (§4.3), which is the engine's general form of "bind this host file into every
sandbox"; the engine mounts it without knowing what it is. Finding the file is
`hostClaudeCredentials` (`packages/core/src/agent/credentials.ts`), which honours the host's own
`CLAUDE_CONFIG_DIR` and never assumes `$HOME` is `/root`, and `jef init` writes and repairs the row
from it. **A machine with no such row shares no login** — see §4.3's upgrade note.

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
- **On macOS the file is not the login, and may still exist.** The account credential is in the
  login keychain (service `Claude Code-credentials`, account the username). The file at
  `~/.claude/.credentials.json` is nonetheless commonly present there, because it is also where
  Claude Code keeps the OAuth tokens for MCP servers signed into on the host. Existence and size
  cannot tell those apart, and the contract is that sandboxr never reads the file to find out.

**The macOS false positive is part of the contract, because it is the cost of not reading the
file.** An MCP-only `~/.claude/.credentials.json` is mounted, `hasLogin`'s `test -s` answers yes,
`agentEnv` therefore withholds `CLAUDE_CODE_OAUTH_TOKEN`, and the session runs with no credential
at all. Claude Code reports `Not logged in · Please run /login`, which names neither the mount nor
the withheld token, and adding a setup-token cannot fix it because the false positive is what
suppresses the token. Observed on a real container with such a file mounted. The two resolutions
are both a person's: put a real login in the file — exported from the keychain and **merged**, an
overwrite destroying the MCP tokens — or take the file out of the mount's way and let the token be
used. The guide carries both.

An exported keychain credential is a **copy of a rotating credential**: rotation writes to the
keychain and not to the file, so it goes stale and the symptom is `Not logged in` again.
`claude setup-token` is the credential built for this; the export is a development-time
compromise, and the two blob formats being identical is an observation rather than anything
either side documents.

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

**This whole section is about a worktree.** A session's runtime runs a self-contained clone on a work
volume and asks for none of these mounts — see §12.4, which is where the reasoning for that lives.
The two consequences below are consequences of the mounts, so they go with them.

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

### 7.4 Reading the code in a container

Two read-only views hang off the sandbox routes: a file explorer, and the branch's own diff.
Both are strictly read-only, and that is a property of the endpoints rather than of the
buttons in front of them: the only commands they run are `find`, `head`, `git diff`,
`git ls-files`, `git rev-parse` and `git merge-base`. Nothing writes. In particular an
untracked file's patch is taken with `git diff --no-index` and never with
`git add --intent-to-add`, which would produce a nicer patch by changing the repository.

**Everything is read from inside the container, over `docker exec`, and never from a host
path.** A sandbox's worktree happens to be a bind mount the host can also see; a workstation's
clone lives on a volume that is not a path on this machine at all. The reader
(`packages/server/src/code.ts`) takes a container name and a root *inside* it — `/workspace`
for a sandbox, §7.2 — so neither view knows which of the two it is talking to. Reaching for the
host path would work today and stop working the first time the code is on a volume.

**Every command is an argument array, and the only value ever interpolated into one is a
commit sha checked against `/^[0-9a-f]{40}$/`.** A filename is one element of an argv, so a
path holding a space, a quote, a newline or a `$(…)` is a path and never code. Paths from a
request go through `safePath` in core first, which refuses a `.` or `..` segment outright
rather than resolving one: whether `a/../../etc` lands inside the root depends on whether
`a` is a symlink, so the only rule that is true by reading it is the one that refuses. A
symlink is reported as a symlink and is never followed.

**That path rule is containment, not the security boundary.** Both routes sit behind the same
session and the same per-project grant as the terminal WebSocket, and that terminal is a root
shell in the container being read. What the rule protects is the explorer staying an explorer
of the workspace.

**The diff's base is the merge base with the branch's upstream.** Diffing against the upstream
*tip* would fold in whatever somebody else pushed and show their additions as this branch's
deletions — a view that gets less accurate the longer the branch lives. From that base a single
`git diff <commit>` covers commits, staged changes and unstaged changes, because it compares
the commit to the working tree; untracked files are a second read, and carry no line counts,
because a file git has never seen has no "before" and counting them in bulk costs one process
per file. A branch with no upstream falls back to `HEAD`, and the answer says which base it
used.

Three things are capped, and every cap is reported rather than applied silently: a directory
listing at 2,000 entries, a file read at 256 KB, a changed-file list at 2,000 files and one
patch at 256 KB. A binary file is identified from `--numstat`'s `-`/`-` counts, or from a
NUL in a file's opening bytes, and is answered as "binary" with no content at all rather than
as mojibake.

Four states are ordinary and answer a sentence rather than a `500`: a stopped sandbox
(`409`), a container that has gone (`404`), a path that is not there (`404`), and a
workspace that is not a git repository (`409`). A `path` that does not normalise is a
`400` that does **not** repeat what was sent.

### 7.5 Putting your own control plane on the bare domain

Everything above §7.3 describes *Jef's* dashboard. The engine offers none, and the mechanism that
puts one there is not Jef's — it is `access/router.ts`'s, and it needs only a name.

**`sandboxr.frontend` is the label that says "this container answers on the bare domain".** One
container, whatever it is; the engine starts none of them.

```ts
// packages/core/src/access/frontend.ts
export const FRONTEND_LABEL = "sandboxr.frontend";

export interface FrontendRoute {
  container: string;
  /** The port it listens on inside its container. */
  port: number;
  domain: string;
  tls: boolean;
}

/** Traefik labels that route the bare domain here, behind the auth handshake. */
export function frontendRouteLabels(route: FrontendRoute): Record<string, string>;

/** Every container currently claiming the bare domain. One `docker ps`. */
export function listFrontends(docker: Docker): Promise<string[]>;
```

The labels are the ones §7's handshake already describes and `routeLabels` already builds: the
bare domain's router, the forward-auth middleware, and the port the router forwards to. A front
end is what the middleware protects and what answers `GET /auth/verify`, so putting a container
here is a claim to own the machine's authentication, not a routing convenience.

**`sandboxr init` prepares the bare domain and does not fill it.** It makes the directories,
builds the base image, issues the certificate, writes the router config, starts the router and
writes `host.env` — and then says that nothing is serving `https://<domain>`, because `sandboxr`
is a command-line tool. `AccessReport.frontend` is where a front end must listen and what the
router will send it:

```ts
export interface AccessReport {
  domain: string; scheme: "http" | "https"; ports: RouterPorts;
  certificate?: Certificate; baseImage: string; notes: string[];
  /** Where a front end must listen and what the router will send it. */
  frontend: { port: number; domain: string; tls: boolean };
}
export interface InitOptions {
  /* …existing… */
  /** The port the router forwards the bare domain to. Default 8080. */
  frontendPort?: number;
  /** Extra keys for host.env, for facts only the embedder names. */
  hostEnvExtra?: Record<string, string>;
}
```

`jef init` is the product's verb: it calls `initAccess`, builds the dashboard, workstation and
orchestrator images, and starts the dashboard and the orchestrator on the port the report named.
Two commands, and the one that knows what a dashboard is belongs to the product.

**The label rename is wire-visible.** A dashboard container started before this carries the old
labels until it is recreated, and `init` recreates it — so an upgrade that runs `jef init` is
whole and one that does not leaves a container the engine's front-end listing cannot see.

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

**An action's scope is part of its identity**, and the route enforces it: a `sandbox` action
must arrive on a route naming a sandbox, and the route refuses one whose slug is not a live
container. So the scope answers "what does this act on", never "where is the button drawn".

`pull` is the case that makes the distinction load-bearing. It brings one worktree up to its
branch's head on the remote (§4.1.3), and it is **project-scoped, taking the worktree's slug as
an argument** — because a worktree exists whether or not a container does, and the sequence it
exists for is pull, then restart, which starts from a sandbox that is stopped. Sandbox-scoped, it
would be unavailable at exactly the moment it is wanted. `worktree-delete` is project-scoped for
the same reason and names a *branch* rather than a slug, because two worktrees cut before the
collision guard existed can still answer to one slug (§3.1).

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

**An action that refuses rather than destroying is not destructive, and must not ask.** `pull`
fast-forwards or it refuses, so there is nothing a confirmation could name as lost — and a
confirmation on an action that cannot lose anything is what teaches people to click through the
ones that can. Its refusal is reported the way any other is: a non-zero exit, and a
`sandboxr-failed:` line so the verdict at the top of the sheet carries the reason rather than an
exit code.

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

## 10. The orchestrator, voice, and Telegram

The orchestrator is a second reader of sessions, opposite to the dashboard: the dashboard
shows you one session, the orchestrator watches all of them and tells you only when one
needs you. It is its own process, and it never shows a conversation — it produces
**escalations**, and voice and Telegram turn those into sound.

**Packages, and the dependency direction is a DAG.** `@jef/orchestrator` is the base:
the model, the policy, the escalation types, the `Notifier`/`Forker`/`Summariser`/`Responder`
interfaces, the hook ingest server, and the store feeder — core-only, pure where it can be.
`@jef/voice` and `@jef/telegram` each depend on it and implement `Notifier`.
`@jef/orchestrator-daemon` sits on top of all three and is the only one that wires
sockets and reads the environment. Nothing depends back up the chain; voice must never import
telegram, and the base must never import either.

**Only `container/` is bash, and everything host-side is TypeScript — except the two audio
sidecars, which are Python by necessity.** On-device speech recognition, neural
text-to-speech and Telegram group-call media are Python ecosystems; the sidecars live under
`sidecars/` (not `packages/`), each a `_sidecar` package with a testable stdlib core and heavy
engines behind an optional extra. Their control planes are TypeScript. This is the one
sanctioned exception to the language rule, and it is confined to `sidecars/`.

### 10.1 What the orchestrator folds, and what it raises

Three feeds, each seeing what the others cannot: the **index** (`runs.json`, §7.2.3) for state
and titles; the **event** stream for the fine grain; and **hooks** (§10.4) for the push — a
subagent's failure stated rather than inferred, and latency the transcript cannot match. The
model is a pure reducer: `now` is an argument, so every signal — a stall, a blocked session, a
failed subagent — is testable without a container or a timer. A fork of a session (a `/btw`) is
never watched; it is only ever the mechanism by which the parent is summarised.

Signals are a closed set: `needs-input`, `error`, `failed`, `finished`, `subagent-failed`,
`stalled`, each with a fixed severity (`info` | `attention` | `urgent`). The **policy** is a
pure function from one signal to an **escalation** or to silence, split on one line: a
**question** is raised only where a person can still change the outcome (needs-input, error,
stalled); everything else is an **update**. A severity floor is the one knob.

The orchestrator never blocks ingestion on a person: delivery is dispatched, coalesced by
`(signal, session)`, and held to one open question per session at a time.

### 10.2 Summaries reuse `/btw`

A session summary is a side question. The orchestrator depends only on a one-method `Forker`;
the daemon's `DockerForker` builds the exact fork command core already defines (`agentArgv`
with `--resume … --fork-session --tools "" --strict-mcp-config`, §7.2.1), opens it with
`sideQuestionPreamble`, runs it over `docker exec` with stdin closed so the one-shot fork ends
after one answer, and reads the answer through core's own `normalise`. No second way to talk to
a session, and no reimplementation of the fork.

### 10.3 The voice protocol, and the heard/unheard boundary

Voice is split brain (TypeScript) and body (Python sidecar) across one newline-delimited-JSON
socket. The body owns the microphone, the speech-to-text, the voice, and — the part that must
be on-device and low-latency — the decision of when a person has started and stopped speaking.
The `protocol` module is the single source of the wire shape; the Python side mirrors it.

The whole protocol is shaped around **barge-in**. Two facts must survive a person talking over
an announcement: how much of it they heard, and what they said. The first is knowable only in
the body, where the audio clock is, so `speaking-interrupted` carries `spokenChars` — the
boundary between heard and unheard, an estimate mapped from the audio clock and retreated to a
whole word so a person is credited with slightly less, never more. An interruption is **two
messages** (the cut, then the transcribed words that caused it) that the brain reassembles into
one outcome.

The brain keeps two records from that boundary. The **`AnnouncementLedger`** tracks, per
announcement, how much was heard. The **`SessionHistory`** is the account of what the person
actually knows, and an interruption **rewrites** it: the cut announcement is trimmed to the
heard prefix, the unheard tail kept as a retraction, and the reply recorded — so the history
matches what is in the person's head, not what was sent to the speaker. This is the one place
"what was said" and "what was heard" are deliberately different, and every downstream decision
uses the second.

### 10.3.1 One voice, three bodies

There is **one voice**, and it has three bodies. Each body is a `Backend` the same `Engine`
drives, and each differs only in where the audio comes from and goes to:

| Body | Where the audio is | File |
|---|---|---|
| `StreamedAudioBackend` | the browser is the microphone and the speaker | `sidecars/voice/voice_sidecar/stream.py` |
| `AudioBackend` | a real microphone and speaker, at the desk | `sidecars/voice/voice_sidecar/audio.py` |
| `CallAudioBackend` | a Telegram group voice call | `sidecars/telegram/telegram_sidecar/call_audio.py` |

They share the **brain** (`packages/orchestrator`, `packages/voice`) and the **engines**
(`engines/piper_tts.py`, `engines/whisper_stt.py`, `endpointer.py`, `engine.py`). The
boundary between the two is a rule, not a habit:

- **What is said, how fast it is said, what was heard, when a turn ends, and what counts as
  speech at all — shared.** It belongs in an engine or in the brain, and there is exactly one
  copy of it.
- **How bytes reach a speaker and leave a microphone — the backend's own.** Opening a
  `sounddevice` stream, draining `audio-out` frames to a socket, pushing PCM at pytgcalls,
  and deriving "playback finished" from whichever signal that device actually has.

**A fix made in one backend is a bug in the other two until it moves.** That is the whole of
it, and every example below was found the hard way rather than reasoned about in advance:

- **The speaking pace lives on `PiperTts`**, not on a backend. A pace held per backend is a
  pace somebody implements for the dashboard and forgets to implement for a phone call. What
  sharing buys is **one implementation**, not one value: the voice sidecar and the telegram
  sidecar are separate processes with a synthesiser each, so a `configure` reaches the socket it
  was sent on and no other (§10.3.2). Three docstrings used to say the value travelled; they were
  wrong, and they say so now.
- **Piper's output is resampled from its native rate (22050 Hz for most voices) to the 16 kHz
  everything else assumes**, in `PiperTts` rather than at each device. Handing 22050 Hz to a
  16 kHz player does not fail; it plays 1.38× too slow and too low, which reads as a deeper,
  slower voice rather than as a bug, and it defeats the pace control on top.
- **Whisper's confidence thresholds and its hallucination denylist are in `WhisperStt`.** A
  breath transcribed as "Thank you." is a message the orchestrator acts on, and it is exactly
  as wrong on a call as in a browser.
- **What counts as speech is `SileroVad`'s — and so is the buffering that makes it possible.**
  Silero decides on a fixed 512-sample window and carries LSTM state between windows; none of
  the three bodies produces 512-sample frames, and the browser's are not even a constant
  (2048 frames of 48 kHz resampled is about 683). So the re-chunking and the state live in the
  engine, behind one `is_speech(frame_pcm)` that takes whatever a body has. A body that chunked
  for itself would be three buffers, three LSTM states and three chances to zero one — and both
  mistakes return plausible probabilities rather than an error, so nothing would ever say so.
  The model is faster-whisper's own `silero_vad_v6.onnx`; the `silero-vad` package is not
  installed and is not needed (§10.6).
- **The end-of-turn silence window is `EndpointerConfig`'s**, and nothing else may hold a
  number for it. Raised from 700 ms to 1200 ms because 700 ended a turn on an ordinary pause
  for thought; the raise reached the voice sidecar and left the Telegram sidecar's own copy at
  700, so calls went on cutting people off after the desk had stopped. Both entry points now
  read the default from `EndpointerConfig`, and a test asserts it.
- **A turn ends four ways, and all four are the engine's.** A run of silence is one
  (`EndpointerConfig`); the recognised words ceasing to change is the other, and it exists
  because in a car or on a train there is no silence to wait for — the VAD calls the noise
  speech and the turn never ends. The second reads the partial transcripts, which are already
  filtered hard enough that noise transcribes to nothing, and it is driven by the frame clock
  rather than by partial completions: partials are throttled and skipped while one is running,
  so a timer measured from them stalls exactly when the CPU is busiest, which is while somebody
  is talking. It also requires `SETTLED_PARTIALS` passes to read the same, because a pass can
  now be slower than the window it is judged against and one identical pass is evidence of
  nothing. `finish` is a third, on demand — it *keeps* what was said, where `stop-listening`
  discards it, and both say so in their docstrings because the names do not. The fourth is the
  turn having gone on too long (`MAX_TURN_MS`, 30 s — Whisper's own window): the first two can
  be defeated at once, by a room the VAD calls speech holding one open while somebody dictating
  without a pause holds the other open, and the buffer then grows for the rest of the session
  while every partial re-transcribes all of it. **At the cap nothing said is discarded.** A turn
  with words ends exactly as `finish` ends one, so a long dictation arrives as several messages
  rather than as the first thirty seconds and silence; a turn with nothing recognised drops its
  audio and keeps listening, because ending it would put an empty message in front of the brain
  and close the ear on somebody who has not started answering yet.

- **A partial transcription never runs on the engine thread, and never more than one at a
  time** (`partials.py`). A partial is a whole Whisper pass — there is no streaming partial from
  Whisper — and it costs about **0.2 s of CPU per second of audio**, measured on the container.
  Against a partial every 700 ms, a buffer past about **3.5 s** therefore costs more than the gap
  between them, so running it on the engine thread put every later frame behind it: turns stopped
  ending, the buffer grew, the next pass cost more, and live dictation degraded through a session
  and then stopped. One worker runs the pass and **posts the result back to the engine's own
  thread**, because the state machine has exactly one writer by design; a partial asked for while
  one is running is **dropped, not queued**, since a queued one describes audio that has already
  been superseded. Two more are never asked for at all, and both are about the *final* transcript
  rather than the partial: one on a silent frame, and one that the measured cost of the last pass
  says would still be running when the turn is capped. The final runs on the engine thread and
  waits behind whatever is in the transcriber, so either would double the time the answer takes to
  arrive in order to refresh a display with words that are about to be sent as a message anyway. A result that lands after its turn ended is dropped too, or it would show the
  last utterance's words under the next one. `WhisperStt` serialises passes for the same reason —
  the final transcript runs on the engine thread and would otherwise be inside the model at the
  same time as a partial.

- **A frame is timed from when it arrived, not from when it was handled.** The endpointer measures
  runs of speech and silence against the stamp the backend gives each frame, so a body that stamps
  frames where they are *processed* tells it that a queue's worth of audio arrived at once: a real
  1.2-second pause measures as nothing and the turn does not end, while the first frame after a
  slow pass appears to jump seconds into the future. `AudioBackend` and `CallAudioBackend` stamp on
  a device or adapter thread and are honest by construction; `StreamedAudioBackend` is handled on
  the engine thread, so the server stamps each `audio-in` as it comes off the socket and hands the
  stamp down. A backlog may then delay a decision, but it cannot corrupt one.
- **What was *heard* is never what was *sent*, wherever there is a consumer in between.** Both
  the browser and a Telegram call buffer ahead of the speakers, so the position in the outgoing
  buffer runs ahead of the ear — and that number is not only a progress indicator, it is the
  heard/unheard boundary the session history is rewritten against at a barge-in. Each backend
  therefore corrects it and errs low: the browser reports its own playback clock, the call
  bounds it by the wall clock (a call plays at exactly 1×, so nobody can have heard more than
  the seconds elapsed), and `AudioBackend` alone needs no correction because PortAudio pulls
  each block just before it is due. That last one is recorded in its docstring so it is not
  re-audited into a bug.
- **Stopping playback has to abort the device, not drain it.** Emptying a buffer stops the
  *next* sample being found; it does not recall what the consumer already holds. In the browser
  that was up to a second of scheduled speech carrying on over somebody who had already
  interrupted; at the desk it is PortAudio's output latency, and `stop()` there makes it worse
  because `stop()` drains — `abort()` is the one that discards. On a call the residue inside
  the encoder and the far end's jitter buffer cannot be recalled at all, which is a fixed
  latency rather than a growing queue, and the code says so rather than pretending otherwise.

The rule's weak point is the small amount of frame bookkeeping the three backends genuinely
repeat — the pre-roll ring that keeps a barge-in's first word, and the per-frame VAD call that
files a frame and judges it in the same breath. It sits against the frame source, which is why
it is there three times; it is also the most likely place for the three to drift next, so a
change to any of it is a change to all three.

### 10.3.2 One voice, one conversation at a time

There is one voice body on a machine — one microphone, one recogniser, one synthesiser, one
`Engine` with one state machine — and the person in front of it has one mouth. **So "voice on
every agent" means the voice can be *pointed at* any conversation, not that every conversation
has one.** Two panes with a microphone each, feeding one recogniser, would be two agents
answering out loud over each other.

The voice is therefore the **machine's**, built from `SANDBOXR_VOICE_SOCKET` alone
(`packages/server/src/voice.ts`, `ServerConfig.voiceSocket`). It used to be built inside
`startOrchestrator`, so a machine with a sidecar had to turn the orchestrator on to get a
microphone — even when what it wanted was to talk to a worktree's own session.

| | |
|---|---|
| **Target** | A conversation, as three functions: `hear(text)`, `listening(on)`, `watch(say)`. The orchestrator's agent and a sandbox session are different objects with different lifetimes, and the voice is better for knowing about neither |
| **Claim** | `MachineVoice.claim(target)`. At most one is held. A second socket on the *same* conversation shares it; a claim on a *different* one takes it |
| **Address** | `/orchestrator/audio` for the machine's own session, `/p/:project/s/:slug/audio` for a worktree's, `/sessions/:session/audio` for the agent in a session's workstation (§12.6.0) — each beside that conversation's own socket, because they are two halves of one conversation |
| **Key** | `orchestrator`, `<project>/<slug>`, and `#ws:<session>`. A key is parsed back into a conversation, and a worktree's is split on the first `/` — so a session's must be one that split can never be handed. A project, a slug and a session id are all `[a-z0-9-]`, so the `#` cannot appear in any of them, and the dispatch is a `switch` over a parsed subject rather than a ladder whose last branch is "whatever did not match" |
| **Capability** | `GET /api/voice` answers `{ enabled, voices, voice }`. A route of its own, not a field on `/api/orchestrator`: every pane asks it, and a worktree page reading a different feature's status to decide whether it may draw a microphone is the right answer arrived at by luck |

Four consequences, each of which is a bug if it is missed:

- **Taking the voice stops the previous conversation mid-sentence and closes its relays.** The
  sound has to stop, not just the bookkeeping: a sentence already playing is about a
  conversation the person has turned away from. The losing tab is told `{"type":"taken","by":…}`
  before its socket closes, because the close on its own arrives as a connection that failed for
  no reason.
- **A conversation the voice is not pointed at is never read aloud, and never spoken into.**
  The `watch` is the claim; speech heard while nothing is claimed is dropped rather than
  delivered to whichever conversation was last, which would put a sentence into a session the
  person had stopped talking to and could not see.
- **The `[spoken]` marker is one constant, `SPOKEN_MARKER` in core.** It prefixes a message
  while somebody is listening, and `SPOKEN_PROMPT` — appended with `--append-system-prompt` to
  every session on a machine that has a voice — is what gives it meaning. Both are core's
  because the orchestrator and a sandbox session have to agree on them exactly. A machine with
  no sidecar appends nothing, so its sessions get a byte-identical command line to the one they
  got before any of this existed.
- **Which voice speaks is a setting, not a deployment.** `PiperVoices` loads every `.onnx`
  beside the mounted default, lazily, and switches on `configure`; the list travels in `ready`
  and a change in a `voice` event. It is on the shared synthesiser for the reason §10.3.1 gives
  about the pace. The dashboard remembers `ready` and replays it to each tab, because it is
  sent once when the *dashboard* connects — long before any browser exists.

**Telegram is the orchestrator's, and none of the above changes that.** The voice became the
machine's; the phone did not. A worktree's session can be spoken to in the dashboard and can never
place a call, for three reasons that are worth keeping separate because a change could break any
one of them on its own:

- **A different sidecar, on a different socket.** `SANDBOXR_VOICE_SOCKET` is the voice body the
  dashboard relays to; `SANDBOXR_TELEGRAM_SOCKET` is a separate process reached only by the
  orchestrator daemon (`packages/orchestrator-daemon/src/daemon.ts`). The relay in `voice.ts` holds
  one transport and it is not that one, so there is no path from an audio socket to a call.
- **The call is placed by the engine, about a session, not by a session.** `RoutingNotifier` sends
  escalations at `urgent` to the Telegram notifier; the conversation held over the call is the
  orchestrator's. A session is a *subject* of a call, never a party to one.
- **The routes are orchestrator-gated.** `GET/PUT /api/orchestrator/telegram` answer 404 when
  `SANDBOXR_ORCHESTRATOR` is unset, **even on a machine that has a voice** — which is now a
  reachable state and was not before. A test pins it.

A consequence worth stating because it reads like a bug otherwise: **the pace and the voice chosen
in a browser do not reach a call.** The two sidecars share their code, so a fix to how either works
reaches both; they do not share a process, so a `configure` reaches the socket it was sent on and
no other. A call speaks at its own sidecar's `SANDBOXR_VOICE_RATE`, in its own mounted voice.

### 10.4 Hooks

Claude Code's hooks are pointed at `sandboxr-orchestrator-hook`, a bin whose one guarantee is
that it is harmless: it forwards the payload and **exits 0 with empty stdout no matter what**,
because a `PreToolUse` hook that is slow or errors can block a tool. The ingest server binds
loopback, needs no auth (a local process handing a local process a local payload), and answers
200 to everything but an unknown route — a hook must never be able to wedge a session with the
orchestrator's opinion of its payload. `SubagentStop`, `Notification`, `Stop`, `PreToolUse` and
`PostToolUse` are modelled; everything else parses to null.

### 10.5 The Telegram control protocol, and the call

Telegram is the notifier for when the person is away from the desk: a question rings them, an
update leaves a text. A real one-to-one Telegram call is not programmable, so the userbot
(Telethon) joins a **group voice chat** and brings the person in; pytgcalls carries the audio.
The control protocol (`call`, `hangup`, `text`; `calling`, `joined`, `left`, `ended`, `error`)
is signalling only — it is kept apart from the voice protocol, which carries the conversation
once the person is on the call. `TelegramCall.call()` resolves on `joined` and rejects on
ring-out or `ended`; nobody answering is a normal outcome, not an error. The conversation over
the call is an ordinary `VoiceNotifier` reused whole — the same barge-in and history rewrite,
with the call as the audio.

### 10.6 The daemon, and what never leaves the machine

**Everything the orchestrator adds is a host process, not a sandbox.** The daemon, the voice
sidecar and the telegram sidecar run on the machine, beside Docker — they must, because voice
owns the microphone, the telegram userbot owns the account login, and the daemon needs the Docker
socket to fork a session. The sandboxes are the subjects, not part of it. Four links join them:
the **run index** (a host file the daemon polls), **hooks** (an HTTP POST from a session to the
daemon), **summaries** (`docker exec` from the daemon into a sandbox, §10.2), and **voice/calls**
(local sockets to the sidecars). The **base package owns no side effects at all** — it opens no
socket, spawns nothing, reads no environment — so the whole decision path is testable without any
of the above; the daemon is the one place those edges live, which is also why it is a separate
package from the base it cannot be depended on by.

**One reachability boundary is left manual, not defaulted.** The index feed reaches the daemon
whatever started a session, because it is a file. A hook runs where `claude` runs: for a session
`claude` runs on the host it reaches the loopback ingest port, and for one the dashboard runs
*inside a sandbox container* it does not, because the port binds loopback on the host. Wiring the
in-container case — `SANDBOXR_ORCHESTRATOR_URL` in the sandbox pointing at the daemon on the
docker-bridge gateway — is deliberately a manual step, because loopback-only is the safe default.

`sandboxr-orchestrator` reads `SANDBOXR_HOME`, polls the index, serves the hook port
(`SANDBOXR_ORCHESTRATOR_PORT`, default 4600, loopback), and routes escalations: voice
(`SANDBOXR_VOICE_SOCKET`) takes everything, Telegram (`SANDBOXR_TELEGRAM_SOCKET`,
`…_CHAT_ID`, `…_USER_ID`) takes the urgent, and a log notifier is the floor under both so a
machine with neither still runs and stays observable. It degrades to logging when a sidecar is
absent, so it is safe to start first.

The whole point of the Python sidecars is that **speech never leaves the machine**: recognition
(Whisper), synthesis (Piper), voice-activity detection (Silero) and the end-of-speech decision
all run locally. The Telegram audio is the one exception, and it is the person's own call on
their own account. Telegram credentials are read from the environment only, never a flag.

### 10.7 In the dashboard, and audio over the browser

The orchestrator owns no side effects, so it runs in two places from one engine. As a
standalone **daemon** (§10.6), and — behind `SANDBOXR_ORCHESTRATOR` — **inside the dashboard
server**, where the two edges it needs are already present: the live session registry, so a
summary is a real `/btw` fork taken through `AgentSessions.fork` rather than a `docker exec`,
and a websocket to the browser, so an escalation is a card and an answer is a click. When the
variable is unset, `startOrchestrator` returns null and every route and gateway treats null as
"the feature does not exist" — an un-opted-in dashboard is unchanged, which is the safety story.

Two sockets and three routes, all gated on a password that covers **every** project (`*`), because
the orchestrator watches across projects and an escalation about one names a sandbox another
login may not see:

- **`/orchestrator`** — the panel. `ready` (recent cards + open question ids) on attach, then
  `escalation` and `answered` frames out; `answer` and `digest` in. A question is answered once,
  by whoever answers first; the `answered` frame clears every other tab's card.
- **`/orchestrator/audio`**, **`/p/:project/s/:slug/audio`** and **`/sessions/:session/audio`** —
  the audio relay, only when a voice is configured. Three addresses, one relay: it is one body
  being pointed at one of them (§10.3.2). Binary PCM both ways with the browser;
  `audio-in`/`audio-out` on the sidecar transport. **`GET /api/voice`** answers
  `{enabled, voices, voice}` — whether the machine has a voice at all, and which voices it can
  speak in. The workstation address takes the same `*` bar `WS /sessions/:session/agent` takes and
  for the same reason (§12.6.0); a conversation with nothing running behind it — a worktree with
  no session, a workstation that is stopped — is a **409**, one refusal for one condition.
- **`GET/PUT /api/orchestrator/telegram`** — the call targets and the enable switch. **Never the
  api id, hash or session**: those are secrets, stay in the sidecar's environment, and have no
  web field. **`GET /api/orchestrator`** answers `{enabled}` so the browser can decide whether to
  draw the panel; it is the one route a disabled dashboard still answers.
- **`GET/PUT /api/orchestrator/soul`** — `{text}`, the orchestrator agent's character, stored as
  prose in `$SANDBOXR_HOME/soul.md` and capped at 8000 characters. **Only the orchestrator reads
  it**; a sandbox session's prompt is core's and is untouched by it. It is appended **after** the
  operational system prompt under a heading limiting it to manner, so it can never widen what the
  agent may do — the allowlist and `--permission-prompt-tool` remain the only things that decide
  that. Absent or empty means no section at all and a byte-identical prompt. It is read when a
  conversation opens, never at construction: `--append-system-prompt` is fixed for the life of the
  `claude` process, so an edit lands on the **next** conversation and every surface must say so.

**Audio on the web streams to the sidecar; it does not use the browser's own speech.** Browser
speech recognition ships audio to a vendor cloud, which would break "speech never leaves the
machine". So the browser is only a microphone and a speaker: it streams PCM to the voice sidecar
(running in **streamed mode** — the socket is its device), which recognises and synthesises
locally and streams the spoken audio back. The `audio-in`/`audio-out` frames carry it, base64 so
the protocol stays one JSON object per line, and the sidecar paces `audio-out` one tick at a time
so the heard boundary stays honest at a barge-in.

**Voice is never a second asker.** There is one conversation, and speech is a way into it, not a
second channel beside it. What the sidecar hears becomes `agent.send(text)` — an ordinary message
— and the agent's finished prose is spoken back; escalations reach the agent (`AgentNotifier`),
which raises them in that same conversation. Talking is typing. The transcript used to be
submitted as the answer to whatever question the panel had open, which was a second answer channel
and could settle the wrong question when two were open at once.

**Streamed audio is also what makes the sidecars containerisable.** With the browser doing the
raw audio I/O, a sidecar needs no audio device, so it ships as an image that runs the same on any
machine and reaches the dashboard over a Unix socket on a shared volume. The desk build (a real
device, via sounddevice) and the streamed build (no device) are the same body with different ends.

## 11. The master compose file

`docker-compose.yml` at the top of the repository runs the machine's **constellation**: the
router (§7), the dashboard, the orchestrator container (§10.7), and the two audio sidecars
(§10.3.1). It is the second way to start those three core-defined containers — `sandboxr init`
is the first — and the only way to start the sidecars alongside them.

**Compose owns the shape; core owns the values.** Every value in that file is either a constant
`packages/core` also names, or a `${…}` out of `.env`. Nothing in it is derived: not a hostname,
not a rule, not an image digest. This is the rule that keeps the file from becoming a second
implementation of `access/dashboard.ts`, which is what "logic belongs in core" forbids.

**Where compose must spell a value core computes, a test pins the two together.**
`packages/core/src/access/compose.test.ts` parses the file, emulates compose's own interpolation,
and compares the result against `routerArgs`, `dashboardArgs`, `dashboardLabels` and
`orchestratorArgs`. A mount, a label, a published port or a forwarded variable that exists on one
side and not the other fails the suite. It is the same device `HANDSHAKE_PATH` uses across core
and the server, and `PROTECTED_IMAGES` across `naming.ts` and `access/index.ts`: two constants
that have to agree, held together by an assertion rather than by discipline.

**Two files hold values, split on whether a person chooses it.**

| File | Written by | Holds |
|---|---|---|
| `.env` | a person, from `.env.example` | paths, domain, password, ports, database credentials, `COMPOSE_PROFILES` |
| `$SANDBOXR_HOME/host.env` | `init` | The engine's three: `GH_TOKEN`, `GIT_AUTHOR_NAME`, `GIT_AUTHOR_EMAIL`. Then whatever the embedder named — for Jef, `SANDBOXR_CLAUDE_CREDENTIALS` and `CLAUDE_CODE_OAUTH_TOKEN` |

`.env` is hand-edited and never generated, and that is the point of it: **a container's
environment is fixed when the container is made**, so a credential added to a running dashboard
reaches nothing — which is how every database variable in §5.2 could be set on a machine and
still be absent from the dashboard. One line in `.env` and one `docker compose up -d` is the
whole fix, and it must stay a file a person can edit for that to be true.

`host.env` is generated because nothing but a host process can produce it: `gh`'s token lives in
the login keychain, the commit identity in a gitconfig the dashboard has not got, and the Claude
login is a path on a filesystem it cannot see. It is loaded as an `env_file`, so it is container
environment only and never interpolated. **Mode 0600**, like `secrets/<project>.env`, because it
holds a token.

**Compose owns the shape, core owns the values, and the embedder owns its own values.** The
engine writes three facts — the keychain's token and the machine's commit identity — because
those are facts about a *sandbox's* host. Everything else in the file is `InitOptions.hostEnvExtra`,
named by whoever ran `init`, written after the engine's own keys and sorted, through the same
quoting and the same refusal of a value carrying a newline. The engine never learns what any of
them is for.

Jef names two. `SANDBOXR_CLAUDE_CREDENTIALS` is a path on the host filesystem. `CLAUDE_CODE_OAUTH_TOKEN`
is `SANDBOXR_CLAUDE_TOKEN` under the name Claude Code reads — the rename `orchestratorArgs`
already performs, done once rather than in YAML. Both services load the file, so the dashboard
sees that token under a second name; it is the same secret §7.2 already gives it, and the login
kept out of the web server is the *credentials file*, which remains a path here and a mount there.

**`jef init --no-start` is the prerequisite, and it is not optional.** The directories, the
three images, the certificate, the router's own configuration under `state/` and `host.env` are
all things no compose file can produce. `--no-start` exists because the alternative is `init`
starting containers under the names compose then wants, which fails as "container name is already
in use" and names nothing about the cause. The two ways to run the constellation are exclusive:
`sandboxr teardown` is the handoff from one to the other.

**The network is external.** `sandboxr init` creates `sandboxr` (§3.3) and every sandbox joins it;
a compose-created `sandboxr_default` would put the router on a network no sandbox is on, and every
app would answer 404 at the router rather than fail in a way that names this.

**Sandboxes are not in it, and the file says so.** A sandbox is created per worktree at run time
by core driving the Docker socket, and its name is derived from a branch that did not exist when
the file was written. `docker compose down` therefore stops the plumbing and leaves every sandbox
running; `sandboxr down` stops one and `sandboxr gc` reclaims what they left. The file states this
at the top because the opposite is the reasonable assumption.

**No Telegram credential appears in it, in `.env.example`, or in any documentation.** The api id,
hash and session string are read from the environment of the shell that runs `docker compose`, as
§10.6 requires, and the compose test asserts that every Telegram entry in the file is a bare name
with no value.

**The sidecars reach the dashboard over `$SANDBOXR_HOME/run`, not a named volume.** The dashboard
already binds `SANDBOXR_HOME` at the identical path inside and out (§4), so one
`SANDBOXR_VOICE_SOCKET` value is correct on the host, in the dashboard and in the sidecar at once.
A named volume would have to be mounted by all three and would still mean a different path in each.

What the file deliberately does not cover: sandboxes, the standalone orchestrator daemon (§10.6,
a host process with no image), and building the three `sandboxr/` images — the base is
content-addressed on everything under `container/` and that digest is core's to compute. The two
sidecar images have ordinary Dockerfiles, so compose builds those.

## 12. The session model

**This section was written before any of it existed, which is what this file is for**: §§1–11
describe a machine that runs today, and this section describes the one being built on top of it.
Everything §§1–11 says about a **sandbox** is still true and still running. §12.10 maps each
superseded rule onto what replaces it, because the reasoning in those sections is what this one is
built out of; none of it is deleted.

**What is built, precisely.** `packages/core/src/session/` creates, lists, fetches and deletes a
session, and creates, starts and stops a workstation — so a container does now answer to
`sandboxr-ws-`, a volume to `sandboxr-work-`, and `state/session/<session>/` holds §12.6's three
files. Beside it, `session/work.ts` knows the `/work/<repo>/<branch>` layout, refuses a second
branch that would share a directory with the first, clones into a work volume from a short-lived
container, and is the only code that may remove one — and `gc` and `prune` leave a work volume
alone under every rule they have, which had to land in the same change, because a work volume the
collector did not know about is somebody's uncommitted work waiting for the next housekeeping run.
All of that has been run against a real daemon.

**The idle clock reads a workstation (§12.7), and it is the clock in `sandbox/expiry.ts`.**
`planSessionExpiry` in `session/expiry.ts` is `planExpiry` over a session and both reach the
engine's one `decide`, which `sandbox/expiry.ts` exports for exactly this; `sessionActivity`
in `sandbox/activity.ts` reads the three signals a workstation has; `session/expire.ts` stops what
has run out, through `stopWorkstation` and no other verb, so a session that goes quiet keeps its
work volume and its host files. The dashboard's reaper drives it on the same pass it drives
sandboxes. **Two things about it are true and worth saying here rather than being discovered:**
nothing writes `AgentRun.session` yet, because no run happens in a workstation yet, so the agent
signal is read and never supplied; and `sandboxr expire` still covers only sandboxes, because the
CLI has no session surface at all. **None of it has been run against a real daemon** — the tests
are unit tests against a fake one.

**The dashboard's HTTP surface for a session is built** (§12.6.2): `/api/sessions/…` lists
sessions, makes one, fetches one, deletes one, starts and stops a workstation, lists the
repositories on a work volume, **clones one into it**, and serves §7.4's two read-only code views
against a workstation rather than a sandbox. Every route is tested over real HTTP against a fake
core and a fake daemon.

**Six of those routes have now been driven against a real daemon**, end to end in one pass: a
session created, `POST …/repos` cloning a 1&nbsp;GB repository's `main` onto its work volume in
twenty-four seconds, `GET …/repos` listing the checkout, and `…/files` and `…/diff` reading it out
of the workstation — then the session deleted, taking its container, its volume and its host
directory with it. The clone was checked for the two traps §12.5 names: its `origin` is the forge's
URL and not `/src`, and it has no `objects/info/alternates`, so it is self-contained. `…/diff`
resolved an upstream of `origin/main`, which is true only if the fetch of the mirror's
`refs/remotes/origin/*` landed — the half that a plain clone of a bare mirror gets wrong. The
refusals were exercised the same way: a second clone of one branch, a branch that resolves nowhere,
a project the workspace does not hold, a project a narrow password may not see, and two branch names
that want one directory.

**`POST …/runtimes` and the `…/r/:runtime` routes have still not been driven against a real
daemon**, and neither has starting or stopping a workstation.

**A runtime can be brought up from a work volume and has been** (§12.4): `up({ runtime })` starts a
sandbox whose `/workspace` is a checkout on `sandboxr-work-<session>`, and the demo project was
cloned into one, started, and served over HTTP.

**Asking for one is built too, both halves** (§12.4, §12.6.1.1). `POST /api/sessions/:session/runtimes`
starts a runtime and answers its URLs, `…/r/:runtime/stop` and `DELETE …/r/:runtime` take one away,
and a session may only run a checkout that is already on its own work volume — enforced against the
volume's own listing rather than against the request. Beside it, `packages/server/src/session-mcp.ts`
is the `sandboxr` MCP server the agent's `claude` process runs, whose every tool is one of those
calls with a per-run token. Both are tested — the routes over real HTTP against a fake core, the
tool over a real stdio pipe against a real HTTP server.

**An agent now runs in a workstation, and the socket into one is `WS /sessions/:session/agent`**
(§12.6.0). Against a live daemon, a session was created, the socket opened, and `claude` started
inside `sandboxr-ws-<session>`: it reported `cwd=/work`, forty tools, and the `sandboxr` MCP server
**connected** — the first time the file of §12.4 has been copied in and started by a real agent.
Two things were found by running it rather than by reading it: the `with-env` prefix is fatal in a
workstation (§12.3), and the `.js`/`.mjs` distinction on the copied file is load-bearing (§12.4).

**No tool call has been made by a model, and no model has answered.** The turn ended on
`Failed to authenticate: OAuth session expired and could not be refreshed`: the machine it was run
on shares its Claude login as `~/.claude/.credentials.json` (§3.3), which on macOS is a *copy* of a
keychain credential, and the copy's refresh was rejected and the file blanked — the failure
`hasLogin` is written about, reached from a workstation for the first time. That is a property of
the machine rather than of this section, and it is the only thing between here and a session that
shows you its work running.

**The browser app is organised around a session now, sidebar included.** The column at every
width above `md` is the list of sessions (`components/shell/SessionBrowser.tsx`), drawn row for
row the way the worktree column was drawn: a state dot at the head, the name, the id or what the
session holds under it, and one thing at the right-hand end. `/sessions` is that same list given
a screen, which is what the phone's tab bar switches to. **New session** is the app's primary
create action — in the header at every width, at the head of the session column, on the home page
and on a project's pane; the header's copy is the one that makes it ambient. It is deliberately
**not** in the phone's tab bar, which already carries one destination more than a tab bar is for.

**`/sessions/<id>` opens on its agent**, filling the pane, with the checkouts, the runtimes and
the three verbs over the workstation in a slide-out column beside it. It is the shape the worktree
pane already had and it is literally the same two components — `AgentSession` given a third
`endpoints`, and one shared `SidePanel`. The conversation is dialled at `/sessions/:session/agent`
below, **which nothing answers yet**: see the closing paragraph of this preamble.

**`New worktree` has gone as an action, and `/new` with it.** Code is something you add to a
session, from inside the session — `POST /api/sessions/:session/repos` (§12.5) — so a second
create making a different noun out of a form is the thing that went. Nothing running was taken
away with it: every worktree-backed sandbox on this machine keeps its own pane at
`/p/<project>/w/<slug>`, `/worktrees` is still the whole list as a pane, and **a project's own
pane is where a worktree is managed from** — it lists every worktree in the project with its
sandbox, its pull request and a Start beside each. The one thing `/new` could do that nothing else
now can is **cut a new branch** (`up` with a `branch` and a `base`); starting a branch that already
exists is unchanged.

**The create asks for nothing and the id is never a field.** One click posts an empty body and
lands on the session it made; `POST /api/sessions` invents the id, and the id is the *address*
(§12.2) — the URL, `sandboxr-ws-<id>`, `sandboxr-work-<id>` — which is precisely why a person
does not type one. The request is held for the whole app rather than by each button, so five
copies of the control are one create; the wait, which is minutes on a machine with no
workstation image, is a band under the header and not a modal — there is no form left for a
modal to hold, and a dialog containing only a progress bar blocks the page for no reason.
**The name is set after the fact**, on the session's own pane, through `PATCH
/api/sessions/:session`: a session nobody has named shows its id as its title, because
`SessionDto.name` is `null` until somebody sets one and is never the id. Adding code to a
session is a project and a branch; §7.4's two read-only views are the same two components,
pointed at a workstation rather than at a sandbox. Everything §12 says about an absence is drawn as one: an unreadable
work volume is `unknown` and never `none` (§12.5), and `runtimesWithheld` and the repositories
listing's `withheld` are rendered rather than dropped (§12.6.1). **Worktrees are unchanged in
everything but where they are listed** — a session cannot yet do everything a worktree can
(§12.10), and every sandbox on any real machine today is on a worktree, so all of §§3–8 still
describes what runs. **None of the browser half has been opened in a browser**: it is tested in
jsdom against the shapes above, and that is all.

**The rest of §12 has not been built**: there is no CLI command and no session scope in §8's
action table, so a session still has no actions and no terminal. It does have a conversation
(§12.6.0): `/sessions/<id>` opens on a pane dialled at `WS /sessions/:session/agent`, and the
server answers there.
[`docs/reference/status.md`](../reference/status.md) carries the same division where a reader of
the site will find it, and it is the only other place that has to.


### 12.1 Four nouns

| Noun | What it is | How many |
|---|---|---|
| **Session** | The unit of work. An agent with a container. It may hold zero or more repositories and may have started zero or more runtimes | the thing the product is organised around |
| **Workstation** | The container the agent runs in | exactly one per session |
| **Runtime** | A running copy of a project: its apps, its database, its hostnames. This is what §§3–8 call a sandbox | zero or more per session |
| **Work volume** | A Docker named volume holding the session's clones | exactly one per session |

**A session replaces the worktree as the thing the product is organised around, and it is not a
worktree under a new name.** A worktree is a checkout of one branch of one repository, and
everything keyed on `<project>/<slug>` inherits that shape: one repository, one branch, one
sandbox. A session starts from the work instead. "Change the retry logic in the API and the copy
on the marketing site" is one session and two repositories. **"Write me a document" is a session
with no repository at all** — a session whose work volume is empty and which has started no
runtime is an ordinary state, not a half-finished one. Nothing may treat it as an error, refuse
to list it, or require a project before a session can exist.

Two vocabulary collisions, both settled here rather than left for whoever hits them:

- **"Runtime" alone always means the noun in that table.** §5.1's sense — a backend, a static
  front-end, a served front-end — is **always spelled "runtime kind" and never shortened**, in
  code, in the API and on every page. §5.1's own heading already spells it that way.
- **§7.2's nouns are untouched.** A **Run** there is one `claude` invocation; it now happens in a
  workstation rather than in a sandbox, and it is keyed on the session (§12.7). The phrase "agent
  session" is retired: a *session* is §12's noun, a *run* is §7.2's, and a sentence using the old
  phrase cannot be read as either.

### 12.2 Identity and naming

A session is identified by a **session id**. It is what every container name, volume name, host
path and route below is built from.

- **The id is sanitised by §3.1's `sanitizeSlug`** — lowercase, `[a-z0-9-]`, runs of `-`
  collapsed, ends stripped. It therefore never contains `--`, which §3.2 depends on.
- **It is bounded at 31 characters, the plain lock budget, and not by any project's ceiling.** A
  session may hold repositories of projects that do not exist yet when it is created, so a
  per-project ceiling cannot be computed at that moment. It does not need to be: a session id
  names a container and a volume, and neither is a DNS label. This is exactly §3.1's reasoning
  for a worktree's directory name.
- **The namespace is flat and machine-wide.** A session is not filed under a project because it
  may hold none, or several. Creating a session under an id something already holds is refused,
  and the refusal names what holds it.

```
sandboxr-ws-<session>       the workstation container
sandboxr-work-<session>     the work volume
```

#### Where the id comes from

`sessionId` in `packages/core/src/session/id.ts`, and it is a pure function like `deriveSlug`: the
caller works out what is taken and passes it in. Three inputs, in this order.

- **An id somebody typed** is sanitised and nothing more. Taken is a **refusal**, naming the
  holder — which is the workstation or, for a stopped session, the work volume. A leftover work
  volume holds an id as firmly as a container does: Docker reuses a volume of that name rather
  than refusing, so creating a session over one would silently hand it somebody else's clones.
- **A name** derives the id, `sanitizeSlug(name)` bounded to 31. On collision it is **given** a
  four-character token — `uniqueSlug`, the same device §3.1 uses for two branches on one ticket,
  reused rather than rewritten. A name is a sentence and may repeat; an id is an address and may
  not, and refusing the second session called "the checkout rewrite" would make naming one a trap.
- **Neither** gives `session`, plus a token once that is taken. A session has no branch, no
  directory and no ticket to read — those are exactly §3.1's inputs — so the base says what the
  thing is and the token distinguishes it. **Not a generated adjective-and-noun pair**: a word
  list is a maintenance surface and eventually produces a pairing nobody wants on a screen, and
  what it buys is memorability that naming the session buys properly.

A name that sanitises to nothing — "🎉" — falls through to the unnamed base and **keeps its name**.
The name is presentation and may be any 60 code points somebody typed (§4.2.1); refusing to create
a session over an id nobody asked to see would be a surprising place to discover that.

#### A runtime's slug, and how it slots into §3.2

**§3.2's hostname scheme is unchanged, and must stay unchanged.** One DNS label above the domain,
`<slug>--<label>--<project>`, `--` as the separator, `parseHost` as the named reverse of `hostFor`.
Every word of the TLS argument in §3.2 still holds, and a session changes none of it. What a
session changes is where the slug comes from.

**A runtime is named within its session by a runtime name**, sanitised the same way, unique within
the session and chosen when the runtime is created. Its slug is then a pure function of the two:

```
slug = ceiling(sanitizeSlug("<session>-<runtime>"), project)
```

where `ceiling` is §3.1's rule in full — `min(31, 63 - len(longest label) - len(project) - 4)`,
and over it the first `ceiling - 9` characters, `-`, and the first 8 hex of the SHA-256 of the raw
input. **The raw input hashed is `<session>/<runtime>`, with the slash**, so two different pairs
that sanitise to one string still hash apart. A ceiling below 12 is refused when the config is
read, as it is today.

Everything downstream of the slug is then untouched: container `sandboxr-<project>-<slug>`,
volumes `sandboxr-<purpose>-<project>-<slug>`, host rule, migration advisory lock, `logs/`,
`build/`. A runtime *is* a sandbox to every one of them.

**The runtime name is always in the slug, even when a session has exactly one runtime.** A session
with one runtime routinely grows a second, and a slug that changed shape when it did would move
every hostname, orphan the first runtime's volumes and hand its database to a name nothing wrote —
§3.1's collision story, caused deliberately this time. `eng-3941-web` rather than `eng-3941` is
the price, and it is small.

**Nothing about a runtime's slug is recorded, because nothing about it is random.** §4.2.3 exists
because a collision token cannot be re-derived; a session id and a runtime name are both chosen
and both stored in the thing they name. `state/session/<session>/` (§12.6) holds no slug, and
`state/slug/` (§4.2.3) is worktree machinery that a session never reads or writes.

Worked, project `acme` with a longest label of `app`: ceiling `min(31, 63-4-3-4) = 31`; session
`eng-3941` with runtimes named `web` and `admin` gives slugs `eng-3941-web` and `eng-3941-admin`,
and hostnames `eng-3941-web--app--acme.sbx.lcl` and `eng-3941-admin--app--acme.sbx.lcl`. Under
§3.1's second worked project — `redeployable-platform-services`, longest label `admin-console`,
ceiling 16 — the same session and runtime give a seven-character prefix and an eight-character
hash, 16 in total, and a host label of `16 + 2 + 13 + 2 + 30 = 63`. The arithmetic has no slack,
which is why the runtime name goes inside the hashed input rather than being appended after it.

**A workstation has no hostname**, and that is not an omission. It serves no apps. The agent is
reached through the dashboard's own routes, the way the terminal already is (§3.2), so it inherits
the dashboard's auth and spends none of the DNS-label budget. Do not give a workstation a
hostname.

### 12.3 The workstation

One container per session, `sandboxr-ws-<session>`, on the shared `sandboxr` network. It is where
`claude` runs, and the host still holds no agent process of its own (§7.2).

**It has no Docker socket. Ever.** This is the hard line of the whole model, not a default. A
container holding the socket can create containers, mount any host path into one and read every
other sandbox's volumes — it is root on the machine with extra steps, and the agent inside a
workstation is the least supervised process sandboxr runs. It never needs the socket, because
**runtimes are created only by the control plane** (§12.4): the agent asks, core acts. Anything
proposing to mount `/var/run/docker.sock` into a workstation, to proxy it, or to hand it a socket
with "only some" verbs, is proposing to delete this paragraph, and has to do that here first.

**The asking half is built** (§12.4): an MCP server the agent's own `claude` process runs, whose
every tool is one HTTP call to the dashboard with a token scoped to that session. It is what makes
the no-socket rule liveable rather than merely strict — an agent that can neither run its own code
nor ask anybody to is an agent somebody will eventually mount a socket for.

**It has no bind mount from the host workspace.** The clones live in the work volume (§12.5), so
there is no host path to mount and nothing inside the container can reach the host's checkouts,
`SANDBOXR_HOME`, or another session's code. The bidirectional editing of §4.1 — a file changed on
the host appearing instantly inside the container — is what is being given up, and §12.9 says what
is kept in its place.

**It has no `/opt/sandboxr/scripts`, so `claude` is exec'd directly.** A sandbox's session is
prefixed with `with-env`, because a sandbox's environment is assembled by its entrypoint — the
project's `env:` map and its mounted secrets file — and `docker exec` never sees what an entrypoint
exported. A workstation runs no project and mounts no secrets, so every variable it has arrives as
`docker run -e`, which *is* the container's configured environment and which an exec does get:
there is nothing for the wrapper to restore, and the image does not ship it. Keeping the prefix
made the exec fail before `claude` was reached, and the stream reported that as "Claude Code exited
without starting a session" — a missing script that reads as a missing agent. `AgentLaunch.withEnv`
is where the two cases part.

What it mounts:

| Mount | Why |
|---|---|
| `sandboxr-work-<session>` at `/work` | the session's clones — §12.5 |
| `sandboxr-claude` at `/root/.claude` | §3.3's shared credential store, moved here from the sandbox. The trade in §3.3 is unchanged: signing into an MCP server once rather than once per session, and every workstation can read every credential in it |
| `~/.claude/.credentials.json`, read-write, when it exists on the host | §3.3's one exception, for the same reason and with the same macOS caveat (§7.2) |
| `secrets/<project>.env` | **not mounted.** A workstation runs no application, and a project's third-party credentials belong to the runtimes of that project (§5.2). A session may hold several projects, and mounting all of them into one container would hand every project's credentials to a session that asked for one |

It carries the labels of §3.4 that mean anything without a project, plus two new ones, and it is
read like every other container — `docker ps`, never a manifest:

| Label | On | Meaning |
|---|---|---|
| `sandboxr.kind` | every container sandboxr creates | `workstation` or `runtime`. A container with no `sandboxr.kind` is a pre-session sandbox and reads as `runtime` |
| `sandboxr.session` | workstations, runtimes, work volumes | the session id |

`sandboxr.project` and `sandboxr.slug` are **absent** on a workstation rather than empty, because a
workstation belongs to no project and an empty string is a value something will one day compare
against. `sandboxr.slug`'s absence is what keeps a workstation out of every sandbox listing without
a second exclusion anywhere: `sandboxFromLabels` already reads a missing slug as "not one of ours".

**Exactly two of §3.4's labels mean anything without a project, and a workstation carries those and
no others**: `sandboxr.created`, because the keep marker is stamped with it (§4.2), and
`sandboxr.ttl`, because the idle clock reads it (§12.7). `branch`, `commit`, `dirty` and `worktree`
describe a checkout a workstation does not have; `driver` and `env` describe a project it does not
run; `access` describes hostnames it does not serve on (§12.2). Four labels in total, and a fifth
would need an argument here first.

**A workstation is running or it is stopped, and there is no third word.** `SessionState` is those
two, against a sandbox's four, because `starting` and `degraded` are read from markers a sandbox's
own service tree writes and a workstation supervises nothing that would write them — a `starting` it
could never leave is a state nothing clears. The proposal that keeps arriving is a *creating*: let
`POST /api/sessions` answer at once and bring the workstation up behind it, so the pane can draw a
session that exists with a container that is still coming. **It is refused, and on grounds older
than this section.** A session's existence is `docker ps` over §12.3's labels and nothing else — a
session whose workstation is not there yet would have to be remembered somewhere on the host, which
is the manifest §3.4 exists to not have; `getSession` already refuses to answer with a session built
from host files alone, because that is "a row on the dashboard whose every action fails"; and a
build that fails leaves the row behind with nothing holding the id and nothing to clear it. It also
buys nothing: the minutes are an image build, and drawing a row while it runs does not shorten it.
The fix for a slow create is to build the image in `init`, where the other two are built, which is
what §3.3's image list now says.

The work volume carries `sandboxr.session` alone. `sandboxr.kind` has no reading on a volume — the
table above puts it on containers — and the name already says what the volume is for.

### 12.4 The runtime

A runtime is what §§3–8 call a sandbox, and every one of those sections applies to it unchanged:
its container name, its four volumes, its hostnames, its plan, its driver, its migration verdict,
its labels, its idle clock, its actions. **It is addressed as a sandbox everywhere a sandbox is
addressed today** — `/p/:project/s/:slug`, and the action scopes of §8 need no new form — and
`/sessions/:session` (§12.6) is the session's own view, which links to them. Two addressing
schemes for one container is how the two drift.

**The engine is handed a workspace, not a session** (§2). `up` takes a `ProvidedWorkspace` —
mounts, git facts, a slug and a directory of manifests — and knows nothing about sessions, work
volumes or staging. `startRuntime` in `packages/core/src/session/runtime.ts` is the product side:
it stages the checkout out of the work volume, builds the workspace, calls `up`, and disposes of
the staging in a `finally`. **Whoever resolves a workspace disposes of it**, because the staged
manifests are an input to one start and a stale copy would be a second opinion about what the
project is.

Three things a session adds:

- **A runtime is created only by the control plane.** Core, driven by the CLI or the dashboard.
  Never from inside any container, which is the other half of §12.3's no-socket rule.

  **How the agent asks.** `POST /api/sessions/:session/runtimes`, over HTTP on the shared Docker
  network, with the per-run token of §12.6.1.1 — and an MCP server, `sandboxr`, that turns that
  into tools the agent's own `claude` process can call (`start_runtime`, `list_runtimes`,
  `list_repositories`, `stop_runtime`, `delete_runtime`). It is
  `packages/server/dist/session-mcp.js`, spoken over stdio, shaped exactly like the orchestrator's
  (§10): hand-rolled JSON-RPC, every tool one HTTP call, no state and no decisions — so what
  starting a runtime *means*, and what it refuses, lives in the route and cannot drift.
  Three variables, set by whatever execs the agent: `SANDBOXR_SESSION_API`,
  `SANDBOXR_SESSION_TOKEN`, `SANDBOXR_SESSION`.

  **The file is put into the workstation, never mounted.** A workstation's mount table is closed
  (§12.3) and the installation is not in it: mounting the host's checkout of sandboxr into the
  container an agent lives in would hand it the thing every other rule here exists to keep away.
  One file is copied in at exec time instead, refreshed on every run so it cannot go stale. It
  lands at **`/opt/sandboxr/session-mcp.mjs`**, and the extension is load-bearing: the compiled
  server is an ES module by virtue of a `package.json` beside it in `dist/`, nothing beside it
  crosses, and a `.js` there would be read by node as CommonJS and die on its first `import` —
  which Claude Code reports only as a server that failed to start, with the tools simply absent.
  It crosses as an argument to `sh -c` rather than on the exec's stdin: an argument array is what
  keeps a file's contents from being able to become shell syntax, and a half-closed hijacked
  socket fails by hanging rather than by erroring.

  **`mcp__sandboxr` is on a workstation run's allowlist**, which is the one pre-approved MCP
  server anywhere in sandboxr and is argued for rather than assumed. Core's
  `DEFAULT_ALLOWED_TOOLS` pre-approves none, because the servers a *sandbox* picks up are the
  operator's claude.ai connectors reached through a shared login, where per-call consent is the
  only real consent. This one is the opposite: every tool is a route on this dashboard that is
  already refused server-side unless it names a checkout on this session's own work volume, so a
  person answering the question adds nothing the rule has not already decided. Leaving it off is
  not neutral either — a workstation has no project, so an "always" cannot be recorded against
  one (§7.2), and every listing of the session's own repositories would stop the turn on a
  question nothing could remember.
- **A runtime belongs to exactly one repository and branch of its session**, and that is what gives
  it a `/workspace`. A runtime is a running copy of a project, a project is described by a
  `sandboxr.yaml` in a checkout, so there is no such thing as a runtime with no code. A session
  with no repository simply has no runtime.
- **`/workspace` is `/work/<repo>/<branch>` (§12.5).** The path `/workspace` keeps its meaning to
  `plan.json`, to §5 and to every container script; it is now a location inside the work volume
  rather than a bind mount from the host. How the container arranges that — a subpath mount, a bind
  inside the container — is the container layer's; `/workspace` being the project root is not.

**A runtime needs none of §7.3's git mounts, and that is the one thing §§3–8 gets *smaller* here.**
`gitMounts` exists because a linked worktree's `.git` is a file naming its repository by absolute
host path, so the worktree and the repository have to be mounted at identical paths inside and out —
which drags two more rules behind it: the repository mount is read-write and therefore shared with
the host, and the base image pins `gc.worktreePruneExpire` to `never` because every sibling worktree
looks prunable from inside. §12.5's clone is self-contained, so its `.git` is a real directory inside
the checkout, there is no `worktrees/` administration anywhere, and there is no host path for git to
resolve. A runtime therefore mounts the work volume and nothing else for git's sake, and a `git gc`
inside one repacks only that session's objects. §7.3's other two rules are untouched: the commit
identity still crosses as `GIT_AUTHOR_*`/`GIT_COMMITTER_*`, and the GitHub token is still off unless
the operator opted the project in. **`gitMounts` is not removed** — it is the contract for every
worktree-backed sandbox (§12.10), and both paths exist side by side.

**The host reads a runtime's project by staging its manifests, never by keeping a checkout.** The
host still has to resolve four things before a runtime can start, and each of them is a file: the
project's `sandboxr.yaml`, the lockfile and `package.json`s that *are* the project image's build
context, the Go module manifests, and which lockfile keys the shared dependency volume. They are
copied out of the volume by a short-lived container that mounts it **read-only**, into a temporary
directory that is deleted when `up` returns and is mounted into nothing. The source stays in the
volume. §5.6's project-level config is deliberately **not** offered to a runtime: it exists because
an uncommitted `sandboxr.yaml` in one worktree does not exist in any other, and a session clones the
repository — so a checkout that does not describe itself is refused, naming its path inside the
volume.

### 12.5 The work volume

`sandboxr-work-<session>`, mounted at `/work` in the workstation and in **every** runtime of that
session. One volume per session, shared by its containers, never shared between sessions.

```
/work/<repo>/<branch>/
```

- **`<repo>` is the workspace directory name** — §4.1's key, the name the host's bare clone is
  filed under, not the `project:` a `sandboxr.yaml` declares. The two are allowed to differ (§4.1)
  and this names a directory.
- **`<branch>` is `sanitizeSlug(branch)`**, the same shape `wt/<branch>` already uses, so the two
  layouts read the same. Two branches that sanitise to one directory name are a collision:
  **the second is refused, naming both branches**, rather than checked out over the first. A
  directory silently holding a different branch than its name says is the failure that looks like
  an editor eating somebody's work.
- **The control plane owns the layout.** Adding a repository or a branch to a session is a control
  plane operation, for the same reason creating a runtime is. It is
  `POST /api/sessions/:session/repos` (§12.6.2), over `addSessionRepo` in
  `packages/core/src/session/repos.ts`, which resolves the three things the clone needs and that the
  volume cannot know: the host's `repo.git` as the source (§12.9), the forge's URL as `origin`, and
  the commit `freshenBranch` chose after a fetch (§4.1.3), passed as a **full sha** because the
  mirror's ref namespace does not exist inside a clone of the mirror.
- **A clone is written by a short-lived container mounting the volume**, running git out of the
  base image — never by the workstation, which may be stopped and must not have to be started to
  add a repository, and never by the host writing into Docker's volume directory, which on macOS
  is inside a VM and is not a path on the host at all.
- **A clone in a work volume must be self-contained, and its `origin` must be the real remote.**
  Both halves are traps. `git clone --reference <host bare clone>` leaves an `alternates` file
  pointing at a host path no container can resolve, and the repository then breaks the first time
  git needs an object the clone never copied — long after the clone and nowhere near it; use
  `--dissociate`, or do not use `--reference`. And a plain `git clone /path/to/repo.git` sets
  `origin` to that local path, so a push from inside the session would write into the host's bare
  clone and reach no forge at all. The objects may come from the host (§12.9); `origin` is the
  remote's URL, always, and §7.3's rules about the GitHub token govern what may be done with it.
- **Nothing prunes inside the volume.** Whatever an agent writes under `/work` — a scratch
  directory, a build output, a file outside any repository — is kept until the session is deleted.
  The volume is the session's disk, not a managed checkout.

**`/workspace` is a `volume-subpath` mount, and that was checked rather than assumed.** §12.4
leaves the mechanism to the container layer; this is what the layer chose and why. On Docker 28.0.1
(API 1.48) `--mount type=volume,…,volume-subpath=<repo>/<branch>` mounts the checkout at
`/workspace` while the same volume is mounted whole at `/work` in the same container, and a write
through either is visible through the other. The reason to prefer it over a bind inside the
container is the failure case: a subpath that does not exist is refused by the daemon at create
time, naming the path, where a symlink or a `cd` in the entrypoint leaves `/workspace` merely
empty — which every script downstream reads as a project with no files in it. It needs a daemon
with the option (Docker 25+); below that `docker run` fails naming `volume-subpath`, which is a
refusal at start rather than a sandbox that comes up wrong.

**Whether a session holds any code cannot be answered from the host while nothing is running, and
the answer is then `unknown`, never `none`.** Reading it means running something that mounts the
volume. An unreadable listing rendered as "no repositories" is a sentence somebody would act on by
deleting the session, and deleting a session is the one irreversible verb in §12.8. This is §3.4's
rule — every failure to read a signal is an absence, never an assertion — applied where it costs
the most.

### 12.6 A session's state on the host

```
~/.sandboxr/state/session/<session>/keep     keeps the workstation alive past its idle limit
~/.sandboxr/state/session/<session>/name     what to call this session on screen
~/.sandboxr/state/session/<session>/attach   a socket is being held open on the workstation
~/.sandboxr/state/session/<session>/adopted  the worktree this session's code was copied from
```

**One directory per session rather than a parallel tree each, and `session/` is a namespace rather
than decoration.** `state/keep/<project>/<slug>` puts a *project* directory at its first level, so
a session id written there could collide with a project of the same name — and the two would then
be one file, exempting a sandbox from its lifetime because somebody pinned a session. The nesting
also makes §12.8's last step one `rm -r` rather than a deletion per file that can half-succeed —
and it is what let `adopted` be added without a fourth tree and a fourth deletion to forget.

Each file keeps the semantics argued for it where it was argued, and each argument carries over
whole:

- **`keep` carries the workstation's `sandboxr.created`** (§4.2). It is an exemption applying to
  one container instance, and a session's workstation is recreated exactly as a sandbox is, so a
  stale marker must fail closed.
- **`name` carries no stamp** (§4.2.1). It names the session, which outlives every container in
  it; stamping it would throw the name away the first time somebody pressed Rebuild. Same
  validation, same 60 code points, same rule that it is presentation and reaches no identifier.
  Written by `POST /api/sessions` when a name was given with the create, and by
  `PATCH /api/sessions/:session` at any time after — which is the ordinary way a session gets one,
  because the create takes no fields (§12.6.2).
- **`attach` is an mtime and a heartbeat** (§4.2.2), written by the dashboard while it holds the
  workstation's terminal or agent socket, believed for `ATTACH_LIVE_GRACE_MS`, stamped once more
  on release.
- **`adopted` holds `<project>/<slug>` and carries no stamp either.** It records the worktree the
  session's code was copied out of (§12.10.1), written once by the adoption and never again. Both
  halves are directory names — §4.1's workspace key and the worktree's own directory under `wt/`,
  which is the pair every worktree route addresses one by — and deliberately **not the branch**,
  because a branch moves between worktrees and is checked out in several at once. **It is a record
  of where the code came from, not a link to a live thing**: the worktree may be deleted the next
  day, nothing looks it up to check, and nothing is keyed on it. A file edited by hand into
  anything that is not a pair of plain directory names reads as *no record*, which is visible,
  harmless and undoable. Absent is the ordinary case — every session made by `POST /api/sessions`
  has no worktree behind it at all.

**What `adopted` is for, and why it is a file rather than a label.** The dashboard has to be able
to say a worktree already has a session rather than offer to make a second, and the only join
available for that is this pair read back the other way round (`GET /api/workspace` and
`GET /api/projects/:project` both do it, and put the session ids on `WorktreeDto.sessions`). A
label on the workstation would be the obvious alternative and is wrong for §4.2.1's reason: a
workstation is recreated exactly as a sandbox is, so the record would be thrown away the first time
somebody rebuilt one.

A runtime's own state stays exactly where §4.2 puts it, under `state/keep/<project>/<slug>` and the
rest. A runtime is a sandbox; its files are a sandbox's files.

**The dashboard's routes for a session are `/sessions/:session` and below it** —
`…/actions/:action`, `…/terminal`, `…/agent`, `…/audio`, and `…/r/:runtime` for the session's view
of one runtime. **`WS /sessions/:session/agent` and `WS /sessions/:session/audio` are built**
(§12.6.0, §12.6.3); `…/actions/:action` and `…/terminal` are not. They are top-level rather than under `/p/:project`, because a session belongs to no
project. §3.4's second activity signal — a dashboard route naming the thing — reads
`…/sessions/<session>/…` out of the same access log, alongside the `…/p/<project>/[sw]/<slug>/…`
it already matches.

#### 12.6.0 The agent socket

`WS /sessions/:session/agent`, and it is **the worktree's `/p/:project/s/:slug/agent` in a
different container**. Same frames in both directions, to the byte, because a session's
conversation and a worktree's conversation are one thing and the browser draws them with one
component; the wire format is the contract between the two files, and a second vocabulary for the
same events is how they stop looking like one product.

Four things differ, and every one of them is decided at the handshake rather than in the middle,
which is why it is a second gateway rather than a branch in the first:

- **What it is addressed by.** `:session`, not `:project`/`:slug`, so the router's grant sweep has
  nothing to check on the path (§12.6.1).
- **The bar.** A control session covering **every** project — the same bar `POST /api/sessions`
  takes, for the stronger version of its reason: a workstation carries the machine's GitHub token
  and the shared Claude credential store (§12.3), and what this route starts inside one can reach
  both, plus every runtime of every project the session holds. A narrow password gets a **403**
  and not a 404, unlike `…/r/:runtime`: the session list is open to any signed-in reader, so there
  is nothing left to hide — what it may not do is start an agent.
- **The credential the agent gets.** A per-run workstation token (§12.6.1.1), minted only when a
  process is really started and handed back when it ends, plus the `sandboxr` MCP server copied in
  beside it (§12.4).
- **Side questions.** There are none. `/btw` forks a conversation about one worktree (§7.2.1) and
  a session is not one, so a `/btw` here is answered with a sentence rather than silently turned
  into something else.

**The run starts at `/work`, and not inside a checkout even when the session holds exactly one.**
A session's repositories come and go while it is alive, so an agent started inside the only one
would silently be working somewhere else the moment a second was cloned, and the same session would
answer "where am I" differently on Tuesday. Deriving the single checkout would also mean reading
the work volume before the exec — a read §12.5 forbids anybody from treating as empty when it
fails — so a start that fell back to `/work` on an unreadable listing would quietly be a *different*
session from the one that succeeded. And Claude Code roots `CLAUDE.md` discovery, `.claude/`
settings and project trust at its working directory, so `/work` is what lets one session see every
repository it holds, which is the point of a session holding several. What it costs is that a
one-repository session's agent says the path once.

**The run is keyed on the session, everywhere the registry keys a sandbox's on `<project>/<slug>`.**
A workstation has neither label, so the pair cannot address one: two sessions would share the key
`/` and the second socket would join the first session's process, in another container. The index
row (§7.2) carries `session` and leaves `project` and `slug` **empty**, which is the join the idle
clock makes — `agentActivity` drops a row with either half of the pair empty and
`agentSessionActivity` keys on `session`, so filling the pair in with anything at all would put a
workstation run on the clock of a sandbox that does not exist.

**It can be spoken to, at `WS /sessions/:session/audio`.** The address sits beside the agent
socket for the reason the worktree's does: they are two halves of one conversation. The machine
has one voice and it is *pointed at* a conversation (§10.3.2), so turning the microphone on in a
session takes it from whatever held it — including a worktree, which is the person turning to talk
to something else rather than a fault. Three things about it are decided here rather than guessed:

- **The grant is checked against `*`.** A session belongs to no project (§12.6.1), so there is no
  project to name, and something had to be chosen. It is the bar the agent socket already sets, for
  the stronger version of that reason: a workstation carries the machine's GitHub token and the
  shared Claude credential store, and this relay puts what a person says *into* the agent running
  in it. A narrower answer would be a microphone that could reach a conversation the same password
  is refused when it tries to type into.
- **The claim key is `#ws:<session>`** — see §10.3.2's Key row for why it cannot be read as a
  worktree's.
- **A session with no run in it is a 409**, the same answer a worktree with no session gets. A
  stopped workstation cannot have a run in it, so it reaches the same refusal by the same route
  rather than through a second one the browser would have to learn.

The **registry's machine-wide watcher carries the session**, not only the project and the slug. A
workstation run leaves both of those empty, so a watcher handed the pair alone would see every
session on the machine as `("", "")` — the same collision `activity()` leaves workstation runs out
to avoid, and here it would read one session's reply aloud into a microphone pointed at another.

**An "always" on a permission question is answered as an "allow".** A standing grant is held per
project (§7.2) and a session belongs to none, so there is no key to write one under: recording it
against the empty project would make a rule granted in one session apply to every session on the
machine, and refusing the call outright would stop a tool the person just said yes to. The tool
runs, it will ask again, and the downgrade is logged rather than silent.

#### 12.6.1 How a session route is authorised

§7's grants are **per project**, and a session may hold several projects or none. The rule, and it
is the one thing that has to be got right before any of these routes exist:

- **A session route is authenticated the way every dashboard route is, and is not project-scoped**,
  because a session does not belong to a project. `/api/sessions/:session` carries no `:project`,
  so the router's grant sweep has nothing to check on it, and that is the answer rather than a gap.
- **Anything that reaches *into* a repository is checked against that repository's project grant,
  exactly as it is today.** The project comes from the repository the operation names, never from
  the session it was reached through. A session's checkout is `/work/<repo>/<branch>` and `<repo>`
  is the workspace directory name (§12.5), which is precisely the key a grant is held against — so
  the code routes spell it as `:project` and inherit the sweep and the grant check unchanged.
- **No session route widens a grant.** A session's runtimes and its repositories are narrowed to
  what the reader could reach anyway, and **what is withheld is counted rather than dropped**: a
  narrow password is told "two runtimes you may not see", never "no runtimes". That is §12.5's rule
  — an absence is never rendered as an assertion — applied to authorisation rather than to a
  failed read.

Four readings were closed rather than left open, each because the rule above does not settle it:

- **Creating, deleting, starting and stopping a session need a password that covers every
  project.** A workstation carries the machine's GitHub token and the shared Claude credential
  store (§12.3), neither of which belongs to a project; and deleting a session deletes its
  runtimes, which are sandboxes of projects the caller may hold no grant over (§12.8). That is the
  same bar the global `clone` action takes, for the same reason. **Reading** a session — the list,
  one session, its repositories — needs only a session, and is filtered.
- **Adopting a worktree takes that same bar, even though it is addressed as a worktree**
  (§12.10.1). It is worth saying because the address argues the other way: `POST
  /api/p/:project/w/:slug/session` names a project, so it goes through the router's grant sweep
  like every other `/p/:project/…` route, and a reading that stopped there would let a
  project-scoped password make sessions. It creates a session, so the create's bar governs and
  being scoped to one worktree does not lower it. The sweep is then redundant in practice — a
  machine-wide password covers every project — and is kept because it is structural, and because it
  is the check that would still be right if the bar were ever loosened. This is the list closing at
  "every session write that is not scoped to a repository" doing its job: the new write inherited
  an answer instead of guessing one.
- **Renaming a session takes that same bar, and the reason is not the one above.** A name reaches
  no container, no credential and no project: it is one host file, presentation only (§4.2.1). The
  reason is what a name is *for*. A session belongs to no project, so a narrow password has no
  claim over one to be measured against — which leaves exactly two answers, machine-wide or any
  signed-in reader, and the second is the dangerous one. Every session on the machine is already
  readable by any password (the list is not filtered, for the reason above it); making every
  session's name **writable** by any password would let one rewrite the labels a person picks a
  session out by, and the verb they then press is `DELETE`. §8.1 puts the wording of a destructive
  confirmation on the server precisely so a browser cannot be wrong about what it is destroying; a
  name anybody can edit reintroduces that by the back door, with a person rather than a browser as
  the thing misled. The bar is therefore the one every non-repository session write already takes,
  and that is the second reason: the list is closed at "every session write that is not scoped to a
  repository", so the next write added inherits an answer instead of guessing one.
- **A runtime the reader's password does not cover answers 404, not 403**, on
  `…/r/:runtime`. It is already absent from that session's runtime list, so a 403 would confirm
  that a sandbox exists inside a project the reader may not see.
- **`:runtime` carries the runtime's slug**, and it is resolved by looking it up among the
  session's own runtimes rather than by deriving it from a runtime name. Nothing records a runtime
  name (§12.2), so a lookup against what is running is the only answer that cannot be wrong about a
  container.

#### 12.6.1.1 The workstation token, and what an agent may ask for

A session's **agent** has to be able to ask the control plane for a runtime (§12.4), because a
workstation has no Docker socket and never may (§12.3). It is a different caller from the person at
the dashboard and is authorised differently, and this is the whole of the difference.

- **Its credential is a per-run token the dashboard minted for one session**, handed to the
  `claude` process in its exec environment and released when that process ends. It is never written
  to disk. **It is not the person's password**, which authorises every Docker-socket-backed action
  on the machine — the same reasoning, and the same shape, as the orchestrator's token (§10).
- **The token names one session, and the router refuses it on a path naming any other.** That is
  where "a session may only address its own runtimes" is enforced: in the route table, not in a
  handler. A token presented against another session's path is a **404**, for §12.6.1's reason — a
  refusal that said "not yours" would confirm that a session of that id exists on the machine.
- **A session may only start a runtime for a repository and branch already on its own work
  volume.** This is the closed rule, and it is enforced *server-side against the volume's own
  listing* (§12.5) rather than by trusting the request. So an agent can run code it already has and
  nothing else — and the only way code reaches a work volume is a clone the control plane made.
  The match is on the **directory** `sanitizeSlug(branch)` produces, because that is what `up`
  mounts at `/workspace`; a checkout whose recorded branch could not be read still matches, since an
  unreadable field is not an absent directory. A listing that could not be read at all **refuses**
  and starts nothing: "no repositories" is never an answer (§12.5), and reading one as such would
  tell an agent its own code does not exist.
- **An agent is not filtered by any project grant within its own session**, and that is not a
  widening. Every runtime it can see is one it asked the control plane to start out of its own
  volume, and the token reaches no other session's routes at all. Filtering would report its own
  work as withheld.
- **The routes an agent may reach are a closed list**, pinned by a test, because a route added to
  it is a capability handed to the least supervised process sandboxr runs. They are the two reads it
  needs to know what it may run — one session, and that session's repositories — and the three
  writes: start, stop, delete. Everything else on the machine, including `/api/p/:project/…` and
  every orchestrator route, refuses the token.
- **`POST …/repos` is deliberately not on that list**, and it is the one write beside the volume's
  own reads that an agent may not have. A workstation token covers every project of its session, so
  opening the clone to one would let an agent pull *any* project on the machine onto its own volume
  and then start a runtime of it — which is precisely the widening the rule above exists to prevent.
  A session runs the code it already has, and **what it has is what a person put there**.
- **A person reaches the same routes with a control session**, filtered by the ordinary project
  grant. Starting a runtime is checked against **the repository's** project and not against every
  project, which is §12.6.1's first rule — it reaches into a repository, and a runtime carries
  neither the machine's GitHub token nor another project's credentials. A repository the password
  does not cover answers 404, in the same words a checkout that is not there gets.

#### 12.6.2 What the JSON API answers today

Built, and listed in §7.1's table with every other route. `…/actions/:action`, `…/terminal` and
`…/agent` **is** built and is §12.6.0's; `…/actions/:action` and `…/terminal` are not, because
there is no session scope in §8's closed table and no terminal socket reaches a workstation.

**The browser dials `…/agent` regardless**, and that is deliberate rather than an oversight. The
session pane is the conversation pane every other agent surface uses (`AgentSession`, given an
`endpoints`), pointed at `ws(s)://<host>/sessions/<session>/agent` with `?resume=` and `?model=`
— the same query `/p/:project/s/:slug/agent` takes, since a session's conversation is that one
noun along. The upgrade is refused with a 404 by `packages/server/src/agent.ts`, whose
`AGENT_PATH` pins the sandbox shape, so what a reader sees is the pane's own **disconnected**
state and a Reconnect. Nothing is stubbed to hide it. When the gateway learns this path, the
browser needs no change; the one thing it will still lack is the slash-command listing, because
there is no `GET /api/sessions/:session/agent/commands` to match
`/api/p/:project/s/:slug/agent/commands`, and the pane is told `commands: null` — a real answer,
meaning no menu and a composer that works, rather than a request to a route that 404s.

| Route | Answers |
|---|---|
| `GET /api/sessions` | Every session on the machine, each with its runtimes narrowed to the grant and the count of what was withheld |
| `POST /api/sessions` | Makes one, from an optional id, name and lifetime (§12.2). A taken **id** is a `409` carrying core's own sentence, which names the workstation or the work volume holding it. **Every field being optional is the point**: the ordinary create sends `{}` and gets a derived id (§12.2's third input), so making a session is one click with nothing to fill in and the name is settled afterwards by the `PATCH` below. It is a volume and a container — a second or two — on a machine whose workstation image `init` has built, which is every machine that has been set up. It still calls `ensureWorkstationImage`, so on one where the tag is missing it takes as long as that build, and there is nowhere on the wire for the build's output to go |
| `PATCH /api/sessions/:session` | Names it, from a `name`. Writes `state/session/<session>/name` and touches nothing else — no container, no volume, no label. An **empty or whitespace-only name clears it**, which is one instruction from a person and not a second route: a cleared field means "go back to having no name". Answers the session, so `name` is `null` on a clear and **never the id** (§12.1) — the browser writes the sentence that shows an id where there is no name, and a route that substituted one would be indistinguishable from a name somebody typed. A name that is not one — a control character, more than 60 code points — is a `400` that does not echo it back. Takes the machine-wide bar of §12.6.1 |
| `GET /api/sessions/:session` | One session in full, including the sentence a delete confirms with |
| `DELETE /api/sessions/:session` | Deletes it (§12.8), and answers what went and what would not. **It takes no `force` and refuses one that is offered**: §8.1 says a browser may not force a destructive action, and ignoring the parameter would leave a browser believing it had one |
| `POST /api/sessions/:session/start` | Starts a stopped workstation. A `404` when the container has gone, which pressing Start again would never fix |
| `POST /api/sessions/:session/stop` | Stops it, removing nothing (§12.8). Already stopped is a `200` that says it changed nothing, not a failure |
| `GET /api/sessions/:session/repos` | What is in the work volume, read by a container that mounts it. **A read that failed says so** — `readable: false` with the reason — and never answers with an empty list (§12.5) |
| `POST /api/sessions/:session/repos` | Clones one repository and branch onto the work volume, from a `project`, a `branch` and an optional `start`. `project` is the workspace directory name, which §12.5 spells `<repo>` and §4.1 makes the key a grant is held against — one name for both, because a second would be a second thing to get wrong and the thing it would get wrong is an access check. Answers `201` with `{ repo, dir, branch, head }`, `head` being the full sha it landed on. **Checked against that project's grant and not the machine's**, and a project the password does not cover answers `404` **in the same words** a project that is not in the workspace gets — anything else would let a narrow password enumerate the machine by reading the difference. §12.5's collision is a `409` naming both branches; a project whose remote this machine has lost is a `409`; a branch nothing resolves is a `404`; a volume that could not be read is a `503`, never an empty one. It answers synchronously and can take tens of seconds: a fetch plus a clone that really copies objects (§12.9), with no action-table scope to stream through |
| `POST /api/p/:project/w/:slug/session` | **Adopts a worktree** (§12.10.1): makes a session holding that worktree's code, its uncommitted work carried across on top, under a name derived from the branch. Takes **no body** — the branch, the commit and the name are read from the worktree, because a caller supplying any of them would be sending what it read on its last poll. Answers `201` with `{ session, repo, carried }`, `carried` being how many files of uncommitted work arrived. **The worktree is never modified, moved or removed**, which is what makes a failure safe to unwind: a clone or a carry that fails takes the session away again and reports the original reason. A project, worktree or directory that is not there is a `404`; a project with no remote, a worktree on no nameable branch and §12.5's collision are `409`; an unreadable volume is a `503`; a carry that failed is a `500` naming any session the rollback could not remove. It takes tens of seconds and answers one body, for `POST …/repos`'s reason |
| `GET /api/sessions/:session/r/:runtime` | The session's view of one runtime, which is the body `GET /api/p/:project/s/:slug` answers. A runtime is a sandbox, and it has one description (§12.4) |
| `POST /api/sessions/:session/runtimes` | Starts one, from a runtime `name`, a `repo`, a `branch` and an optional lifetime. Refused unless that checkout is on this session's work volume (§12.6.1.1). A taken runtime name is a `409` carrying core's own sentence. It can take as long as building the project's image. Answers the runtime **core really started** and its URLs — the route derives no slug, because the ceiling that shapes one is declared by a `sandboxr.yaml` the host has no copy of (§12.2) |
| `POST /api/sessions/:session/r/:runtime/stop` | Stops it, removing nothing. Already stopped is a `200` that says it changed nothing |
| `DELETE /api/sessions/:session/r/:runtime` | Removes its container and its volumes. **No `force`, and one that is offered is refused** (§8.1), exactly as on the session delete |
| `GET /api/sessions/:session/repos/:project/:dir/files`, `…/diff`, `…/diff/file` | §7.4's two read-only views, against the **workstation** container rooted at `/work/<repo>/<dir>`. The reader is the same one the sandbox routes use and knows which of the two it is talking to only by the container and root it is handed |

**The sentence a delete confirms with travels on the session** (§7.1: the server owns the wording of
a destructive confirmation), because what is lost is a fact about that session — a session with
three runtimes loses three databases. It is counted from **every** runtime, including the ones a
narrow password cannot see, since a confirmation that understated what it destroys would be worse
than none.

**A runtime carries a second such sentence of its own**, and the two are not interchangeable:
deleting a session takes the work volume with it and nothing in there has a copy anywhere, while
deleting one runtime takes a container and a database and leaves every clone alone. One sentence
for both would mean the browser wrote the other, which is the thing §8.1 rules out.

### 12.7 Lifetime

**The idle clock is the one in `packages/core/src/sandbox/expiry.ts` and it is not redesigned.**
`max(startedAt, lastActive) + ttl`, the deadline derived at read time and never stored, `ttl`
resolved by §4.3's ladder. Read that file before changing anything about lifetimes; the reasons
the deadline is not `created + ttl`, and not a boolean, are written there and each has already
cost somebody an afternoon.

A workstation's `lastActive` reads §3.4's signals, with one absent and three present:

| Signal | For a workstation |
|---|---|
| A request to its own hostnames | **none.** A workstation has no hostname (§12.2) |
| A dashboard route naming it | `…/sessions/<session>/…` in the router's access log |
| An agent run | `agent/runs.json`, joined on the **session** rather than on `project/slug` — `AgentRun.session`, which a run in a workstation fills in and a run in a sandbox leaves absent — and the transcript's mtime for when it last emitted |
| A socket held open on it | the mtime of `state/session/<session>/attach` |

**The keep marker is the "keep it up forever" toggle**, and it is the only exemption. A live agent
run and a held socket reach the clock as a `lastActive` of now, never as a second exemption — the
paragraph in `expiry.ts` explaining why is the same paragraph, for the same reason.

**Stopping a workstation never touches the work volume.** Code and data are retained until an
explicit delete, without exception and without a time limit. An idle session that comes back three
weeks later comes back to its clones, its branches and its uncommitted changes.

**A session's runtimes have their own clocks and are not stopped with it.** Each container answers
for itself: traffic to a runtime's apps holds that runtime up, the agent working holds the
workstation up, and a session whose workstation has been stopped may still be serving a runtime
somebody is looking at. Coupling them would mean an agent going quiet takes down a preview a
reviewer is reading, which is the failure the per-container clock exists to avoid.

### 12.8 Deletion

Three verbs, and each removes exactly its own list. Nothing removes more than it names.

| Verb | Removes | Leaves |
|---|---|---|
| **Stop** a workstation or a runtime | nothing at all — the container is stopped | every volume, every file |
| **Delete a runtime** | §3.3's list for that sandbox: the container, its `data`, `blob`, `bin` and `www` volumes, its `build/` files, its `logs/` directory, its attach and keep markers | **the work volume.** It is the session's, not the runtime's |
| **Delete a session** | everything: each runtime by the row above, then the workstation, then `sandboxr-work-<session>`, then `state/session/<session>/` | nothing |

**Deleting a runtime deletes that runtime's own data**, which is what a database volume is, and
that is the whole of it. The work volume holds the code every other runtime of the session is also
running from.

**Deleting a session is ordered, and the order is forced twice over** — the same two reasons
§3.3.1 gives: a volume cannot be removed while a container holds it, and the names of what has to
go are resolved from the session, so destroying the session's record first leaves orphans nothing
can find. Runtimes, then the workstation, then the volume, then the host files.

**`deleteSession` refuses nothing, and that is deliberate.** `deleteWorktree` refuses over
uncommitted changes (§3.3.1) because it can read them: the worktree is a directory on the host.
A work volume cannot be read while nothing is running, and the answer is then `unknown` and never
`none` (§12.5) — so a refusal built on it would fire or not fire depending on whether a container
happened to be up, which is a coin toss wearing a safety feature's clothes. The confirmation
belongs where the person is, which for a browser is §8.1's rule that it may not force a
destructive action at all. What core does instead is **report**: what went, and separately what
would not go, because a work volume docker will not release is the one failure here that leaves
real data on the disk and must not read as a clean delete.

**A session's host directory is created lazily**, the way `state/keep/` is: a session that is
never named, never kept and never attached to has nothing to record, and an empty directory per
session would be a set of paths that exist and mean nothing — the first thing a reader would take
for a manifest. A delete removes the directory whether or not anything else of the session is
left, because these three files are the part that can outlive every container without anything
noticing.

**Deactivating or idling a session keeps everything.** No timer anywhere deletes a work volume,
and none may be added.

**`gc` and `prune` never reclaim a work volume**, and this is a fourth rule beside the three in
§3.3. Both are built to remove volumes no container references, and **a work volume with no
container is the ordinary state of a stopped session** — the case their rule was written to catch
is here the case that must survive. It joins `sandboxr-claude` and the other shared volumes on the
never-reaped list, for a stronger reason: signing the machine out of an MCP server is recoverable.

### 12.9 What becomes of the host workspace

**`<workspace>/<project>/repo.git` is kept. `<workspace>/<project>/wt/` is not the model any
more.** The two halves of §4.1 have different fates, and the reasoning is different for each.

The bare clone stays, demoted from *where the work lives* to **the machine's local source of
objects and refs**, and it earns that on four counts:

- **A session starts by cloning, and cloning from a disk is not cloning from GitHub.** The saving
  is the network and the forge's rate limits, not the disk: a clone into a Docker volume crosses a
  filesystem boundary, so git's hardlink optimisation does not apply and the objects really are
  copied. On a large repository that is still the difference between seconds and minutes, every
  time a session is created — which is the operation the whole model exists to make cheap.
- **One fetch serves every session.** `fetchProject` (§4.1.3) already updates
  `refs/remotes/origin/*` in the one place, and `freshenBranch` already decides which commit a new
  checkout lands on. A session cloning from the forge directly would talk to it once per session,
  and would land on whatever refs it happened to get.
- **The host already reads it for things a container cannot.** §4.1.2's pull-request index is one
  `gh` call per *repository*, and the repository it is per is this one. Removing the clone would
  leave the dashboard with no per-repository object on the host at all.
- **It costs nothing to keep.** It is already there, already maintained, and already out of
  `git clean`'s reach by living under `SANDBOXR_HOME`.

Two of its rules are unchanged and one is reinforced. It stays **`--bare` with an explicit
`+refs/heads/*:refs/remotes/origin/*`, never `--mirror`** — §4.1's reason is that a mirror's
refspec force-updates `refs/heads/*` and would reset a branch a worktree has checked out, and
while worktrees exist that hazard is live; past that, a clone people cut sessions from still must
not have its local heads rewritten under it. The project list stays the **union** of the workspace
and `docker ps`, never a filter. And the clone is now a *source*, so §12.5's rule governs
everything cut from it: self-contained objects, `origin` pointing at the forge.

`wt/` is superseded. A worktree is a checkout on the host, and **nothing bind-mounts a host path
into a container any more**, so a host checkout has no reader. No worktree is cut for a session.
What this does not do is delete anything: §3.3.1, §4.1.1, §4.1.2 and §4.1.3 remain the contract
for the worktree-backed sandboxes on machines running today, and every one of them keeps working
exactly as written. `packages/core/src/pull.ts` in particular is not reasoning that dies with
`wt/` — fast-forward or refuse, divergence measured by patch and never by sha, a rewritten
upstream moved onto rather than refused, never `reset --hard` — and a session's clones need every
line of it.

### 12.10 What supersedes what

**This is the map between two contracts, not between two halves of one file.** §§1–11 are the
engine's and stay in `sandboxr`; §12 is Jef's and leaves with it (§2). While they share a file the
table below reads as it always did; once they do not, it is the page a reader of the product's
contract follows back to the engine's, and every right-hand entry is the product's own.

Nothing below is deleted. Each left-hand entry is a rule the engine still enforces, for everyone;
each right-hand entry is what Jef builds on top of it. **Where the two look like they disagree,
the engine's rule is the one that binds** — the product cannot change a sandbox's slug ceiling or
a volume's reclamation rule by describing it differently, it can only decline to use the thing.

| The engine (§§1–11) | Jef (§12) |
|---|---|
| §1 "one container per git worktree" | One workstation per session, and zero or more runtimes beside it (§12.1) |
| §3.1's slug, derived from a worktree or a branch | A runtime's slug, derived from the session and the runtime name (§12.2). The ceiling, the hash form and both budgets are unchanged and still bind |
| §3.1's collision token, and §4.2.3's record of it | Not used by a session. A session's slugs are deterministic, so there is nothing to write down (§12.2). Both remain the contract for worktrees |
| §3.2's hostnames | **Unchanged in every respect** (§12.2). Only the slug's origin moves |
| §3.3's container, volume and image names | Unchanged for a runtime. Two new names beside them: `sandboxr-ws-<session>` and `sandboxr-work-<session>` (§12.2) |
| §3.3's reclamation rules | Unchanged, plus a fourth: a work volume is never reclaimed (§12.8) |
| §3.3.1 deleting a worktree | Deleting a session (§12.8), ordered for the same two reasons |
| §3.4's labels | Unchanged on a runtime, plus `sandboxr.kind` and `sandboxr.session` on everything (§12.3) |
| §3.4's four activity signals | Three of the four for a workstation, re-keyed on the session (§12.7) |
| §4.1's `repo.git` | Kept, as the local source of objects and refs (§12.9) |
| §4.1's `wt/<branch>` | The work volume, `/work/<repo>/<branch>` (§12.5) |
| §4.1.1's `Worktree` type | Not what a session lists. A session holds repositories and branches inside its volume, and may hold none (§12.1, §12.5) |
| §4.2, §4.2.1, §4.2.2 | The same three files with the same arguments, under `state/session/<session>/`, plus a fourth of §12's own — `adopted` (§12.6) |
| §5, §6, §7.1, §8 | Unchanged. They are about a runtime, and a runtime is a sandbox |
| §7.3's git mounts | Not used by a runtime: a clone on a work volume is self-contained and needs no identical-path mount (§12.4). §7.3's other two rules — the commit identity, the GitHub token — are unchanged, and the mounts remain the contract for a worktree |
| §7.2's "agent session" on a worktree | A Run in a workstation, keyed on the session (§12.1, §12.7). The Run / Thread / Event model is untouched |
| The dashboard's sidebar of worktrees | The sidebar of sessions. The worktree list is the `/worktrees` pane at every width, and a project's own pane is where one is managed from — both still list exactly what §4.1.1 reports |
| The dashboard's **New worktree**, and `/new` | Nothing. Code is added to a session instead, with `POST /api/sessions/:session/repos` (§12.5). Starting a sandbox on an existing branch is unchanged and is still a Start on a project's pane; **cutting a new branch from a base has no button any more** |

Four rows the other way round — engine capabilities that exist *because* §12 needed them, and
that any embedder may use:

| The engine offers | Jef uses it for |
|---|---|
| A sandbox started on a workspace somebody else resolved: mounts, git facts and a slug handed in, rather than a worktree on the host (§12.4) | A runtime on a work volume, which the host has no checkout of. The staging, and the disposing of it, are the product's |
| `sandboxr-work-` reserved, never reclaimed (§3.3) | The work volume (§12.5) |
| `share:` in the machine's config (§4.3) | The host's Claude credential, into `/root/.claude/.credentials.json`. `jef init` writes the row |
| `sandboxr.frontend` and `AccessReport.frontend` (§7.5) | The dashboard on the bare domain. `jef init` starts it; `sandboxr init` only prepares the domain |

#### 12.10.1 Adopting a worktree

The map above says what replaces what, and leaves one thing out: the worktrees that are already on
the machine. Every sandbox on any real machine today runs on one, somebody has been working in them
for a week, and the session model arrived afterwards. **Adoption is the one operation that crosses
that gap** — one action, repeatable, that makes a session holding a worktree's code under a name a
person can read.

`POST /api/p/:project/w/:slug/session` (§7.1, §12.6.2), `adoptWorktree` in
`packages/core/src/session/adopt.ts`.

**Adoption copies. It does not migrate.** The worktree is never modified, moved or removed — not by
the operation and not afterwards. A worktree that has been adopted is still a worktree, its sandbox
still runs, and it can be adopted again. That is not politeness: a person presses this to *try* a
session, and an operation that consumed the thing it was pointed at would make trying it the
irreversible act. It is also what makes a failure safe to unwind — see the rollback below.

**The commit is the worktree's own HEAD, and no fetch runs.** `POST …/repos` beside it goes through
`freshenBranch` (§4.1.3) and lands the session on whatever origin holds; adoption must not. The
request is "give me a session holding *this*", and moving the checkout to origin's head before
applying a patch built against an older commit would either fail to apply or apply somewhere nobody
asked for. The sha always resolves in the project's bare clone, because a worktree shares its object
database (§12.9) — including for commits that exist nowhere else on earth.

**The uncommitted work comes across, or the adoption fails.** This is the whole difficulty. A
session's code is a clone (§12.5) and a clone carries committed state only, so a worktree with
twenty modified files adopted naively becomes a session that looks right, is missing a week, and
says nothing about it — on a branch whose author has no reason to go looking.

It is carried as **one patch**, `git diff --binary HEAD`, applied by a second short-lived container
to the clone that was just checked out at that same commit. Four things follow, and each was a
decision:

- **The patch cannot fail on context, by construction.** The destination is the exact tree the patch
  was generated against. That is what makes this safe to do unattended.
- **`--binary`, so a changed image or a lockfile git treats as binary survives.** A git binary patch
  is base85, which is plain ASCII, so the patch is also safe to carry as a string on the way to the
  daemon.
- **A copy of the working tree was rejected**, and not on taste. A copy carries what git deliberately
  does not — `node_modules`, `dist/`, a `target/`, gigabytes of it built for the host's architecture
  — and excluding it means reimplementing `.gitignore`. A copy also **cannot express a deletion**: a
  file removed but not committed is simply absent, and copying an absent file over a clone that still
  has it loses the deletion silently. And a copy has to mount the worktree into a container, which is
  a write path onto somebody's checkout for the life of that container. The patch means **the
  worktree is never mounted anywhere at all**.
- **Untracked files are in the patch, and reading them writes nothing.** `git diff HEAD` says nothing
  about a file git has never been told about, and the usual way to make one visible is
  `git add --intent-to-add`, which writes the index — and the index is part of the worktree. So the
  index is copied first and git is pointed at the copy: `GIT_INDEX_FILE` takes every write,
  `GIT_OBJECT_DIRECTORY` takes the one object `--intent-to-add` records, and
  `GIT_ALTERNATE_OBJECT_DIRECTORIES` keeps the real object database readable. Without the object
  redirection git writes the empty blob into the *project's shared bare clone* — harmless in itself,
  and still a write into a repository three other worktrees share, made by an operation that said it
  would copy. **`GIT_OBJECT_DIRECTORY` must name a directory that already exists**: `is_git_directory`
  checks it, so pointing at one that does not yet exist makes every command answer
  `fatal: not a git repository` about a worktree that plainly is one.

**What does not come across is said out loud rather than discovered.** Ignored files — `.env`,
`node_modules`, build output — are not carried: a runtime installs its own dependencies, §6 is where
a project's secrets come from, and a session seeded with the host's `.env` would be a credential
copied by a button nobody expected to copy one. The staged/unstaged split is flattened, because
`git diff HEAD` is one comparison; everything arrives unstaged. Stashes and other branches are in the
bare clone and the session can fetch them.

**A failure after the session exists is rolled back.** If the clone or the carry fails, the session
just made is deleted and the original refusal is reported. That is safe *only* because adoption
copies: every byte it held is still in the worktree. A half-adopted session left on the machine
would be worse than the refusal — a workstation whose volume holds a clone with a week missing,
which is exactly the outcome this exists to prevent. A rollback that itself fails names the session
it left, because then there really is something for a person to deal with.

**The name is derived and the id is not.** §12.2 is unchanged: the id is `sanitizeSlug` of whatever
name the session ends up with, bounded at 31, and is the address. The *name* is a label, and
`sessionNameForWorktree` in `packages/core/src/session/adopt-name.ts` derives it — in core, because
a name derived in the dashboard and a name derived by a future `sandboxr session adopt` would
eventually differ, and what they would differ about is what a person picks a session out of a list
by. The rule, in order:

1. **A name somebody already gave the worktree wins, untouched** (§4.2.1). It is the only sentence
   on the machine a person actually wrote about this work.
2. **Otherwise the branch, read as words.** `claude/eng-3850-top-navbar-parity` is three facts stuck
   together — a namespace, a ticket and a description — and only the third is a name. The leading
   path segments go, a leading tracker key goes (`eng-3850`, `ENG4042`, either spelling), and what is
   left is sentence-cased: **"Top navbar parity"**. A branch that is *only* a ticket keeps it — "Eng
   4042" beats nothing.
3. **Otherwise the slug**, which is at least the address on screen.

It is bounded at §4.2.1's 60 code points, cut at a word boundary where one is late enough to use,
because `normaliseDisplayName` **refuses** an over-long name rather than truncating it — so an
unbounded derivation would be an adoption that failed on a branch somebody happened to name at
length.

**A worktree that already has a session says so rather than offering a second.** The join is
`state/session/<session>/adopted` read the other way round (§12.6): `GET /api/workspace` and
`GET /api/projects/:project` list every session, group the records by `<project>/<slug>`, and put
the ids on `WorktreeDto.sessions`. Empty means nobody has adopted it. A second adoption is not
forbidden — adoption copies — but the ordinary reason to press the button twice is not knowing the
first one worked. A session deleted takes its record with it, because the record is in the session's
state directory and §12.8's last step removes the lot, so the list can never name a session that is
not there.

**What has been run, and what has not.** The happy path has been driven end to end against a real
daemon and a real project — a 1&nbsp;GB monorepo with three worktrees on it:

- **A clean worktree**, adopted in eighteen seconds, `carried: 0`. Its session took its name from
  the worktree's own display name, which is rule 1 above.
- **A worktree with twenty uncommitted files** — eighteen modifications, a deletion and a
  rename-with-modification — adopted in sixteen seconds, `carried: 20`. Its session was named
  **"Top navbar parity"** from `claude/eng-3850-top-navbar-parity`, which is rule 2.
- **The uncommitted work was checked rather than assumed.** The session's checkout and the worktree
  were diffed against their common HEAD with the same normalisation on both sides
  (`--binary --no-renames --full-index`, over a scratch index so untracked files appear in both):
  **byte-identical**, one sha256 over 54,170 bytes and 21 paths. The clone was checked for §12.5's
  two traps as well — `origin` is the forge's URL and there is no `objects/info/alternates` — and
  its upstream resolved to `origin/claude/eng-3850-top-navbar-parity`, which is true only if the
  fetch of the mirror's `refs/remotes/origin/*` landed.
- **The join was checked from the other end**: `GET /api/workspace` named each adopted worktree's
  session and left the third worktree's `sessions` empty.
- **Two refusals**, a worktree that is not there and a project that is not there, both `404`.
- Both sessions were then deleted, and all three worktrees were byte-identical to how they were
  found — the dirty one still carrying its twenty files, and the named one still named.

**Not run against a daemon**: the narrow-password refusal, the rollback, and the `409`, `503` and
`500` answers. Those are tested against a fake core and a fake daemon. **The browser half has not
been opened in a browser** — it is tested in jsdom, which is the same thing §12's preamble says of
everything else there.
