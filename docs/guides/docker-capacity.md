---
title: Giving Docker the whole machine
description: Where Docker's disk and memory limits actually come from, what sandboxr accumulates, and how to get the space back without losing the things that are expensive to rebuild.
sidebar:
  order: 9
---

The complaint that brings people here is always the same shape: Docker has run out of room, the
obvious fix was to stop some sandboxes, and stopping them gave nothing back.

That is not a bug, and it is not a limit you have hit. **Stopping a container frees its memory and
its CPU and no disk at all** — the container, its volumes and the image it ran from are all still
there. What fills a machine is images and build cache, and neither of those belongs to any
particular sandbox.

So there are two separate questions, and they have different answers:

| The symptom | The real question |
|---|---|
| "No space left on device", a build failing halfway, MySQL reporting a corrupt database | **Disk.** How much has Docker got, and what is it storing? |
| A build killed with `code 137`, a sandbox dying while another one builds | **Memory.** How much may the daemon use at once? |

## On Linux there is no allocation

**Start here, because it is the answer for a server and it is easy to miss.**

On Linux the Docker daemon is a process on your host. There is no virtual machine, no disk image,
and no memory allocation to raise. It writes to a directory on your filesystem and it allocates
memory from your kernel like anything else, so:

- **Disk** is however much free space that filesystem has. There is no ceiling to lift.
- **Memory** is the host's memory. A container with no `memory:` limit can use all of it.

Every "increase Docker's disk limit" instruction on the internet is about Docker Desktop, and on a
server it describes a setting that does not exist. If you are deploying sandboxr to a box you want
it to fill, you have already won this one — the lever is which disk Docker writes to, not how much
of it Docker is permitted to use.

> [!NOTE] `docker info` says `/var/lib/docker` on a Mac too
> On Docker Desktop that path is real, but it is inside the virtual machine. The thing on your Mac
> is a single sparse disk image. Reading `Docker Root Dir` and going looking for it on the host is
> a five-minute detour that ends in an empty directory.

## Where Docker's data lives, and how to move it

On Linux, everything Docker stores — every image layer, every volume, every build cache record —
is under one directory:

```
/var/lib/docker
```

If the machine's root filesystem is small and the data disk is large, that is the whole problem and
`data-root` is the whole fix. In `/etc/docker/daemon.json`:

```json
{
  "data-root": "/mnt/data/docker"
}
```

Moving it is a stop, a copy and a start, and the copy has to preserve ownership, permissions,
extended attributes and hard links — a plain `cp -r` produces a directory Docker will not start
against:

```bash
sudo systemctl stop docker
sudo rsync -aHAX /var/lib/docker/ /mnt/data/docker/
sudo systemctl start docker
docker info --format '{{.DockerRootDir}}'      # confirm before deleting anything
```

Keep the old directory until the daemon has come back and `docker images` looks the way you
remember it. Then remove it.

> [!WARNING] Not a bind mount, and not a symlink
> Docker's storage driver cares about the filesystem underneath it. `data-root` is the supported
> way to move the directory; a symlink from `/var/lib/docker` works until it does not, and the
> failure arrives as an unrelated-looking storage error weeks later.

**This is the lever on a server.** Put `data-root` on the big disk, and the ceiling becomes the
disk's size.

## Docker Desktop's sliders are a VM allocation

On macOS and Windows the daemon runs inside a Linux virtual machine, and the settings in
**Settings → Resources** size that VM:

| Setting | What it really is |
|---|---|
| **Virtual disk limit** | The maximum size of one sparse disk image on your real disk. The file grows towards it and does not shrink on its own |
| **Memory limit** | Memory the VM may take from the host. Every container shares it |
| **CPU limit** | Host cores the VM may schedule on |
| **Disk image location** | Where that file lives — move it to an external or secondary disk from here rather than by hand |

Two consequences worth knowing before you drag anything:

- **Raising the disk limit is cheap and reversible; lowering it is not.** Shrinking the virtual
  disk is offered as "reset", and reset means deleting every image, container and volume on the
  machine.
- **The disk image does not shrink when you delete things.** Reclaiming space inside the VM makes
  room *for Docker*; the file on your Mac stays whatever size it grew to.

On a Mac, the memory limit is usually the binding constraint rather than the disk — a sandbox with
a database, a Go backend and a front-end build in it is not small, and several at once share one
allocation. `docker info --format '{{.MemTotal}}'` reports what the VM actually has.

## What accumulates, and what does not

| Thing | Grows with | Freed by stopping a sandbox? |
|---|---|---|
| **Docker's build cache** | Every image build, forever, unless pruned | No |
| **Project images** | One per project *per content hash* — a new one each time the base image, the tool version, a Dockerfile or a lockfile changes | No |
| The base and dashboard images | Once per machine, rebuilt on a version bump | No |
| A sandbox's volumes (`data`, `blob`, `bin`, `www`) | One set per sandbox | No — `sandboxr down` is what removes them |
| The shared `deps-<hash>`, `gocache`, `gomod` volumes | One per distinct lockfile; the Go caches grow with what has been built | No, and deliberately never automatically |
| The container's own writable layer | Barely — everything that matters is on a volume or a mount | Not applicable |
| **Your worktrees** | Your work | They are **bind-mounted from the host** and were never in Docker's storage at all |

