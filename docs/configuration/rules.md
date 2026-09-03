---
title: The rules a config must obey
description: Every constraint on a sandboxr.yaml in one place, each with the symptom you see when you break it.
---

A config that parses can still be wrong. This page collects every rule sandboxr enforces,
what you see when you break it, and what to change. Read it when something is refused, or
read it once before writing a config so nothing here surprises you.

```prompt
Diagnose why a sandboxr config is being refused.

Read docs/configuration/rules.md and match the exact error text against the table there.
Run `sandboxr config` to see what the file resolved to. Fix the field the error names.

Stop and tell me if the fix would change what data the sandbox is seeded from, or would
make a public project private, or the reverse — those are decisions about who can see
real records, not typos.
```

Errors take one shape, so they are easy to read:

```
/home/you/acme/sandboxr.yaml: frontends.app: needs an `out` directory or a `serve` command
```

The file, then the field, then what is wrong. The file named is the one whose author has to
edit it.

## Naming and hostnames

**A hostname label must be unique within a project.** Every runtime answers on
`<slug>.<label>.<project>.<domain>`, so two runtimes sharing a label would share a hostname
and one of them would be unreachable. Backends and front-ends share one namespace.

> `label "app" is already used by backend api`

**Every backend `name` must be unique.** The name is the binary's name and a `routes`
target.

> `two backends are called "api"`

**A label is a hostname label.** Lowercase letters, digits and dashes, not starting or
ending with a dash, at most 63 characters. So is `project`.

> `must be a hostname label: lowercase, digits and dashes`

## The slug

You do not write the slug in the config. sandboxr derives it, and two of its properties can
surprise you.

**The alphabet is `[a-z0-9-]`.** Anything else in a branch or directory name is folded to a
dash, runs of dashes collapse, and leading and trailing dashes are trimmed.

**The ceiling is 31 characters.** Over that, the slug becomes the first 22 characters, a
dash, and the first 8 hex characters of the SHA-256 of the **original** name.

Hashed rather than truncated, and that is load-bearing. Two similar branch names truncate
to the same string, and the two sandboxes would then share one database lock.

<details class="agent">
<summary><b>Details for an agent</b> — how a slug is derived, why it is hashed, and the lock-name budget</summary>

From `packages/core/src/naming.ts` (rules 3 to 6) and `packages/core/src/worktree-slug.ts`
(rules 1 and 2, and the resolver `slugFor` that puts them in this order):

1. An explicit argument (`sandboxr up my-slug`), if non-blank.
2. A slug recorded for this worktree at
   `~/.sandboxr/state/slug/<project>/<worktree dir>`, written when the slug it would
   derive was already another worktree's.
3. A ticket id in the worktree directory's **basename**, matched by
   `/[a-z]+-[0-9]+/i`.
4. The same pattern in the branch name.
5. The branch name itself — unless it is `HEAD`, which is what git reports for a detached
   worktree and names nothing.
6. The worktree directory's basename.

Rules 3 to 6 are `deriveSlug`, which is pure. Rule 2 reads a file, which is why the order
lives in `slugFor` and why every caller — `up`, the dashboard, the CLI — goes through it.

If none of those exist: `NamingError: cannot derive a slug: no explicit name, worktree or
branch`. A name that sanitises to nothing gives
`slug "…" is empty after sanitising`.

Constants: `SLUG_MAX = 31`, prefix kept `22`, hash length `8`. A ticket id wins over the
rest of the name because it is what makes a slug readable: `tkt-4821` rather than
`feat-tkt-4821-rework-the-thing`.

The ceiling exists to bound the advisory lock name
`sandboxr_migrate_<project>_<slug>`, which MySQL's `GET_LOCK` truncates silently at 64
characters. Over budget, `lockName()` throws rather than colliding.

Why hashed and not truncated: `feature/checkout-redesign-part-one` and
`feature/checkout-redesign-part-two` truncate to the same string. Two sandboxes would then
share one advisory lock, and one migration would silently wait on the other. Raising the
ceiling means re-checking the lock-name budget of every driver.

