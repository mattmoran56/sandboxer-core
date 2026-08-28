---
title: Just the CLI, on my laptop
description: Running sandboxr from the terminal alone — everything that still works, and the one thing that stops working when the dashboard is not there.
---

This is the smallest working setup: the `sandboxr` command, Docker, and nothing to log in to. It is
the right shape when you are the only person who needs these sandboxes and you already live in a
terminal.

```prompt
Set this machine up to run sandboxr from the command line only, and start a sandbox from the
repository in this directory.

Read docs/getting-started/install.md, then docs/setups/cli-only.md, then work through them.
Add SANDBOXR_REAP_MINUTES=0 to my shell profile and tell me you did, because nothing enforces a
sandbox lifetime on a machine whose dashboard is not running.

Stop and tell me if Docker is not running, if it has under 8 GB of memory, or if this directory
has no sandboxr.yaml — I will need to write one before anything can start.
```

## What you install

Exactly what everybody installs: Docker, Node 22, git, and the `sandboxr` command itself.
[Install it](../getting-started/install.md) has the steps.

## `init` still starts the dashboard, and there is no way to skip it

`sandboxr init` sets up the whole machine in one go: the shared Docker network, the base image, a
certificate if mkcert is trusted, the shared router, and the dashboard.

**There is no flag that leaves the dashboard out.** So "CLI only" is a decision about what you use,
not about what gets installed. You have two honest ways to hold it:

- **Leave it running and ignore it.** It costs one small container. Lifetimes are enforced, and the
  browser is there the day you want it.
- **Stop it.** `docker stop sandboxr-dashboard`, or `sandboxr teardown` to stop the router too.
  Nothing about `up`, `down` or any other command changes.

> [!NOTE] `doctor` will call a stopped dashboard a problem
> `sandboxr doctor` lists "the dashboard is not running" as a failed check and suggests
> `sandboxr init`. On this setup that is expected, not broken. Nothing else on the machine minds.

## What still works — which is nearly everything

The router is what gives a sandbox its hostname, and the router is independent of the dashboard. So
a sandbox you start from the terminal serves on its real URL whether or not anything is watching.

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

Managing repositories works too: `sandboxr project` and `sandboxr worktree` are ordinary CLI verbs
and need no browser. See [Several repositories at once](many-projects.md).

## The one thing that does not work: lifetimes

A sandbox is supposed to stop once it has sat unused for its lifetime — twelve hours by default.
**Nothing enforces that while the dashboard is not running.** The reaper is a timer inside the
dashboard process, and a process that is not there runs no timers.

So say so, rather than trusting a timer that will not fire:

```bash
export SANDBOXR_REAP_MINUTES=0
```

Zero turns the reaper off outright. On a machine where it was never going to run, that is the
truthful setting, and it means `sandboxr ls` is not showing you a countdown that nothing acts on.

You still have the manual version, which does the same work when you ask it to:

```bash
sandboxr expire --dry-run    # what would be stopped, and why
sandboxr expire              # stop them
```

`expire` only ever **stops** a sandbox. Its database and its uploads survive, and
`sandboxr start <slug>` brings it back in seconds. Put it on a `cron` or `launchd` timer if you
want the behaviour back without the dashboard.

The mechanism — what counts as use, the precedence ladder, what keep-alive really records — is on
[Projects, worktrees and lifetimes](../guides/managed-sandboxes.md).

## What else you give up

None of these is a limitation of the CLI. Each one is a feature that lives in the dashboard, so it
is absent for as long as the dashboard is.

| Missing | Why | What you use instead |
|---|---|---|
| The browser terminal | It is a WebSocket route inside the dashboard | `sandboxr shell <slug>` |
| Agent sessions | The dashboard starts `claude` inside a container and streams it to a browser | Run your own agent against the worktree — [agents in a sandbox](../guides/agents-in-a-sandbox.md) |
| Per-app build and migrate buttons | Actions are dashboard routes that stream their output to a page | `sandboxr reload`, `sandboxr db migrate` |
| **Private apps** | The router authenticates a private app by asking the dashboard. With no dashboard there is nothing to ask | Keep `access.apps` at its default, `public` |
| The idle timer | Covered above | `sandboxr expire`, by hand or on a timer |

