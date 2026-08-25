---
title: Deployment guide
description: What putting sandboxr on a shared server would take — DNS arithmetic, wildcard certificates, sizing, firewall rules — and exactly how much of it exists today.
sidebar:
  order: 1
---

> **Planned, not built** — No remote deployment has been attempted. There is no code that requests a certificate, writes a DNS record, installs a service unit or routes a hostname to a container. The dashboard process is the one piece that runs today.

A server changes three things about sandboxr: DNS is real, certificates are real, and the machine
is reachable by people who are not you. Everything else would be identical to a laptop.

**Almost none of it is built.** This page is worth reading anyway — the sizing, the DNS
arithmetic, the certificate constraint and the firewall rules are all real and all worked out, and
they are what somebody will need on the day this is attempted. Read the commands as a proposal and
the reasoning as settled.

> [!CAUTION] What does not exist
> - **No `sandboxr init`.** There is no command that installs DNS, a certificate, a router or a
>   service unit. Setup is entirely manual today.
> - **No machine-wide router.** Nothing maps a hostname to a container. Sandbox containers publish
>   no host ports either, so on a server today a sandbox is simply **not reachable in a browser**.
>   [More](./architecture/request-path.md).
> - **No certificate code.** Nothing speaks ACME, and nothing manages a wildcard.
> - **No service unit or installer.** No systemd unit, no launchd plist, and nothing that writes one.
>
> [What is built](./reference/status.md) is the full inventory.

> [!CAUTION] Read the security pages first
> [The two tiers](./security/two-tiers.md) and [public sandboxes](./security/public-sandboxes.md). The
> dashboard talks to the Docker socket, so an unprotected control endpoint is remote code execution
> on the machine. Ten minutes now.

## What you can actually run today

One thing: the dashboard process. It is written, it has tests including its security properties,
and it starts.

```bash
npm --workspace @sandboxr/server run build

SANDBOXR_PASSWORD='something long and random' \
SANDBOXR_DOMAIN=sbx.example.com \
  node packages/server/dist/bin.js
```

It binds `127.0.0.1:8080` by default, deliberately: the intention is that a router publishes it,
and until one exists it should not be publishing itself. It needs the Docker socket, because that
is how it lists and drives containers.

Its configuration — every environment variable, the per-project passwords, what it can and cannot
run — is covered in detail on [the dashboard page](./guides/dashboard.md), and
`packages/server/README.md` is the authoritative list. This page does not repeat them.

## Sizing the machine

| Resource | Guidance |
|---|---|
| **Memory** | A sandbox's container limit is the largest limit any one of the project's apps declares, with a **floor of 4 GB**. So budget at least 4 GB per concurrently-running sandbox, more if a front-end declares more, plus 2 GB for the host and the dashboard. Four sandboxes of a project whose heaviest build asks for 6 GB wants 26 GB, not 16. |
| **Disk** | 40 GB floor. The shared base image is around 400 MB; each project's layer adds its toolchains and dependency tree; each sandbox adds a few hundred MB of volumes; Docker's build cache will take everything you leave it. |
| **CPU** | Builds are the only bursty part. Four cores suits a small team; two feels slow the moment two people rebuild at once. |
| **Swap** | Some. It converts a hard out-of-memory kill into slowness, which is a much better failure. |

