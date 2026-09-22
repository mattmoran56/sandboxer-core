---
title: The edit–reload loop
description: How a file you save becomes running code, what each rebuild costs, and why there is no hot reload.
---

Your worktree is mounted straight into the sandbox at `/workspace`, so **the file you just
saved is already inside**. What is not automatic is turning it into something running. This
page is the one command that does that, and what each kind of rebuild costs.

```prompt
I have edited a file in this worktree. Get the sandbox serving the new version.

Read docs/guides/edit-and-reload.md first. Work out from the project's sandboxer.yaml
which runtime the file belongs to, then run the right `sandboxer reload` for it and tell
me what you ran and what it printed.

Stop and ask me if I changed sandboxer.yaml or the lockfile — those need `sandboxer up`,
which replaces the container. Stop and tell me if the build output contains `Killed` or
`137`: that is the sandbox running out of memory, not a broken build.
```

## The loop

Edit, reload, refresh. There are three things `reload` can do, and you pick one:

```bash
sandboxer reload --go=api        # rebuild one backend and restart it
sandboxer reload --go            # every backend
sandboxer reload --web=app       # build one front-end into the web root
sandboxer reload --web=all       # the build-everything set
sandboxer reload --web=built     # exactly what this sandbox has already built
sandboxer reload --migrate       # re-run this sandbox's migrations
```

One kind at a time. If you pass more than one, `--migrate` wins, then `--web`, then `--go`.

## What needs what

| You changed | Do this | Roughly |
|---|---|---|
| A backend's source | `reload --go=<name>` | seconds — the compiler cache is a volume |
| A static front-end's source | `reload --web=<label>` | seconds to minutes, depending on the app |
| A `serve:` front-end's source | usually nothing — see below | — |
| A migration file | `reload --migrate` | as long as the migration takes |
| `sandboxer.yaml` | `sandboxer up` — the plan is written at start | a restart, seconds |
| The lockfile | `sandboxer up` — the dependency volume is keyed on its hash | an install |

The last two need `up` rather than `reload` for the same reason: neither the plan nor the
mounted volumes can change on a container that is already running. `up` replaces the
container, keeps every volume, and takes seconds because nothing is restored.

## There is no hot reload

Saving a file does not make the running app change. That is a deliberate trade, and it is
worth understanding rather than working around.

A dev server watching for changes holds its whole module graph in memory for as long as the
container lives, whether or not anybody ever opens that app. One dev server per app, per
sandbox, and the whole point of sandboxer is running several sandboxes at once. Four sandboxes
with three apps each is twelve resident dev servers on one machine.

A static build costs a few seconds when you ask for it, and nothing when you do not. So
sandboxer builds when asked.

**Where you genuinely need hot reload, run that one app's dev server on your own machine and
point it at the sandbox's API.** Keep the sandbox for the integration. That gets you the fast
inner loop where you are actually working and the realistic environment everywhere else.

### The one exception is not an exception sandboxer makes

A front-end declared with `serve:` instead of `out:` is a **long-running process** — a real
dev server, supervised inside the sandbox. If that server hot-reloads, it hot-reloads, and it
did so because the project's own dev server does that. It is the project's behaviour, not
sandboxer's, and sandboxer neither adds it nor takes it away.

These are the expensive ones, which is why a project usually marks them `optional: true` and
starts them with `sandboxer up --with <label>`. See [The three runtime
kinds](../configuration/runtime-kinds.md).

## An app that has not been built answers 503

Static front-ends are built on demand and **never at startup**. A sandbox has to come up in
seconds, and an app nobody opens should cost nothing. So there is a normal, expected state in
which an app's hostname is live and the app is not there yet, and opening it gives you a
`503` with instructions rather than a `404`:

```
app has not been built in this sandbox.

Run:  sandboxer build <slug> --app app
```

> [!WARNING] That page names a command that does not exist
> The real command is `sandboxer reload <slug> --web=<label>`. `sandboxer build` was never
> added to the CLI, and the 503 page in `container/scripts/gen-caddyfile.sh` still points at
> it. Use `reload`.

Once it is built, the same hostname serves the bundle. There is nothing else to do — no
restart, no separate step.

<details class="agent">
<summary><b>Details for an agent</b> — <code>reload</code>'s exact surface, and what runs inside the container</summary>

`sandboxer help` prints this:

```
reload [slug] --go [name]                Rebuild a backend and restart it
              --web <label|all|built>    Rebuild a front-end
              --migrate                  Re-run this sandbox's migrations
```

> [!WARNING] The spacing in that help text does not work
> `--web` and `--go` are not among the flags that take the next word as a value, so
> `sandboxer reload --web app` sets `--web` to `true` and reads `app` as the **slug**. Always
> write `--web=app`. Every example on this page uses the `=` form for that reason.
> [CLI commands](../reference/cli.md) has the parser's full flag list.

Also accepted, and not listed in `sandboxer help`: `--backend [name]` is a synonym for
`--go`. `--project NAME` and `--worktree PATH` resolve which sandbox is meant, exactly as on
the other verbs. `--json` puts the result on stdout.

`--go` and `--backend` with no value mean `all`. `--web` with no value means `all`.

| Target | Resolves to |
|---|---|
| `--go=<name>` | The backend whose `name` matches. No match is an error |
| `--go` / `--go=all` | Every backend in the config |
| `--web=<label>` | The front-end with that label, static or `serve:` |
| `--web=all` | `build-static.sh --all` — every static app the plan does not exclude with `in_build_all: false` |
| `--web=built` | `build-static.sh --built` — the labels in `/srv/www/.built.json`. With nothing built yet it falls back to `--all` |

