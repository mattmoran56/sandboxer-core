---
title: CLI commands
description: Every sandboxr command that exists today, what it does, what it touches, and what it prints — taken from the source rather than from a plan.
sidebar:
  order: 1
---

> **Written, never run** — Every command on this page exists in packages/cli and has unit tests. None has been run against a real project, so the behaviour described is the behaviour the code intends.

`sandboxr` does one thing per command and prints the result. All the actual work happens in
`@sandboxr/core`, which the dashboard also calls — so the two can never disagree about what a
sandbox is.

```bash
sandboxr help          # this whole surface, in your terminal
sandboxr version
```

> [!NOTE] Where the output goes
> **Anything a person reads goes to stderr. `--json` puts the result on stdout.**
>
> That way `sandboxr ls --json | jq` works while you still see the progress, and an agent driving
> the CLI can read stdout without having to strip a progress line out of it.
>
> Two commands break the rule on purpose, because their output *is* the result rather than a
> description of it: `sandboxr logs` and `sandboxr db snapshot` both write to stdout unaltered, so
> `sandboxr db snapshot > before.sql` produces the file it looks like it produces.

## Starting and stopping

### `sandboxr up [slug]`

Starts a sandbox from the worktree you are standing in. This is the command that does everything
— reads the config, checks it is allowed to run, prepares the database seed, writes the plan,
starts the container, waits for it, provisions the database, and prints the URLs.

```bash
cd .worktrees/feat-123
sandboxr up
```

If a sandbox with that name already exists, its container is replaced. **Its volumes are kept**,
so the database survives. Only `down` and `gc` remove data.

<details>
<summary><b>Details for an agent:</b> every flag, the exit codes, and the order the steps run in</summary>

| Flag | What it does |
|---|---|
| `[slug]` | Name the sandbox explicitly instead of deriving it from the directory or branch |
| `--slug NAME` | The same thing, as a flag |
| `--worktree PATH` | Start from another worktree instead of the current directory |
| `--with a,b` | Also start runtimes the config marks `optional: true` |
| `--seed local\|file\|fixtures` | Force a seed source instead of choosing one |
| `--detach` | Return as soon as the container starts, without waiting or provisioning |
| `--timeout N` | Seconds to wait for the container to be up. Default 180 |
| `--json` | Print the full result object on stdout |

Exit codes: `0` started, `1` failed, `2` the config is invalid (the message names the file and
the field), `3` started but **degraded** — the container is up and the migrations failed.

The order, from `packages/core/src/sandbox/index.ts`:

1. Load and validate `sandboxr.yaml`, from `--worktree` or the current directory.
2. Derive the slug and the container name.
3. Refuse if the project serves public apps and a secrets file exists that it may not carry.
4. Create the `~/.sandboxr` directories and the shared `sandboxr` Docker network.
5. Choose a seed source and produce the seed artifact **on the host**, before the container.
6. Write `~/.sandboxr/build/<project>/<slug>.env` and `<slug>.plan.json`.
7. Remove an existing container of the same name.
8. `docker run` with the labels, mounts, memory limit and environment files.
9. Unless `--detach`: wait for the container, then provision the database and migrate.
10. Read the sandbox's own state back and print the URLs.

The secrets file is layered **under** the generated environment, so a credential may be supplied
from outside but nothing outside may redirect a sandbox's database or storage at something that
is not its own.

</details>

### `sandboxr down [slug] [--keep]`

Removes the sandbox and everything it owned: the container, its database volume, its
object-storage volume, its built binaries and its built websites.

```bash
sandboxr down feat-123
sandboxr down feat-123 --keep    # remove the container, keep the data
```

It never touches your worktree, your commits, or the logs in `~/.sandboxr/logs/`. Because the
database lives *inside* the container, there is no shared schema left behind for someone to find
next month and wonder about.

### `sandboxr gc [--dry-run]`

Reaps sandboxes whose worktree no longer exists, and removes volumes no surviving sandbox owns.

```bash
sandboxr gc --dry-run
sandboxr gc
```

A sandbox whose worktree you deleted is unreachable anyway — you cannot rebuild anything in it —
so it is pure waste.

> [!WARNING] `gc` does not reclaim build-cache disk
> Docker's build cache is the fastest-growing thing in this whole system, and `gc` does not touch
> it. Use `docker system df` to see it and `docker builder prune` to clear it.

<details>
<summary><b>Details for an agent:</b> how gc decides, and why it will not guess at a volume name</summary>

