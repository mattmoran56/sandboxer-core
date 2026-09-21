---
title: Which setup is yours
description: The four ways people run sandboxr, what each one gives you, what it costs, and which page to read next.
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

**Where it runs.** Pick one of the first two rows. Your own machine is the ordinary answer;
a server is the same tool on somebody else's hardware, and it is not finished.

**What you point it at.** The last two rows are about your repositories, not your machine. Either
applies to either of the first two.

If a term in the table is unfamiliar, [the glossary](../reference/glossary.md) has it.

| Setup | What you get | What it costs | What it needs |
|---|---|---|---|
| [Just the CLI, on my laptop](cli-only.md) | **The default.** Every command. Real sandboxes on real hostnames. Nothing to log in to | Nothing enforces a lifetime, so `sandboxr expire` is yours to run. No private apps | Docker, Node 22, git. Give Docker about 8 GB |
| [On a server, for a team](shared-server.md) | Branches your colleagues can open without a laptop of their own | **This does not exist yet.** The page is sizing arithmetic and a plan, not instructions | Somebody to build the missing pieces first |
| [One repo, many branches](one-repo-many-worktrees.md) | Every branch of one project running at once, out of worktrees you already keep | Memory, mostly. Two worktrees on one ticket want one name, which sandboxr settles for the ones it cuts | One repository, with git worktrees cut from it |
| [Several repositories at once](many-projects.md) | sandboxr keeps the repositories itself. Pick a branch, get a sandbox | A managed workspace to learn, and `--project NAME` on most commands | Disk for the clones. `gh` for the convenient parts |

## If you are not sure

Start at [just the CLI](cli-only.md) with [one repository](one-repo-many-worktrees.md). It is the
smallest thing that works, and everything you learn there is still true in the other three setups.

Move to [several repositories](many-projects.md) the first time you want a branch of a project you
have no checkout of. Nothing you set up has to be redone.

<details class="facts">
<summary><b>Fact sheet</b> — the defaults every setup shares</summary>

| Thing | Default | Set by |
|---|---|---|
| Domain | `sbx.localhost` | `SANDBOXR_DOMAIN` |
| Sandbox hostname | `<slug>--<label>--<project>.<domain>` | derived — see [how it works](../how-it-works.md) |
| The bare domain | `<domain>` itself, left empty for a control plane of your own, and never a sandbox hostname | fixed |
| Router bind address | `127.0.0.1`, ports 80 and 443 | `sandboxr init --bind`, `--http-port`, `--https-port` |
| Host state | `~/.sandboxr` | `SANDBOXR_HOME` |
| Managed repositories | `~/.sandboxr/workspace` | `SANDBOXR_WORKSPACE` |
| Idle limit | `12h` | `~/.sandboxr/config.yaml`, `--ttl`, `SANDBOXR_TTL_HOURS` |
| What enforces that limit | `sandboxr expire`, when you run it | a `cron` or `launchd` timer of your own |
| Sandbox memory cap | the largest `memory:` any one app declares, floor `4g` | the project's `sandboxr.yaml` |
| Certificate issuer | mkcert, and nothing else | — |

Every variable is listed on [Environment variables](../reference/environment.md). Every command
and flag is on [CLI commands](../reference/cli.md).

</details>

**Next:** [Install it](../getting-started/install.md) if you have not yet, or go straight to the
setup page you picked above — each one starts from a working install.
