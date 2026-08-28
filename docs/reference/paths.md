---
title: Paths
description: Every path sandboxr reads or writes — in its own repository, in your project, on your computer, and inside a container.
---

Four separate places, and mixing them up is the most common way to get lost. This page lists all of
them.

## 1. Your project's repository

One file, at the root of the project you want to sandbox.

```
your-project/
  sandboxr.yaml     ← the whole configuration, versioned with the code
```

It lives with the project rather than with sandboxr, so a new service and the settings that describe
it land in the same commit.

**The directory holding that file is what gets mounted at `/workspace`.** The config's directory, not
the git top level — so a project kept in a subdirectory of a larger repository is mounted at the
right level.

There is one exception, for a managed project that has not committed a config yet. It can keep one
[beside its mirror](#the-workspace), and every worktree with none of its own uses it. The worktree is
still what gets mounted.

## 2. On your computer

Everything sandboxr writes at run time lives under `SANDBOXR_HOME`, default `~/.sandboxr`.

| Path | What it holds | Survives `down`? |
|---|---|---|
| `cache/` | Database seed artifacts, named by content | yes |
| `logs/<project>/<slug>/` | Per-sandbox logs, and the schema baselines | **yes** — deliberately |
| `tls/` | Certificates and keys the router serves | yes |
| `state/` | Router config, the dynamic config directory, the dashboard's session key | yes |
| `state/keep/<project>/<slug>` | Keeps one sandbox alive past its idle limit | **no** — see below |
| `state/name/<project>/<slug>` | What to call one worktree on screen | **yes** — see below |
| `secrets/<project>.env` | Third-party credentials, mode 0600. **A file you edit** — see below | yes |
| `build/<project>/<slug>.env` | The generated environment for one sandbox | yes |
| `build/<project>/<slug>.plan.json` | The plan for one sandbox | yes |
| `bin/` | Helper binaries built on the host | yes |
| `agent/runs.json` | Which agent session belongs to which sandbox | yes |
| `agent/grants.json` | Standing agent permissions, per project | yes |
| `agent/log/<id>.jsonl` | One agent session's transcript, append-only | yes |
| `config.yaml` | The machine's own settings | yes |
| `workspace/<project>/` | A managed project: its bare clone and its worktrees | yes |
| `workspace/<project>/sandboxr.yaml` | Optional: a config for worktrees that have none | yes |

The logs surviving is on purpose. The logs from a sandbox you have just deleted are usually exactly
the ones you wanted.

> [!NOTE] Never inside a repository
> `git clean -xdf` is an ordinary thing to run, and it would destroy the seed cache, the certificates
> and every sandbox's logs.

### The two files you edit

`config.yaml` holds what belongs to the machine rather than to any project. `sandboxr init` writes a
commented example the first time and never touches it again.

```yaml
# How long a sandbox may sit unused before it is stopped.
ttl: 12h
# Whether a sandbox is handed this machine's GitHub token. `none` or `token`.
github: none
# Per project, optional.
projects:
  acme: { ttl: 3d, github: token }
```

A missing file means the defaults. A malformed one is an error naming the file and the key — because
silently applying a default lifetime to a machine where somebody has just written down the lifetime
they wanted is how a week of work gets stopped after twelve hours.

`secrets/<project>.env` is the other one. It holds a project's third-party credentials, at mode
`0600`, as `NAME="value"` one per line. It is **edited, not generated**: `sandboxr secrets set`,
`sandboxr secrets edit` and the dashboard's Environment panel all author it directly, and
`sandboxr secrets import` merges a project's own `.env` files into whatever is already there. It is
mounted read-only into every sandbox of the project, so an edit reaches a running one on a restart.
See [Secrets](../configuration/secrets.md).

### The keep-alive marker

`state/keep/<project>/<slug>` is the only row that does not survive `down`, including `down --keep`.
The container is gone either way, and a marker for a container that no longer exists means nothing.

It is not relied on, though. The file records which container instance it was written for, so one
left behind by a bare `docker rm` is ignored rather than applied to whatever takes the slug next.

### A worktree's name

`state/name/<project>/<slug>` holds what you have chosen to call one worktree — "the checkout flow
rewrite" rather than `feat/tkt-4821`. It is the row directly above's opposite number, and comparing
the two is the quickest way to see the rule both follow.

A keep-alive marker applies to a container, so it names one and dies with it. A name applies to the
*worktree*, which outlives every sandbox cut on it — so it carries no instance and survives `down`,
a delete, and being started again. Stamping it would mean a rename quietly undoing itself the next
time you rebuilt.

It is only a label. **Renaming a worktree moves nothing**: the slug, the hostname, the container
name and every URL are still built from the branch and the directory. Set it with
`sandboxr worktree name <project> <branch> <name>`; an empty name hands the worktree back to its
branch. The file is plain text and you can edit it by hand — one that has been
edited into something that is not a name (more than 60 characters, or with a line break in it) is
read as *no name*, so the worktree shows its branch again rather than showing something broken.

### The workspace

The workspace has its own variable, `SANDBOXR_WORKSPACE`, because the repositories are the one part
of this tree worth putting on a different disk. Inside it, one directory per project:

```
<workspace>/<project>/
  sandboxr.yaml    optional — a config for every worktree that has none of its own
  repo.git/        a bare clone — this is what makes the directory a project
  wt/<branch>/     one worktree per branch, all peers
```

**A project is a directory containing `repo.git`.** There is no registry file, so listing the
projects is a directory read — a pure function of the filesystem, for the same reason `sandboxr ls`
is a pure function of `docker ps`.

`sandboxr.yaml` here is the only file you put in a project directory by hand, and it is a stopgap. A
worktree is a separate checkout, so an uncommitted config in one does not exist in any other, and
without this you would copy the file into every new worktree for ever. A worktree that carries its
own config always wins, so committing the file upstream ends the arrangement on its own. See
[Several repositories at once](../setups/many-projects.md).

> [!WARNING] The project directory is read, never mounted
> It holds `repo.git` and every other worktree. Only a worktree is ever mounted at `/workspace`, and
> running `sandboxr up` from the project directory itself is refused with an error saying so.

`SANDBOXR_HOME` overrides the root and everything else is derived from it, so there is no second
variable to set. On a server, set it **in the service definition**, not in a login shell: a service
started at boot has no login shell, and the fallback to `~/.sandboxr` under a service account puts
the state somewhere nobody looks.

## 3. Inside a running sandbox

| Path | What it is | Mounted |
|---|---|---|
| `/workspace` | Your worktree | read-write |
| `/sandboxr/plan.json` | The plan | read-only |
| `/sandboxr/secrets.env` | The project's third-party credentials — only when it has a secrets file | read-only |
| `/sandboxr/cache/` | The host's seed cache | read-only |
| `/sandboxr/seed/<name>` | A seed file you declared with `seed_from.file` — that one file, from wherever you keep it | read-only |
| `/var/lib/sandboxr/data` | The database | the `data` volume |
| `/var/lib/sandboxr/blob` | Object storage | the `blob` volume |
| `/var/lib/sandboxr/bin` | Compiled backends | the `bin` volume |
| `/srv/www` | Built websites, one directory per app label | the `www` volume |
| `/srv/www/.built.json` | What this sandbox has built, and when | on that volume |
| `/var/log/sandboxr` | Per-service log files | from the host's `logs/` |
| `/run/sandboxr` | Marker files the status document is composed from | a tmpfs — gone with the container |
| `/opt/sandboxr/scripts/` | The container scripts | from the image |
| `/opt/deps` | Dependencies installed into the image, copied out on first boot | from the image |
| `/go/pkg/mod`, `/go/cache` | Go's module and build caches | machine-wide volumes |
| `/root/.claude` | Claude Code's state | the machine-wide `sandboxr-claude` volume |
| `/root/.claude/.credentials.json` | The **host's** Claude Code login, when the host has one | that one file, read-write |

```bash
sandboxr shell tkt-4821      # and look for yourself
```

<details class="agent">
<summary><b>Details for an agent</b> — the two mounts that make git work, and why they use host paths</summary>

Two more mounts exist and they are not in the table because their paths are not fixed: **the worktree
a second time, at the path the host calls it**, and **the repository the worktree points at**,
read-write.

A linked worktree's `.git` is a *file* holding `gitdir: <repo>/worktrees/<name>` — an absolute host
path. A container with only `/workspace` therefore fails every git command with
`fatal: not a git repository`, naming a directory that is not there. Mounting both at the identical
path inside and out is what fixes it. The repository mount is read-write because `git commit` writes
objects and refs into it.

Neither is present for a plain checkout, whose `.git` is inside `/workspace` already. The host
decides which is which.

The Claude credential is **one file, and the directory around it is deliberately not mounted.**
Binding all of the host's `~/.claude` would give every sandbox write access to its `settings.json`,
which can define hooks — commands the host's own Claude Code then executes. It is shared rather than
copied because an OAuth refresh token rotates and is single-use: two copies invalidate each other the
first time either side refreshes, which is why that mount is read-write.

The Go cache paths must keep agreeing with the image's `GOPATH` and `GOCACHE`. Mounting a volume
anywhere else leaves the real cache in the container's writable layer, where it dies with the
container — and the symptom is not a missing mount, it is "sandboxes are just slow", for ever.

</details>

## 4. The sandboxr repository

Where to look when you need the source rather than the documentation.
[Package by package](../architecture/packages.md) is the guide to this.

| Path | What it is |
|---|---|
| `packages/core` | Config, drivers, Docker orchestration, the access layer, lifecycle |
| `packages/cli` | The whole command surface |
| `packages/server` | The dashboard's server |
| `packages/web` | The dashboard's browser app |
| `packages/docs` | The machinery that publishes `docs/` as a site |
| `container/base`, `container/project` | The two images |
| `container/scripts` | What a sandbox runs at boot |
| `docs/architecture/contracts.md` | **The source of truth for every boundary** |
| `examples/` | Example configs, and a project that really runs |

<details class="agent">
<summary><b>Details for an agent</b> — which file answers which question</summary>

| Question | File |
|---|---|
| What fields does `sandboxr.yaml` accept? | `packages/core/src/config/schema.ts` |
| What refuses a config, and why? | `packages/core/src/config/load.ts`, `access.ts`, `advice.ts` |
| What is in `~/.sandboxr/config.yaml`? | `packages/core/src/config/machine.ts` |
| What does the container actually receive? | `packages/core/src/config/plan.ts`, and `container/README.md` |
| What is a sandbox called? | `packages/core/src/naming.ts` |
| Where does sandboxr write on my disk? | `packages/core/src/paths.ts` |
| Which paths does the container see? | `packages/core/src/sandbox/layout.ts` |
| What does `docker run` get? | `packages/core/src/sandbox/run.ts` |
| What does the host pass into a container? | `packages/core/src/sandbox/env.ts` |
| Every command and flag | `packages/cli/src/main.ts`, the `USAGE` constant |
| The dashboard's own variables | `packages/server/src/env.ts` |
| What the dashboard can run | `packages/server/src/actions/table.ts` — a closed list |
| What does the container do at boot? | `container/scripts/entrypoint.sh` |
| How is a database seeded and migrated? | `container/scripts/db/<driver>.sh` |

</details>

## Docker object names

For a project `acme` and a slug `tkt-4821`:

| Object | Name |
|---|---|
| Container | `sandboxr-acme-tkt-4821` |
| Network | `sandboxr` — one, shared by every sandbox on the machine |
| Database volume | `sandboxr-data-acme-tkt-4821` |
| Uploads volume | `sandboxr-blob-acme-tkt-4821` |
| Binaries volume | `sandboxr-bin-acme-tkt-4821` |
| Built sites volume | `sandboxr-www-acme-tkt-4821` |
| Shared dependencies | `sandboxr-deps-<16 hex of the lockfile hash>` |
| Shared Go caches | `sandboxr-gocache`, `sandboxr-gomod` |
| Shared agent state | `sandboxr-claude` |
| Project image | `sandboxr/acme:<12 hex of the build inputs>` |
| Machine images | `sandboxr/base`, `sandboxr/dashboard` |
| The router | `sandboxr-router` |
| The dashboard | `sandboxr-dashboard` |

## What is not stored anywhere

There is no list of sandboxes. No manifest file, no database of what exists. Everything sandboxr
knows about a running sandbox is read from Docker container labels at the moment you ask.
[Why that matters](../architecture/state.md).

---

**Next:** [Environment variables](environment.md) for what gets written into
`build/<project>/<slug>.env`, or [Giving Docker the whole machine](../guides/docker-capacity.md) when
one of these directories has grown too large.
