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
**Jef's**, and it is defined in Jef's contract — §9 there, with §9.10 as the map from each rule
here to what Jef builds on it. An engine rule is never bent to suit a
session: the engine is handed a workspace and starts a container on it.

## 2. Two repositories, and the one rule between them

This tree is being split in two, and the boundary is the reason this file exists.

- **The engine, `sandboxr`.** `packages/core`, `packages/cli`, `packages/docs`, `packages/tokens`,
  `container/`, `docs/`, `examples/`. It turns a git worktree into a running copy of a project on
  its own hostname. It knows about worktrees, sandboxes, images, volumes, a router and a
  certificate. It knows nothing about agents, sessions or Jef.
- **The product, `Jef`.** `packages/server`, `packages/web`, `packages/sessions`,
  `packages/orchestrator`, `packages/voice`, `packages/telegram`,
  `packages/orchestrator-daemon`, `sidecars/`, `container/jef-base/`, and the dashboard,
  orchestrator and workstation containers. It is an agent you talk to, built on the engine.

```
packages/core      @sandboxr/core     engine   Config, drivers, docker orchestration, lifecycle
packages/cli       @sandboxr/cli      engine   The `sandboxr` command
packages/tokens    @sandboxr/tokens   engine   One stylesheet, tokens.css, and the fonts it imports
packages/docs      @sandboxr/docs     engine   The documentation site
container/         (no package)       engine   What runs INSIDE a sandbox: Dockerfiles, s6, scripts — except jef-base/
examples/          (no package)       engine   Example sandboxr.yaml files
packages/sessions  @jef/sessions      product  Sessions, the agent that works in one, and reading the code it changed
packages/server    @jef/server        product  The dashboard's server: auth, JSON API, terminal, actions
packages/web       @jef/web           product  The dashboard's browser app: React, Tailwind, built by Vite
container/jef-base (no package)       product  The agent layer on the base image: claude, and nothing else
sidecars/          (no package)       product  The audio body: Python, by necessity
docker-compose.yml (no package)       product  The whole constellation, in one file
```

**The engine ships no `docker-compose.yml` and no `.env.example` describing one.** It is a CLI
and a router; a constellation of long-running services is what a product assembles out of it.

**This file is the engine's contract. Jef's is `docs/jef/contracts.md`**, in the `meet-jef`
repository — deliberately not a link, because the two files are about to stop sharing a tree. It
holds what used to be §§7.1, 7.2, 7.4, 10, 11 and 12 of this one: the dashboard's HTTP
surface, agent sessions, reading code in a container, the orchestrator, the compose file and the
session model. Where the two look like they disagree, **this one binds** — Jef cannot change a
slug ceiling or a volume's reclamation rule by describing it differently, it can only decline to
use the thing. Jef's §9.10 is the map from each rule here to what Jef builds on it.

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
session is; it takes a parameter. A workspace somebody else resolved, activity somebody else
knows about (§3.4), a file the machine says to share (§4.3), a front end somebody else runs
(§7.2) — each of those is an argument the embedder supplies, never a hook the engine reaches
through.

Ownership rule: **only `container/` contains bash.** Everything host-side is TypeScript.
The container scripts are deliberately shell because they run under s6 with no toolchain
guarantees, and because they are ported from a working implementation.
## 3. Naming

### 3.1 Slug

