---
title: Your first sandbox
description: One worktree, one container, one URL — what happens in what order, and how to throw it all away.
---

This page starts one sandbox from a git worktree, shows you what happened, and then deletes it.
Five commands in total.

You need a machine that has had [`sandboxr init`](install.md) run on it, and a project with a
`sandboxr.yaml` at its root. If your project has no config yet,
[Build your config, step by step](../configuration/index.md) starts from an empty file. If you
would rather borrow a project that already works, use
[the demo project](demo-project.md) instead.

```prompt
Start a sandbox for this worktree and confirm it serves.

Read docs/getting-started/first-sandbox.md and follow it. Run `sandboxr up` in the worktree, then
open the URL it prints and confirm it answers. Report the URL and the output of `sandboxr status`.

Stop and ask me if:
- There is no sandboxr.yaml in this project. Do not write one without asking.
- `sandboxr up` exits with code 3. That means the sandbox is up but its migrations failed — show
  me `sandboxr logs` and wait.
- It refuses to start because the project serves public apps and has real credentials on this
  machine.
- An app answers 503 with a page naming a build command. Ask before running a build; some cost
  minutes and gigabytes.

Do not run `sandboxr down` unless I ask. That deletes the sandbox's database.
```

## 1. Make a worktree

A sandbox is built from a directory holding a checkout. A [git worktree](../reference/glossary.md)
is the natural one — a second working copy of the same repository, on its own branch, without
disturbing the checkout you are sitting in.

```bash
cd ~/acme
git worktree add .worktrees/tkt-4821 -b tkt-4821
```

> [!NOTE] The name comes from the directory or the branch
> sandboxr looks for a ticket-shaped id — letters, a dash, digits — first in the worktree
> directory's name, then in the branch name. Failing both it uses the branch name, then the
> directory name. So `.worktrees/feat-tkt-4821-rework-the-thing` still becomes `tkt-4821`. Pass
> your own with `sandboxr up my-name`.

## 2. Start it

```bash
cd .worktrees/tkt-4821
sandboxr up
```

```
==> Seeding: empty, then migrations and seeds/fixtures.sql
==> Building sandboxr/acme:8f2c1a94d0b7
==> acme has no GitHub token: git commit works in this sandbox, gh and git push do not.
      Set projects.acme.github: token in /home/you/.sandboxr/config.yaml, and allow the
      session git push and gh — neither is in its default allowlist.
==> Starting tkt-4821 from tkt-4821@a1b2c3d
==> Applied fixtures from seeds/fixtures.sql
  ok Sandbox tkt-4821 is running

  api          https://tkt-4821--api--acme.sbx.localhost
  app          https://tkt-4821--app--acme.sbx.localhost
```

Open one of those URLs. That is your branch, running.

Hostnames are always `<slug>--<label>--<project>.<domain>`. The slug is this sandbox, the label is
one app or service in the project, and the project is the name in its `sandboxr.yaml`.

The line about the GitHub token is said on every start where the token is off, which is the default.
Nothing is broken — `git commit` works inside the sandbox exactly as it does outside — but pushing
does not, and the only other moment you would find that out is a failed `git push` much later. See
[Access and security](../access.md) for what turning it on hands over.

**The first run on a project is the slow one.** It builds the project's own image layer — its
language toolchains and its dependencies, on top of the base image. Later runs reuse it. The image
is named after a hash of what goes into it, so a second branch that has not changed its toolchain
or its lockfile builds nothing at all and starts in seconds.

### What happened, in order

1. sandboxr worked out which worktree you meant, loaded `sandboxr.yaml`, and asked git for the
   branch and commit.
2. It derived the slug from the directory and the branch.
3. It picked a database seed source and produced the seed on the host, before the container
   existed.
4. It resolved the project's dependency tree and wrote a `plan.json` — the container's only view
   of your project. Nothing inside a sandbox reads `sandboxr.yaml`.
5. It built the project image layer, if a matching one was not already there.
6. It issued a certificate covering this sandbox's hostnames, when the router is serving HTTPS.
7. It started the container, mounting your worktree at `/workspace`.
8. Inside, the container read the plan, wrote its own service tree, and started up. Its own web
   server comes up immediately; the project's services wait for the database to be ready.
9. Back on the host, sandboxr staged the database copy, ran your migration command, and applied
   your fixtures.
10. It printed one URL per app.

Nothing on the host records that this sandbox exists. Everything sandboxr knows about it lives in
labels on the container, which is why `sandboxr ls` cannot disagree with reality.

### Starting one that already exists

Not an error. The container is replaced from the current config and the current commit, and its
volumes carry straight over. That is what makes `up` the right command after you edit
`sandboxr.yaml`.

### If it comes up degraded

`sandboxr up` exits with code **3** when the sandbox is running but its migrations failed. That is
deliberate: inspecting a failed migration is one of the reasons the sandbox exists, so it is not
torn down. See [Testing a migration](../guides/testing-a-migration.md).

<details class="agent">
<summary><b>Details for an agent</b> — every flag <code>sandboxr up</code> and <code>sandboxr down</code> accept</summary>

`up [slug]` — the positional argument is the slug, and it wins over everything derived.

