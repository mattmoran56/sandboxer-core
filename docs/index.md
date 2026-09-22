---
title: Welcome
description: sandboxer turns a git worktree into a running copy of your whole project, on its own hostname.
tableOfContents: false
---

**sandboxer turns a git worktree into a running copy of your whole project, on its own
hostname.** One container holds every service, every front-end, its own database and its own
file storage. Several run at once, so two branches can be open in two browser tabs.

```bash
cd .worktrees/tkt-4821
sandboxer up
# https://tkt-4821--app--acme.sbx.localhost
```

## Hand this to your agent

```prompt
Install sandboxer on this machine, then start a sandbox for the git worktree I am in.

Read docs/getting-started/install.md and work through it, then do the same with
docs/getting-started/first-sandbox.md. Stop and tell me if Docker is not running, if Docker
has under 8 GB of memory available, or if this worktree has no sandboxer.yaml at its root.
```

## What do you want to do?

| I want to… | Go to |
|---|---|
| Understand what this is, in plain words | [What sandboxer is](introduction.md) |
| Understand how it works before I install it | [How it works, in five steps](how-it-works.md) |
| Get it running on my machine | [Start here](getting-started/index.md) |
| Work out which arrangement suits me | [Which setup is yours](setups/index.md) |
| Use it for a day's work | [Day to day](guides/index.md) |
| Describe my own project to it | [Build your config, step by step](configuration/index.md) |
| Look up a command, a path or a hostname | [Cheat sheet](reference/cheat-sheet.md) |
| Find the right prompt for my agent | [Every agent prompt](reference/agent-prompts.md) |
| See how the thing is built | [The shape of it](architecture/index.md) |
| Fix something that broke | [Troubleshooting](troubleshooting.md) |
| Look up a word I do not recognise | [Glossary](reference/glossary.md) |

## Two things worth knowing on the way in

The apps a sandbox serves are **public by default**, and the controls that start, stop and
rebuild sandboxes are **always behind a password**. That second half cannot be switched off.
[Access and security](access.md) explains both.

sandboxer is early software, and the docs say so where it matters rather than everywhere.
[What is built](reference/status.md) is the honest inventory of what has been run for real.

**Next:** [What sandboxer is](introduction.md) if you are deciding whether this helps you, or
[Start here](getting-started/index.md) if you already know and want it running.