A slug identifies one sandbox. **A session's runtime is a sandbox and carries a slug like any
other; where that slug comes from is Jef's §9.2, and every rule below — the ceiling, both budgets, the
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
workstation has no hostname at all (Jef's §9.2). Nothing in Jef's §9 may be read as licence to relax the
one-label rule or the `--` separator.

The dashboard lives on the bare domain and **never** on a per-sandbox hostname. The
terminal is a route *within* the dashboard (`/p/<project>/s/<slug>/terminal`), so it
inherits the dashboard's session automatically. Do not give the terminal its own hostname.

The paths under that one hostname are Jef's §3.

### 3.3 Docker names

- Container: `sandboxr-<project>-<slug>`
- Session containers and volumes: `sandboxr-ws-<session>` and `sandboxr-work-<session>` — Jef's §9.2
- Network: `sandboxr` (one, shared)
- Volumes: `sandboxr-<purpose>-<project>-<slug>` where purpose is one of
  `data` (database), `blob` (object storage), `bin` (built binaries), `www` (built sites).
- Shared volumes, the engine's own: `sandboxr-deps-<hash>` (node_modules, keyed on lockfile),
  `sandboxr-gocache`, `sandboxr-gomod`. `SHARED_VOLUMES` names the last two and nothing else.
- **An embedder's shared volume is the embedder's**, mounted by handing `up` a
  `UpOptions.volumes` row and reserved by naming it in `protectVolumes`. Jef's is
  `sandboxr-claude`, an agent's credential store at `/root/.claude` with `CLAUDE_CONFIG_DIR`
  pointing at it — Jef's §4. The engine mounts what it is handed and has no name for any of it.

**A shared volume is populated only when it says so itself.** `sandboxr-deps-<hash>` is
filled in by the container on first boot, and *shared*: every sandbox on that lockfile
mounts the same one. A boot interrupted part-way through the copy leaves a directory that is
non-empty and incomplete, so "non-empty" cannot be the test for "installed" — it poisons the
volume permanently, and every sandbox on the lockfile inherits a tree that is silently short
of packages. The container writes `node_modules/.sandboxr-deps` — the lockfile hash it
installed from — as the *last* step, by rename, and treats only that marker as done. Same
shape as a seed artifact's `.partial`, and for the same reason.

**An embedder's shared volume is shared by every sandbox on the machine, and the trade goes
with it rather than with the engine.** Jef's is the whole of that case: sharing the store is what
makes signing into an MCP server something you do once per machine rather than once per worktree,
and it means every sandbox can read every credential in it. That sentence is Jef's §4's to make,
because only Jef knows what is in the volume.

What the engine promises is narrower and holds whoever the embedder is. None of the shared volumes
is ever reaped when a sandbox is deleted (§ garbage collection), and neither is a volume of a shape
the engine did not mint — so an embedder's store is out of the collector's scope before any list is
consulted, and `protectVolumes` is what makes that a promise rather than luck about a spelling.

A path inside such a volume may come from the host rather than from the volume, and that is not a
special case: it is a `share:` row in the machine's `config.yaml` (§4.3), like any other host file
the operator shares. Jef's `jef init` writes the row that puts a stored login over the volume's
copy, so it is shared with every sandbox rather than duplicated into each. On macOS that file is
usually not a login at all, which has a consequence worth knowing. See Jef's §4.

Images are named under one namespace, and the split between them decides what may be reclaimed:

- Project layer: `sandboxr/<project>:<12 hex>`, the hash covering the tool version, the rendered
  Dockerfile and every staged manifest. Content-addressed, so every sandbox of a project shares one
  image and a rebuild is triggered by exactly the things the build reads.
- The machine's own: `sandboxr/base`, `sandboxr/dashboard` and `sandboxr/workstation` (Jef's §9.3),
  tagged by tool version and by `latest`. **All three are built by `init`**, and all three are on
  the never-reclaimed list. An embedder's own base is a fourth — Jef's is `jef/base`, the engine's
  base with an agent on it, built by `jef init` and named to `up` as `baseImage` — and it is
  **content-addressed on the engine base tag plus its own Dockerfile**, not tagged by tool version:
  it is one layer on a tag that is already a digest of everything below it, so a base rebuild has to
  move it or the two drift. The engine does not know its name. It is kept because the caller passes
  it as `protectImages`, which is unioned with the engine's own reservations and never replaces
  them.
