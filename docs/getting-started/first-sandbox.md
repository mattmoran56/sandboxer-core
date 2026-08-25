---
title: Your first sandbox
description: Make a worktree, start a sandbox from it, find out whether it is healthy, build a front-end, and throw it away — with the real commands and the real output.
sidebar:
  order: 3
---

> **Written, never run** — Every command on this page exists in `packages/cli/src/main.ts` and the output shapes are taken from that code; the sequence has not been run against a real project.

This page runs one sandbox, start to finish. It assumes the project already has a
`sandboxr.yaml` at the root of its repository, and it uses the fictional project **acme** and a
branch called **feat-123** throughout.

For what is actually happening behind each command, read
[the life of a sandbox](../orientation/life-of-a-sandbox.md) alongside this. This page is the doing;
that page is the explaining.

> [!WARNING] You probably cannot open the URLs yet
> Nothing maps a sandbox hostname to a container today — [the router is not
> built](../reference/status.md). Everything on this page works, but "open the URL" means either a
> reverse proxy you set up yourself ([set up your machine](./setup.md)) or a `curl` from
> inside the container, which is shown below.

## Step 1 — make a worktree

A sandbox is made from a **worktree**: git's own way of having the same repository checked out
in more than one directory at once. The reason is simple — two sandboxes on two branches need
two directories on disk, because each directory is linked live into its own container.

```bash
git worktree add .worktrees/feat-123 feat-123
cd .worktrees/feat-123
```

This is plain git. sandboxr has no command that makes worktrees for you.

Git will refuse in two common situations, and the fix differs:

| Situation | What git says | What to run instead |
|---|---|---|
| The branch exists locally and is not checked out anywhere | nothing — the command above works | — |
| The branch is checked out somewhere else, including your main checkout | `fatal: 'feat-123' is already used by worktree at …` | `git worktree add --detach .worktrees/feat-123 refs/heads/feat-123` |
| The branch exists only on the remote | `fatal: invalid reference: feat-123` | `git fetch` then `git worktree add -b feat-123 .worktrees/feat-123 origin/feat-123` |

<details>
<summary><b>Details for an agent:</b> what `--detach` costs, and why the sandbox still knows the branch name</summary>

`--detach` checks out the commit rather than the branch, which is how you run a branch that is
already checked out elsewhere — git refuses to have one branch in two worktrees, because then
two directories could commit to the same ref.

A detached worktree has no branch name, and `git rev-parse --abbrev-ref HEAD` answers with the
literal string `HEAD`. That would label the sandbox `HEAD`, losing the one fact anybody asking
about it wants.

So `branchOf` in `packages/core/src/git.ts` recovers it: it asks
`git branch --points-at HEAD` for any local branch on the same commit, and falls back to a
remote-tracking branch with the remote prefix stripped, so the name matches what a forge calls
the head ref. Only if both find nothing does the label become `?`.

The trade-off you keep: a detached worktree does not advance the branch when you commit in it.
Commits are real and safe, but you push them explicitly.

</details>

<details>
<summary><b>Why it works this way:</b> why sandboxr never runs from your main checkout</summary>

A sandbox links its worktree directory into the container read *and* write. Anything running
inside — a build, a migration runner, a coding agent — writes to that directory, and those
writes appear in `git status` immediately.

That is the point when the directory is a scratch worktree. It is not the point when the
directory is the tree you have open in an editor. Keeping sandboxes in `.worktrees/` means the
worst an agent can do is dirty a directory you were going to delete anyway.

</details>

## Step 2 — start it

```bash
sandboxr up
```

No name needed. The directory is called `feat-123`, that looks like a ticket id, so the
sandbox's short name — its **slug** — becomes `feat-123`. Pass one explicitly if you would
rather: `sandboxr up my-name`.

What you see, roughly:

```
→ Seeding: copying the acme_db container
→ Starting feat-123 from feat-123@a1b2c3d
✔ Sandbox feat-123 is running

  app          https://feat-123.app.acme.sbx.localhost
  api          https://feat-123.api.acme.sbx.localhost
  admin        https://feat-123.admin.acme.sbx.localhost
  www          https://feat-123.www.acme.sbx.localhost
```

Read a hostname as `<slug>.<label>.<project>.<domain>`. The dashboard is separate: it lives on
the bare domain, covers every sandbox and every project, and is behind a password.

