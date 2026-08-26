---
title: Configuring a project
description: How a project describes itself to sandboxr, in one file at its repo root.
---

A project describes itself in a **`sandboxr.yaml`** at its repo root. That file is versioned with
the project's own code, so a branch that adds a service adds it to the config in the same commit.

There is one exception, and it is a stopgap: a project sandboxr keeps in its
[workspace](../guides/managed-sandboxes.md#a-config-for-a-project-that-has-not-committed-one) can
keep a config beside its clone, for the stretch before the file is committed upstream. Every
worktree that has none of its own uses it, and any worktree that has one uses that instead.

sandboxr resolves it on the host into a `plan.json`, and hands the container the plan.
[Nothing inside a container ever reads `sandboxr.yaml`](../how-it-works.md).

| Page | What it covers |
|---|---|
| [sandboxr.yaml, field by field](sandboxr-yaml.md) | The complete reference — every block, every field, every default |
| [Three runtime kinds](runtime-kinds.md) | Backend, static front-end, served front-end — and how to choose |
| [Secrets](secrets.md) | Importing a project's `.env` files, under rules that stop the wrong things leaking in |
| [Two worked examples](examples.md) | A MySQL monorepo, and a Worker on D1 |

The smallest valid config is two lines:

```yaml
project: acme
sandboxr: ">=0.1.0"
```

That starts a container with the worktree mounted and nothing running in it — useful for checking
the plumbing, and nothing else.

> [!TIP] Check your config before starting anything
> `sandboxr config` prints which file was used, the directory it resolved against, and what it
> resolved to. Every error names the file and the field, and the config is validated before anything
> is created.
