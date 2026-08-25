---
title: Start, stop, list, clean up
description: The commands you run every day — up, ls, down and gc — what each one really removes, and why deleting a sandbox can never lose your work.
sidebar:
  order: 1
---

> **Written, never run** — Every command here exists in packages/cli and has unit tests behind it. None has been run against a real project, so read the sample output as the shape the code produces rather than as a transcript.

A sandbox is one container built from one git worktree, with its own database and its own web
address. This page is the whole daily surface for making one, looking at it, and getting rid
of it.

```bash
cd .worktrees/feat-123
sandboxr up          # start a sandbox from this worktree
sandboxr ls          # every sandbox on this machine
sandboxr status      # this one, in detail
sandboxr down        # remove it, and its database and uploads
sandboxr gc          # reap sandboxes whose worktree is gone
```

Every one of those takes an optional **slug** — the sandbox's short name. You almost never type
it, because standing in the worktree is enough: sandboxr works the name out from the directory
or the branch. `sandboxr down feat-123`, and `sandboxr down` run from `.worktrees/feat-123`,
are the same command.

## Starting one

```bash
sandboxr up
```

It reads `sandboxr.yaml`, prepares a copy of the database, starts the container, waits for it,
and prints the sandbox's URLs. On the internal tool sandboxr was generalised from, that took
about half a minute once the database copy was cached; nobody has yet timed it here. What
happens inside that time is told step by step in
[the life of a sandbox](../orientation/life-of-a-sandbox.md).

Four flags come up often enough to know:

```bash
sandboxr up --with cms            # also start a runtime marked `optional: true`
sandboxr up --seed fixtures       # skip the real data; start from the fixture file
sandboxr up --detach              # do not wait for it — print and return
sandboxr up --worktree ../other   # a worktree other than the one you are standing in
```

`--with` exists because some things are too expensive to run for everybody. A live development
server holds hundreds of megabytes for as long as the container lives, whether or not anyone
opens it — so a runtime declared `optional: true` starts only when it is asked for by name.

<details>
<summary><b>Details for an agent:</b> every flag of `up`, what it returns, and what happens when the sandbox already exists</summary>

| Flag | Default | What it does |
|---|---|---|
| *(positional)* `slug` | derived | The sandbox's name. Also accepted as `--slug NAME`. |
| `--worktree PATH` | the current directory | Which worktree to build from. |
| `--with a,b` | none | Comma-separated names of optional runtimes to start as well. |
| `--seed local\|file\|fixtures` | whatever the config allows | Forces the seed source. An unrecognised value is refused by name before anything starts. |
| `--detach` | off | Do not wait for the container, and do not run the database provisioning step. |
| `--timeout N` | `180` | Seconds to wait for the container to become ready. |
| `--json` | off | The whole result as JSON on stdout. Human-readable output always goes to stderr. |

Exit codes: `0` started, `3` started but **degraded** (up, with failed migrations), `2` a
config error that names the file and the field, `1` anything else.

**Starting a sandbox that already exists is not an error.** The existing container is removed
and a fresh one started in its place, from the current config and the current commit. Its
volumes are *not* touched, so the database, the uploads and the built apps carry straight
over. That is what makes `up` the right command after editing `sandboxr.yaml`, and after a
dependency change — the shared dependency volume is named after a hash of the lockfile, so a
new lockfile means a different volume, and only a fresh container can pick it up.

Source: `cmdUp` in `packages/cli/src/main.ts`, `up()` in `packages/core/src/sandbox/index.ts`.

</details>

> [!NOTE] The source database is only ever read
> Wherever the data comes from, sandboxr copies it first and works on the copy. Nothing a sandbox
> does can reach back into the database it was copied from.

## Seeing what you have

```bash
sandboxr ls
```

```
PROJECT  SLUG       STATE     BRANCH            WORKTREE
acme     docs-pass  running   docs/rewrite      /home/dev/acme/.worktrees/docs-pass
acme     feat-123   running   feat-123*         /home/dev/acme/.worktrees/feat-123
acme     fix-nav    degraded  fix/nav-overflow  /home/dev/acme/.worktrees/fix-nav

* uncommitted changes when the sandbox started
```

`list` is accepted as well as `ls`. `--project NAME` narrows it to one project.

