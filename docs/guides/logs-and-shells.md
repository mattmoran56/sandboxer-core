---
title: Logs, shells and terminals
description: Three ways to look inside a running sandbox — the container's log stream, the per-service log files, and a shell — and when each one is the right one.
sidebar:
  order: 3
---

> **Written, never run** — `sandboxr logs` and `sandboxr shell` exist in packages/cli, and the container writes the per-service files described here; no sandbox has ever been running for anyone to read a log out of.

A sandbox runs several things at once — a router, a database, a database-provisioning step,
one process per backend, sometimes a development server. When something is wrong, there are
three genuinely different ways to look inside, and picking the wrong one is most of why people
find a sandbox opaque.

1. **The container's own log stream** — everything, interleaved, in one place.
2. **The per-service log files** — one process on its own, without the noise.
3. **A shell** — for when reading is not enough and you need to run something.

## 1. The container's log stream

```bash
sandboxr logs                    # the last 200 lines
sandboxr logs feat-123           # a sandbox other than this worktree's
sandboxr logs --tail 1000        # more history
sandboxr logs -f                 # follow: keep printing as new lines arrive
```

This is the container's own output — the same thing `docker logs` would show you — and it
carries **every process in the sandbox, interleaved**. That is its strength and its weakness.
It is the right place to look when you do not yet know which part is broken, especially in the
first minute of a sandbox's life, when a container that dies during boot leaves its reason
here and nowhere else.

It is the wrong place to look once you know which service you care about, because there is no
way to filter it after the fact. That is what the per-service files below are for.

<details>
<summary><b>Details for an agent:</b> the exact syntax, where the output goes, and how `-f` behaves</summary>

```
sandboxr logs [slug] [--tail N] [-f|--follow] [--json]
```

- `slug` is optional and defaults to the sandbox for the current worktree, as everywhere else.
- `--tail` defaults to **200**.
- `-f` and `--follow` are the same flag. A followed log has no end, so it is streamed straight
  through rather than collected: buffering it would hold every line and print none until the
  container died.
- **The log itself goes to stdout**, not stderr, whether or not `--json` was asked for, so
  `sandboxr logs > today.txt` produces the file you expected. Human-readable *status* output
  from other commands goes to stderr; here the log is the result, not commentary on it.
- `--json` returns `{ container, lines: [...] }` instead, which is the shape to parse. It has
  no effect on `-f`.
- **`logs` takes no service argument.** `sandboxr logs feat-123 api` does not select the `api`
  service; the second positional is not read.

`cmdLogs` in `packages/cli/src/main.ts`.

</details>

## 2. The per-service log files

Every supervised process in the sandbox also writes its own file:

```
/var/log/sandboxr/api.log        one backend
/var/log/sandboxr/db-init.log    provisioning: restore, migrations, fixtures, buckets
/var/log/sandboxr/caddy.log      the sandbox's internal router
/var/log/sandboxr/mysqld.log     the database server
```

The file is named after the service, and the services are the backends the config declares,
any `serve:` front-end, and the handful the container runs for itself.

**`db-init.log` is the one worth remembering.** Restoring the database, running the project's
migrations and applying its fixtures all happen there, so it is the first place to look when a
sandbox comes up `degraded`.

These files are why a busy sandbox is readable at all. The container's log stream mixes every
process together and cannot be filtered afterwards, which makes it useless for the question
"what did the API do" — for a person, and just as much for a coding agent trying to work out
what broke.

### They are on your machine, not just in the container

That directory is a bind mount of a directory on the host:

```
~/.sandboxr/logs/acme/feat-123/
```

Same files, two names. Which means you can `grep`, `tail` and open them with ordinary tools,
without a shell inside the sandbox — and, deliberately, that **they survive `sandboxr down`**.
The logs from a sandbox you have just deleted are usually the ones you want.

> [!TIP] Why the log path is outside every repository
> `SANDBOXR_HOME` defaults to `~/.sandboxr` and is never inside a checkout, so `git clean -xdf`
> cannot destroy your logs, your database seed cache or your certificate.

<details>
<summary><b>Details for an agent:</b> how the files are written, and the size rule that stops a long-lived sandbox filling its own disk</summary>

