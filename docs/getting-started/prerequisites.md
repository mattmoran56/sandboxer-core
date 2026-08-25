---
title: Prerequisites
description: What has to be installed before sandboxr can do anything, how much memory and disk to allow, and the three things people get wrong before they start.
sidebar:
  order: 1
---

> **Partly verified** — The software requirements are what the code genuinely needs, and `sandboxr doctor` exists and reports the checks listed below; the memory and disk figures were measured on the internal tool sandboxr generalises, not on sandboxr.

sandboxr itself is a Node program. It does all its real work by talking to Docker. There is no
other daemon to install, no Kubernetes, and no cloud account.

## What must be installed

| Thing | Minimum | Why |
|---|---|---|
| **Docker** | Any version with BuildKit | A sandbox is a container, and the base image is built with BuildKit. Docker must be *running*, not merely installed. |
| **Node.js** | 22 or newer | `"engines": { "node": ">=22" }` in every package. |
| **Git** | 2.30 or newer | Sandboxes are made from git worktrees, and `git worktree add --detach` is used for a branch already checked out elsewhere. |

Worth having, but nothing breaks without them:

| Thing | What it buys you |
|---|---|
| **`gh`, logged in** | The dashboard can list open pull requests and offer to start a sandbox from one. Without it the dashboard still works, and links to a branch search instead. |
| **A local database container** | On a laptop, sandboxr can copy a database container you already run, so a sandbox starts from real structure with no dump file to look after. |

> [!NOTE] Why `gh` runs on your machine and not in the sandbox
> Turning a pull-request number into a branch needs an authenticated API call, and fetching that
> branch needs credentials from your keychain. A token has no business inside a container whose
> job is rendering a page, and no container can read your keychain anyway. Both happen on the
> host, and the dashboard degrades gracefully when neither is available.

## Checking the machine

```bash
sandboxr doctor
```

`doctor` exists and runs today. It is designed to be run *when something is wrong* and to name
what is missing, rather than to just exit non-zero.

Be aware of what it does **not** yet look at: it does not check DNS, it does not check the
certificate, and it does not check whether a router is running — because none of those is
installed by sandboxr yet. See [set up your machine](./setup.md).

<details>
<summary><b>Details for an agent:</b> every check `doctor` performs today, in order, and the fix it names for each</summary>

From `cmdDoctor` in `packages/cli/src/main.ts`:

| Check | Failure text | Fix it names |
|---|---|---|
| Docker responds | `Docker is not running` | `start Docker and try again` |
| A `sandboxr.yaml` exists here or in a parent | `no sandboxr.yaml in <dir> or any parent directory` | `add one at the root of the project you want to sandbox` |
| That file parses and resolves | the config error, which names the field | `fix the field named above` |
| A file-backed database would not be written into the worktree | the advice text for that field | the advice's own fix |
| Every credential the config asks for is present | `missing credentials: <names>` | `sandboxr secrets import` |
| Reports `SANDBOXR_HOME` | — | — |
| Reports how many sandboxes are on the machine | — | — |

Two related commands are useful alongside it:

```bash
sandboxr config              # where the config file is, and what it resolved to
sandboxr secrets check       # which credentials are missing, by name — never values
```

`--json` on any of them puts a machine-readable result on stdout; human-readable output goes
to stderr, so a script can read one while a person reads the other.

</details>

## Sizing

#### Laptop

Measured on the monorepo in [the worked example](../configuration/example-monorepo.md), with every
service running, using the internal tool sandboxr generalises:

| | Cost |
|---|---|
| One sandbox, in use | ~560 MB memory |
| A router, when there is one | ~40 MB |
| A local DNS resolver | ~15 MB |
| The shared base image | ~400 MB disk, once per machine |
| A per-project image layer | Toolchains, database engine and installed dependencies — several GB for a large monorepo, once per project |
| Each sandbox's own volumes | A few hundred MB |

On an **8 GB Docker virtual machine** that is five or six sandboxes, comfortably. Below 8 GB
you will spend your time having things killed for memory.

Disk is the tighter constraint in practice, and Docker's **build cache** grows faster than
anything else here.

  
  #### Shared server

Take the laptop numbers and add headroom, because several people share the machine:

- **Memory:** allow about 1 GB for each sandbox you intend to hold at once, plus 2 GB for the
  host and the router, plus whatever a heavy front-end build peaks at. Eight concurrent
  sandboxes wants 16 GB, not 8.
- **Disk:** 40 GB is a sane floor. The base image is ~400 MB, each project's image layer is the
  multi-gigabyte part, each sandbox's volumes are a few hundred MB, and the build cache will
  happily take everything left.
- **Processors:** builds are the only bursty part. Four cores is enough for a small team; two
  will feel slow the moment two people rebuild at once.

Remote deployment is [not built](../reference/status.md). Treat
[the deployment guide](../running-on-a-server.md) as a statement of intent.

  