> [!IMPORTANT] "Public" here means public to this machine
> The router binds `127.0.0.1`. A public app is reachable by browsers on this laptop and by nothing
> else on the network. That is what makes `public` a reasonable default here and a decision worth
> thinking about on a server. [Access and security](../access.md).

<details class="agent">
<summary><b>Details for an agent</b> — the full CLI surface on this setup, and the variables that change it</summary>

**Every command works except the ones that are dashboard routes.** There are no CLI verbs that
require the dashboard process. `sandboxr init` starts it regardless; stopping it afterwards is a
plain `docker stop sandboxr-dashboard`.

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
| `db` | `seed [--seed SOURCE]`, `migrate [slug]`, `snapshot [slug]`, `shell [slug]` |
| `secrets` | `list`, `set NAME`, `unset NAME`, `edit`, `import [--replace]`, `check` |
| `config`, `doctor`, `version`, `help` | — |

`--json` puts machine-readable output on stdout on every command; human output goes to stderr.

Exit codes: `0` success, `1` a general failure, `2` a config error (the message names the file and
the field), `3` from `up` when the sandbox came up `degraded`.

`status`, `logs`, `shell`, `reload` and `db` resolve a named sandbox's worktree from its own
container label, so they work from any directory. `--worktree PATH` overrides that; `--project
NAME` disambiguates a slug that exists in two projects.

Variables worth setting on this machine:

| Variable | Set it to | Because |
|---|---|---|
| `SANDBOXR_REAP_MINUTES` | `0` | No dashboard, no reaper. Say so |
| `SANDBOXR_DOMAIN` | leave it | Default `sbx.localhost` resolves to loopback with no DNS setup |
| `SANDBOXR_HOME` | leave it | Default `~/.sandboxr`, deliberately outside any repository |
| `SANDBOXR_PASSWORD` | set it anyway | Only the dashboard reads it, but `init` bakes it in, so setting it now means the browser works the day you want it |

The complete list is [Environment variables](../reference/environment.md).

</details>

<details class="failure">
<summary><b>If it goes wrong</b> — the three failures specific to running without a dashboard</summary>

**A sandbox has no hostname.** `up` warns `The shared router is not running, so this sandbox will
have no hostname` and carries on. The container is fine; the router is not up. Run `sandboxr init`.
This is about the router, not the dashboard.

**A private app will not open.** A project with `access.apps: private` gets a forward-auth
middleware on its hostnames, pointing at the dashboard. With the dashboard stopped there is nothing
to answer the check, so the hostname cannot be opened at all. Either start the dashboard or set the
project back to `public`.

**A sandbox you expected to be stopped is still running.** That is this page's headline. Nothing was
going to stop it. Run `sandboxr expire`, and set `SANDBOXR_REAP_MINUTES=0` so `ls` stops implying a
timer exists.

`sandboxr prune` has no dashboard action in any setup — it is a CLI command only, everywhere. See
[What is built](../reference/status.md).

</details>

<details class="why">
<summary><b>Why it works this way</b> — the reaper's home, and why nobody moved it</summary>

The reaper needs two things: to be running all the time, and to hold the Docker socket. The
dashboard is the only component on the machine that is both. A CLI process exits the moment it has
printed its answer, so a timer inside it would fire once and never again.

The alternative was a separate always-on daemon with a pidfile, which is a worse version of what
Docker already does for the dashboard's container. So the timer lives in the dashboard, and the
consequence is stated plainly rather than hidden: on a laptop whose dashboard is usually stopped,
sandboxes live until something stops them. `SANDBOXR_REAP_MINUTES=0` is how you write that down.

The same honesty applies to the idle signal itself. Last activity is read from the shared router's
access log. If the router cannot be read, every sandbox falls back to its start time rather than
being treated as idle — because reading a missing router as universal idleness would stop every
sandbox on the machine at once.

</details>

**Next:** [One repo, many branches](one-repo-many-worktrees.md) to get several branches running at
once, or [The dashboard on my laptop](dashboard-on-a-laptop.md) when you want the browser and the
idle timer back.
