---
title: Giving Docker the whole machine
description: Where Docker's disk and memory limits actually come from on each platform, what sandboxr accumulates, and how to get the space back without losing what is expensive to rebuild.
---

Docker has run out of room. You stopped some sandboxes, and that gave nothing back. This page
explains why, and how to get the space back safely.

```prompt
Docker on this machine is out of space. Work out where it went and reclaim it.

Read docs/guides/docker-capacity.md first. Run `sandboxr prune` and `docker system df`
and show me both reports before removing anything. Then reclaim in the order that page
gives, least destructive first.

Never run `docker system prune -a --volumes` — it deletes the shared volumes sandboxr
protects, including an agent session's credentials. Stop and ask me before anything with
`--yes` or `-a` in it.
```

## Stopping a container frees no disk

This is the whole misunderstanding, so it is worth stating on its own.

Stopping a container frees its **memory** and its **CPU**. It frees no disk at all. The
container is still there, its volumes are still there, and the image it ran from is still
there. Nothing was deleted, so nothing came back.

And what actually fills a machine is not the containers. It is **images and build cache** —
and neither of those belongs to any particular sandbox, so no amount of stopping sandboxes
touches them.

That splits your problem in two, and the two have different answers:

| What you are seeing | The real question |
|---|---|
| "No space left on device". A build failing halfway. A database reporting corruption | **Disk.** How much has Docker got, and what is it storing? |
| A build killed with `code 137`. A sandbox dying while another one builds | **Memory.** How much may Docker use at once? |

## Where the limits come from depends on your machine

Docker looks like one product and behaves like two, and every confusing answer on the
internet comes from mixing them up.

### On Linux, there is no allocation to raise

The Docker daemon is just a process on your machine. There is no virtual machine and no disk
image. It writes files to a directory on your filesystem and it asks the kernel for memory
like any other program. So:

- **Disk** is however much free space that filesystem has. There is no ceiling to lift.
- **Memory** is the machine's memory. A container with no declared limit can use all of it.

Every "increase Docker's disk limit" instruction you will find is about Docker Desktop, and
on Linux it describes a setting that does not exist. The only lever is **which disk Docker
writes to**.

### On macOS and Windows, the sliders size a virtual machine

Docker Desktop runs the daemon inside a Linux virtual machine. **Settings → Resources** sizes
that VM, and the numbers there mean:

| Setting | What it really is |
|---|---|
| **Virtual disk limit** | The maximum size of one sparse file on your real disk. It grows towards that number and does not shrink on its own |
| **Memory limit** | Memory the VM may take from your machine. Every container shares it |
| **CPU limit** | How many of your cores the VM may schedule on |
| **Disk image location** | Where that file lives. Move it to a second or external disk from here, never by hand |

Two things to know before you drag anything:

- **Raising the disk limit is cheap and reversible. Lowering it is not.** Shrinking the
  virtual disk is offered as "reset", and reset means deleting every image, container and
  volume on the machine.
- **The disk image does not shrink when you delete things.** Reclaiming space inside the VM
  makes room *for Docker*. The file on your Mac stays whatever size it grew to.

On a Mac, **memory is usually the binding constraint rather than disk**. A sandbox with a
database, a backend and a front-end build in it is not small, and several at once share one
allocation.

> [!NOTE] `docker info` says `/var/lib/docker` on a Mac too
> That path is real, and it is inside the virtual machine. The thing on your Mac is a single
> sparse disk image. Reading `Docker Root Dir` and going to look for that directory on the
> host is a five-minute detour that ends in an empty folder.

<details class="agent">
<summary><b>Details for an agent</b> — moving Docker's storage on Linux with <code>data-root</code></summary>

Everything Docker stores — every image layer, every volume, every build cache record — is
under one directory, `/var/lib/docker`. If the root filesystem is small and the data disk is
large, that is the entire problem and `data-root` is the entire fix.

`/etc/docker/daemon.json`:

```json
{
  "data-root": "/mnt/data/docker"
}
```

Moving it is a stop, a copy and a start. The copy must preserve ownership, permissions,
extended attributes and hard links — a plain `cp -r` produces a directory Docker will not
start against:

```bash
sudo systemctl stop docker
sudo rsync -aHAX /var/lib/docker/ /mnt/data/docker/
sudo systemctl start docker
docker info --format '{{.DockerRootDir}}'      # confirm before deleting anything
```