> [!WARNING] A full Docker disk does not report itself as a full disk
> When disk runs out part-way through loading a database, MySQL reports something that reads as a
> *corrupt database*. If a sandbox's database will not start, check free space before you believe
> anything else it tells you. This one has cost real hours — see
> [symptom to cause](../troubleshooting.md).

<details>
<summary><b>Details for an agent:</b> the two commands that reclaim disk, and which one reclaims what</summary>

They do different jobs, and only one of them is sandboxr's.

```bash
sandboxr gc --dry-run    # say what it would remove
sandboxr gc              # remove sandboxes whose worktree is gone, and orphaned volumes
```

`gc` reaps sandboxes whose branch directory no longer exists on disk, and removes volumes that
no surviving sandbox owns. **It does not touch Docker's build cache**, which is usually the
biggest thing on the disk. That is Docker's own command:

```bash
docker system df          # what is actually using the space
docker builder prune      # reclaim the build cache
```

</details>

## Memory is one limit for the whole sandbox

There is no per-sandbox override flag, and no `SANDBOXR_MEMORY_LIMIT`. One number applies to
the whole container, and it is worked out from the project's settings:

**the largest `memory:` any single app or service declares, with a floor of 4 GB.**

The floor is fine for services and single-page apps. It is not fine for a static site generator
rendering thousands of pages:

- That kind of build spreads its work across many worker processes, so no single per-process
  memory setting bounds it. The **container total** is what the kernel enforces and what it
  kills against.
- The failure surfaces as npm's `code 137` and a bare `Killed`, with no mention of memory
  anywhere. `137` is `128 + 9`, meaning the process was killed with signal 9.

The fix is to declare what that one app really needs, which raises the ceiling for the whole
sandbox:

```yaml
frontends:
  apps:
    - { label: www, package: marketing, build: npm run build, out: out, memory: 6g }
```

<details>
<summary><b>Details for an agent:</b> the exact rule, where it is implemented, and the format the value takes</summary>

`memoryFor` in `packages/core/src/sandbox/run.ts`:

```ts
export function memoryFor(config: ResolvedConfig, floor = "4g"): string
```

It collects `memory` from every entry in `backends` and `frontends`, adds the `4g` floor to
that list, and returns the largest. The result becomes `docker run --memory <value>`.

The value is a Docker memory string, validated by the config schema against
`/^[0-9]+(b|k|m|g)?$/i` — so `6g`, `512m` and `2048` are all accepted, and `6GB` is not.

Because the largest wins, declaring `memory: 6g` on one app raises the ceiling for the whole
sandbox to 6 GB. That is correct, not a bug: the kernel enforces the container total, so a
6 GB build inside a 4 GB container dies whatever the app's own entry says.

</details>

## What else you need, and it is not software

1. **A domain name.** On a laptop a made-up one is fine, and `sbx.localhost` is the default. Set
   `SANDBOXR_DOMAIN` to change it. On a shared server it has to be a real domain you control,
   because you need a wildcard DNS record and a real certificate for it.

2. **`sudo`, once.** Local DNS for a whole suffix needs one line written into a system file.
   There is no command that does this for you today —
   [set up your machine](./setup.md) has the line.

3. **Your login provider's allowed URLs updated.** If the project's apps log in through a
   hosted identity provider that validates redirect URLs, every sandbox hostname has to be
   allowed or login dead-ends on a mismatch. One **wildcard per app label** covers every
   sandbox for ever:

   ```
   https://*.app.acme.sbx.localhost
   https://*.admin.acme.sbx.localhost
   ```

   Add each to the allowed callback URLs, logout URLs, web origins and CORS origins. If your
   provider refuses a wildcard — web origins is the field most likely to — keep the list per
   sandbox against a **development-only** application, never the one production uses.

4. **A password for the controls.** `SANDBOXR_PASSWORD`. There is no default, and there is no
   way to turn the requirement off. [Why](../security/two-tiers.md).

<details>
<summary><b>Details for an agent:</b> every environment variable sandboxr reads on the host, and what each defaults to</summary>

| Variable | Default | What it does |
|---|---|---|
| `SANDBOXR_HOME` | `~/.sandboxr` | The root of everything sandboxr writes. Every other path is derived from it, so there is no second variable to set. |
| `SANDBOXR_DOMAIN` | `sbx.localhost` | The suffix every sandbox hostname ends in. |
| `SANDBOXR_PASSWORD` | none | The dashboard password. Required by the dashboard; no default and no opt-out. |
| `SANDBOXR_IMAGE` | `sandboxr/base:latest` | The image a sandbox runs. This is the override that exists because building a per-project layer is not implemented. |

Resolved in `packages/core/src/paths.ts` and `packages/core/src/naming.ts`. The full list,
including what the *container* sets for itself: [environment](../reference/environment.md).

On a shared machine, set `SANDBOXR_HOME` in the service definition, not in a login shell. A
process started at boot has no login shell, and falling back to `~/.sandboxr` under a service
account puts the state somewhere nobody looks.

</details>

Next: [set up your machine](./setup.md).