- **`sandboxr/workstation` used to be built by the first `createSession` instead**, on the argument
  that a machine which never creates a session never needs it. That argument has expired on its own
  stated condition — "revisit when a session is the ordinary way to start work" — and a session now
  *is* the thing the dashboard is organised around. The cost of leaving it where it was is paid in
  the one place it must not be: the first **New session** on a machine took the several minutes of a
  `claude` install, in a request that answers one JSON body and has nowhere to stream a build log to
  (Jef's §9.6.2). A build belongs in the verb that sets a machine up, beside the other two, where it is
  expected to take a while and says so. `createSession` still calls `ensureWorkstationImage` and
  must keep doing so: `init` having built it is what makes a create fast, never what makes it
  correct, and the tag carries the tool version — so an upgrade invalidates it, and `init` is the
  verb somebody runs after one.
- **The base image's digest covers `container/base/` and `container/scripts/`, and nothing else.**
  Those are the two directories `base/Dockerfile` copies from, so they are exactly what the build
  reads. This is an allowlist because it used to be a deny-list naming `project/`, `examples/` and
  `workstation/`, and every directory that arrived under `container/` afterwards silently joined the
  digest — `workstation/` had to be noticed that way, and `dashboard/`, `orchestrator/` and
  `jef-base/` would each have had to be noticed again. Including any of them rebuilds the base for a
  change that cannot affect it: several minutes and several gigabytes, on the next `init`, for
  nothing. The allowlist also survives the repository split, where the engine's tree holds `base/`
  and `scripts/` and no others — a deny-list would have to name directories that are not there.

**Reclamation is a contract, not a heuristic.** `gc` removes sandboxes, the volumes they owned, and
the project images a newer build replaced. `prune` removes the same volumes and images with sizes
against them, and Docker's build cache when it is asked. Both are bound by five rules:

- The shared volumes above are never removed, by either — nor is any volume the caller reserved
  with `protectVolumes`, nor any name the engine did not mint. A store shared by every sandbox is
  referenced by none of them the moment they are all stopped, which is a machine at rest rather
  than a volume nobody wants, and taking Jef's would sign it out of every MCP server it has.
- **The engine reclaims only a volume name it can reconstruct, and never one under a reserved
  prefix.** Everything else in the collector reads "no container references it" as "nothing wants
  it". For a name the engine did not mint, that reading is exactly backwards — nothing on the
  machine can say what is in it, so an unrecognised name must read as "something holds it". This
  is §3.4's failure-is-an-absence rule applied where it costs the most.

  **`sandboxr-work-` is the reserved prefix, and it belongs to the embedder.** Jef's work volumes
  live under it (Jef's §9.5): a session whose workstation is stopped has no container at all, which is
  the ordinary state of a session somebody comes back to next week, and what would go is every
  clone and every uncommitted change in it. The engine promises never to reclaim one, without
  knowing what a session is. `isWorkVolume` in `packages/core/src/naming.ts` is the test, beside
  `WORK_VOLUME_PREFIX` which is the name it reserves.
- `sandboxr/base` and `sandboxr/dashboard` are never removed as superseded: they are tagged by
  version rather than by content, so "older tag" does not mean "replaced". An embedder adds its own
  names to that list by passing them, and `jef/base` is on it.
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
  protects. `--force` overrides both; a browser cannot (Jef's §6.1).

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
stray. Jef gives both labels a meaning in its own §9.3, and that meaning is Jef's.

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
| A **front end's** request path that names the sandbox — `…/p/<project>/[sw]/<slug>/…` (Jef's §3) | the **same** access log, under each front end's own router name, from the request path | opening a worktree, its logs, opening its terminal socket, opening its agent socket |
| Activity **somebody else knows about**, keyed `<project>/<slug>` | handed in by the caller — the engine reads nothing of its own for this | an agent working while nobody is watching (Jef's §4), or anything else an embedder can see and the engine cannot |
| A terminal or agent socket **held open** on the sandbox | the mtime of `state/attach/<project>/<slug>`, re-stamped by whatever holds the socket or the run (§4.2.2) | a session somebody is sitting in, or an agent running in one, for longer than the ttl |

**A front end is a container the embedder put on the bare domain, and the engine is told which
they are.** It carries `sandboxr.frontend` (§7.2) and answers on the domain itself rather than on
a sandbox hostname, so its lines in the access log are *about* sandboxes rather than *to* one:
the router name is the front end's, and the sandbox is named in the request path. The engine has
one route shape of its own here — `…/p/<project>/[sw]/<slug>/…`, which is how Jef's §3 addresses a
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

**`repo.git` survives the move to sessions and `wt/` does not** — Jef's §9.9 argues both, and the
rules in this section still govern the clone. A session's code lives in a Docker volume (Jef's §9.5)
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
the unit the sidebar was built from until the column became the list of sessions (Jef's §9).

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
decides nothing else about it: the state itself is the server's answer (Jef's §3).

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
(Jef's §3). Two workspace directories cloned from one repository share the call. Where several pull
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

**A session keeps the same three files with the same arguments, under a directory of its own
(Jef's §9.6).** The test below is what decides where any of them may live, and it is the test Jef
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
none, never the branch name), and the route is `PUT /api/p/:project/w/:slug/name` (Jef's §3). It is
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

**The engine builds the handshake and answers none of it.** It writes the router's labels and
knows which hostnames must be protected; the thing that decides whether a given request is allowed
is a front end on the bare domain, which is the embedder's (§7.2). So this section is a
mechanism, not a login.

- **An app hostname belonging to a `private` project gets a forward-auth middleware**, pointing at
  `GET /auth/verify` on the bare domain. Traefik calls it before the request reaches the sandbox
  and forwards it only on a 200. A `public` project's hostnames skip the middleware entirely, and
  that is the whole of the difference (§5.3 is what a public project must prove first).
- **The bare domain is the one address the middleware trusts**, and the container serving it
  claims it with `sandboxr.frontend` (§7.2). A container that holds that label is claiming to own
  the machine's authentication.
- **The forwarded host is how a verifier knows what is being asked for.** The engine sends the
  original hostname, so the front end can resolve which project the request is for and answer
  per project rather than per machine. Nothing else is forwarded, and nothing about the answer
  reaches the engine.

Non-negotiables, and they bind the engine and any front end equally:

- **Every request that reaches Docker is untrusted input.** Slugs, project names and branch names
  are validated against the patterns in this file before they reach a command, and commands are
  executed as argument arrays — never a shell string. `packages/core/src/naming.ts` holds the
  patterns, and they are the same ones §3.1 defines.
- **A private project is private on every hostname it has.** There is no per-app exception, and
  `access.apps` is read once when the routes are written, so a project that changes to `private`
  is protected on the next `up` and not before — which is why `sandboxr config` reports the
  resolved value rather than the file's.
- **No credential the engine handles is ever logged or echoed.** The secrets file (§5.2), the
  GitHub token (§7.1) and anything a `share:` row mounts (§4.3) are read and passed on; none of
  them appears in a log line, an error message or `plan.json`.

**Everything a control plane must do beyond this is Jef's §3**: the session cookie, the password
comparison, the rate limit on the login route, the content-security policy, and the rule that no
action endpoint is reachable without a session.

### 7.1 Git in a sandbox, and the GitHub token

**Git works inside a sandbox, and making it work is a mount rather than a setting.** A linked
worktree's `.git` is a *file* naming its repository by absolute path, so a container that has the
worktree and not the repository fails every git command — `status`, `diff`, `log`, `commit` — with
one `fatal: not a git repository` naming a host path. The rule, the same one the dashboard's
workspace mount follows: the worktree **and** the repository it points at are bind-mounted at the
**identical path inside and out**, on top of the worktree's mount at `/workspace`. `gitMounts` in
`packages/core/src/git.ts` decides which paths those are; a plain checkout needs neither, and a
project that is a subdirectory of a larger repository gets neither and is told so once.

**This whole section is about a worktree.** A session's runtime runs a self-contained clone on a work
volume and asks for none of these mounts — see Jef's §9.4, which is where the reasoning for that lives.
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

### 7.2 Putting your own control plane on the bare domain

The handshake of §7 needs something to answer it, and the engine offers nothing that does. **The
mechanism that puts a control plane on the bare domain is not Jef's** — it is
`access/router.ts`'s, and it needs only a name.

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

## 8. The verbs

What the engine can be asked to do, and the rules that hold whoever asks — the CLI, a cron job,
or a product that calls core in process. **The verb is the engine's; the button, the stream and
the confirmation dialog are not** (Jef's §6).

| Verb | Scope | What it does |
|---|---|---|
| `up` | worktree | Resolves the config, builds what is missing, starts one container, registers its routes |
| `down` | sandbox | Removes the container and its volumes, and the logs go with it (§3.3) |
| `stop`, `start` | sandbox | The container, without touching what it holds |
| `reload` | sandbox | Rebuilds what changed inside a running sandbox |
| `ls`, `status`, `logs`, `shell` | sandbox | Reads. `ls` and `status` are pure functions of `docker ps` |
| `keep`, `unkeep` | sandbox | Writes and clears `state/keep/…` (§4.2) |
| `expire` | machine or project | Stops every sandbox past its idle limit (§4.2, §3.4) |
| `gc`, `prune` | machine | Reclaims what the rules in §3.3 allow, and nothing else |
| `project` | machine | Clones, lists and fetches — the workspace of §4.1 |
| `worktree` | project | Cuts, names, pulls and deletes one. Every subcommand names a *branch* |
| `db` | sandbox | `seed`, `migrate`, `snapshot`, `shell`, through the driver of §6 |
| `secrets`, `config` | machine or project | The files of §5.2 and §4.3 |
| `init`, `teardown`, `doctor` | machine | The router, the certificate and the domain of §3.2 |

**A verb's scope is part of its identity**, and it answers "what does this act on", never "where
is the button drawn". `worktree pull` is the case that makes it load-bearing. It brings one
worktree up to its branch's head on the remote (§4.1.3), and it is scoped to the *worktree*
because a worktree exists whether or not a container does — the sequence it exists for is pull,
then restart, which starts from a sandbox that is stopped. Scope it to the sandbox and it is
unavailable at exactly the moment it is wanted.

**Every `worktree` subcommand names a branch, not a slug**, for a related reason: two worktrees
cut before the collision guard existed can still answer to one slug (§3.1), and the branch is the
name that cannot collide.

**Nothing has a lifetime unless something runs `expire`.** The engine has no reaper of its own and
starts no daemon: `sandboxr expire` is the whole mechanism, it is a pure plan followed by stops,
and it is meant to be run from cron. A machine that never runs it keeps every sandbox it ever
started. See [the CLI-only setup](../setups/cli-only.md).

**A refusal is the last word, and `--force` is the only override.** Where core refuses a
destructive operation because something would be lost — `worktree rm` or `worktree delete` on a
worktree with uncommitted work — it refuses and reports what it found; it does not ask. The
override is the CLI's `--force`, typed by somebody at the machine. A refusal carries whether it
is forceable at all, so a caller can say which of the two it is looking at, and that is the whole
of what a caller gets: **the engine offers no way to force a destructive operation without a
person**, which is why `--force` lives on the command rather than on an option of the call.

**An operation that refuses rather than destroying is not destructive.** `worktree pull`
fast-forwards or it refuses, so there is nothing a confirmation could name as lost — and
confirming an operation that cannot lose anything is what teaches people to click through the
ones that can.
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

