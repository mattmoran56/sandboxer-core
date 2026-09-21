---
title: CLI commands
description: Every sandboxr command, every flag, what it touches and what it returns.
---

The complete command surface. `sandboxr help` prints the same tree, and the source of truth is
`packages/cli/src/main.ts`.

```
sandboxr <command> [slug] [flags]
```

## Conventions

**The slug is usually optional.** Stand in the worktree and sandboxr works the name out for itself.
It looks for a ticket-shaped id in the directory name, then in the branch name, then uses the branch,
then the directory. `--slug NAME` and the bare positional argument mean the same thing.

A worktree that was *given* a slug — because the one it would have taken was already a sibling's —
keeps that one, and it beats everything but a name you pass. See
[One repo, many branches](../setups/one-repo-many-worktrees.md).

Four commands are the exception: `stop`, `start`, `keep` and `unkeep`. They act on a sandbox
elsewhere on the machine, so they want the slug spelled out.

**Output goes to two streams.** Anything a person reads goes to **stderr**. `--json` puts the result
on **stdout**. So `sandboxr ls --json | jq` works while you still see the progress.

Two commands break that rule on purpose. `sandboxr logs` and `sandboxr db snapshot` put their real
output on stdout whether or not you asked for JSON, because `sandboxr db snapshot > before.sql` has
to produce the file it looks like it produces.