The ceiling is also why a *given* slug uses four random characters rather than a UUID.
`sandboxr worktree add` compares the slug a new worktree would derive against the ones its
siblings resolve to, and on a match assigns `<base>-<token>` with `<base>` trimmed so the
whole thing still fits in 31. A 36-character UUID would not, and would be unreadable if it
did.

</details>

## The version constraint

**`sandboxr:` must be satisfiable by the tool you are running.**

> `needs sandboxr >=0.2.0, and this is 0.1.0 — upgrade the tool, or relax the constraint`

**And it must be a constraint sandboxr can parse.**

> `"latest" is not a version — expected something like ">=0.1.0"`

Accepted comparators are `>=`, `<=`, `>`, `<`, `^`, `~` and `=`. A space or a comma between
terms means AND; `||` separates alternatives; `*` or an empty string accepts anything.

## The database

**One writer per file-backed database.** With the `d1` or `sqlite` driver the database is a
single file, and two processes that open it deadlock. So the config names the single service
allowed to open it.

> `a d1 database admits one writer, so it must name the service that owns it (one of: api, app)`

`database.owner` is required for `d1` and `sqlite` whenever the project declares more than
one runtime. With exactly one runtime you may leave it out, and sandboxr resolves it into
the plan for you.

The plan itself may never leave it out. The container withholds the database's location from
every service that is not the owner, so an absent owner there means nobody gets it.

**`owner` must name something you declared.**

> `"web" is not a declared backend or front-end`

The value is a backend `name` or a front-end `label`.

**A driver must have something to do.**

> `a driver with neither a seed nor a migration has nothing to do`

Set `driver: none`, or add `seed_from`, or add `migrate`.

**A file-backed runtime must be pointed at the sandbox's own state.** This one is
**advice, not a refusal** — `sandboxr doctor` reports it and `up` proceeds anyway.
[Databases](../databases.md) has the detail.

<details class="agent">
<summary><b>Details for an agent</b> — what has to name the state directory, and the three symptoms when nothing does</summary>

Both the `migrate` command and the owner's `serve` command have to direct the runtime at
the sandbox's state directory — `--persist-to "$SANDBOXR_D1_DIR"` for wrangler.

It is advice rather than a refusal because a project can point its runtime at the right
place through a config file sandboxr cannot read. A refusal has to be certain, and this one
cannot be.

The symptom, when it is genuinely missing, is three things at once and none of them is an
error:

1. The sandbox's database lands in your branch and shows up in `git status`.
2. Two sandboxes from one worktree share a file.
3. `sandboxr down` no longer removes the database.

</details>

## Runtimes

**A backend needs a build command**, on the entry or in `defaults`.

> `has no build command, and backends.defaults sets none`

**A static front-end needs both a build and an output directory.**

> needs an `out` directory or a `serve` command
>
> has no build command, and frontends.defaults sets none

**A served front-end needs a port.** It is reached by proxy, so without a port there is
nothing to send traffic to.

> is a server, so it needs the `port` it listens on

**No entry is both.**

> is both a static build (`out`) and a server (`serve`) — pick one

**A compiled backend needs a `toolchain`.** Nothing checks it. The config is accepted and
that service's log later says `go: command not found`.

**A heavy front-end build needs `memory:`.** The default sandbox limit is 4 GB, and a build
over it is killed with no mention of memory. Declare `memory: 6g` on the app that needs it.

**A service that cannot possibly start should be left out, or marked `optional`.** Nothing
refuses it. Including it produces a permanent crash-loop that makes the sandbox look broken.

<details class="failure">
<summary><b>If it goes wrong</b> — the two rules nothing refuses, and what they look like instead</summary>

**No `toolchain`.** `toolchain.go` and `toolchain.node` decide what goes into your
project's image layer. Declare a Go backend with no `toolchain.go` and the config is
accepted, the sandbox starts, and that service's log says `go: command not found` — a
message which never mentions `sandboxr.yaml`.

**No `memory:` on a heavy build.** A build that renders many pages across several worker
processes is not bounded by any single heap limit. The cgroup total is what the kernel
enforces. From outside, that looks like a bare `Killed` and a package manager's exit code
137, neither of which says anything about memory.