The plan is a pure function of `docker ps` and `docker volume ls` plus one question per sandbox:
does the path in its `sandboxr.worktree` label still exist? That is checked on the filesystem
rather than with git's own worktree list, because a worktree removed with a plain `rm -rf`
leaves a stale entry in git's admin files that would keep it looking alive.

Orphaned volumes are worked out by asking which volumes the *survivors* would have, not by
parsing names. Both a project name and a slug may contain dashes, so a name cannot be split back
into its parts unambiguously — and a wrong split here deletes somebody's database.

A shared dependency volume is keyed on a lockfile rather than on a sandbox, so only an unmounted
one is an orphan.

`packages/core/src/sandbox/gc.ts`.

</details>

## Looking at what is running

### `sandboxr ls [--project NAME]`

Every sandbox on the machine. `sandboxr list` is the same command.

```
PROJECT  SLUG       STATE     BRANCH               WORKTREE
acme     feat-123   running   feat-123             /home/you/acme/.worktrees/feat-123
acme     fix-nav    degraded  fix/nav-overflow*    /home/you/acme/.worktrees/fix-nav

* uncommitted changes when the sandbox started
```

This is a pure function of `docker ps`. There is no list of sandboxes stored anywhere, so
nothing can drift out of date. [Why](../architecture/state.md).

`degraded` means the container is up and the migrations failed. That is deliberate — inspecting
a failed migration is one of the reasons a sandbox exists.

### `sandboxr status [slug]`

One sandbox in detail, including which of its services actually answer.

```
acme/feat-123
  state       running
  branch      feat-123@a1b2c3d
  driver      mysql
  migrations  ok
  access      public
  worktree    /home/you/acme/.worktrees/feat-123
  built       app, admin

  up    api               https://feat-123.api.acme.sbx.localhost
  down  jobs              https://feat-123.jobs.acme.sbx.localhost
```

Exits `3` if the sandbox is degraded, so a script can branch on it.

### `sandboxr logs [slug] [--tail N] [-f]`

The container's own log stream, on stdout.

```bash
sandboxr logs                    # the last 200 lines
sandboxr logs feat-123 -f        # follow
sandboxr logs --tail 2000 > today.txt
```

This interleaves every process in the container. For one service at a time, read the per-service
files inside the sandbox — see [logs, shells and terminals](../guides/logs-and-shells.md).

### `sandboxr shell [slug] [-- command…]`

A shell inside the sandbox, in `/workspace`.

```bash
sandboxr shell
sandboxr shell feat-123 -- go test ./...
```

Everything after a bare `--` is run instead of a login shell, which is what makes this usable
from a script. Edits you make here are edits to your branch — the worktree is mounted read-write.

## Rebuilding

### `sandboxr reload [slug] --go | --web | --migrate`

Rebuilds something inside a running sandbox and restarts it. Nothing is built when a sandbox
starts, so this is the command you run all day.

```bash
sandboxr reload --go api        # one backend
sandboxr reload --go            # every backend
sandboxr reload --web app       # one front-end, by label
sandboxr reload --web all       # the project's main front-ends
sandboxr reload --web built     # exactly what this sandbox has already built
sandboxr reload --migrate       # re-run this sandbox's migrations
```

One of the three is required; `reload` with none of them tells you so and exits 1.

<details>
<summary><b>Details for an agent:</b> what each mode actually does, including the failure behaviour</summary>

**`--go [name]`** compiles the backend inside the container and then restarts its supervised
process. If the build fails, **the running process is left alone** — a broken branch should not
also take the sandbox's services down. The failed name is printed and the exit code is 1.

**`--web <target>`** builds a front-end and swaps the result into the served directory.

- A `serve:` front-end is a long-running dev server, so it is *restarted* rather than built.
- The build deliberately does **not** typecheck. A branch that does not typecheck still needs a
  sandbox, and CI is what enforces types.
- `all` is everything except apps marked `in_build_all: false`.
- `built` is exactly what this sandbox has already built, read from `/srv/www/.built.json`. It
  never *starts* a first build of something excluded from `all` — that is an explicit act.
- If the output mentions `137` or `Killed`, `reload` says so in words: that is the kernel taking
  it for memory, not a code error, and the fix is a `memory:` on that app in `sandboxr.yaml`.

**`--migrate`** runs the project's own migration command through the driver, against this
sandbox's copy of the database.

`packages/core/src/sandbox/index.ts`, the `reload` function.

</details>

## Databases

Four commands. Each one runs against the sandbox's own copy — the source database is only ever
read.