> [!CAUTION] Under memory pressure the kernel does not choose politely
> A heavy front-end build on a loaded host gets *something* killed, and that something can be another
> person's sandbox. Declare `memory:` on any app that needs it, so the whole sandbox is scheduled
> with room rather than discovering the limit as
> [`code 137`](./guides/edit-and-reload.md#memory-limits) halfway through a build.

<details>
<summary><b>Details for an agent:</b> what to measure before you plan for twenty, and where the memory rule is implemented</summary>

The only measurement carried over from the internal tool sandboxr generalises: a fully-running
sandbox of one large monorepo sat around 500 MB resident, and its shared router around 40 MB. That
is *resident usage*, not the container limit, and it is one project. Measure your own before
planning a fleet.

The limit itself: `memoryFor` in `packages/core/src/sandbox/run.ts` takes the maximum of every
`memory:` declared by any backend or front-end, against a floor of `4g`, and passes it as
`docker run --memory`. There is no per-run override flag — a build that needs 6 GB needs it every
time, and that belongs in the project's config where a reviewer sees it.

Disk is the constraint that bites first, and Docker's build cache is the fastest-growing thing on
the machine. **`sandboxr gc` does not prune it.** `gc` reaps sandboxes whose worktree has gone and
removes volumes no surviving sandbox owns; `docker builder prune` is what reclaims build cache.
Put both on a timer.

</details>

## DNS: a wildcard per project

Sandbox hostnames are four labels deep:

```
<slug>.<label>.<project>.<domain>
feat-123.app.acme.sbx.example.com
```

A single wildcard is **not** enough, and this catches everyone once. A DNS wildcard matches exactly
**one** label. `*.sbx.example.com` matches `app.sbx.example.com` and does **not** match
`feat-123.app.acme.sbx.example.com`.

So you need one record per project, plus the bare domain for the dashboard:

```
sbx.example.com.                A   203.0.113.10      the dashboard
*.acme.sbx.example.com.         A   203.0.113.10      project acme
*.worker-thing.sbx.example.com. A   203.0.113.10      project worker-thing
```

Add `AAAA` records too if the host has IPv6, or browsers will sometimes prefer a v6 address that
goes nowhere.

A record per project is a small recurring cost with a benefit: the set of projects a host serves is
explicit in DNS, which is a useful thing to be able to read.

```bash
export SANDBOXR_DOMAIN='sbx.example.com'
```

## Certificates: ACME with DNS-01

You need **wildcard** certificates — one per project, plus the bare domain — and this is not a
preference. **HTTP-01 cannot issue a wildcard.** That leaves DNS-01, which means whatever requests
the certificate needs an API credential for your DNS provider so it can write a TXT record.

Scope that credential to the one zone. It should be able to create and delete TXT records there and
nothing else.

Two things not to do:

- **Do not reuse a laptop setup's local certificate authority.** It only works because your own
  machine was told to trust it. Nobody else's browser will.
- **Do not terminate TLS elsewhere and forward plain HTTP** without setting the forwarded headers
  correctly. Apps generate absolute URLs from what they are told, and getting this wrong produces
  redirect loops that are miserable to debug.

> [!TIP] Certificate transparency logs are public
> Every certificate issued publishes its hostnames to public logs. So `*.acme.sbx.example.com` tells
> the world that a project called `acme` exists on this host — which is a good argument for a
> wildcard rather than per-sandbox certificates: a wildcard leaks the project name, and per-sandbox
> certificates would leak the list of branches people are working on.

## The password

```bash
export SANDBOXR_PASSWORD="$(openssl rand -base64 32)"
```

Then put it in whatever secret manager the machine already uses, and take it out of your shell
history.

Treat it as a **root credential for this host**, because that is what it is: whoever has it can run
every action the dashboard offers, and the dashboard drives Docker. Per-project passwords are
supported, so different people can be given different projects —
[how](./guides/dashboard.md#different-people-different-projects).

## Seeds: a dump, not a fork

There is no local database container on a server, so `seed_from.local` has nothing to fork — and
pointing it at a production database would be exactly the mistake the driver contract exists to
prevent.

```yaml
database:
  seed_from:
    file: /var/sandboxr/seeds/acme-anonymised.sql.zst
    anonymised: true
    fixtures: db/seeds/fixtures.sql
```

Put the dump somewhere the host can read, refresh it on a schedule if you want it current, and
**anonymise it** if `access.apps` is `public`. The `anonymised: true` flag is an assertion by
whoever wrote the config, and it is the only thing the refusal accepts as marking a dump safe —
[a refusal, not advice](./security/public-sandboxes.md).

## Firewall

Open **80 and 443**. Nothing else.

Sandbox containers publish no host ports at all — a router is meant to reach them by container name
on a Docker network — so there is genuinely nothing else to open.

The Docker socket must never be exposed over TCP. The dashboard reaches it as a mounted Unix
socket, which is the only form in which it should ever be reachable.

## Bringing it up

1. **Install the prerequisites.** Docker, Node 22 or newer, git.
   [Full list](./getting-started/prerequisites.md).

2. **Set the environment.** `SANDBOXR_DOMAIN`, `SANDBOXR_PASSWORD`, and `SANDBOXR_HOME` if you want
   state somewhere other than `~/.sandboxr`.

3. **Check what can be checked.** `sandboxr doctor` verifies Docker is running, that a
   `sandboxr.yaml` resolves, that the credentials the config asks for are present, and how many
   sandboxes exist. It does **not** check DNS, certificates, a router or free disk, because none of
   those exist for it to check.

4. **Clone the projects you want to serve**, each with its `sandboxr.yaml` at the root.

5. **Start the dashboard**, bound to loopback, and reach it over an SSH tunnel until there is
   something in front of it.

6. **Start one sandbox** with `sandboxr up` and confirm it reports itself healthy —
   `sandboxr status <slug>`. It will not be reachable in a browser: nothing routes to it.

7. **Then the missing pieces**, in this order, when they exist: a router, certificates, DNS, a
   service unit. Publish the DNS record last, after the
   [pre-flight checklist](#the-pre-flight-checklist).

## Keeping it up across a reboot

> [!WARNING] No service unit ships today
> sandboxr ships no systemd unit, launchd plist or equivalent, and no installer that would write one.
> On a server the dashboard is a long-running Node process, and the only way to keep it running today
> is whatever process manager the machine already has.

<details>
<summary><b>Details for an agent:</b> what the first service unit has to get right</summary>

- **`SANDBOXR_HOME` must be set in the unit**, not inherited from a login shell. A service started
  at boot has no login shell, and defaulting to `~/.sandboxr` under a service account puts state
  somewhere nobody looks.
- **The Docker socket must be reachable**, which means the service's user is in the group that owns
  it. That is a substantial grant — see [the two tiers](./security/two-tiers.md) — and it is why the
  password is a root credential for the host.
- **Bind address.** `SANDBOXR_HOST` defaults to `127.0.0.1`. Leave it there and let the router
  publish the dashboard; changing it puts the control plane on the network directly.
- **The sandboxes themselves need no unit.** Containers with a restart policy come back on their
  own, and their state lives in Docker labels, so nothing has to be reconstructed. Only the
  dashboard and the router need supervising.
- **A sandbox's database is not preserved across a host reboot in any guaranteed way.** The volume
  survives, but a sandbox is disposable by design and nothing verifies it came back intact.

</details>

## The pre-flight checklist

Everything in
[public sandboxes](./security/public-sandboxes.md#a-pre-flight-checklist-for-a-public-deployment),
plus these operational items:

- [ ] `sandboxr gc` runs on a timer, and so does `docker builder prune`. Someone owns disk.
- [ ] `~/.sandboxr` is on a volume with room, and is **not** inside a repository.
- [ ] Log retention is bounded. `~/.sandboxr/logs/` survives containers by design and will grow.
- [ ] Per-app `memory:` limits are declared for anything that renders thousands of pages.
- [ ] You have opened the dashboard in a private browser window and been asked for the password.
- [ ] You have opened an app hostname in a private browser window and seen what a stranger sees.
- [ ] You know who has the password and how you would rotate it.

## Operating it

| Job | How |
|---|---|
| Reap abandoned sandboxes | `sandboxr gc` on a timer. It removes sandboxes whose worktree is gone, and volumes no sandbox owns |
| Reclaim disk | `docker builder prune` for the build cache — `gc` does not touch it |
| See what is running | `sandboxr ls` — a pure function of `docker ps` |
| Refresh the seed | Replace the dump; the cache is content-addressed, so it invalidates itself |
| Update a toolchain | Change `toolchain:`, rebuild the project's image layer, then `sandboxr up` each sandbox. **There is no command that builds an image today** |
| Rotate the password | Change `SANDBOXR_PASSWORD` and restart the dashboard. Sessions are signed with a key in `~/.sandboxr/state/`, so rotating the password alone does not end existing sessions — remove that key too |
| Restart one sandbox's services | `sandboxr up <slug>` replaces the container and keeps its volumes, so the database survives |

## What sandboxr is not

It is not a staging environment and it should not become one.

There is no high availability, no backup of a sandbox's database, no way to move a sandbox between
hosts, and no promise that a sandbox survives a host reboot with its data intact. A sandbox is
disposable by design; the durable thing is the git branch it was made from.

If you find yourself wanting uptime guarantees for a sandbox, the thing you want is a staging
environment, and sandboxr is the wrong tool for it.

## Related

- [The dashboard](./guides/dashboard.md) — its configuration, in full.
- [How a request arrives](./architecture/request-path.md) — the routing this page would need.
- [The two tiers](./security/two-tiers.md) — why the controls are behind a password, always.
- [What is built](./reference/status.md) — the honest inventory.
