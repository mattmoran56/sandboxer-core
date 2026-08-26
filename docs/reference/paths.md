---
title: Paths
description: Every path sandboxr reads or writes — in its own repository, in your project, on your computer, and inside a container.
sidebar:
  order: 3
---

Four separate places, and mixing them up is the most common way to get lost.

## 1. The sandboxr repository

| Path | What it is |
|---|---|
| `packages/core/src/config/` | Reading `sandboxr.yaml`, and writing `plan.json` |
| `packages/core/src/drivers/` | One module per kind of database |
| `packages/core/src/sandbox/` | `up`, `down`, `list`, `status`, `reload`, `gc`, and the `docker run` argument list |
| `packages/core/src/access/` | The shared router, certificates, the dashboard container |
| `packages/core/src/naming.ts` | Every name in the system is decided here |
| `packages/core/src/paths.ts` | Every host path is decided here |
| `packages/cli/src/main.ts` | The whole command surface |
| `packages/server/src/actions/table.ts` | What the dashboard can run — a closed list |
| `packages/docs/` | The machinery that publishes `docs/` as a site |
| `container/base/`, `container/project/` | The two images |
| `container/scripts/` | What a sandbox runs at boot |
| `docs/architecture/contracts.md` | **The source of truth for every boundary** |
| `examples/` | Two example configs, and a project that really runs |

Which file to open for a given question:

| Question | File |
|---|---|
| What fields does `sandboxr.yaml` accept? | `packages/core/src/config/schema.ts` |
| What does the container actually receive? | `packages/core/src/config/plan.ts`, and `container/README.md` |
| What is a sandbox called? | `packages/core/src/naming.ts` |
| Where does sandboxr write on my disk? | `packages/core/src/paths.ts` |
| What does `docker run` get? | `packages/core/src/sandbox/run.ts` |
| How does the dashboard call core? | `packages/server/src/core/adapter.ts` |
| What does the container do at boot? | `container/scripts/entrypoint.sh` |
| How is a database seeded and migrated? | `container/scripts/db/<driver>.sh` |

## 2. Your project's repository

One file, at the repository root:

```
your-project/
  sandboxr.yaml     ← the whole configuration, versioned with the code
```

It lives with the project rather than with sandboxr so a new service and the settings that describe
it land in the same commit.

The directory holding it is what gets mounted at `/workspace` — the **config's** directory, not the
git top level, so a project kept in a subdirectory of a larger repository is mounted at the right
level.

## 3. On your computer

Everything sandboxr writes at run time is under `SANDBOXR_HOME`, default `~/.sandboxr`.

| Path | What it holds | Survives `down`? |
|---|---|---|
| `cache/` | Database seed artifacts, named by content | yes |
| `logs/<project>/<slug>/` | Per-sandbox logs, and the schema baselines | **yes** — deliberately |
| `tls/` | Certificates and keys the router serves | yes |
| `state/` | Router config, the dynamic config directory, the dashboard's session key | yes |
| `secrets/<project>.env` | Third-party credentials, mode 0600 | yes |
| `build/<project>/<slug>.env` | The generated environment for one sandbox | yes |
| `build/<project>/<slug>.plan.json` | The plan for one sandbox | yes |
| `bin/` | Helper binaries built on the host | yes |

The logs surviving is on purpose: the logs from a sandbox you have just deleted are usually exactly
the ones you want.

> [!NOTE] Never inside a repository
> `git clean -xdf` is a normal thing to run, and it would destroy the seed cache, the certificates
> and every sandbox's logs.

`SANDBOXR_HOME` overrides the root and everything else is derived from it, so there is no second
variable to set. On a server, set it **in the service definition**, not in a login shell — a
service started at boot has no login shell, and falling back to `~/.sandboxr` under a service
account puts the state somewhere nobody looks.

## 4. Inside a running sandbox

| Path | What it is |
|---|---|
| `/workspace` | Your worktree, mounted read and write |
| `/sandboxr/plan.json` | The plan, read-only |
| `/sandboxr/cache/` | The host's seed cache, read-only |
| `/opt/sandboxr/scripts/` | The container scripts |
| `/var/lib/sandboxr/data` | The database |
| `/var/lib/sandboxr/blob` | Object storage |
| `/var/lib/sandboxr/bin` | Compiled backends |
| `/srv/www` | Built websites, one directory per app label |
| `/srv/www/.built.json` | What this sandbox has built, and when |
| `/var/log/sandboxr` | Per-service log files, bind-mounted from the host |
| `/run/sandboxr` | Marker files the status document is composed from |
| `/opt/deps` | Dependencies installed into the image, copied out on first boot |

```bash
sandboxr shell tkt-4821
```

## Docker object names

For a project `acme` and a slug `tkt-4821`:

| Object | Name |
|---|---|
| Container | `sandboxr-acme-tkt-4821` |
| Network | `sandboxr` — one, shared by every sandbox on the machine |
| Database volume | `sandboxr-data-acme-tkt-4821` |
| Object storage volume | `sandboxr-blob-acme-tkt-4821` |
| Built binaries volume | `sandboxr-bin-acme-tkt-4821` |
| Built websites volume | `sandboxr-www-acme-tkt-4821` |
| Shared dependencies | `sandboxr-deps-<16 hex of the lockfile hash>` |
| Shared Go caches | `sandboxr-gocache`, `sandboxr-gomod` |
| The router | `sandboxr-router` |
| The dashboard | `sandboxr-dashboard` |

## What is not stored anywhere

There is no list of sandboxes — no manifest file, no database of what exists. Everything sandboxr
knows about a running sandbox is read from Docker container labels at the moment you ask.
[Why that matters](../architecture/state.md).
