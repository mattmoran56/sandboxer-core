---
title: sandboxr documentation
description: Turn any git worktree into a running copy of a whole project, on its own hostname.
tableOfContents: false
---

**sandboxr turns a git worktree into a running copy of a whole project, on its own hostname.**

One container per worktree. Inside it: every service the project declares, every front-end, its
own database and its own file storage. Several run at once, and each is reachable in a browser
at an address of its own.

```bash
cd .worktrees/tkt-4821
sandboxr up
# https://tkt-4821.app.acme.sbx.localhost
# https://tkt-4821.api.acme.sbx.localhost
```

## Start with what you came to do

| I want to… | Go to |
|---|---|
| Understand what this is | [Introduction](introduction.md) |
| Understand how it works inside | [How it works](how-it-works.md) |
| Try it on my own machine | [Getting started](getting-started/index.md) |
| Use it day to day | [Guides](guides/index.md) |
| Describe my project to it | [Configuring a project](configuration/index.md) |
| Give my project a database | [Databases](databases.md) |
| Know who can reach what | [Access and security](access.md) |
| Look up a command, a field, a variable | [Reference](reference/index.md) |
| Work out why something broke | [Troubleshooting](troubleshooting.md) |

## Everything, in order

**Start here** — [introduction](introduction.md) · [how it works](how-it-works.md)

**Getting started** — [install it](getting-started/install.md) ·
[your first sandbox](getting-started/first-sandbox.md) ·
[every worktree at once](getting-started/every-worktree.md)

**Guides** — [start, stop, list, clean up](guides/lifecycle.md) ·
[the edit–reload loop](guides/edit-and-reload.md) ·
[logs, shells and terminals](guides/logs-and-shells.md) ·
[the dashboard](guides/dashboard.md) ·
[testing a migration](guides/testing-a-migration.md) ·
[agents in a sandbox](guides/agents-in-a-sandbox.md)

**Configuring a project** — [sandboxr.yaml, field by field](configuration/sandboxr-yaml.md) ·
[three runtime kinds](configuration/runtime-kinds.md) ·
[secrets](configuration/secrets.md) ·
[two worked examples](configuration/examples.md)

**Databases and access** — [databases](databases.md) · [access and security](access.md)

**Architecture** — [how a request arrives](architecture/request-path.md) ·
[the startup graph](architecture/startup.md) ·
[plan.json](architecture/plan-json.md) ·
[state lives in labels](architecture/state.md) ·
[design decisions](architecture/decisions.md) ·
[the contract](architecture/contracts.md)

**Reference** — [CLI commands](reference/cli.md) ·
[environment variables](reference/environment.md) ·
[paths](reference/paths.md) · [glossary](reference/glossary.md) ·
[what is built](reference/status.md)

**Elsewhere** — [running on a server](running-on-a-server.md) ·
[troubleshooting](troubleshooting.md)

> [!NOTE] The one document that outranks this site
> [`docs/architecture/contracts.md`](architecture/contracts.md) is the source of truth for every
> boundary in sandboxr: naming, paths, the configuration schema, the driver interface, access
> control. Where this site disagrees with it, this site is wrong.
