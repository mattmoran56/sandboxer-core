---
title: When to use it
description: The six cases where a sandbox earns its cost, the five where it is the wrong tool, and the honest list of things it will not do for you.
sidebar:
  order: 2
---

> **Partly verified** — The trade-offs and the failure modes are real, drawn from daily use of the internal tool sandboxr generalises; the timing and memory figures were measured there, not here, and no sandbox has yet been started end to end with sandboxr itself.

A sandbox is cheap enough to be careless with and expensive enough that one per idea is a bad
habit. On the project it was measured against, one used about 560 MB of memory and took around
thirty seconds to start once the data had been cached. Here is where that pays for itself.

## Use one when

**A branch touches more than one service.** A change that moves a field from one service to
another cannot be reviewed by reading two diffs. Running both, against one database, is the
only honest check.

**You need to send somebody a link.** A designer, a product manager, the person who filed the
ticket. A sandbox hostname is a normal URL serving the real app from your branch — no account
for them, no build step for them, no screenshots. (This one depends on the router, which is
[not built yet](../reference/status.md).)

**You are changing the database.** This is the strongest case. A sandbox's database is a
*copy* — taken from a database container you already run, or restored from a dump file — so a
half-written migration can be pointed at real structure and real volume. Getting it wrong
costs one `sandboxr down` and one `sandboxr up`. The source database is only ever read.

**Two branches need comparing side by side.** Two sandboxes, both running, each with the
database its own migrations produced. No stashing, no rebuild between them.

**An agent is going to work unsupervised for a while.** The branch's directory is linked live
into the container, so the agent's edits are your branch's edits, and it has somewhere to see
the result of its own work without touching the tree you have open in an editor. See
[agents in a sandbox](../guides/agents-in-a-sandbox.md).

**A reviewer wants to poke at a pull request without checking it out.** From the dashboard, a
pull request with no sandbox is one button away from having one.

## Do not use one when

**You want the page to update as you type.** There is no hot reload. The loop is edit, rebuild
the thing you touched, refresh. That is a deliberate trade: a live development server for
every app in every sandbox would hold hundreds of megabytes for as long as the container
lived, and the whole point is running several sandboxes at once. If you are iterating on one
component's styling, run that app's development server on your own machine and keep the
sandbox for checking the whole thing works together.

**A unit test would answer the question.** Run the test. A sandbox is for questions that need
everything running at once.

**You need to reproduce something that happened to real production data.** A sandbox starts
from structure plus made-up fixture data, or from an anonymised dump. If the project's apps are
public it *may not* be loaded from live data at all — that is
[a refusal](../security/public-sandboxes.md), not a setting you can flip. Debugging one real
customer's record is a different job with different rules.

**You are measuring performance.** Several sandboxes share one machine's processors and one
Docker virtual machine's memory. Numbers taken from a sandbox mean nothing.

**The machine has under 8 GB available to Docker.** Below that you will spend your time having
things killed for memory, and under memory pressure the thing the kernel picks may not be the
sandbox — it can be your own local database.

<details>
<summary><b>Details for an agent:</b> how many sandboxes actually fit, and why the 4 GB limit is not the number to divide by</summary>

Two different numbers get confused here.

- The **limit** on a sandbox is a ceiling the kernel enforces. It is the largest `memory:` any
  single app in the project declares, with a floor of **4 GB**. Nothing is reserved: a
  container under a 4 GB cap using 500 MB is using 500 MB.
- **Actual use** is the number that decides how many fit. On the monorepo this was measured
  against, everything running came to roughly 560 MB per sandbox — so five or six on an 8 GB
  Docker virtual machine was comfortable.

Divide by real usage, not by the cap. The cap only matters at the moment something spikes,
which in practice means a large front-end build.

Sizing figures and what to give a shared machine: [prerequisites](../getting-started/prerequisites.md).

</details>

## The honest limits

> [!WARNING] Things a sandbox will not do for you
> - **There is no router yet.** Nothing maps `feat-123.app.acme.sbx.localhost` to a container.
>   Containers are labelled so a router could find them, but no code starts or configures one.
>   Today a sandbox is reached with `sandboxr shell` or a reverse proxy you run yourself.
> - **There is no setup command.** There is no `sandboxr init`. DNS, the certificate and the
>   router are all manual right now — [set up your machine](../getting-started/setup.md) says exactly what to
>   do by hand.
> - **No hot reload.** Every change needs a rebuild of the thing you touched.
> - **Front-ends are built on demand, never at startup.** A sandbox that has just come up has
>   built nothing. Each app answers `503` with a page naming the command that builds it, until
>   you run it.
> - **Heavy front-end builds need headroom.** A static site rendering thousands of pages needs
>   more than the 4 GB floor and is killed part-way through without it — reported by npm as
>   nothing but `code 137`, with no mention of memory. Declare `memory:` on that app. See
>   [the edit–reload loop](../guides/edit-and-reload.md).
> - **A failed migration leaves the sandbox running.** That is intended — inspecting a failed
>   migration is one of the reasons the sandbox exists — but it means "the sandbox is up" is not
>   the same as "the database is what you expected". Check for `degraded`.
> - **One writer per file-backed database.** Two processes opening the same D1 or SQLite file
>   deadlock, so exactly one service may own it. See [D1 and SQLite](../databases/d1-sqlite.md).

## Laptop or shared server?

Both are intended, and the difference is not the tool — it is DNS and certificates. Everything
past that point is identical.

| | Laptop | Shared server |
|---|---|---|
| Domain | `sbx.localhost`, a made-up suffix that resolves only on your machine | A real domain you own, with a wildcard record |
| DNS | A local resolver, installed once with `sudo` | Wildcard `A`/`AAAA` records at your DNS provider |
| Certificates | A certificate authority only your own machine trusts | Real certificates from a public authority |
| Database source | Copy the database container you already run | Restore an anonymised dump; copying a live database is not available |
| Who can reach it | You | Anyone, which is why the security pages exist |

Start on a laptop. Neither path is automated yet.

<details>
<summary><b>Details for an agent:</b> what is not built on either path, so you can plan around it</summary>

| Piece | State |
|---|---|
| A command that installs DNS, a certificate or a router | **Does not exist.** There is no `sandboxr init`. |
| The machine-wide router | **Not built.** Containers carry a `sandboxr.router=true` label so one could find them; nothing starts one. |
| Real remote deployment — wildcard DNS, automatic certificates, a service that starts at boot | **Planned.** [The deployment guide](../running-on-a-server.md) is intent, not instructions. |
| Building the per-project image layer | **Not built.** A template exists at `container/project/Dockerfile.template`; nothing renders or builds it. `packages/core` runs `sandboxr/base:latest` unless `SANDBOXR_IMAGE` overrides it. |
| A coding agent running inside a sandbox | **Planned.** |
| Continuous integration for sandboxr itself | **Not built.** |

The full list, kept current: [what is built](../reference/status.md).

</details>

Next: [prerequisites](../getting-started/prerequisites.md).