Declaring `memory: 6g` on the app does two things. It raises the whole sandbox's limit,
because the largest limit any runtime asks for wins. And it lets the build refuse in a
second instead of dying part-way:

```
'www' declares it needs 6g to build; this sandbox has 4 GB.
```

That message suggests a variable nothing reads. The container's build script follows the
line above with `SANDBOXR_MEMORY=6g sandboxr up`, and nothing on the host reads
`SANDBOXR_MEMORY` today. The working fix is the one the host's own output gives: set
`memory` on that app in `sandboxr.yaml` and start the sandbox again.

</details>

## Routes

**A route's outer key must be a declared front-end label.**

> `no front-end is labelled "app"`

**A route's target must be a backend name or a served front-end label.**

> `"api" is neither a backend nor a served front-end`

A static front-end cannot be a route target. It has no port and no process.

Both are checked when the config is read, because a typo here is a 404 in a browser with
nothing in any log.

## Public projects: the two refusals

If `access.apps` is `public`, two things must hold. Both are refusals rather than
warnings. Neither failure can be undone: leaked records stay leaked, and money spent
calling somebody's API stays spent.

**1. A public project refuses a non-anonymised dump, and refuses a live fork.**

| `seed_from` source | `public` | `private` |
|---|---|---|
| `fixtures` | allowed | allowed |
| `file` with `anonymised: true` | allowed | allowed |
| `file` without it | **refused** | allowed |
| `local` — forking a database you run | **refused** | allowed |

Listing several sources is **not** a violation. A config is refused only when none of its
sources is permissible, because which source a run uses depends on the machine.

**2. A public project refuses real third-party credentials.** Anyone who can drive a public
app can otherwise make it send real email and spend real credit.
[Access and security](../access.md) explains the tiers.

<details class="agent">
<summary><b>Details for an agent</b> — the exact wording of both refusals, and when each is checked</summary>

The seed refusals are checked when the config is read:

> a public sandbox cannot be seeded by forking a live database — a public URL over real
> records is a data leak. add database.seed_from.fixtures, mark a dump `anonymised: true`,
> or set access.apps to private
>
> a public sandbox may only restore a dump that is explicitly marked anonymised. add
> `anonymised: true` beside the file if it is anonymised, or set access.apps to private

The credentials refusal is checked when a sandbox starts rather than when the config is
read, because it depends on whether this machine's secrets file for the project **holds
anything**. An empty file carries no credentials and is not refused:

```
acme serves public apps, so it may not carry the real credentials in
/home/you/.sandboxr/secrets/acme.env
  Either set access.credentials to real (and accept that), or set access.apps to private.
```

</details>

## Where the file lives, and what it governs

**The config lives at the root of the project being sandboxed.** sandboxr walks *up* from
the directory you ran the command in, trying `sandboxr.yaml`, `sandboxr.yml` then
`.sandboxr.yaml` in each directory.

> `no sandboxr.yaml here or in any parent directory — a project describes itself in one at its repo root`

The directory holding the file is what gets mounted at `/workspace`. That is the config's
directory, not the git top level, so a project kept in a subdirectory of a larger repository
is mounted at the right level.

**`root` may never be a workspace project directory.** A project sandboxr manages lives at
`<workspace>/<project>/`, which holds `repo.git` and every worktree of it. Mounting that as
`/workspace` would put all of them inside one sandbox, so it is refused outright. Run from a
worktree instead.

<details class="agent">
<summary><b>Details for an agent</b> — the refusal's exact wording, and the project-level config fallback</summary>

Mounting the project directory would also resolve every declared path one directory too
high, and none of the failures that follow looks anything like a wrong root. The refusal:

> `is the project-level config for a managed project, so it cannot be run from /home/you/.sandboxr/workspace/acme — that directory holds repo.git and every worktree, and mounting it would put all of them in the sandbox. Run from a worktree under /home/you/.sandboxr/workspace/acme/wt, where this file applies on its own`

