---
title: What is where, and how it works
description: An orientation section — the two halves of the system, the one file between them, a sandbox from start to finish, and which directory holds what.
---

The section to read before you work on sandboxr, and the fastest way to build a picture of the
whole thing. Three pages, in the order they are useful.

| Page | What it answers |
|---|---|
| [The repository map](repository-map.md) | Which directory does what job, what each package is for, and which file to open for a given question |
| [The life of a sandbox](life-of-a-sandbox.md) | One sandbox from `sandboxr up` to `sandboxr down`, step by step, saying which part of the system is doing each step |
| [Where everything lives](where-things-live.md) | Every path sandboxr reads or writes — in its own repository, in your project, on your computer, and inside a running container |

**Who these pages are for:** anyone who is about to change sandboxr, review a change to it, or
operate it precisely. The prose is written for somebody who has not seen the codebase; the
collapsed blocks carry the exact paths and file names.

**Two documents outrank everything here.** [`architecture/contracts.md`](../architecture/contracts.md)
is the single source of truth for every boundary in the system, and `container/README.md` in the
repository is the authority on everything that runs inside a sandbox.
