---
title: Configuring a project
description: How a project tells sandboxr what it is — one file at the repository root, field by field, with two complete worked examples.
---

A project describes itself in a single file called `sandboxr.yaml`, at the root of its own
repository. That is the whole configuration surface: what to build, what to run, what database it
needs, which credentials to bring, and who may reach it.

The file lives with the project rather than with sandboxr, so a new service and the settings that
describe it land in the same commit.

| Page | What it covers |
|---|---|
| [sandboxr.yaml, field by field](sandboxr-yaml.md) | Building a configuration from nothing, block by block, in the order you would add them |
| [Three runtime kinds](runtime-kinds.md) | The three different things a project can run, why the third is not a variation on the other two, and how a built directory is served |
| [Secrets](secrets.md) | Bringing the credentials a project needs, and refusing the ones that would point a disposable copy at something real |
| [Example: a MySQL monorepo](example-monorepo.md) | The hard case, annotated — several services, several front-ends, a real database |
| [Example: Workers on D1](example-workers.md) | The easy case, annotated — one dev server, one database file |

**The authority is the schema**, in `packages/core/src/config/schema.ts`. Every object in it is
strict, so a misspelled key is an error that names the key rather than a setting that silently
does nothing. The exhaustive field-by-field table is in
[the configuration schema reference](../reference/config-schema.md); the pages above explain what
each block is *for*.