What actually happens inside the container:

- **A backend** runs the project's `build:` command in its `workdir`. `{out}` in that command
  is replaced with `/var/lib/sandboxer/bin/<name>` and `{name}` with the backend's name. On
  success, core execs `sandboxer-restart <name> || true` in the container.
- **A static front-end** runs the project's `build:` command in its package directory, then
  copies the output directory over `/srv/www/<label>/` by swap, so a page load mid-build never
  sees a half-written bundle. The build time is recorded in `/srv/www/.built.json`.
- **A `serve:` front-end** is not built. Core execs `sandboxer-restart <label> || true`.
  `build-server.sh` runs the app's optional `prepare` step if it declares one.
- **`--migrate`** runs `container/scripts/migrate-run.sh`, which runs the project's own
  migration command and writes the verdict to `/run/sandboxer/migrate.json`. It never exits
  non-zero; the verdict comes from the output.

`reload` refuses on a sandbox that is stopped or does not exist:
`sandbox <slug> is not running`. Exit `1` if anything failed to build, and the last 20 lines
of the build output are printed.

`build:`, `out:`, `serve:`, `prepare:`, `in_build_all:` and `memory:` are all config fields —
[sandboxer.yaml, field by field](../configuration/sandboxer-yaml.md) is the reference, and
[CLI commands](../reference/cli.md) is the full flag list.

</details>

<details class="failure">
<summary><b>If it goes wrong</b> — a rebuild that succeeds and changes nothing</summary>

The restart step of `reload --go` and `reload --web=<serve-label>` calls a helper named
`sandboxer-restart` inside the container, and tolerates its absence with `|| true`. **No such
program is installed in the base image.** So the build happens, `reload` reports the service
as rebuilt, and the old process carries on serving the old binary.

If a backend rebuild appears to do nothing, that is why. `sandboxer up` is the reliable way
round it: it replaces the container, and each backend's supervisor script rebuilds it on the
way up if the source is newer than the binary. The volumes are kept, so this costs seconds.

Two related honest limits, from [What is built](../reference/status.md): **no compiled
backend has ever been built or run in a sandbox**, and **nothing with a real bundler has ever
been built in one**. The staleness check, the build-failure pause, the memory refusal and the
out-of-memory hint below are all written and unit-tested, and none has met a real compiler.

</details>

## Two things that fail quietly, on purpose

**A backend that fails to build leaves the old one running.** The build happens first, and
the restart only happens if the build succeeded. A sandbox with a broken branch in it still
serves the last thing that compiled, which is what you want when the failure is a typo you
are about to fix.

**A front-end build does not check types.** Projects usually spell their build script as
`tsc -b && vite build`. sandboxer's own examples declare `npx vite build` instead, because a
branch that does not typecheck still needs a sandbox, and CI is what enforces types. Your
project chooses: whatever you put in `build:` is what runs, verbatim.

## `all` and `built` are not the same thing

**`all`** is the project's ordinary apps and nothing else. It deliberately leaves out the
expensive members — a marketing site rendering thousands of pages, a component library —
because something as small as a shared-component tweak triggers `all`, and widening it would
start a multi-gigabyte build as a side effect. An app opts out with `in_build_all: false`.

**`built`** reads what this sandbox has actually built and refreshes exactly that. Once you
have built the marketing site *here*, `built` includes it. In a sandbox where you never did,
it does not, and it will not start that first build for you.

> `all` is "the usual few, fast". `built` is "everything this sandbox actually serves".

There is one wrinkle worth knowing. In a brand-new sandbox `built` has nothing to refresh, so
it falls back to `all`. What `built` really guarantees is narrower than "no first builds": it
guarantees that **nothing the project excluded with `in_build_all: false` is ever built as a
side effect.** That is where the cost is, and it is the reason the exclusion exists.

## The memory failure that reads as something else

A sandbox gets **one memory limit for the whole container**: the largest `memory:` that any
single runtime in the config declares, never below **4 GB**. One limit for everything,
because that is what the kernel enforces. A build that needs 6 GB is killed under a 4 GB cap
no matter which app declared what.

When a static build dies for memory you get this:

```
> marketing@1.0.0 build
> next build
   Collecting page data ...
Killed
npm ERR! code 137
```

Nothing there mentions memory. `137` is `128 + 9` — killed by signal 9 — and it reads like a
broken build rather than a full one. `reload` watches for exactly that: if the output
contains `137` or `Killed`, it says in plain words that the kernel took it for memory.

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

Then `sandboxer up` again. The limit is set at `docker run` and cannot change on a live
container.

> [!TIP] A generator will die at 6 GB too, just later
> A static site generator spreads rendering over many worker processes, so no single heap
> limit bounds it — the cgroup total is what the out-of-memory killer measures. Declare the
> real requirement once rather than bisecting upwards.

A sandbox that declares more memory than the machine will give it refuses the build up front
rather than discovering it halfway through. It names the shortfall and tells you to restart
the sandbox with more. Sizing the machine itself is [Giving Docker the whole
machine](docker-capacity.md).

## When `reload` is not enough

`sandboxer up` again. It replaces the container from the current config and the current
commit, keeps every volume, and takes seconds because nothing is restored. It is the right
answer after a config change, a lockfile change, or any time you are not sure what state the
container has got itself into.

**Next:** [Logs, shells and terminals](logs-and-shells.md) is where you read a build that
failed. [The three runtime kinds](../configuration/runtime-kinds.md) explains what is being
rebuilt, and why `serve:` behaves differently from the other two.
