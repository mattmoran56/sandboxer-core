---
title: Just the CLI, on my laptop
description: The ordinary setup — the sandboxr command, Docker, and nothing to log in to — and the one job you have to give a timer.
---

This is the whole of sandboxr: the `sandboxr` command, Docker, and nothing to log in to. The
engine has no web interface of its own, so there is nothing to start besides the shared router,
nothing to authenticate against and nothing else to keep running.

```prompt
Set this machine up to run sandboxr, and start a sandbox from the repository in this directory.

Read docs/getting-started/install.md, then docs/setups/cli-only.md, then work through them.
Once a sandbox is up, add a cron entry that runs `sandboxr expire` every fifteen minutes and tell
me what you added — nothing else on this machine enforces a sandbox's lifetime.

Stop and tell me if Docker is not running, if it has under 8 GB of memory, or if this directory
has no sandboxr.yaml — I will need to write one before anything can start.
```

## What you install

Docker, Node 22, git, and the `sandboxr` command itself.
[Install it](../getting-started/install.md) has the steps.

## `init` prepares the machine and starts the router

`sandboxr init` makes the directories, builds the base image, issues a certificate if mkcert is
trusted, writes the router's configuration and starts the shared router. It then says that nothing
is serving the bare domain, because nothing is: the bare domain is left free for a control plane,
and sandboxr does not have one.

Your sandboxes do not need it. They answer on their own hostnames, through that same router.

```
  sandboxes   https://<slug>--<label>--<project>.sbx.localhost
  bare domain https://sbx.localhost — free, for a control plane on port 8080
```

Everything under the domain resolves to `127.0.0.1` with no DNS configuration at all, which is why
`sbx.localhost` is the default.

## What you can do, which is everything the engine does

| You want to | Command |
|---|---|
| Start a sandbox from this worktree | `sandboxr up` |
| Remove it, and its database and uploads | `sandboxr down` |
| Stop the container but keep everything | `sandboxr stop <slug>` |
| Start a stopped one again | `sandboxr start <slug>` |
| See every sandbox on the machine | `sandboxr ls` |
| See one in detail, with its URLs | `sandboxr status <slug>` |
| Follow its log | `sandboxr logs <slug> -f` |
| Get a shell inside it | `sandboxr shell <slug>` |
| Rebuild a backend or a front-end | `sandboxr reload <slug> --go` / `--web=app` |
| Re-run its migrations | `sandboxr reload <slug> --migrate` |
| Work on its database | `sandboxr db shell`, `db migrate`, `db seed`, `db snapshot` |
| Exempt one from the idle clock | `sandboxr keep <slug>` / `sandboxr unkeep <slug>` |
| Stop everything past its idle limit, now | `sandboxr expire` |
| Reap sandboxes whose worktree is gone | `sandboxr gc` |
| Reclaim disk from old images and volumes | `sandboxr prune` |
| Edit a project's credentials | `sandboxr secrets list`, `set`, `unset`, `edit` |
| Load them from the project's own `.env` files | `sandboxr secrets import`, then `secrets check` |
| See which config resolved, and to what | `sandboxr config` |
| Check the machine | `sandboxr doctor` |

Managing repositories works the same way: `sandboxr project` and `sandboxr worktree` clone, list,
cut, rename, pull and delete. See [Several repositories at once](many-projects.md).

## Lifetimes: the one job that needs a timer

A sandbox is supposed to stop once it has sat unused for its lifetime — twelve hours by default.
**`sandboxr expire` is the whole of that mechanism, and nothing runs it for you.** sandboxr starts
no daemon and has no reaper of its own, so a machine that never runs `expire` keeps every sandbox
it ever started.

```bash
sandboxr expire --dry-run    # what would be stopped, and why
sandboxr expire              # stop them
```

`--dry-run` prints one line per sandbox with the reason — `would stop acme-login — idle 9h, past
its 8h limit` — so the plan is checkable before anything goes away. `--project NAME` narrows it to
one project.