`container/scripts/logged.sh` wraps every supervised service:

```bash
exec "$@" >>"$LOG" 2>&1
```

Two properties of that line matter.

**It redirects, and never pipes.** Writing `exec cmd | tee log` would make the *shell* the
supervised process. The supervisor would then signal the shell on restart, the service itself
would survive still holding its port, and every replacement would die with `address already in
use` while the old code carried on serving. The symptom is "my change did nothing" and the
cause is a run script.

**The files are trimmed, not rotated.** Before a service starts, a log over **20 MB** is cut
back to its last **5 MB**. These are development logs: a sandbox left up for days must not be
able to fill its own disk, and nobody is going to want the beginning of a crash loop from
Tuesday. The trim is best-effort and can never stop a service from starting.

Paths: `LOG_DIR` is `/var/log/sandboxr` inside (`packages/core/src/sandbox/layout.ts`), mounted
from `~/.sandboxr/logs/<project>/<slug>` on the host (`paths().logsFor`).

</details>

## 3. A shell inside

```bash
sandboxr shell               # this worktree's sandbox
sandboxr shell feat-123      # a named one
```

You land in `/workspace`, which is your worktree, with the project's toolchain on `PATH` at the
versions the config declares. Anything you build or edit there is happening in your worktree:

```bash
$ sandboxr shell
sandbox:/workspace$ go build ./services/api
sandbox:/workspace$ exit

$ git status
	modified:   services/api/handler.go
```

That is the same property agents rely on. It also means `rm -rf` in a sandbox shell deletes
files from your branch. **The container is disposable; the mount is not.**

To run one command instead of opening a shell, put it after a bare `--`:

```bash
sandboxr shell -- go test ./...
sandboxr shell feat-123 -- npm run lint
```

That is the form to use from a script or an agent: it returns the command's own exit code, so
it composes with everything else.

A database shell is a separate command, because it needs the database's own client:

```bash
sandboxr db shell            # an interactive client against this sandbox's database
```

<details>
<summary><b>Details for an agent:</b> what `shell` actually execs, and why the `--` form is the one to script with</summary>

```
sandboxr shell [slug] [-- command...]
```

It runs `docker exec -it <container> <command>` with the working directory set to
`/workspace`. With nothing after `--` the command is `bash`.

Everything after the bare `--` is passed through as an **argument array**, not a shell string,
so nothing in it is re-interpreted by a shell on the way. The exit code is the command's own.

There is no `--project` or config-free form: `shell` resolves the project from the
`sandboxr.yaml` above the current directory, the same as every other command, and derives the
slug from the positional argument, `--slug`, or the worktree.

`cmdShell` in `packages/cli/src/main.ts`.

</details>

## The same three things, in a browser

The dashboard gives you all of this without a terminal or a checkout: it streams a sandbox's
logs live, and it offers a **terminal inside any sandbox** as a page in the browser.

```
https://sbx.localhost/p/acme/s/feat-123/terminal
```

Note the shape. It is a route *inside the dashboard*, not a hostname of its own — so it
inherits the dashboard's login, and there is no second way in to get wrong. A terminal on a
per-sandbox hostname would be one configuration mistake away from an interactive shell, on the
internet, on your Docker host.

Everything the dashboard can do, and how it is protected: [the dashboard](./dashboard.md).

## Choosing between them

| You want to | Use |
|---|---|
| Find out why a sandbox died during boot | `sandboxr logs <slug>` — the container stream is the only place a boot failure lands |
| Watch a sandbox come up | `sandboxr logs -f` |
| See why one backend is crash-looping | `~/.sandboxr/logs/<project>/<slug>/<name>.log` |
| See why the database is not what you expected | the same directory's `db-init.log` |
| Read the logs of a sandbox you already deleted | the same directory — it outlives the container |
| Run a build, a test, or poke at files | `sandboxr shell`, or `sandboxr shell -- <command>` |
| Query the database | `sandboxr db shell` |
| Compare the schema against another branch | `sandboxr db snapshot > after.sql` |
| Do any of this from a machine that is not yours | the [dashboard](./dashboard.md) |