That last row is worth pausing on, because it is the one people fear. Deleting Docker images and
volumes cannot touch a worktree, a branch or a commit. The durable thing is always the git
repository on the host.

The row above it is the one that surprises people: `sandboxr-claude` holds the credentials an agent
session has been given, and `sandboxr-gocache` / `sandboxr-gomod` are an expensive rebuild. Nothing
in sandboxr ever removes them, and the blunt Docker commands below will.

### Rough sizes

Measured on one machine — a Mac running two projects, one of them large. Yours will differ, and
these are here so a number is not a mystery, not as a specification:

| | |
|---|---|
| The base image | ~670 MB |
| A project image | 800 MB for a small Workers project; 6 GB for a monorepo with Go, Node and MySQL in it |
| A sandbox's volumes | a few hundred MB, dominated by the database |
| The build cache | **21 GB across 440 records**, having built two projects a handful of times |

The build cache is the one that grows without bound. It is also the one nothing prunes on its own.

Its two numbers do not match, and that is not an error: on that machine 21 GB of records held only
5.1 GB that no image was also holding, and 5.1 GB is what a prune returns. Deleting a cache record
whose bytes an image still has frees nothing. `docker system df` draws the line in the same place,
and so does `sandboxr prune`.

## Reclaiming, least destructive first

### 1. `sandboxr prune` — what sandboxr made, and nothing else

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

It offers three things and protects the rest:

- **Orphaned per-sandbox volumes** — a `sandboxr-<purpose>-…` volume no surviving sandbox owns.
- **Superseded project images** — for each project, everything older than its newest image. The
  newest one stays, because the tag is a content hash and the next `up` will find it and start in
  seconds instead of rebuilding a toolchain.
- **Docker's build cache**, only with `--build-cache`, because sandboxr is not its only writer.

It never touches `sandboxr-claude`, `sandboxr-gocache` or `sandboxr-gomod`, and never touches
`sandboxr/base` or `sandboxr/dashboard`.

**It reports by default and removes only with `--yes`** — the opposite way round from `gc`, which
acts unless you pass `--dry-run`. That is deliberate: what `gc` removes costs a restart, and what
`prune` removes costs a toolchain rebuild on somebody's next `up`.

> [!NOTE] Sizes are what removal actually returns
> Two project images built on the same base each report several gigabytes, and most of that is the
> base layer they share. The figures above are the bytes only that image is holding, which is why
> they are smaller than `docker images` and why they add up to something you get.

### 2. `sandboxr gc` — sandboxes whose work is over

```bash
sandboxr gc --dry-run
sandboxr gc
```

Reaps a sandbox whose worktree no longer exists on disk, and the volumes that went with it. This
one **does** delete databases — the sandboxes it chooses are ones whose worktree you already
deleted. [Start, stop, list, clean up](lifecycle.md).

### 3. `docker builder prune -a` — the build cache

```bash
docker builder prune -a
```

Usually the largest single reclaim on a machine that has been building for a while. The cost is
that the next build of every project on the daemon is a cold one: no cached `npm ci`, no cached
`go mod download`, no cached toolchain download. On a big project that is tens of minutes, once.

`sandboxr prune --build-cache --yes` runs exactly this, and reports the same figure beforehand.

### 4. `docker image prune -a` — images nothing is running

```bash
docker image prune       # dangling images only — safe, and usually small
docker image prune -a    # every image no container is using
```

`-a` takes the base image and the dashboard image too, because nothing is *running* from the base
image between sandboxes. `sandboxr init` rebuilds them, in several minutes.

### 5. `docker system prune -a --volumes` — be careful with this one

> [!CAUTION] This takes the things sandboxr deliberately protects
> `--volumes` removes every volume no container has mounted, and that includes **`sandboxr-claude`**
> — signing the machine out of every MCP server an agent session had been authorised for — along
> with `sandboxr-gocache` and `sandboxr-gomod`, which are an expensive rebuild, and the `data`
> volume of every stopped sandbox.

If you want the machine empty, this is the command. If you want the machine to have room, the four
above it get you there without losing a credential you will have to go and find again.

## On a server

Put the three levers together:

- **`data-root` on the big disk.** That is the sizing decision; there is no allocation to raise.
- **Swap on.** It turns a hard out-of-memory kill into slowness, which is a far better failure than
  the kernel picking somebody else's sandbox to end.
- **`sandboxr prune --build-cache --yes` and `sandboxr gc` on a timer.** Nothing prunes the build
  cache on its own, and a build machine left alone will fill any disk you give it.

Declare `memory:` on any app that needs it, so a sandbox is scheduled with room rather than
discovering the limit as `code 137` halfway through a build. [Running on a
server](../running-on-a-server.md) has the rest — DNS, certificates, the firewall.

## Related

- [Start, stop, list, clean up](lifecycle.md) — what `down` and `gc` each remove
- [Running on a server](../running-on-a-server.md) — sizing, DNS and certificates
- [Troubleshooting](../troubleshooting.md) — the failures a full disk reports as something else
- [CLI reference](../reference/cli.md)
