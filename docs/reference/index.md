---
title: Reference
description: Look something up — a command, a variable, a path, a word, or what is actually built.
---

| Page | What it holds |
|---|---|
| [CLI commands](cli.md) | Every command, every flag, every exit code |
| [Environment variables](environment.md) | The ones you set, the ones the host passes in, the ones the sandbox computes |
| [Paths](paths.md) | Every path sandboxr reads or writes, on the host and in a container |
| [Glossary](glossary.md) | Every term this site uses precisely, and where it is defined |
| [What is built](status.md) | What has been run for real, and what has not |

The configuration schema lives with the rest of the configuration documentation:
[sandboxr.yaml, field by field](../configuration/sandboxr-yaml.md).

> [!NOTE] The authority
> [`docs/architecture/contracts.md`](../architecture/contracts.md) fixes every boundary. Where a
> page here disagrees with it, the page is wrong. Where the contract disagrees with
> `packages/core/src`, the code is what runs.
