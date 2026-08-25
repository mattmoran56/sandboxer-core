---
title: Databases
description: How a sandbox gets a database of its own — the four rules every driver obeys, and what each kind of database costs.
---

Every sandbox has its own database. That is the single most useful thing about it: a branch with
a migration in it can be run against real structure and real volume, and getting the migration
wrong costs one `sandboxr down`.

Four rules hold for every kind of database, and they are what make that safe:

1. **The source database is only ever read.** Every destructive operation targets a copy.
2. **A failed migration does not stop the sandbox.** It is marked `degraded` and boots anyway,
   because inspecting the failure is one of the reasons the sandbox exists.
3. **The schema baseline survives a failed run**, so "what did that actually change?" still has an
   answer afterwards.
4. **sandboxr never reimplements a project's migration logic.** It runs the project's own command.

| Page | What it covers |
|---|---|
| [The driver model](drivers.md) | The four rules in full, the interface every driver implements, and what `driver: none` is for |
| [MySQL: the hard case](mysql.md) | A real server to install, start, dump and restore — plus the traps that cost real hours |
| [D1 and SQLite: the easy case](d1-sqlite.md) | A database that is a file, and the one rule that comes with it: one writer |

**To actually do it:** [testing a migration](../guides/testing-a-migration.md) is the walkthrough.