| Exit | Means |
|---|---|
| `0` | Fine |
| `1` | Something failed |
| `2` | A config error, naming the file and the field |
| `3` | The sandbox is [degraded](glossary.md#d) — up, with a failed migration |

<details class="agent">
<summary><b>Details for an agent</b> — how flags are parsed, and the two spellings that are not interchangeable</summary>

The parser is `packages/cli/src/args.ts`. It is deliberately tiny, and three of its rules bite.

- **Only a fixed list of flags takes the next word as a value**: `--worktree`, `--slug`,
  `--project`, `--branch`, `--base`, `--name`, `--ttl`, `--seed`, `--tail`, `--timeout`, `--with`,
  `--bind`, `--http-port`, `--https-port`. Everything else is a boolean.
- **`--web` and `--go` are not on that list.** `sandboxr reload --web=app` works.
  `sandboxr reload --web app` does not: `--web` becomes `true`, and `app` is taken as the
  *positional slug*. Always use the `=` form when naming a target. The same applies to `--backend`.
- **`--name=value` works for every flag**, so the `=` form is the safe spelling everywhere.
- `--no-x` sets the boolean `x` to false. That is how `--no-tls` works.
- A single-dash cluster sets each letter as a boolean: `-f` is follow, `-y` is yes, `-h` is help.
- Everything after a bare `--` is passed through untouched, which is what makes
  `sandboxr shell -- go test ./...` work.

`--target`, `--prefer`, `--since` and `--ref` are in the parser's value list and no command reads
them. They do nothing.

`sandboxr` with no command prints the usage and exits `1`. `sandboxr --help`, `-h` and `help` print
it and exit `0`. An unrecognised command prints an error, then the usage, and exits `1`.

</details>

## Setting the machine up

### `sandboxr init`

Sets this machine up. It creates `~/.sandboxr` and the shared Docker network, writes the machine's
settings file if there is none, builds the base image, issues a certificate if one can be trusted,
writes `~/.sandboxr/host.env`, then starts the router.

It is idempotent. Running it again is also how you change the domain or pick up TLS after
installing mkcert's root.

> [!NOTE] It prepares the bare domain and does not fill it
> Nothing serves `https://<your domain>` after `sandboxr init`, and the command says so. `sandboxr`
> is a command-line tool — your sandboxes are reachable on their own hostnames either way. A control
> plane there is yours to build and start; `init` prints the port it has to listen on.

| Flag | What it does |
|---|---|
| `--no-tls` | Serve plain HTTP even if a trusted CA is present |
| `--tls` | Insist on HTTPS even if the CA is not trusted yet |
| `--rebuild` | Rebuild the base image |
| `--bind ADDR` | Publish the router here instead of `127.0.0.1` |
| `--http-port N` | Publish HTTP here instead of 80 |
| `--https-port N` | Publish HTTPS here instead of 443 |
| `--no-start` | Prepare the machine but start nothing |

`--no-start` does everything except run the router: the directories, the image, the certificate,
the router's configuration and `host.env` are all prerequisites that nothing but a host process can
produce, and something else may want to start the router itself under the name `init` would take.

<details class="agent">
<summary><b>Details for an agent</b> — what <code>init</code> reports, and the notes it can return</summary>

Prints the domain, the hostname shape and the port a control plane on the bare domain should
listen on. `--json` returns the whole report: `domain`, `scheme`, `ports`, `certificate`,
`baseImage`, `frontend` and `notes`.

`frontend` is `{ port, domain, tls }` — where a control plane must listen, and what the router will
send it. A container that wants the bare domain carries the `sandboxr.frontend` label.

`notes` is a list of things that need a person. Each is printed as a warning:

- `Wrote ~/.sandboxr/config.yaml. Edit it to change how long a sandbox may sit unused.`
- `mkcert is not installed, so the router serves plain http.`
- `mkcert's root is not in this machine's trust store, so the router serves plain http.`
- `mkcert could not issue a certificate, so the router serves plain http.`
- `The certificate is issued but its root is not trusted.`
- `Nothing is serving <url> — sandboxr is a command-line tool.`

The certificate covers the domain and one wildcard under it, and that is the whole machine: a
sandbox hostname is one label deep, so the wildcard reaches every sandbox as well as the bare domain.
Starting a sandbox issues no certificate of its own.

`init` never installs a trust root implicitly. `mkcert -install` is the one step that needs an
administrator password, so it is left to you.

</details>

### `sandboxr teardown [--network]`

Stops the router, and whatever is on the bare domain — anything carrying the `sandboxr.frontend`
label, found by the label rather than by a name. With `--network` it also removes the shared Docker
network.

**It leaves sandboxes running.** Those are `down`'s business, and it says so.

## Running a sandbox

### `sandboxr up [slug]`

Reads `sandboxr.yaml`, prepares the seed, builds the project image if it is not already built, issues
a certificate, starts the container, waits for it, provisions the database and prints the URLs.

| Flag | Default | What it does |
|---|---|---|
| `--worktree PATH` | the current directory | Which worktree to build from |
| `--project NAME` | — | A project in the workspace, instead of a path |
| `--branch NAME` | — | Which branch of that project. Its worktree is found, or cut |
| `--base REF` | — | Create `--branch` off this ref rather than expecting it to exist |
| `--ttl 12h\|never` | `config.yaml`, else `12h` | Stop it once it has sat unused this long |
| `--slug NAME` | derived | The same as the positional argument |
| `--with a,b` | none | Also start these `optional: true` runtimes |
| `--seed local\|file\|fixtures` | whatever the config allows | Force the seed source |
| `--detach` | off | Do not wait for it to come up |
| `--timeout N` | `180` | Seconds to wait for the container to be ready |
| `--json` | off | The whole result on stdout |

Starting a sandbox that already exists replaces the container and **keeps its volumes**, so the
database and the uploads survive.

> [!NOTE] A sandbox started here has no agent in it
> `sandboxr up` builds the project layer on the engine's own base image, and that image carries no
> `claude` — sandboxr runs a project and has no opinion about who edits the worktree. A sandbox
> started from the dashboard is built on `jef/base` instead, which is the engine's base with the
> agent on top, so it does. If you started a sandbox here and `claude` is not found inside it,
> nothing is broken: use the dashboard, or run your own agent against the bind mount
> ([your own agent in a sandbox](../guides/agents-in-a-sandbox.md)).

`up` is the only command that enforces the rules a public sandbox has to obey. Everything else loads
the config without them, so you can still inspect and clean up a project whose config would be
refused.

<details class="agent">
<summary><b>Details for an agent</b> — refusals, exit codes and what <code>--json</code> returns</summary>

Two flags are checked before any work starts, so a typo costs nothing:

- `--seed X` where X is not `local`, `file` or `fixtures` →
  `--seed X is not a source — one of local, file, fixtures`, exit `1`.
- `--ttl X` that is not a duration →
  `--ttl X is not a duration — a span like 30m, 12h or 7d, or never`, exit `1`.

Exit `3` when the sandbox comes up `degraded` — the container is running and the migration failed.
The URLs are still printed, and so are the two commands worth running next (`sandboxr logs` and
`sandboxr db shell`).

`--json` returns `{ sandbox, urls, migrationFailure? }`. `--timeout` is accepted and is not listed
in `sandboxr help`.

With `--project`, there is no worktree yet, so no config is loaded before core resolves one. Core
then loads the config from the worktree it picked, so the refusals still happen — one step later.

</details>

### `sandboxr down [slug] [--keep]`

Removes the container and the certificate naming its hostnames. The router's entry goes with the
container, because the router reconciles from Docker labels. Unless `--keep`, it also removes the
sandbox's `data`, `blob`, `bin` and `www` volumes — so the database and the uploads go.

It removes the keep-alive marker either way, `--keep` included: the container is gone, and a marker
for a container that no longer exists means nothing.

It never touches the worktree, the branch, or the database you seeded from. A sandbox that does not
exist is not an error.

### `sandboxr stop <slug>` and `sandboxr start <slug>`

Stops the container, or starts a stopped one again. Everything else survives: the volumes, the
database, the worktree. `start` takes seconds where `up` would rebuild and re-seed.

Stopping something that is already stopped is the state you asked for, so it exits `0`. Starting
something that does not exist cannot be, so it exits `1`.

### `sandboxr keep <slug>` and `sandboxr unkeep <slug>`

Exempts one sandbox from the idle clock, or hands it back.

`pin` and `unpin` are the names these had before the idea was called keep-alive. They still work and
are not listed in `sandboxr help`.

<details class="agent">
<summary><b>Details for an agent</b> — why <code>keep</code> can refuse</summary>

The marker is a file at `~/.sandboxr/state/keep/<project>/<slug>`, and it records the container's
`sandboxr.created` value. A marker whose stamp does not match the live container is ignored, so a
leftover file cannot silently keep the *next* sandbox to take that slug alive.

That is why two cases are refused rather than written:

- No such sandbox → `no sandbox called <slug> in <project> — keep one that exists`, exit `1`.
- The sandbox carries no `created` label →
  `<slug> carries no created label, so a keep-alive could not tell it from its successor`, exit `1`.
  The fix it prints is `sandboxr down` and `up` again, to relabel it.

`unkeep` just removes the file and always succeeds.

</details>

### `sandboxr ls [--project NAME]`

Every sandbox on the machine: project, slug, state, ttl, branch, worktree. `list` is an accepted
alias.

A `*` after the branch means the worktree had uncommitted changes when the sandbox started. That
sandbox is not reproducible from its commit alone.

The TTL column holds two facts, because they answer one question — when does this go away? It reads a
duration, `never`, `-` for a sandbox with no ttl, or `kept`. `kept` is shown *instead* of the
duration, because it is what the clock will actually do.

### `sandboxr status [slug]`

One sandbox in detail: state, branch and commit, driver, migration verdict, access, worktree, which
apps have been built, and whether each service answers its health path. Exit `3` if degraded.

### `sandboxr logs [slug] [--tail N] [-f]`

The container's own log stream. `--tail` defaults to **200**. `-f` or `--follow` streams it.

It takes no service argument. For one service, read its own file under
`~/.sandboxr/logs/<project>/<slug>/`.

### `sandboxr shell [slug] [-- command…]`

An interactive shell inside the sandbox, starting in `/workspace`. Defaults to `bash`. Anything after
a bare `--` is run instead of a login shell.

```bash
sandboxr shell tkt-4821 -- go test ./...
```

### `sandboxr reload [slug] …`

Rebuilds something inside a sandbox that is already running, and restarts it. It fails if the sandbox
is missing or stopped.

| Flag | What it rebuilds |
|---|---|
| `--migrate` | Re-runs this sandbox's migrations |
| `--web` | Every front-end in the build-everything set |
| `--web=<label>` | One front-end |
| `--web=built` | Only what this sandbox has already built |
| `--go` | Every backend |
| `--go=<name>` | One backend. `--backend=<name>` is an accepted alias |

One kind at a time. If you pass more than one, `--migrate` wins, then `--web`, then `--go`. Passing
none of them is an error naming the three.

> [!WARNING] Use the `=` form when you name a target
> `--web app` is parsed as `--web` plus a positional word, and the positional word is read as the
> slug. `--web=app` is the spelling that does what it looks like.

Exit `1` if any target failed, with the last 20 lines of its output.

## Cleaning up

### `sandboxr expire [--dry-run] [--project NAME]`

Stops every sandbox that has sat unused past its limit. `--dry-run` prints the plan and stops
nothing.

The clock measures **idleness, not uptime**. The deadline is the later of the container's current
start time and the last time anybody used it, plus the ttl. Four things count as use: a request
through the router, opening the sandbox in the dashboard, an agent session on its worktree, and a
terminal or agent panel somebody is holding open on it. A live agent session and an open socket both
hold the sandbox open, and the countdown starts when they stop. So using a sandbox buys it a full
lifetime, and so does pressing start.

```
KEEP  main      — no expiry set
KEEP  staging   — 3h 25m left, idle 34m
STOP  tkt-4821  — idle 13h, past its 12h limit
```

A sandbox that is kept alive, one with no ttl, and one Docker cannot give a start time for are all
left alone.

<details class="agent">
<summary><b>Details for an agent</b> — where last activity comes from, and what happens without a router</summary>

Last activity is read from the shared router's access log at the moment it is asked for. Nothing is
stored, so nothing can drift.

With no router running, no sandbox has a last-activity time and every one of them falls back to its
start time. A log that cannot be read must never be read as "nobody has used anything" — that would
stop every sandbox on the machine at once.

The per-sandbox log files are deliberately **not** an activity signal: the dashboard's health probes
write to them every few seconds, so a timer keyed on them would never fire.

`--dry-run` lists what would be stopped with the reason. `--json` adds what was kept, and why each
survived.

</details>

### `sandboxr gc [--dry-run]`

Reaps sandboxes whose recorded worktree no longer exists, then removes `sandboxr-` volumes nothing
owns and nothing has mounted, then the project images a newer build of the same project replaced.
The shared volumes, `sandboxr-deps-*`, `sandboxr/base`, `sandboxr/dashboard` and every project's
newest image are left alone, as is any image a container references, running or stopped.

Such a sandbox is unreachable anyway: you cannot rebuild anything in it, because the source it would
build from is gone. A superseded image is unreachable in the same sense — its tag is a hash of a
build that no longer exists, so no `up` can ask for it.

`--dry-run` prints all three lists and removes nothing.

### `sandboxr prune [--yes] [--build-cache]`

The whole-machine disk report: the same orphaned volumes and superseded images `gc` takes, with the
bytes each would return, plus Docker's build cache with `--build-cache`. **It reports by default and
removes only with `--yes`** — the opposite way round from `gc --dry-run`.

The asymmetry is deliberate, and it is about the build cache and the reading, not about the images:
sandboxr is not the build cache's only writer, and a whole-machine reclaim is worth looking at
before it runs. `gc` and `prune` agree exactly about which images may go.

| Flag | What it does |
|---|---|
| `--yes` (or `-y`) | Remove what was listed. Without it nothing is deleted |
| `--build-cache` | Include Docker's build cache, which sandboxr is not the only writer of |
| `--json` | The plan, and what was actually removed, on stdout |

| Offered | Never offered |
|---|---|
| `sandboxr-` volumes no surviving sandbox owns | `sandboxr-claude`, `sandboxr-gocache`, `sandboxr-gomod` |
| Project images older than that project's newest | Each project's newest image, so the next `up` starts rather than builds |
| Docker's build cache, with `--build-cache` | `sandboxr/base`, `sandboxr/dashboard`, and any image a container holds |

<details class="agent">
<summary><b>Details for an agent</b> — how the sizes are computed, and what a refusal looks like</summary>

Sizes are the bytes only that object holds, not what `docker images` reports. Two project images
built on the same base share the base layer, so removing one returns the difference rather than the
total.

The build cache is **always reported**, whether or not it is in scope, because on a full machine it
is usually the largest number on the page. It is removed only with `--build-cache`.

With `--yes`, anything that could not be removed is named one by one rather than counted: a refusal
is nearly always a container started against the image since the plan was made. The reclaimed total
is summed over what actually went, not over the plan.

There is no dashboard action for `prune`. It is a CLI command only — see
[What is built](status.md).

</details>

[Giving Docker the whole machine](../guides/docker-capacity.md) is the guide.

## Projects and worktrees

The workspace is the set of repositories sandboxr keeps for itself, so a sandbox can be a branch you
pick rather than a worktree you made by hand.
[Several repositories at once](../setups/many-projects.md) is the guide; these are the commands.

| Command | What it does |
|---|---|
| `sandboxr project ls` | Every project in the workspace: name, base branch, origin. `list` is an alias |
| `sandboxr project available` | Repositories your `gh` can reach, newest first |
| `sandboxr project clone <url> [--name NAME]` | Clone one in as a bare mirror |
| `sandboxr project fetch <name>` | Update its remote-tracking branches. Never touches local work |
| `sandboxr project prs <name>` | Open pull requests, as `gh` reports them |
| `sandboxr worktree ls <project>` | Every worktree cut from it. `list` is an alias |
| `sandboxr worktree add <project> <branch> [--base REF]` | Cut one, or hand back the one already there |
| `sandboxr worktree rm <project> <branch> [--force]` | Remove the directory, leaving any sandbox on it behind. `remove` is an alias |
| `sandboxr worktree delete <project> <branch> [--force]` | Remove its sandbox **first**, then the directory |
| `sandboxr worktree name <project> <branch> <name>` | Call it something a person can read. An empty name (`""`) hands it back to its branch |
| `sandboxr worktree pull <project> <branch>` | Fast-forward it onto the branch's head on the remote. Never merges, never discards |

Marks in the output: `*` after a repository name means a fork; `*` after a pull-request number means
draft; `~` after a branch means the worktree is detached, because that branch is checked out
somewhere else; `(GONE)` means the directory is not on disk.

Naming a project that is not in the workspace exits `1` and says so. It never clones one by accident.

<details class="agent">
<summary><b>Details for an agent</b> — what an empty list means, and what <code>--force</code> costs</summary>

`project available` and `project prs` both read GitHub through `gh`, and an empty answer has several
causes. Both commands say which, in a sentence, and exit `0` — an empty list is an ordinary answer,
and `project clone <url>` still works on a machine with no `gh`.

- `gh is not installed here, or is not logged in, so there are no repositories to list.`
- `gh can see no repositories for this account.`
- `<project> is not a GitHub repo (<origin>), so there are no pull requests to read.`
- `No open pull requests on <project>.`

`project available` lists the 200 most recently updated repositories and warns when there were more.
A repository counts as `added` when a project in the workspace was cloned from it, whichever way
each spells the URL — ssh and https are one repository, not two.

`project prs --json` carries a `state` on each pull request — `draft`, `open`, `closed` or `merged`
— alongside the raw `draft` flag it composes with. The table stays as it is, listing what is open;
the state is there because it is the same value the dashboard marks each worktree with, and one
composition of it lives in core so the two cannot disagree (contracts §4.1.2).

`worktree rm` looks the branch up in the listing rather than rebuilding a path from the name, so a
worktree added by hand is still removable. `--force` removes one with uncommitted work in it, and
that work is gone.

`worktree add` may write one file too: `~/.sandboxr/state/slug/<project>/<worktree directory>`,
holding the slug the new worktree was given because the one it would have derived was already
another worktree's. It says so on the way. `worktree rm` deletes it.

**`worktree delete` is `down` and `rm` as one ordered operation**, and the order is not a
preference. A volume cannot be removed while its container runs, and every artefact a sandbox owns
is named after the worktree (contracts §3.1) — so removing the directory first destroys the input
you needed to find what to clean up, which is how `rm` leaves an orphan for `gc`. It refuses,
removing nothing, when the worktree has uncommitted changes or commits that are on no remote; the
message names them and `--force` overrides it. It resolves every worktree of the project through the
same `slugFor` the dashboard and `up` use, so a worktree that was *given* a slug is compared under
the name it actually has — and where two worktrees still answer to one slug, which is possible for
any cut before `worktree add` began guarding it, deleting either **keeps** the sandbox and says
which other worktree is using it. A slug that names two worktrees is refused outright rather than
deleting whichever came first. What goes, in order, is in
[Start, stop, list, clean up](../guides/lifecycle.md).

`worktree name` writes one file, `~/.sandboxr/state/name/<project>/<slug>`, and does nothing else.
**The name is presentation only**: the slug, the hostname, the container name and every URL are
still derived from the branch and the directory, and the command prints the slug alongside to say
so. The name is bounded at 60 characters and may not contain a line break or a control character;
an empty name removes the file. `worktree ls` grows a `NAME` column once something in the project
has one, and `--json` always carries `displayName`, which is `null` when there is none. `worktree
rm` removes a worktree's name along with it.

`worktree pull` fast-forwards a checkout onto its branch's head on the remote and does nothing
else — no merge, no rebase, no `reset --hard`. It fetches the **project's mirror**, so it is the
same conversation with the remote that `project fetch` has, and it works on a detached worktree,
which is the ordinary state of one whose branch is checked out somewhere else. It exits `0` for
`already up to date`, for a fast-forward and for a move onto a rebuilt branch, and `1` for a
refusal, having changed nothing. A refusal lists every reason at once and names the files:
uncommitted changes to files the incoming commits also change, untracked files those commits
would overwrite, and commits here that the remote has no equivalent of.

**A rebased or force-pushed branch is not a divergence.** Divergence is judged by patch, with
`git cherry`, so commits the remote already carries under a different hash are not counted as
work at risk; where none is genuinely absent, the worktree is moved onto the rebuilt branch by
`git checkout` and the outcome is `replaced` rather than `fast-forwarded`. `--json` carries
`outcome`, `branch`, `detached`, `from`, `to`, `commits` and `refusals`. A file a sandbox's own
build wrote — `.env.local` beside a package — does not block a pull. See
[Several repositories at once](../setups/many-projects.md).

`worktree add` fetches before it resolves anything, so a new worktree lands on the remote's
current tip rather than on whatever the last fetch left behind. Where the local branch is behind
and checked out nowhere it is fast-forwarded onto the remote; where it is checked out elsewhere
the new worktree is detached at `origin/<branch>` and the branch ref is left alone; where it has
commits the remote does not, nothing moves and the command prints which commit the worktree
landed on and how far that is from the remote.

</details>

## Databases

| Command | What it does | Needs a running sandbox |
|---|---|---|
| `sandboxr db seed [--seed SOURCE]` | Produce or refresh the seed artifact | no |
| `sandboxr db migrate [slug]` | Run the project's migration command | yes |
| `sandboxr db snapshot [slug]` | Print the schema to **stdout** | yes |
| `sandboxr db shell [slug]` | An interactive database prompt. Read-only for `d1` | yes |

`db migrate` exits `1` on failure. It leaves the database exactly as it is, for you to inspect, and
prints where the schema baseline was taken.

There is no `db diff` and no `db reset`. Comparing before and after is two snapshots and `diff`;
starting clean is `down` then `up`.

> [!WARNING] A `sqlite` shell is writable
> The `d1` shell opens the file read-only, because the owning service holds it while it runs. The
> plain `sqlite` shell does not, so it is a second writer — which is the deadlock described in
> [Troubleshooting](../troubleshooting.md#a-d1-or-sqlite-migration-hangs). Close it before a
> migration runs.

## Secrets

One file per project, `~/.sandboxr/secrets/<project>.env`, and six verbs over it.

| Command | What it does |
|---|---|
| `sandboxr secrets list` | Every credential the project carries: the name, the last four characters, the length |
| `sandboxr secrets set NAME` | Set one. **The value is never an argument** — it is read from a hidden prompt, or from stdin |
| `sandboxr secrets unset NAME` | Remove one. Exit `0` when it was not there |
| `sandboxr secrets edit` | Open the whole file in `$EDITOR`, checked on save |
| `sandboxr secrets import` | **Merge** the project's `.env` files in. `--replace` rebuilds the file from them instead |
| `sandboxr secrets check` | Say which credentials are missing, by name. Exit `1` if any is |

```bash
printf '%s' "$STRIPE_KEY" | sandboxr secrets set STRIPE_SECRET_KEY
```

An argument would be in your shell history and in every `ps` on the machine for as long as the
command runs, so `set` does not take one.

**No command here prints a value**, so the output is safe to paste anywhere. `edit` is the
exception, and it is a different act: it opens the file in the editor you already use, and
prints nothing. See [Secrets](../configuration/secrets.md).

## Working out what is wrong

### `sandboxr doctor`

Checks the local setup and names the fix for anything it finds. Exit `1` if it finds anything.

It checks, in order:

1. Docker is running.
2. The base image exists.
3. The router is running.
4. The dashboard is running.
5. Whether the router serves HTTP or HTTPS, and why.
6. `SANDBOXR_PASSWORD` is set.
7. A config was found.
8. The config resolves.
9. A file-backed database is pointed at the sandbox's own state directory.
10. The project's credentials are present — the same check as `secrets check`.
11. Every `projects:` entry in `~/.sandboxr/config.yaml` names a project this machine has.
12. Where `SANDBOXR_HOME` is.
13. How many sandboxes exist.

Check 11 is the one that catches a setting that looks applied and is not. A `projects:` key may be
a project's workspace directory or the `project:` its `sandboxr.yaml` declares; a key that is
neither matches nothing and silently does nothing. `doctor` names it and lists the names that would
have worked, rather than guessing which one was meant.

### `sandboxr config`

Which config was used, and what it resolved to: project, file, root, origin, driver, access,
backends, front-ends — and what `~/.sandboxr/config.yaml` resolved to for this project, which is
`ttl`, `github`, and the `projects:` key that decided each. Exit `2` if there is no config here or
in any parent directory.

When `github` is `none`, which is the default, it says so in full: that `git commit` works inside
the sandbox and `gh` and `git push` do not, the exact key to write, and that a session has to be
allowed to run those two commands as well. That is here because the absence has no other symptom —
committing works, so nothing goes wrong until a push, long after the sandbox started.

`--json` prints the whole resolved config, which is the fastest way to see what a default became.

`file` is where the settings came from. `root` is the directory they resolve against — the one
mounted at `/workspace`. They are the same directory for a project that describes itself at its own
repository root, and `origin` says when they are not:

```
demo
  file        /home/you/.sandboxr/workspace/demo/sandboxr.yaml
  root        /home/you/.sandboxr/workspace/demo/wt/tkt-5000
  origin      the workspace project directory, not this worktree
   ! this worktree has no sandboxr.yaml of its own, so the project-level one applies
```

That is a project-level config, the fallback for a worktree that carries none. See
[Several repositories at once](../setups/many-projects.md).

### `sandboxr version` and `sandboxr help`

`version` prints `{ "version": "0.1.0" }` on stdout, with or without `--json`. `help` prints the
usage tree on stderr.

## What each command touches

| Command | Scope | Destructive |
|---|---|---|
| `init` | machine | Replaces the router container |
| `teardown` | machine | Removes them. Leaves sandboxes alone |
| `up` | one sandbox | Replaces the container; **keeps** its volumes |
| `down` | one sandbox | Removes the container, the database and the uploads |
| `ls`, `status`, `logs`, `config`, `doctor`, `version` | — | No |
| `stop`, `start` | one sandbox | No — the container only |
| `keep`, `unkeep` | one sandbox | No — one file under `~/.sandboxr/state/keep/` |
| `expire` | machine | Stops **every** sandbox past its idle limit. Removes nothing |
| `gc` | machine | Reaps **every** sandbox whose worktree is gone, and every superseded project image |
| `prune` | machine | Nothing without `--yes`; then images and volumes, never a shared volume |
| `shell` | one sandbox | Whatever you run |
| `reload` | one sandbox | Rebuilds; touches data only with `--migrate` |
| `db seed` | project | Rewrites the shared seed artifact |
| `db migrate` | one sandbox | That sandbox's database only |
| `db snapshot`, `db shell` | one sandbox | `shell` is interactive |
| `secrets list`, `secrets check` | project | No |
| `secrets set`, `secrets unset`, `secrets edit`, `secrets import` | project | Writes the project's secrets file. Running sandboxes pick the change up on a restart |
| `project ls`, `project available`, `project prs`, `worktree ls` | workspace | No |
| `project clone`, `project fetch` | workspace | Writes a project directory; a fetch never touches local work |
| `worktree add` | one project | Creates a checkout, fetching first so it lands on the remote's tip. May write one slug file under `~/.sandboxr/state/slug/`, when the new worktree would have taken a sibling's slug |
| `worktree pull` | one worktree | Fast-forwards it, or refuses and changes nothing. Never merges or discards |
| `worktree rm` | one project | Removes a checkout, and with `--force` any uncommitted work in it |
| `worktree delete` | one worktree | Removes its sandbox — container, database, uploads — and then the checkout. Refuses while there is work nothing else has a copy of, unless `--force` |
| `worktree name` | one project | Writes one label file under `~/.sandboxr/state/name/`. No identifier moves |

## How a slug is resolved to a project

`stop`, `start`, `keep` and `unkeep` name a sandbox rather than stand in one, so they work its
project out in this order:

1. `--project NAME`, if you gave one.
2. The one sandbox in `sandboxr ls` with that slug. A slug in two projects is ambiguous, and is
   refused naming both rather than picked between.
3. The config in the current worktree.

Slugs come from ticket ids, so two projects sharing a `tkt-4821` is ordinary rather than exotic.

---

**Next:** [Cheat sheet](cheat-sheet.md) for the one-line version, or
[Start, stop, list, clean up](../guides/lifecycle.md) for the same commands with context.