**`expire` only ever stops a container.** Its database, its uploaded files and its worktree all
survive, and `sandboxr start <slug>` brings it back in seconds. Nothing is deleted, so running it
from a timer is safe.

Put it on one:

```bash
# crontab -e — every fifteen minutes
*/15 * * * * /usr/local/bin/sandboxr expire >> $HOME/sandboxr-expire.log 2>&1
```

<details class="agent">
<summary><b>Details for an agent</b> — what the clock reads, and what cron does not inherit</summary>

**The deadline is `max(startedAt, lastActive) + ttl`.** Using a sandbox resets its clock, and
restarting it buys a full lifetime. `lastActive` is read from the shared router's access log — a
request to one of the sandbox's apps, a request path naming it, or a socket somebody is holding
open on it. `startedAt` is the floor, because the log window only reaches so far back and a
sandbox in constant use whose evidence has scrolled off must not read as idle since the beginning
of time.

**A sandbox somebody asked to keep is exempt.** `sandboxr keep <slug>` writes
`~/.sandboxr/state/keep/<project>/<slug>`; `unkeep` removes it. `expire` reads that file, so the
exemption survives a restart and is visible on disk.

**If the router's log cannot be read, every sandbox falls back to its start time** rather than
being treated as idle. Reading a missing router as universal idleness would stop every sandbox on
the machine at once, which is the failure this rule exists to prevent.

**cron does not inherit your shell.** It runs with a near-empty environment and a `PATH` that
often does not include `/usr/local/bin`, so give `sandboxr` its absolute path. If you set
`SANDBOXR_HOME` or `SANDBOXR_WORKSPACE` in your profile, set them in the crontab too — an `expire`
pointed at the default `~/.sandboxr` will not find sandboxes you keep somewhere else. `launchd`
and `systemd --user` have the same trap and the same fix.

`expire` exits `0` whether or not it stopped anything, so a timer that reports non-zero exits stays
quiet until something real goes wrong.

</details>

## What sandboxr does not do

None of these is a limitation of this setup. sandboxr is a command-line tool, and each of them is a
job for something built on top of it.

| Not here | Why | What you use instead |
|---|---|---|
| A browser terminal | There is no web process to hold a socket | `sandboxr shell <slug>` |
| Buttons that build and migrate | The verbs are the interface | `sandboxr reload`, `sandboxr db migrate` |
| Anything on the bare domain | `init` prepares it and starts nothing on it | Run your own front end there — [Access and security](../access.md) |
| **Private apps** | The router asks whatever is on the bare domain whether a request is allowed. With nothing there, nothing answers | Keep `access.apps` at its default, `public`, or run a front end |
| A lifetime that enforces itself | Covered above | `sandboxr expire`, on a timer |

> [!IMPORTANT] "Public" here means public to this machine
> The router binds `127.0.0.1`. A public app is reachable by browsers on this laptop and by nothing
> else on the network. That is what makes `public` a reasonable default here and a decision worth
> thinking about on a server. [Access and security](../access.md).

<details class="agent">
<summary><b>Details for an agent</b> — the full CLI surface, and the variables that change it</summary>

Verbs, with the flags that matter here:

| Verb | Flags |
|---|---|
| `init` | `--no-tls`, `--tls`, `--rebuild`, `--bind ADDR`, `--http-port N`, `--https-port N` |
| `teardown` | `--network` (refused while a sandbox is still on the network) |
| `up [slug]` | `--worktree PATH`, `--project NAME`, `--branch NAME`, `--base REF`, `--ttl 12h\|never`, `--with a,b`, `--seed local\|file\|fixtures`, `--detach` |
| `down [slug]` | `--keep` |
| `stop <slug>` / `start <slug>` | `--project NAME` |
| `keep <slug>` / `unkeep <slug>` | `--project NAME` |
| `ls` | `--project NAME` |
| `status [slug]` | — |
| `logs [slug]` | `--tail N`, `-f` |
| `shell [slug]` | — |
| `reload [slug]` | `--go [name]`, `--web=<label\|all\|built>`, `--migrate` |
| `expire` | `--dry-run`, `--project NAME` |
| `gc` | `--dry-run` |
| `prune` | `--yes`, `--build-cache` |
| `project` | `ls`, `available`, `clone <url> [--name NAME]`, `fetch <name>`, `prs <name>` |
| `worktree` | `ls`, `add [--base REF]`, `rm [--force]`, `delete [--force]`, `name`, `pull` |
| `db` | `seed [--seed SOURCE]`, `migrate [slug]`, `snapshot [slug]`, `shell [slug]` |
| `secrets` | `list`, `set NAME`, `unset NAME`, `edit`, `import [--replace]`, `check` |
| `config`, `doctor`, `version`, `help` | — |

`--json` puts machine-readable output on stdout on every command; human output goes to stderr.

Exit codes: `0` success, `1` a general failure, `2` a config error (the message names the file and
the field), `3` from `up` when the sandbox came up `degraded`.

`status`, `logs`, `shell`, `reload` and `db` resolve a named sandbox's worktree from its own
container label, so they work from any directory. `--worktree PATH` overrides that; `--project
NAME` disambiguates a slug that exists in two projects.

Variables worth knowing on this machine:

| Variable | Set it to | Because |
|---|---|---|
| `SANDBOXR_HOME` | leave it | Default `~/.sandboxr`, deliberately outside any repository |
| `SANDBOXR_WORKSPACE` | a path on another disk, or leave it | The one part of the tree worth moving; default `~/.sandboxr/workspace` |
| `SANDBOXR_DOMAIN` | leave it | Default `sbx.localhost` resolves to loopback with no DNS setup |
| `SANDBOXR_TTL_HOURS` | a number, or leave it | The lifetime a sandbox gets when neither `--ttl` nor `config.yaml` names one |

**Nothing reads a file of these.** There is no `.env` anywhere in sandboxr's own tree and nothing
loads one, so they are shell variables: export them from your profile, or use
`set -a && . ./.env && set +a` if you would rather keep them in a file of your own. The complete
list is [Environment variables](../reference/environment.md).

</details>

<details class="failure">
<summary><b>If it goes wrong</b> — the three failures this setup actually has</summary>

**A sandbox has no hostname.** `up` warns `The shared router is not running, so this sandbox will
have no hostname` and carries on. The container is fine; the router is not up. Run `sandboxr init`.

**A private app will not open at all.** A project with `access.apps: private` gets a forward-auth
middleware on its hostnames, pointing at the bare domain. With nothing serving the bare domain
there is nothing to answer the check, so the hostname refuses every request. Either put a front
end there or set the project back to `public`.

**A sandbox you expected to be stopped is still running.** Nothing was going to stop it. Run
`sandboxr expire`, then put it on a timer as above.

</details>

<details class="why">
<summary><b>Why it works this way</b> — why `expire` is a command rather than a daemon</summary>

Enforcing a lifetime needs two things: something running all the time, and the Docker socket. A CLI
process exits the moment it has printed its answer, so a timer inside it would fire once and never
again — and an always-on daemon with a pidfile is a worse version of what `cron`, `launchd` and
`systemd` already do well.

So `expire` is a plain command: a pure plan you can print with `--dry-run`, followed by stops. The
consequence is stated rather than hidden — on a machine with no timer, sandboxes live until
something stops them — and the fix is one crontab line.

It takes no argument from an embedder, either, and that is deliberate. A cron job has nobody to
hand it a product's half of the evidence, so the signals `expire` reads are all the engine's own:
the router's access log, and the marker a held socket writes.

</details>

---

**Next:** [One repo, many branches](one-repo-many-worktrees.md) to get several branches running at
once, or [Start, stop, list, clean up](../guides/lifecycle.md) for the day-to-day loop.