<details>
<summary><b>Details for an agent:</b> every flag `up` accepts, its exit codes, and what `--json` returns</summary>

```
sandboxr up [slug]
  --worktree PATH             start from a different worktree than the current directory
  --with a,b                  also start these optional runtimes
  --seed local|file|fixtures  force where the database is loaded from
  --detach                    do not wait for it to come up
  --timeout N                 seconds to wait for the container (default 180)
  --json                      the whole result as JSON on stdout
```

| Exit code | Means |
|---|---|
| `0` | Running |
| `1` | Something failed — the message says what |
| `2` | The config file is wrong, and the message names the field |
| `3` | Started, but **degraded** — the migrations failed |

`--json` returns `{ sandbox, urls, migrationFailure?, seed }`. Human-readable output goes to
stderr and JSON to stdout, so one script can read the JSON while a person watches the steps.

**Starting a sandbox that already exists replaces the container and keeps its volumes** — so
the database survives. Only `down` and `gc` remove volumes.
Code: `packages/core/src/sandbox/index.ts`.

</details>

<details>
<summary><b>Details for an agent:</b> how long the first run takes, and where the time goes</summary>

Measured on one large monorepo using the internal tool sandboxr generalises, not on sandboxr:

| | Cost |
|---|---|
| Everything except the database | a few seconds |
| Restoring a cached database copy | most of the remaining time |
| **Total, cache warm** | ~30 seconds |
| The very first run, before any image exists | tens of minutes, once |

Your project's numbers will differ. The *shape* will not: the database dominates, and the
front-ends cost nothing at all yet because none of them has been built.

Note that building the per-project image layer is [not implemented](../reference/status.md) — a
sandbox runs `sandboxr/base:latest` unless `SANDBOXR_IMAGE` names something else.

</details>

## Step 3 — check it is healthy

```bash
sandboxr ls
```

```
PROJECT  SLUG      STATE     BRANCH             WORKTREE
acme     feat-123  running   feat-123           /home/you/acme/.worktrees/feat-123
acme     fix-nav   degraded  fix/nav-overflow*  /home/you/acme/.worktrees/fix-nav

* uncommitted changes when the sandbox started
```

`degraded` **important** means the sandbox started but its
database migrations failed. That is deliberate. A failed migration does **not** stop a sandbox,
because looking at a failed migration is one of the main reasons the sandbox exists — the
services boot, you can get a shell, and you can read the schema.

For one sandbox in detail:

```bash
sandboxr status feat-123
```

```
acme/feat-123
  state       running
  branch      feat-123@a1b2c3d
  driver      mysql
  migrations  ok
  access      public
  worktree    /home/you/acme/.worktrees/feat-123
  built       app

  up    api              https://feat-123.api.acme.sbx.localhost
  up    admin-api        https://feat-123.admin-api.acme.sbx.localhost
  down  jobs             https://feat-123.jobs.acme.sbx.localhost
```

<details>
<summary><b>Details for an agent:</b> where each field of `status` comes from, and why state is never stored</summary>

| Field | Source |
|---|---|
| `state` | Computed at read time: the container's own state, plus the migration verdict the sandbox publishes at `/__sandboxr/status.json`. Never written to a label. |
| `branch`, `commit`, `dirty` | The `sandboxr.branch` / `.commit` / `.dirty` labels, fixed when the sandbox was created |
| `driver` | The `sandboxr.driver` label |
| `access` | The `sandboxr.access` label — `public` or `private` |
| `worktree` | The `sandboxr.worktree` label, plus a live check of whether that path still exists (`(GONE)` if not) |
| `built` | Which front-ends this sandbox has actually built, read from inside it |
| the service list | The plan, plus each service's own health endpoint |

There is **no list of sandboxes anywhere**. No manifest, no database. `ls` is a function of
`docker ps` and container labels and nothing else, so there is no second copy of the truth that
can drift. Runtime state is deliberately never labelled: a label saying `running` goes stale the
moment a process dies. [Why that matters](../architecture/state.md).

`status` exits `3` for a degraded sandbox, so a script can branch on it.

</details>

## Step 4 — build a front-end

Ask for an app right after `up` and you will get a **503** with a page naming the command that
builds it.

That is not a failure. **Front-ends are built on demand, never at startup.** A sandbox has to
come up in seconds, building every app first would make that impossible, and most of the time
you only care about one of them.