This table is a **pure function of `docker ps`**. There is no manifest file and no database of
sandboxes anywhere; every column is read from a label on the container. Nothing can drift out
of sync, because there is no second copy of the truth to drift from. See
[state lives in labels](../architecture/state.md).

Three states, and only one of them is unusual:

| State | Means |
|---|---|
| `running` | The container is up and its migrations succeeded |
| `degraded` | The container is up and its **migrations failed** |
| `stopped` | The container exists but is not running |

`degraded` is deliberate rather than a half-failure. The services still start and you can still
get a shell, because looking at a migration that has just failed is one of the main reasons to
have a sandbox at all.

For one sandbox in detail — including which of its services actually answer — use `status`:

```bash
sandboxr status feat-123
```

<details>
<summary><b>Details for an agent:</b> every line `status` prints, and where each value comes from</summary>

```
acme/feat-123
  state       running
  branch      feat-123@8f2c1ab (dirty)
  driver      mysql
  migrations  ok
  access      public
  worktree    /home/dev/acme/.worktrees/feat-123
  built       admin, app

  up    api               https://feat-123.api.acme.sbx.localhost
  down  jobs              https://feat-123.jobs.acme.sbx.localhost
```

- `state`, `branch`, `driver`, `access` and `worktree` are container labels, written when the
  sandbox started.
- `migrations` is `ok`, `failed` or `pending`, read from marker files the container itself
  writes into `/run/sandboxr` as it boots — not inferred by the host.
- `built` is the list of front-ends this sandbox has actually built, read from
  `/srv/www/.built.json` inside it.
- Each service line is a live probe: `curl` against `127.0.0.1:<port><health>` inside the
  container. So `down` means "did not answer just now", not "was never started".
- `worktree` gains ` (GONE)` when the directory the label names is no longer on disk. That is
  exactly the condition `gc` reaps on.

Exit code `3` when the sandbox is degraded, so a script can branch on it. `--json` returns the
whole structure.

</details>

## Deleting one

```bash
sandboxr down feat-123
```

That removes the container and everything the sandbox owned:

| Removed | Name |
|---|---|
| The container | `sandboxr-acme-feat-123` |
| Its database | volume `sandboxr-data-acme-feat-123` |
| Its uploads | volume `sandboxr-blob-acme-feat-123` |
| Its compiled binaries | volume `sandboxr-bin-acme-feat-123` |
| Its built websites | volume `sandboxr-www-acme-feat-123` |

It does **not** remove:

- **The worktree on disk.** Deleting a sandbox never deletes code and never loses a commit.
- The shared dependency volume, which other sandboxes on the same lockfile are still using.
- The shared compiler caches, which are what make the next sandbox fast.
- `~/.sandboxr/logs/acme/feat-123/`, which survives on purpose — the logs from a sandbox you
  have just deleted are usually the ones you want.

Because the database lives *inside* the sandbox rather than on a shared server, `down` really
does take all of it. There is no leftover schema for somebody to find next month and wonder
whether it is still in use.

```bash
sandboxr down feat-123 --keep
```

`--keep` removes the container and leaves every volume behind, so the next `up` for that slug
finds its database exactly as it was. Use it to free the memory a sandbox is holding without
paying for the database restore again.

## Clearing up in bulk

```bash
sandboxr gc --dry-run    # say what it would do, and do nothing
sandboxr gc              # do it
```

`gc` does two things, both safe by construction:

1. **Reaps sandboxes whose worktree is gone.** It reads the `sandboxr.worktree` label, checks
   whether that directory still exists, and removes the sandbox if it does not. A sandbox whose
   worktree you have deleted is unusable — there is no source left to rebuild anything from —
   so it is pure waste.
2. **Removes volumes no surviving sandbox owns.** The left-behind database and website volumes
   of sandboxes that went away some other way.

> [!WARNING] `gc` does not free Docker's build cache
> The fastest-growing thing on a machine running sandboxes is Docker's own build cache, and
> nothing in sandboxr touches it. If you are short of disk, the command is
> `docker builder prune`, and `docker system df` is what tells you where the space actually went.

<details>
<summary><b>Details for an agent:</b> how `gc` decides, and the one input the CLI never supplies</summary>

`planGc` in `packages/core/src/sandbox/gc.ts` is a pure function of what `docker ps` and
`docker volume ls` report, which is why `--dry-run` can print the exact plan without touching
anything.