| Flag | Effect |
|---|---|
| `--worktree PATH` | Build from this worktree instead of the current directory |
| `--project NAME` | Build from a project in the managed workspace instead of a path |
| `--branch NAME` | Which branch of it to run |
| `--base REF` | Create that branch off this ref first |
| `--ttl 12h` \| `--ttl never` | Stop it once it has sat unused this long. A span like `30m`, `12h`, `7d`, a number of seconds, or `never` |
| `--with a,b` | Also start runtimes the config marked `optional: true` |
| `--seed local` \| `file` \| `fixtures` | Force a seed source instead of letting precedence pick |
| `--detach` | Do not wait for it, and skip the database step entirely |
| `--json` | Put the full result on stdout |

`down [slug]` — removes the container, the certificate, and the database, blob, binary and
built-front-end volumes. `--keep` removes the container and leaves every volume, so the next `up`
reuses the database. Neither form touches your worktree, your branch, or the database the seed came
from.

**Exit codes**: `0` healthy, `3` degraded (running, migrations failed), anything else non-zero is
a failure.

**Refusals worth knowing about**

- An unreadable `--ttl` is refused before anything is built, by name.
- `--seed X` where `X` is not one of `local`, `file`, `fixtures` is refused immediately.
- A project whose apps are `public` is refused if a real credentials file exists for it on this
  machine. Both ways out are named in the message: set `access.credentials: real` and accept it,
  or set `access.apps: private`.
- Seed precedence, when you do not force one, is `local`, then `file`, then `fixtures` — filtered
  first by what the access rules permit.

**Waiting**: `up` waits up to 180 seconds for the container before it runs migrations.

**Where things are written on the host**

| Path | What |
|---|---|
| `~/.sandboxr/build/<project>/<slug>.plan.json` | The plan this sandbox is running |
| `~/.sandboxr/build/<project>/<slug>.env` | The generated environment, rewritten on every start |
| `~/.sandboxr/logs/<project>/<slug>/` | Logs that outlive the container |
| `~/.sandboxr/cache/` | The seed cache, mounted read-only into every sandbox |

</details>

## 3. Check it is healthy

```bash
sandboxr status
```

```
acme/tkt-4821
  state       running
  branch      tkt-4821@a1b2c3d
  driver      mysql
  migrations  ok
  access      public
  worktree    /home/dev/acme/.worktrees/tkt-4821

  up    api              https://tkt-4821--api--acme.sbx.localhost
```

The service lines list the project's **backends** and whether each answers. A front-end has no
process to probe unless it is a long-running dev server.

Every hostname a sandbox serves also answers a small status surface of its own, even while the
database is still restoring. No CLI needed:

| Path | Answers |
|---|---|
| `/__sandboxr/live` | `ok`, unconditionally — the container and its own web server are up |
| `/__sandboxr/status.json` | `booting`, `ok` or `degraded`, plus the migration verdict |
| `/__sandboxr/built.json` | Every app label, and when each was last built |
| `/__sandboxr/health/<service>` | Proxied to that service's own health path |

```bash
curl -s https://tkt-4821--app--acme.sbx.localhost/__sandboxr/live
```

## 4. Build a front-end

**Nothing is built when a sandbox starts.** An app that has never been built answers `503` with a
page naming the command that builds it.

That is deliberate. A sandbox has to come up in seconds, and the heaviest app in a project can
cost minutes and gigabytes.

```bash
sandboxr reload --web=app     # build one app
sandboxr reload --web=all     # build every app in the build-everything set
sandboxr reload --web=built   # rebuild only what this sandbox has already built
```

An app that is a long-running dev server rather than a build is **restarted** instead, and says
so. Backends are `sandboxr reload --go`. The whole loop is in
[The edit–reload loop](../guides/edit-and-reload.md).

## 5. Look inside

```bash
sandboxr logs -f          # the container's own log stream
sandboxr shell            # a shell inside, starting in /workspace
sandboxr db shell         # an interactive database prompt
```

Inside the shell, `/workspace` **is** your worktree. Edit a file there and it changes on your host;
`git status` in your worktree shows it. Edit a file on your host and it is inside the container
immediately. There is no sync step and no watcher.

## 6. Throw it away

```bash
sandboxr down
```

That removes the container, the database, the file storage, the built binaries and the built
front-ends. It does **not** touch your worktree, your branch, or the database your seed came from.

`sandboxr down --keep` removes the container and leaves the volumes, so the next `up` reuses the
same database.

```bash
git worktree remove .worktrees/tkt-4821
sandboxr gc                # reap sandboxes whose worktree is gone
```

<details class="failure">
<summary><b>If it goes wrong</b> — the failures specific to a first <code>up</code></summary>

**`no sandboxr.yaml here or in any parent`** — you are not in a project that describes itself. Run
`sandboxr config` to see where it looked. [Build your config, step by step](../configuration/index.md)
is the way in.

**`The shared router is not running, so this sandbox will have no hostname.`** — a warning, not a
refusal. The sandbox is running and useful; it just has no URL. Run `sandboxr init`.

**The URL loads but shows a 503 naming a build command** — that is the intended answer for an app
nobody has built yet. Run the command it names.

**`up` exits 3** — migrations failed and the sandbox is up so you can look at it.
`sandboxr logs` and `sandboxr db shell` are the next two commands, and both are printed for you.

Everything else, by symptom, is in [Troubleshooting](../troubleshooting.md).

</details>

**Next:** [Run the demo project](demo-project.md) — the one project proven end to end, and a config
small enough to read line by line. Then [Every worktree at once](every-worktree.md), which is the
case the tool actually exists for.