Keep the old directory until the daemon is back and `docker images` looks the way you
remember. Then remove it.

**Not a bind mount, and not a symlink.** Docker's storage driver cares about the filesystem
underneath it. `data-root` is the supported way to move the directory. A symlink from
`/var/lib/docker` works until it does not, and the failure arrives weeks later looking like
an unrelated storage error.

</details>

## What accumulates, and what does not

| Thing | Grows with | Freed by stopping a sandbox? |
|---|---|---|
| **Docker's build cache** | Every image build, for ever, unless pruned | No |
| **Project images** | One per project *per content hash* — a new one whenever the base image, the tool version, the Dockerfile or a lockfile changes | No |
| The base and dashboard images | Once per machine, rebuilt on a version bump | No |
| A sandbox's own volumes (`data`, `blob`, `bin`, `www`) | One set per sandbox | No — `sandboxr down` is what removes them |
| The shared `deps-<hash>`, `gocache` and `gomod` volumes | One per distinct lockfile; the Go caches grow with what has been built | No, and deliberately never automatically |
| The container's own writable layer | Barely — everything that matters is on a volume or a mount | Not applicable |
| **Your worktrees** | Your work | They are **mounted from your disk** and were never in Docker's storage at all |

That last row is the one people fear, so it is worth being blunt. Deleting Docker images and
volumes cannot touch a worktree, a branch or a commit. The durable thing is always the git
repository on your own filesystem.

The row above it is the one that surprises people. `sandboxr-claude` holds the credentials an
agent session has been given. `sandboxr-gocache` and `sandboxr-gomod` are an expensive
rebuild. **Nothing in sandboxr ever removes those three**, and the blunt Docker commands
further down will.

### Rough sizes, so a number is not a mystery

Measured on one machine — a Mac running two projects, one of them large. Yours will differ.
These are here as a sense of scale, not a specification:

| | |
|---|---|
| The base image | ~670 MB |
| A project image | 800 MB for a small Workers project; 6 GB for a monorepo with Go, Node and MySQL in it |
| A sandbox's volumes | a few hundred MB, dominated by the database |
| The build cache | **21 GB across 440 records**, having built two projects a handful of times |

The build cache is the one that grows without bound, and the one nothing prunes on its own.

Its two numbers do not match, and that is not an error. On that machine, 21 GB of records
held only **5.1 GB that no image was also holding**, and 5.1 GB is what a prune actually
returns. Deleting a cache record whose bytes an image still has frees nothing. `docker system
df` draws the line in the same place, and so does `sandboxr prune`.

## How much memory to give it

A sandbox is capped at one limit for the whole container: **the largest `memory:` any single
app in the project declares, and never below 4 GB.** One limit for everything, because the
cgroup total is what the kernel enforces.

So the sum is simple:

- **4 GB per sandbox you want running at once**, or more if any app in the project declares
  more.
- **Plus about 2 GB** for the host and the dashboard.

Four sandboxes of a project whose heaviest build asks for 6 GB wants 26 GB, not 16.

**8 GB is the floor for using sandboxr at all**, and 40 GB of disk with it. Below that you
will spend your time having things killed for memory, and the thing the kernel picks to kill
may not be the thing that asked for too much.

> [!CAUTION] Under memory pressure the kernel does not choose politely
> A front-end build that quietly needs 6 GB can get somebody else's sandbox killed instead of
> itself. The fix is to declare `memory:` on the app that needs it, so the whole sandbox is
> given room up front rather than discovering the limit as `code 137` halfway through a
> build. [The edit–reload loop](edit-and-reload.md) has what that failure looks like.

Turn **swap** on if you can. It converts a hard out-of-memory kill into slowness, which is a
much better failure.

## Reclaiming, least destructive first

### 1. `sandboxr prune` — what sandboxr made, and nothing else

Start here. It reports before it removes anything:

```bash
sandboxr prune                      # a report; removes nothing
sandboxr prune --yes                # remove what it listed
sandboxr prune --build-cache --yes  # and Docker's build cache with it
```

