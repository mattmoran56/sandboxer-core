---
title: On a server, for a team
description: The sizing, DNS and certificate arithmetic for running sandboxr for a team — and a plain statement of which parts are not built.
---

**Running sandboxr on a server for a team is not built.** No code in this repository requests a
certificate over ACME, writes a DNS record, or installs a service unit. mkcert is the only
certificate issuer sandboxr knows about. And `sandboxr init` sets up a local machine, with a router
bound to `127.0.0.1`.

What this page is, then: the arithmetic. The sizing, the DNS shape and the certificate constraint
are worked out and hard-won, and they are what somebody building the missing pieces needs. They are
not steps you can follow today. [What is built](../reference/status.md) is the honest inventory.

```prompt
Assess whether this project could run on a shared server, and produce a sizing plan.

Read docs/setups/shared-server.md and docs/guides/docker-capacity.md. From this project's
sandboxr.yaml, work out the per-sandbox memory cap, then tell me the memory, disk and CPU a
server would need for the number of concurrent sandboxes I name, and list the DNS records it
would need.

Do not try to deploy anything. Remote deployment does not exist in sandboxr: there is no ACME
client, no DNS writer and no service unit. Stop and tell me if I ask you to install it anyway.
```

> [!CAUTION] Read the security page before anything else
> The dashboard holds the Docker socket, so an unprotected control endpoint is remote code
> execution on the machine. [Access and security](../access.md). Ten minutes now.

## Sizing the machine

| Resource | Guidance |
|---|---|
| **Memory** | A sandbox's cap is the largest limit any one of the project's apps declares, floor **4 GB**. Budget at least that per concurrently running sandbox, plus 2 GB for the host and the dashboard. Four sandboxes of a project whose heaviest build asks for 6 GB wants 26 GB, not 16 |
| **Disk** | 40 GB floor. The base image is around 580 MB, and the agent layer on top of it another 234 MB. Each project's layer adds its toolchains and its dependency tree, and a large one measured 6 GB. Each sandbox adds a few hundred megabytes of volumes. Docker's build cache will take everything you leave it |
| **CPU** | Builds are the only bursty part. Four cores suits a small team. Two feels slow the moment two people rebuild at once |
| **Swap** | Some. It turns a hard out-of-memory kill into slowness, which is a much better failure |

The cap is a **ceiling, not a reservation**. What decides how many sandboxes fit is real usage, so
measure your own project before planning a fleet.

> [!CAUTION] Under memory pressure the kernel does not choose politely
> A heavy front-end build on a loaded host gets *something* killed, and that something can be
> another person's sandbox. Declare `memory:` on any app that needs it. Then the whole sandbox is
> scheduled with room, rather than discovering the limit as `code 137` halfway through a build.

**Disk is the constraint that bites first**, and Docker's build cache is the fastest-growing thing
on the machine. On Linux there is no allocation to raise. The daemon writes to `/var/lib/docker` on
the host's own filesystem, so the decision is which disk that is — `data-root` in
`/etc/docker/daemon.json` — rather than any Docker Desktop setting. Put `sandboxr prune
--build-cache --yes` and `sandboxr gc` on a timer.

[Giving Docker the whole machine](../guides/docker-capacity.md) has the rest: what accumulates, what
stopping a container does and does not free, and what each reclaim command costs.

## DNS: one wildcard, for everything

A sandbox hostname is **one label** above the domain — `tkt-4821--app--acme.sbx.example.com` — so
one record covers every sandbox this server will ever run:

```
sbx.example.com.        A   203.0.113.10   the dashboard
*.sbx.example.com.      A   203.0.113.10   every sandbox, every app, forever
```

Starting a sandbox is never a DNS change, and neither is adding an app to a project or adding a
project to the machine. There is nothing to generate and nothing to keep in step.

Add `AAAA` records too if the host has IPv6. Otherwise browsers will sometimes prefer a v6 address
that goes nowhere.

None of this applies locally. `.localhost` resolves to the loopback address whatever the depth,
which is exactly why it is the default.

## Certificates: the constraint that shaped the hostname

**A TLS wildcard matches exactly one label**, and `*.*.example.com` is not a valid certificate name
— issuers reject it and mkcert refuses it outright.

