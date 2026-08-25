---
title: sandboxr documentation
description: Turn any git worktree into a running copy of a whole project, on its own hostname. Start here, whatever you came to do.
tableOfContents: false
---

**sandboxr turns a git worktree into a running copy of a whole project, on its own hostname.**

One container per branch. Inside it: every service the project declares, every front-end, its
own database and its own file storage. Several run at once — on a laptop or a server — and each
is reachable in a browser at an address of its own.

```bash
cd .worktrees/feat-123
sandboxr up
# https://feat-123.app.acme.sbx.localhost
# https://feat-123.api.acme.sbx.localhost
```

> **sandboxr is early.** No project has been run in a sandbox from start to finish yet, so treat
> every command here as the behaviour the code intends rather than behaviour anyone has watched.
> [What is built, honestly](reference/status.md) says exactly which is which, page by page.

## Start with what you came to do

| I want to… | Go to |
|---|---|
| **Understand what this is** and whether it would help | [What sandboxr is](introduction/what-it-is.md), then [when to use it](introduction/when-to-use.md) |
| **Try it** on my own machine | [Getting started](getting-started/index.md) |
| **Find my way around the repository** — what is where, and how the pieces fit | [The repository map](orientation/repository-map.md) |
| **Use it day to day** — start one, rebuild something, read a log | [Guides](guides/index.md) |
| **Describe my project to it** so it knows what to run | [Configuring a project](configuration/index.md) |
| **Test a migration** without fear | [Testing a migration](guides/testing-a-migration.md) |
| **Know who can reach what**, before I point a domain at anything | [Access and security](security/index.md) |
| **Understand how it works** inside | [Architecture](architecture/index.md) |
| **Look something up** — a command, a field, a variable | [Reference](reference/index.md) |
| **Work out why something broke** | [Troubleshooting](troubleshooting.md) |
| **Operate it as an agent**, exactly and without guessing | [Reference](reference/index.md), then [the repository map](orientation/repository-map.md) |

## How these pages are written

Every page is written twice over, in the same file.

**The main text is prose**, for somebody meeting the idea for the first time. Short sentences,
no unexplained jargon, and the reason for a thing before its name.

**The exact detail is folded away** in expandable blocks whose label says who they are for and
what is inside — "Details for an agent: every field of the database block", "If it goes wrong:
the five failure modes and their fixes". Open them when you need the precision; ignore them
otherwise.

A product manager should be able to read only the prose and understand the product. An agent
should be able to open everything and operate the system without asking a question.

## Everything, in order

**Introduction** — [what sandboxr is](introduction/what-it-is.md) ·
[when to use it](introduction/when-to-use.md)

**What is where, and how it works** — [the repository map](orientation/repository-map.md) ·
[the life of a sandbox](orientation/life-of-a-sandbox.md) ·
[where everything lives](orientation/where-things-live.md)

**Getting started** — [prerequisites](getting-started/prerequisites.md) ·
[set up your machine](getting-started/setup.md) ·
[your first sandbox](getting-started/first-sandbox.md)

**Guides** — [start, stop, list, clean up](guides/lifecycle.md) ·
[the edit–reload loop](guides/edit-and-reload.md) ·
[logs, shells and terminals](guides/logs-and-shells.md) ·
[the dashboard](guides/dashboard.md) ·
[testing a migration](guides/testing-a-migration.md) ·
[agents in a sandbox](guides/agents-in-a-sandbox.md)

**Configuring a project** — [sandboxr.yaml field by field](configuration/sandboxr-yaml.md) ·
[three runtime kinds](configuration/runtime-kinds.md) ·
[secrets](configuration/secrets.md) ·
[example: a MySQL monorepo](configuration/example-monorepo.md) ·
[example: Workers on D1](configuration/example-workers.md)

**Databases** — [the driver model](databases/drivers.md) ·
[MySQL](databases/mysql.md) · [D1 and SQLite](databases/d1-sqlite.md)

**Access and security** — [the two tiers](security/two-tiers.md) ·
[public sandboxes](security/public-sandboxes.md)

**Architecture** — [how a request arrives](architecture/request-path.md) ·
[the startup graph](architecture/startup.md) ·
[plan.json](architecture/plan-json.md) ·
[state lives in labels](architecture/state.md) ·
[design decisions](architecture/decisions.md) ·
[the contract](architecture/contracts.md)

**Reference** — [CLI commands](reference/cli.md) ·
[configuration schema](reference/config-schema.md) ·
[environment variables](reference/environment.md) ·
[glossary](reference/glossary.md) · [what is built](reference/status.md)

**Elsewhere** — [running on a server](running-on-a-server.md) ·
[troubleshooting](troubleshooting.md)

## The two documents that outrank this site

- **[`docs/architecture/contracts.md`](architecture/contracts.md)** is the single source of
  truth for every boundary in sandboxr: naming, paths, the configuration schema, the database
  driver interface, access control. Where this site disagrees with it, this site is wrong.
- **`container/README.md`** in the repository is the authoritative specification of everything
  that runs inside a sandbox, including the exact shape of the file the host hands it.
