---
title: Running on a server
description: What running sandboxr for a team would take — the sizing, the DNS arithmetic, the certificate constraint — and which of it is not built.
sidebar:
  order: 8
---

> [!WARNING] This is a plan, not a procedure
> `sandboxr init` sets up a **local** machine: mkcert certificates, a router bound to `127.0.0.1`.
> Nothing in this repository requests a certificate over ACME, writes a DNS record, or installs a
> service unit. The sizing and the arithmetic below are worked out and worth having; the steps are
> not automated. [What is built](reference/status.md).

> [!CAUTION] Read the security pages first
> The dashboard talks to the Docker socket, so an unprotected control endpoint is remote code
> execution on the machine. [Access and security](access.md). Ten minutes now.

## Sizing the machine

| Resource | Guidance |
|---|---|
| **Memory** | A sandbox's container limit is the largest limit any one of the project's apps declares, floor **4 GB**. Budget at least that per concurrently running sandbox, plus 2 GB for the host and the dashboard. Four sandboxes of a project whose heaviest build asks for 6 GB wants 26 GB, not 16 |
| **Disk** | 40 GB floor. The base image is around 670 MB; each project's layer adds its toolchains and dependency tree, and a large one measured 6 GB; each sandbox adds a few hundred MB of volumes; Docker's build cache will take everything you leave it |
| **CPU** | Builds are the only bursty part. Four cores suits a small team; two feels slow the moment two people rebuild at once |
| **Swap** | Some. It converts a hard out-of-memory kill into slowness, which is a much better failure |

The limit is a **ceiling**, not a reservation, so the number that decides how many fit is real
usage. Measure your own project before planning a fleet.

> [!CAUTION] Under memory pressure the kernel does not choose politely
> A heavy front-end build on a loaded host gets *something* killed, and that something can be
> another person's sandbox. Declare `memory:` on any app that needs it, so the whole sandbox is
> scheduled with room rather than discovering the limit as `code 137` halfway through a build.

**Disk is the constraint that bites first**, and Docker's build cache is the fastest-growing thing
on the machine. On Linux there is no allocation to raise: the daemon writes to `/var/lib/docker` on
the host's own filesystem, so the sizing decision is which disk that is — `data-root` in
`/etc/docker/daemon.json` — rather than any Docker Desktop setting. Put `sandboxr prune
--build-cache --yes` and `sandboxr gc` on a timer.

[Giving Docker the whole machine](guides/docker-capacity.md) has the arithmetic: what accumulates,
what stopping a container does and does not free, and which reclaim commands cost what.

## DNS: a wildcard per project

Sandbox hostnames are four labels deep, and **a DNS wildcard matches exactly one label**. This
catches everyone once: `*.sbx.example.com` matches `app.sbx.example.com` and does **not** match
`tkt-4821.app.acme.sbx.example.com`.

A wildcard therefore has to sit **one level above the slug**, which means one record per
`<label>.<project>` pair rather than one per project:

```
sbx.example.com.                A   203.0.113.10   the dashboard
*.app.acme.sbx.example.com.     A   203.0.113.10   acme's app label
*.api.acme.sbx.example.com.     A   203.0.113.10   acme's api label
*.app.demo.sbx.example.com.     A   203.0.113.10   demo's app label
```

Starting a sandbox is then never a DNS change — only *adding a label to a project* is. In practice
a server wants a DNS provider with an API, and these records generated from each project's config.

Add `AAAA` records too if the host has IPv6, or browsers will sometimes prefer a v6 address that
goes nowhere.

None of this applies locally: `.localhost` resolves to the loopback address whatever the depth,
which is exactly why it is the default.

## Certificates: the constraint that shapes everything

The same arithmetic applies, and it is stricter. **A TLS wildcard matches exactly one label**, and
`*.*.example.com` is not a valid certificate name — issuers reject it.

So no wildcard can cover a sandbox hostname. sandboxr's answer locally is a **certificate per
sandbox**, with its hostnames listed, issued when the sandbox starts and removed when it goes; the
router picks between them by SNI and watches the directory, so nothing reloads.

On a real domain that means per-sandbox certificates from a public authority, which brings two
consequences:

- **HTTP-01 would work** for a hostname that resolves publicly, but issuance happens at `up` time
  and is on the critical path of starting a sandbox. DNS-01 with a credential scoped to the one
  zone is the more controllable option.
- **Certificate transparency logs are public.** Per-sandbox certificates publish your branch names
  to the world. If that matters, `access.apps: private` and an internal certificate authority is
  the honest answer rather than a wildcard you cannot have.

Two things not to do:

- **Do not reuse a laptop's local certificate authority.** It only works because your own machine
  was told to trust it.
- **Do not terminate TLS elsewhere and forward plain HTTP** without setting the forwarded headers
  correctly. Apps generate absolute URLs from what they are told, and getting this wrong produces
  redirect loops that are miserable to debug.

None of this is implemented. mkcert is the only issuer sandboxr knows about.

## The password

```bash
export SANDBOXR_PASSWORD="$(openssl rand -base64 32)"
```

Treat it as a **root credential for this host**, because that is what it is: whoever has it can run
every action the dashboard offers, and the dashboard drives Docker. Put it in whatever secret
manager the machine already uses, and set it in the **service definition**, not a login shell.

Per-project passwords let different people be given different projects. [How](access.md).

## Seeds: a dump, not a fork

There is no local database container on a server, so `seed_from.local` has nothing to fork — and
pointing it at a production database would be exactly the mistake the driver rules exist to
prevent.

```yaml
database:
  seed_from:
    file: /var/sandboxr/seeds/acme-anonymised.sql.zst
    anonymised: true
    fixtures: db/seeds/fixtures.sql
```

Put the dump somewhere the host can read, refresh it on a schedule if you want it current, and
**anonymise it** if `access.apps` is `public`. The flag is an assertion by whoever wrote the config,
and it is the only thing the refusal accepts as marking a dump safe.

## Firewall

Open **80 and 443**. Nothing else. Sandbox containers publish no host ports at all — the router
reaches them by container name on the shared Docker network — so there is nothing else listening.

The Docker socket must not be exposed to the network under any circumstances.

## The pre-flight checklist

- [ ] `SANDBOXR_HOME` is set in the service definition, on a disk with room.
- [ ] `SANDBOXR_PASSWORD` is long, random, and not in anyone's shell history.
- [ ] Per-project passwords exist for anyone who should not have everything.
- [ ] The router is publishing on the interface you meant, not on `127.0.0.1`.
- [ ] Every project's `access.apps` is what you meant, checked one by one.
- [ ] No project seeds from `local`; every `file` seed is genuinely anonymised.
- [ ] `access.credentials` is `dummy` unless you have a reason.
- [ ] The firewall opens 80 and 443 only.
- [ ] `data-root` points at the disk with the room on it.
- [ ] `sandboxr gc` and `sandboxr prune --build-cache --yes` are on a timer.
- [ ] `sandboxr doctor` is clean.

## What sandboxr is not

A sandbox is disposable. There is no high availability, no backup of a sandbox's database, and no
promise a sandbox survives a host reboot with its data intact. The durable thing is the git branch
it was made from.

If you need something that stays up, that is a staging environment, and it is a different job with
different rules.

## Related

- [Giving Docker the whole machine](guides/docker-capacity.md)
- [Access and security](access.md)
- [Every worktree at once](getting-started/every-worktree.md)
- [What is built](reference/status.md)