A worktree is a separate checkout, so an **uncommitted** `sandboxr.yaml` in one worktree
does not exist in any other. For that case only, a managed project may keep a config beside
its mirror at `<workspace>/<project>/sandboxr.yaml`, and every worktree of that project
that carries none of its own uses it.

Three rules, all load-bearing:

1. **A worktree's own config always wins.** The project-level file is a fallback, never an
   override.
2. **`root` is always the worktree.** The project-level file is read for its content only;
   every path it declares still resolves inside the branch's own checkout.
3. **The search is bounded at the top of the worktree.** An unbounded walk-up would leave
   the checkout and land on the project-level file on its own. `root` would then be that
   file's directory, which is rule 2's failure exactly.

`ResolvedConfig.origin` is `repo` when the file is inside `root` and `project` when it is
the workspace fallback. `sandboxr config` prints it. This is the one place
`root === dirname(file)` does not hold; code wanting the directory a declared path resolves
against wants `root`, or `projectPath()`.

See [Projects, worktrees and lifetimes](../guides/managed-sandboxes.md).

</details>

Two more file-level errors: `is not valid YAML: …` and `is empty`.

<details class="facts">
<summary><b>Fact sheet</b> — every constraint, its field, and whether it refuses</summary>

| Rule | Field named | Refuses? | Checked when |
|---|---|---|---|
| `project` and `sandboxr` present | the missing one | yes | config read |
| `project` matches the hostname alphabet | `project` | yes | config read |
| No unknown keys anywhere | the key | yes | config read |
| `sandboxr` parses as a constraint | `sandboxr` | yes | config read |
| `sandboxr` is satisfied by this tool | `sandboxr` | yes | config read |
| Labels unique across backends and front-ends | `backends.<name>` / `frontends.<label>` | yes | config read |
| Backend names unique | `backends` | yes | config read |
| Backend has a build | `backends.<name>` | yes | config read |
| Static app has `out` | `frontends.<label>` | yes | config read |
| Static app has `build` | `frontends.<label>` | yes | config read |
| Served app has `port` | `frontends.<label>` | yes | config read |
| Not both `out` and `serve` | `frontends.<label>` | yes | config read |
| Route key is a declared front-end label | `routes.<label>` | yes | config read |
| Route target is a backend or served front-end | `routes.<label>."<prefix>"` | yes | config read |
| Non-`none` driver has a seed or a migration | `database` | yes | config read |
| `d1`/`sqlite` with 2+ runtimes names an `owner` | `database.owner` | yes | config read |
| `owner` names a declared runtime | `database.owner` | yes | config read |
| Public project has a permissible seed | `database.seed_from.local` / `.file` | yes | config read |
| Public project's secrets file holds nothing | — | yes | `sandboxr up` |
| `root` is not a workspace project directory | — | yes | config read |
| File is valid, non-empty YAML | — | yes | config read |
| Front-end build fits the sandbox's memory | — | yes | build time, in the container |
| Migrate/serve command mentions the state variable | `database.migrate.command` / `frontends.<label>.serve` | **no** — `doctor` advice | `sandboxr doctor` |
| A compiled backend has a `toolchain` | — | **no** | never; fails at build time |
| A service that cannot start is omitted | — | **no** | never; crash-loops |

Defaults filled in during resolution: `database.driver` → `none`; `storage` →
`{ driver: none, buckets: [] }`; `access` → `{ apps: public, controls: password,
credentials: dummy }`; `static_mode` → `spa`; `in_build_all` → `true`; `optional` →
`false`; `deps.lockfile` → `package-lock.json`; `deps.install` →
`npm ci --no-audit --no-fund`; `frontends.root` → `""`; `routes` → `{}`; `env` → `{}`.

Constants: slug ceiling 31, prefix 22, hash 8; hostname label ≤ 63; port 1–65535; memory
floor `4g`; MySQL lock-name ceiling 64.

</details>

**Next:** [sandboxr.yaml, field by field](sandboxr-yaml.md) for what each field means, or
[Troubleshooting](../troubleshooting.md) for symptoms that are not about the config.