| Command | What it does |
|---|---|
| `sandboxr db seed [--seed SOURCE]` | Produce or refresh the reusable seed artifact in `~/.sandboxr/cache` |
| `sandboxr db migrate [slug]` | Run the project's own migration command against the copy |
| `sandboxr db snapshot [slug]` | Print the schema, structure only, on stdout |
| `sandboxr db shell [slug]` | An interactive database client against this sandbox |

```bash
sandboxr db snapshot > before.sql
sandboxr db migrate
sandboxr db snapshot > after.sql
diff before.sql after.sql
```

> [!WARNING] There is no `db diff` and no `db reset`
> Comparing a schema before and after is done by hand, as above. Starting clean is `sandboxr down`
> then `sandboxr up`. Both are gaps rather than decisions — see
> [testing a migration](../guides/testing-a-migration.md).

`db migrate` exits 1 on failure and prints the file it failed at and the schema baseline, and
says that the database is left exactly as it is for you to inspect.

## Secrets

```bash
sandboxr secrets import     # build ~/.sandboxr/secrets/<project>.env from the project's .env files
sandboxr secrets check      # say which credentials are missing, by name
```

**Names only, never values, are ever printed.** The import reports which files it read, a count,
and a list of names — so it is safe to run with someone watching your screen.

`secrets check` exits 1 if anything the config asks for is absent, so it works in a script.

## Working out what is wrong

### `sandboxr doctor`

Checks the local setup and names the fix for anything missing, because "Docker is not running"
without "start Docker and try again" is a diagnosis with no next step.

It checks: Docker is running; a `sandboxr.yaml` exists here or in a parent; the config resolves;
a file-backed database's commands actually point at the sandbox's own state directory; every
credential the config asks for is present; and how many sandboxes are on the machine.

Exits 1 if it found anything.

### `sandboxr config`

Where the config is and what it resolved to.

```
acme
  file        /home/you/acme/sandboxr.yaml
  driver      mysql
  access      apps public, credentials dummy
  backends    api, admin-api, jobs
  frontends   app (static), admin (static), cms (server)
```

`sandboxr config --json` prints the whole resolved object, which is the fastest way to see what
a default became.

## The slug

Most commands take an optional slug and default to the one for the worktree you are in.

<details>
<summary><b>Details for an agent:</b> the derivation order, the character rules and the length ceiling</summary>

In order of preference:

1. an explicit argument, or `--slug`
2. a ticket-style id anywhere in the worktree directory name, matched by `/[a-z]+-[0-9]+/i`
3. that same pattern in the branch name
4. the branch name — unless git reports `HEAD`, which names nothing
5. the worktree directory name

Then sanitised: lower-cased, every character outside `[a-z0-9-]` becomes `-`, runs of `-`
collapse, leading and trailing `-` are stripped.

**Ceiling 31 characters.** Over that: the first 22 characters, trimmed of a trailing dash, plus
`-`, plus the first 8 characters of the SHA-256 of the *raw* input.

Hashed rather than truncated because the slug ends up inside a MySQL advisory lock name, which
MySQL truncates at 64 characters. Two long branch names very often share a prefix, so truncation
would let two sandboxes collide on one lock and one migration would silently wait on the other.

`packages/core/src/naming.ts`. Contract §3.1.

</details>

## What each command touches

| Command | Container | Database | Storage | Built apps | Worktree | Host state |
|---|---|---|---|---|---|---|
| `up` | replaces | provisions | provisions | – | reads | writes env + plan |
| `reload` | – | only with `--migrate` | – | **rebuilds** | reads | – |
| `db seed` | – | – | – | – | reads | writes cache |
| `db migrate` | – | **writes the copy** | – | – | reads | – |
| `db snapshot` | – | reads | – | – | – | – |
| `down` | **removes** | **removes** | **removes** | **removes** | – | – |
| `down --keep` | **removes** | kept | kept | kept | – | – |
| `gc` | **removes** | **removes** | **removes** | **removes** | – | – |
| `secrets import` | – | – | – | – | reads | **writes** |
| `ls`, `status`, `logs`, `config`, `doctor` | reads | – | – | – | reads | – |

No command writes to the source database. That is the whole
[driver contract](../databases/drivers.md).

## Commands that do not exist

Earlier drafts of these pages, and the tool sandboxr generalises, used names that are not in
`packages/cli` today. If you find one referenced anywhere, it is a documentation bug:

`init`, `ensure`, `restart`, `dash`, `base build`, `image build`, `db fork`, `db pending`,
`db diff`, `db reset`, `db refresh`, `secrets list`, `up --memory`, `gc --merged`, and
`logs <slug> <service>`.

Setting up DNS, a certificate and a machine-wide router is manual today. Building the
per-project image layer is manual too — see [what is built](./status.md).