That is a fact about TLS and not about DNS, and it is worth separating the two because sandboxr's
own documentation once had them confused. A *DNS* wildcard genuinely does match more than one label
(RFC 4592's closest-encloser rule; Cloudflare and Route 53 both document it). So the older
`<slug>.<label>.<project>.<domain>` shape resolved perfectly well — it was the *certificate* that
could not be written, and the answer was one certificate per sandbox, issued on `up` and removed on
`down`.

Hostnames are one label now precisely so that constraint goes away. `*.<domain>` covers every
sandbox, so a shared server needs **one certificate**, issued once, and starting a sandbox touches
neither DNS nor TLS.

On a real domain that means a wildcard certificate from a public authority:

- **DNS-01 is the challenge that works**, because a wildcard cannot be issued over HTTP-01. It
  needs a credential scoped to the one zone.
- **Certificate transparency logs are public**, and a wildcard publishes only the domain — not, as
  a per-sandbox certificate would have, every branch name anyone has ever cut.

Two things not to do:

- **Do not reuse a laptop's local certificate authority.** It works only because your own machine
  was told to trust it.
- **Do not terminate TLS elsewhere and forward plain HTTP** without setting the forwarded headers
  correctly. Apps build absolute URLs from what they are told, and getting this wrong produces
  redirect loops that are miserable to debug.

None of this is implemented. mkcert is the only issuer sandboxr knows about, and it is what issues
the same single wildcard locally.

## The password

```bash
export SANDBOXR_PASSWORD="$(openssl rand -base64 32)"
```

Treat it as a **root credential for this host**, because that is what it is. Whoever has it can run
every action the dashboard offers, and the dashboard drives Docker. Put it in whatever secret
manager the machine already uses, and set it in the **service definition**, not in a login shell.

Per-project passwords let different people be given different projects.
[How](../access.md).

## Seeds: a dump, not a fork

There is no local database container on a server, so `seed_from.local` has nothing to fork. Pointing
it at a production database would be exactly the mistake the driver rules exist to prevent.

```yaml
database:
  seed_from:
    file: /var/sandboxr/seeds/acme-anonymised.sql.zst
    anonymised: true
    fixtures: db/seeds/fixtures.sql
```

Put the dump somewhere the host can read. Refresh it on a schedule if you want it current. And
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
- [ ] No project seeds from `local`, and every `file` seed is genuinely anonymised.
- [ ] `access.credentials` is `dummy` unless you have a reason.
- [ ] The firewall opens 80 and 443 only.
- [ ] `data-root` points at the disk with the room on it.
- [ ] `sandboxr gc` and `sandboxr prune --build-cache --yes` are on a timer.
- [ ] `sandboxr doctor` is clean.

<details class="agent">
<summary><b>Details for an agent</b> — exactly which pieces are missing, and what exists to build on</summary>

**Missing, with nothing in the repository to configure:**

- An ACME client. No code requests a certificate from a public authority. `packages/core/src/access/tls.ts` issues through mkcert and only mkcert.
- A DNS writer. Nothing creates or updates a record anywhere.
- A service unit. Nothing installs systemd units, launchd plists or any other supervisor definition.
  The dashboard and the router are Docker containers with `--restart unless-stopped`, which is what
  survives a reboot today.

**Present and usable on a server as-is:**

- `sandboxr init --bind ADDR` publishes the router somewhere other than `127.0.0.1`, and
  `--http-port N` / `--https-port N` move it off 80 and 443.
- `SANDBOXR_HOME` and `SANDBOXR_WORKSPACE` relocate all host state, and the workspace has its own
  variable precisely so the repositories can sit on a different disk.
- `~/.sandboxr/config.yaml` sets the idle limit machine-wide and per project, and decides which
  projects are trusted with the machine's GitHub token (`github: none` by default). Key a project
  on its workspace directory or on the `project:` its `sandboxr.yaml` declares; `sandboxr doctor`
  names any entry that matches neither, which on a server with many projects is worth running after
  every edit.
- `SANDBOXR_TTL_HOURS` exists for exactly this case — it is what a service unit sets — and sits
  *below* `config.yaml` in precedence, so an operator editing the file always wins over a variable
  set months ago and forgotten.
- The managed workspace: `sandboxr project clone`, `worktree add`, and `up --project NAME --branch
  NAME`. See [Several repositories at once](many-projects.md).
- The reaper, which is the dashboard's own timer: `SANDBOXR_REAP_MINUTES`, default `5`. On a server
  the dashboard is always up, so unlike a laptop the timer really runs.

**Certificate arithmetic, stated as constraints:**

| Hostname | Labels above the domain | Covered by |
|---|---|---|
| `sbx.example.com` | 0 — the dashboard | the certificate naming the domain itself |
| `tkt-4821--app--acme.sbx.example.com` | 1 | `*.sbx.example.com` |
| `a.tkt-4821--app--acme.sbx.example.com` | 2 | **nothing wildcard can express** — and nothing sandboxr serves is here |

The third row is the reason the second one is written the way it is. `packages/core/src/naming.ts`
builds every sandbox hostname as a single label, and `packages/core/src/access/tls.ts` issues one
certificate for the machine — `baseCertificateNames`, from `init`. There is no per-sandbox
certificate and nothing on the `up` path that issues one. What a public issuer would plug into is
that single call; the issuer is not there.

</details>

## What sandboxr is not

A sandbox is disposable. There is no high availability, no backup of a sandbox's database, and no
promise that a sandbox survives a host reboot with its data intact. The durable thing is the git
branch it was made from.

If you need something that stays up, that is a staging environment. It is a different job, with
different rules.

**Next:** [What is built](../reference/status.md) for the full inventory of what has and has not been
run, or [Giving Docker the whole machine](../guides/docker-capacity.md) for the capacity arithmetic
in depth.