```bash
sandboxr reload --web app
```

Then ask again. From then on that app stays built for the life of the sandbox.

Without a router, ask the container directly:

```bash
sandboxr shell feat-123 -- curl -sI -H 'Host: feat-123.app.acme.sbx.localhost' localhost/
```

<details>
<summary><b>Details for an agent:</b> every form of `reload`, and what each one costs</summary>

```
sandboxr reload [slug] --go [name]              rebuild one backend, or all of them, and restart
                      --web <label|all|built>   rebuild a front-end
                      --migrate                 re-run this sandbox's migrations
```

- `--go` with no name rebuilds every backend. `--go api` rebuilds one.
- `--web app` rebuilds one app. `--web all` rebuilds everything except apps marked
  `in_build_all: false`. `--web built` rebuilds only the ones this sandbox has already built,
  which is the useful one after a shared-code change.
- `--migrate` re-runs the project's migrations against this sandbox's own copy of the database.

There is no `--app` and no `--backend` in the usage — those are `--web` and `--go`. Calling
`reload` with none of the three prints
`what should be reloaded? --go [name] | --web <label|all|built> | --migrate` and exits `1`.

Nothing is rebuilt automatically when you save a file. The file is inside the container
instantly, because the worktree is linked live, but turning source into a binary or a bundle is
always something you ask for. Costs and the reasoning:
[the edit–reload loop](../guides/edit-and-reload.md).

</details>

> [!TIP] The unbuilt page names its own command
> It says which app it is and what to run. That is the entire reason it exists instead of a 404 —
> a 404 at a sandbox hostname is indistinguishable from DNS being broken, and you would go and
> debug the wrong thing entirely.

## Step 5 — look inside

```bash
sandboxr logs feat-123 --tail 200     # the container's log stream
sandboxr logs feat-123 -f             # follow it
sandboxr shell feat-123               # a shell inside
sandboxr db shell feat-123            # an interactive database shell
sandboxr db snapshot feat-123         # print the schema
```

`logs` takes no service name — it is the container's whole stream, with every service's output
tagged in it. `db snapshot` prints the schema to stdout unaltered, so
`sandboxr db snapshot > before.sql` produces a usable file.

<details>
<summary><b>If it goes wrong:</b> the five things that go wrong on a first run, and what each really is</summary>

1. **`up` refuses and names a config field.** Working as designed: the project serves public
   apps and the settings would put real data or real credentials in them. Either set
   `access.apps` to `private`, or opt in explicitly.
   [The full reasoning](../security/public-sandboxes.md).

2. **Nothing resolves in a browser.** Expected — there is no router. Use
   `sandboxr shell … -- curl` as above, or set up a proxy yourself
   ([set up your machine](./setup.md)).

3. **MySQL will not start, reporting something that reads as corruption.** Check free disk
   **first**. A full Docker disk reports itself as a corrupt database, and you will otherwise
   spend an hour on the wrong problem. `docker system df`.
   [Details](../troubleshooting.md).

4. **A build died with `code 137`.** That is the kernel killing it for memory, reported by npm
   with no mention of memory at all. `137` is `128 + 9`. Declare `memory:` on that app, which
   raises the whole sandbox's ceiling. [Details](../guides/edit-and-reload.md).

5. **The sandbox is `degraded`.** The project's migrations failed and the sandbox stayed up on
   purpose. Read the failure, then look at what it left behind:

   ```bash
   sandboxr logs feat-123
   sandboxr db shell feat-123
   sandboxr db snapshot feat-123
   ```

   There is no `sandboxr db diff`. Compare a snapshot taken before against one taken after.

Everything else: [symptom to cause](../troubleshooting.md).

</details>

## Step 6 — throw it away

```bash
sandboxr down feat-123
```

The container, its database, its file storage and its built output — all gone. Because the
database lives *inside* the container, there is no shared schema left behind for somebody to
find next month and wonder about.

Your worktree is left alone, and so are your commits and the logs under `~/.sandboxr/logs/`.
Deleting a sandbox never loses work.

```bash
sandboxr down feat-123 --keep     # remove the container, keep the volumes
git worktree remove .worktrees/feat-123
```

The exact table of what survives which command is in
[the life of a sandbox](../orientation/life-of-a-sandbox.md#what-survives-what).

Next: [everyday use](../guides/lifecycle.md).
