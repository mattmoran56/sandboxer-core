---
title: Which setup is yours
description: The five ways people run sandboxr, what each one gives you, what it costs, and which page to read next.
---

sandboxr works the same way on every machine. What changes is **which machine it runs on**, and
**what you point it at** — and those are two separate decisions. This page makes both of them, then
sends you to one page.

```prompt
Work out which sandboxr setup fits this machine and tell me which one, with your reasoning.

Read docs/setups/index.md, then read the page for the setup you pick. Check what is actually
here first: is Docker running, how much memory has it been given, is there a git repository in
this directory, and does anything already exist under ~/.sandboxr. Do not install anything yet.

Stop and ask me if the answer depends on whether other people need to open these URLs, or if
this machine looks like a shared server rather than somebody's laptop.
```

## The two decisions

**Where it runs.** Pick exactly one of the first three rows. Each one is a superset of the one
above it, so you can move up later without redoing anything.

**What you point it at.** The last two rows are about your repositories, not your machine. Either
applies to any of the first three.

If a term in the table is unfamiliar, [the glossary](../reference/glossary.md) has it.

| Setup | What you get | What it costs | What it needs |
|---|---|---|---|
| [Just the CLI, on my laptop](cli-only.md) | Every command. Real sandboxes on real hostnames. Nothing to log in to | No browser terminal, no agent sessions, no private apps — and nothing enforces a lifetime | Docker, Node 22, git. Give Docker about 8 GB |
| [The dashboard on my laptop](dashboard-on-a-laptop.md) | All of the above, plus a browser: every worktree, buttons, streamed logs, a terminal, agent sessions, and the idle timer | One password, which is a root credential for the machine, held by a container that holds the Docker socket | The same, plus `SANDBOXR_PASSWORD` before you run `sandboxr init` |
| [On a server, for a team](shared-server.md) | Branches your colleagues can open without a laptop or a terminal | **This does not exist yet.** The page is sizing arithmetic and a plan, not instructions | Somebody to build the missing pieces first |
| [One repo, many branches](one-repo-many-worktrees.md) | Every branch of one project running at once, out of worktrees you already keep | Memory, mostly. Two worktrees on one ticket want one name, which sandboxr settles for the ones it cuts | One repository, with git worktrees cut from it |
| [Several repositories at once](many-projects.md) | sandboxr keeps the repositories itself. Pick a branch, get a sandbox | A managed workspace to learn, and `--project NAME` on most commands | Disk for the clones. `gh` for the convenient parts |

## If you are not sure

Start at [just the CLI](cli-only.md) with [one repository](one-repo-many-worktrees.md). It is the
smallest thing that works, and everything you learn there is still true in the other four setups.

Add the [dashboard](dashboard-on-a-laptop.md) the first time you want to hand somebody a URL
without also handing them a terminal.

<details class="facts">
<summary><b>Fact sheet</b> — the defaults every setup shares</summary>

| Thing | Default | Set by |
|---|---|---|
| Domain | `sbx.localhost` | `SANDBOXR_DOMAIN` |
| Sandbox hostname | `<slug>.<label>.<project>.<domain>` | derived — see [how it works](../how-it-works.md) |
| Dashboard hostname | `<domain>`, the bare domain, and never a sandbox hostname | fixed |
| Router bind address | `127.0.0.1`, ports 80 and 443 | `sandboxr init --bind`, `--http-port`, `--https-port` |
| Host state | `~/.sandboxr` | `SANDBOXR_HOME` |
| Managed repositories | `~/.sandboxr/workspace` | `SANDBOXR_WORKSPACE` |
| Idle limit | `12h` | `~/.sandboxr/config.yaml`, `--ttl`, `SANDBOXR_TTL_HOURS` |
| Reaper interval | every `5` minutes, and only while the dashboard runs | `SANDBOXR_REAP_MINUTES` |
| Sandbox memory cap | the largest `memory:` any one app declares, floor `4g` | the project's `sandboxr.yaml` |
| Certificate issuer | mkcert, and nothing else | — |

Every variable is listed on [Environment variables](../reference/environment.md). Every command
and flag is on [CLI commands](../reference/cli.md).

</details>

**Next:** [Install it](../getting-started/install.md) if you have not yet, or go straight to the
setup page you picked above — each one starts from a working install.
