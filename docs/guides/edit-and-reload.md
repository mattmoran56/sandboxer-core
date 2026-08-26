---
title: The edit–reload loop
description: How a file you save becomes running code, what each rebuild costs, and why there is no hot reload.
sidebar:
  order: 2
---

Your worktree is bind-mounted at `/workspace`, so **your changes are already inside the
sandbox** the moment you save. What is not automatic is turning them into something running: a
compiled backend has to be rebuilt, a static front-end has to be built and copied into the web
root.

That is what `reload` does.

```bash
sandboxr reload --go api        # rebuild one backend and restart it
sandboxr reload --go            # every backend
sandboxr reload --web app       # build one front-end into the web root
sandboxr reload --web all       # the build-everything set
sandboxr reload --web built     # exactly what this sandbox has already built
sandboxr reload --migrate       # re-run this sandbox's migrations
```

One kind at a time. If you pass more than one, `--migrate` wins, then `--web`, then `--go`.

## What needs what

| You changed | Do this | Roughly |
|---|---|---|
| A backend's source | `reload --go <name>` | seconds — the compiler cache is a volume |
| A front-end's source | `reload --web <label>` | seconds to minutes, depending on the app |
| A `serve:` app's source | nothing — it is a dev server and reloads itself | — |
| A migration file | `reload --migrate` | as long as the migration takes |
| `sandboxr.yaml` | `sandboxr up` — the plan is generated at start | a restart |
| The lockfile | `sandboxr up` — the dependency volume is keyed on its hash | an install |

## Two things that fail quietly, on purpose

**A backend that fails to build leaves the old one running.** The build happens first; the
restart only happens if it succeeded. A sandbox with a broken branch in it still serves the last
thing that compiled, which is what you want when the failure is a typo you are about to fix.

**A front-end build does not check types.** Projects usually spell their build script as
`tsc -b && vite build`. sandboxr's examples declare `npx vite build` instead, because a branch
that does not typecheck still needs a sandbox — and CI is what enforces types. Your project
chooses: whatever you put in `build:` is what runs.

## `all` and `built` are not the same thing

**`all`** is the project's ordinary apps and nothing else. It deliberately leaves out the
expensive members — a marketing site rendering thousands of pages, a component library — because
something as small as a shared-component tweak triggers `all`, and widening it would start a
multi-gigabyte build as a side effect. An app opts out with `in_build_all: false`.

**`built`** reads what this sandbox has actually built and refreshes exactly that. Once you have
built the marketing site here, `built` includes it; in a sandbox where you never did, it does
not. It never *starts* a first build of an expensive app. With nothing built yet it falls back
to `all`.

> `all` is "the usual few, fast". `built` is "everything this sandbox actually serves".

## There is no hot reload

The loop is edit, reload, refresh. That is a deliberate trade.

A dev server for every app in every sandbox would hold hundreds of megabytes resident for the
life of the container, whether or not anyone ever opens that app — and the whole point is running
several sandboxes at once. A static build costs a few seconds when you ask for it and nothing
when you do not.

Where you genuinely need hot reload, run that one app's dev server on your own machine pointed at
the sandbox's API, and keep the sandbox for the integration.

The exception is a `serve:` front-end, which really is a long-running dev server and really does
hot-reload. That is what [the third runtime kind](../configuration/runtime-kinds.md) is for, and
it is why such apps are usually `optional: true`.

## The memory failure that reads as something else

A sandbox gets **one memory limit for the whole container**: the largest `memory:` any single
runtime declares, never less than **4 GB**. One limit for everything, because that is what the
kernel enforces — a build needing 6 GB is killed under a 4 GB cap no matter which app declared
what.

When a static build dies you get this:

```
> marketing@1.0.0 build
> next build
   Collecting page data ...
Killed
npm ERR! code 137
```

Nothing there mentions memory. `code 137` is `128 + 9` — killed by signal 9 — and it reads like
a broken build rather than a full one. `reload` watches for exactly this: if the output contains
`137` or `Killed` it says in plain words that the kernel took it for memory.

The fix is to declare what the app needs, not to raise the limit until it stops:

```yaml
frontends:
  apps:
    - label: www
      package: marketing
      build: npm run build
      out: out
      memory: 6g
```

Then `sandboxr up` again — the limit is set at `docker run` and cannot change on a live
container.

> [!TIP] A generator will die at 6 GB too, just later
> A static site generator spreads rendering over many worker processes, so no single heap limit
> bounds it. The cgroup total is what the out-of-memory killer measures. Declare the real
> requirement once rather than bisecting upwards.

## When reload is not enough

`sandboxr up` again. It replaces the container from the current config and the current commit,
keeps every volume, and takes seconds because nothing is restored.

## Related

- [Three runtime kinds](../configuration/runtime-kinds.md) — what is being rebuilt
- [Logs, shells and terminals](logs-and-shells.md) — reading a build that failed
- [Troubleshooting](../troubleshooting.md)