- Whether a worktree still exists is answered by **looking at the filesystem**, not by asking
  git. A worktree deleted with a plain `rm -rf` leaves a stale entry in git's admin files that
  would keep the sandbox looking alive.
- Orphan volumes are found by asking which volumes the *survivors* would own and subtracting,
  never by parsing volume names. Both a project name and a slug may contain dashes, so a name
  cannot be split back into its parts unambiguously — and a wrong split here deletes somebody's
  database.
- The shared volumes (`sandboxr-gocache`, `sandboxr-gomod`) and anything currently mounted by a
  live container are never orphans.
- A dependency volume is keyed on a lockfile rather than on a sandbox, so it is shared. Only an
  unmounted one is an orphan, and without a mount list it is left alone.

`planGc` also accepts a set of **merged branches** and will reap their sandboxes. Nothing
supplies that set today: there is no `--merged` flag on the CLI, because deciding whether a
branch is merged is an authenticated call to a code host that sandboxr does not make.

</details>

## What survives what

| Action | Container | Database | Uploads | Built apps | Worktree | Logs |
|---|---|---|---|---|---|---|
| `sandboxr reload` | kept | kept | kept | rebuilt | kept | kept |
| `sandboxr up` again | **replaced** | kept | kept | kept | kept | kept |
| `sandboxr down` | removed | **removed** | **removed** | **removed** | kept | kept |
| `sandboxr down --keep` | removed | kept | kept | kept | kept | kept |
| `sandboxr gc` | removed | **removed** | **removed** | **removed** | already gone | kept |

Only `down` and `gc` remove data. Everything else keeps it, which is what makes re-running `up`
after a config change cheap and safe.

There is **no `sandboxr restart`**. To put new code into a running sandbox, rebuild the one
thing you changed with [`sandboxr reload`](./edit-and-reload.md). To restart the whole
sandbox, run `sandboxr up` again — it replaces the container and keeps the database.

## A day, end to end

1. **Morning.** `sandboxr ls` to see what survived yesterday. `sandboxr gc --dry-run` if the
   machine feels full.

2. **Pick up a ticket.** Make a worktree for the branch, and start a sandbox in it:

   ```bash
   git worktree add .worktrees/feat-456 feat-456
   cd .worktrees/feat-456
   sandboxr up
   ```

3. **Work.** Edit in the worktree, `sandboxr reload --go api`, refresh the browser. The loop,
   and what each rebuild costs: [the edit–reload loop](./edit-and-reload.md).

4. **Show somebody.** The app hostname is a real HTTPS URL, so if the project's apps are
   `public`, sending the link is the whole of it — though the machine-wide router that serves
   those hostnames [is not built yet](../reference/status.md).

5. **Something is wrong and the logs are not enough.** `sandboxr shell`, or the terminal in the
   dashboard. [Logs, shells and terminals](./logs-and-shells.md).

6. **Done with it.** `sandboxr down`. The worktree and your commits stay exactly where they are.

<details>
<summary><b>If it goes wrong:</b> what `up`, `down` and `gc` say when they refuse, and what each one means</summary>

| Message | Cause | What to do |
|---|---|---|
| `Docker is not running. Start it and try again.` | No Docker daemon. | Start Docker. |
| `acme serves public apps, so it may not carry the real credentials in …` | The project's apps are public and a real secrets file exists. A refusal rather than a warning: money spent on somebody else's API calls stays spent. | Set `access.credentials: real` and accept that, or set `access.apps: private`. |
| `a sandbox called feat-123 already exists` | Only when a caller asks not to replace. The CLI never does — from the command line, `up` always replaces. | — |
| `sandboxr-acme-feat-123 exited while starting` | The container died during boot. | `sandboxr logs feat-123` — the reason is in the container's own output. |
| `… did not become ready in 180s` | The container is up but `/workspace` never appeared, or the boot really is that slow. | `--timeout` for a slow first boot; otherwise read the logs. |
| `No sandbox called feat-123` (from `down`) | There was nothing to remove. Reported, not an error — `down` is safe to run twice. | — |
| `Sandbox is up, but its migrations FAILED.` | The project's own migrations failed. The sandbox stays up on purpose. | `sandboxr logs <slug>`, then `sandboxr db shell <slug>`. |

Everything else: [symptom to cause](../troubleshooting.md).

</details>