```
WOULD REMOVE  NAME                        SIZE    WHY
image         sandboxr/acme:40ed880f9db8  5.3 GB  sandboxr/acme:48273eacdece replaced it
image         sandboxr/demo:664cb3e82b64  452 MB  sandboxr/demo:de1aab947f66 replaced it

About 5.8 GB in total. Add --yes to remove it.
```

It offers three things and protects everything else:

- **Orphaned per-sandbox volumes** — a `sandboxr-<purpose>-…` volume no surviving sandbox
  owns and no container has mounted.
- **Superseded project images** — for each project, everything older than its newest image.
- **Docker's build cache**, only with `--build-cache`, because sandboxr is not its only
  writer.

Each project's newest image survives, because its tag is a content hash and the next
`sandboxr up` will find it and start in seconds instead of rebuilding a toolchain. It never
touches `sandboxr-claude`, `sandboxr-gocache` or `sandboxr-gomod`, and never touches
`sandboxr/base` or `sandboxr/dashboard`. Those are contract rules, not preferences.

> [!NOTE] Sizes are what removal actually returns
> Two project images built on the same base each report several gigabytes in `docker images`,
> and most of that is the base layer they share. The figures in this report are the bytes
> only that image is holding — which is why they are smaller, and why they add up to
> something you get.

The full detail of what `prune` and `gc` remove, and why one asks and the other acts, is in
[Start, stop, list, clean up](lifecycle.md).

> [!IMPORTANT] `sandboxr prune --yes` has never removed anything
> The report has been run against a live daemon and its figures match `docker system df`. The
> removal path is unit-tested only. See [What is built](../reference/status.md).

### 2. `sandboxr gc` — sandboxes whose work is over

```bash
sandboxr gc --dry-run
sandboxr gc
```

Reaps a sandbox whose worktree no longer exists on disk, and the volumes that went with it.
This one **does** delete databases — but the sandboxes it picks are ones whose worktree you
already deleted yourself.

It also removes the superseded project images from the section above, without being asked
twice. That is deliberate: those images are six gigabytes apiece, nothing will ever ask for
their tags again, and leaving them to a command you have to remember is how a machine fills
up. Every image the report above protects, `gc` protects too.

### 3. Docker's own commands, when that was not enough

<details class="agent">
<summary><b>Details for an agent</b> — the four blunter Docker commands, in order, and what each costs</summary>

**`docker system df`** first, always. It is the report the numbers above are compared
against, and `-v` breaks it down per image, volume and cache record.

**`docker builder prune -a`** — the build cache. Usually the largest single reclaim on a
machine that has been building for a while. The cost is that the next build of *every*
project on the daemon is a cold one: no cached dependency install, no cached toolchain
download. On a big project that is tens of minutes, once.
`sandboxr prune --build-cache --yes` runs exactly this and reports the same figure first.

**`docker image prune`** — dangling images only. Safe, and usually small.

**`docker image prune -a`** — every image no container is using. This takes
`sandboxr/base` and `sandboxr/dashboard` too, because nothing is *running* from the base
image between sandboxes. `sandboxr init` rebuilds them, in several minutes.

**`docker system prune -a --volumes`** — do not run this unless you want the machine empty.
`--volumes` removes every volume no container has mounted, which includes:

- **`sandboxr-claude`** — signing the machine out of every MCP server an agent session had
  been authorised for.
- **`sandboxr-gocache`** and **`sandboxr-gomod`** — an expensive rebuild.
- The `data` volume of every **stopped** sandbox, which is its database.

If you want room, the commands above it get you there without losing a credential you will
have to go and find again.

</details>

## On a server

Three levers, and they are the whole sizing decision:

- **`data-root` on the big disk.** There is no allocation to raise on Linux, so this is it.
- **Swap on.** A hard out-of-memory kill becomes slowness.
- **`sandboxr prune --build-cache --yes` and `sandboxr gc` on a timer.** Nothing prunes the
  build cache on its own, and a build machine left alone will fill any disk you give it.

Then declare `memory:` on any app that needs it, so a sandbox is given room rather than
discovering the limit halfway through a build.

[On a server, for a team](../setups/shared-server.md) has the rest of the arithmetic — and
says plainly which parts of running sandboxr on a server do not exist yet.

**Next:** [Start, stop, list, clean up](lifecycle.md) is the exact rule for what each
reclaiming command removes. [Troubleshooting](../troubleshooting.md) covers the failures a
full disk reports as something else entirely.
