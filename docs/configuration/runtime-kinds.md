---
title: The three runtime kinds
description: Backend, static front-end and served front-end — what each costs, and how to choose between them.
---

Everything a [sandbox](../reference/glossary.md) runs is one of three kinds. Which kind a thing is decides when it gets
built, what it costs while nobody is looking at it, and what you run after you change it.
This page is how you choose.

```prompt
Classify every runnable thing in this project into sandboxr's three runtime kinds.

Read docs/configuration/runtime-kinds.md. For each app or service, say which kind it is
and why, and write the sandboxr.yaml entry for it. Find the real build command, output
directory and port by reading the project — do not guess.

Stop and tell me if something is a long-running dev server with no static build, because
that is the expensive kind and I may want it marked optional.
```

| | Declared with | Built | Cost while idle | Picks up an edit on its own |
|---|---|---|---|---|
| **backend** | an entry under `backends` | when its service starts | one process | no — `reload --go` |
| **static front-end** | `out:` | on demand, never at startup | nothing | no — `reload --web` |
| **served front-end** | `serve:` and `port:` | never — it *is* the server | hundreds of MB, permanently | yes |

The last column is why the first two have no automatic reload. It is not a missing feature.
It is the price of running six sandboxes on one laptop.

## A backend

A program that listens on a port: an API, a compiled service, a worker with an HTTP
interface.

```yaml
backends:
  defaults:
    workdir: services
    build: go build -o {out} ./{name}
    health: /health
  services:
    - { name: api, port: 8001, label: api }
```

It is built when its supervised service starts, which is during the sandbox's boot. Then it
is watched: if it exits, it starts again. A compiled service is cheap to build and useless
until it exists, which is why this kind is built up front while a front-end is not.

`health` gives the sandbox a way to answer "is this working" rather than only "is the
process alive". Without it, a service that started and immediately wedged still counts as
up.

```bash
sandboxr reload --go=api     # compile, then replace the process
```

> [!NOTE] No compiled backend has been built in a sandbox yet
> This kind is written and unit-tested, and no real compiler has run against it. Expect the
> details to need adjusting. [What is built](../reference/status.md) is the full inventory.

<details class="agent">
<summary><b>Details for an agent</b> — how a backend is built and supervised</summary>

`container/scripts/run-backend.sh` builds first, then `exec`s the binary so s6 supervises
the service itself rather than a wrapper shell. A supervised shell would survive
`s6-svc -r`, keep its child alive and hold the port, so every replacement would die with
`address already in use` while the old code carried on serving.

The build is skipped when the binary exists and nothing under its `workdir` is newer than
it. `node_modules` and `.git` are excluded from that walk. `SANDBOXR_FORCE_BUILD=true`
overrides the check.

A build failure is not allowed to become a crash-loop that scrolls its own error away: the
run script warns, sleeps ten seconds and exits, so the compiler output stays readable in
that service's log.

The binary lands at `{out}`, inside the sandbox's `bin` volume. The build runs in
`/workspace/<workdir>`, and so does the binary.

</details>

> [!TIP] Leave out a service that cannot start
> A service whose database exists on no developer machine, and that no migration creates,
> should be omitted or marked `optional`. Otherwise it can only crash-loop.

## A static front-end

A build command that leaves files in a directory. No process, no port, and no memory cost
once it has been built — a request is a file read.

```yaml
frontends:
  root: web/packages
  defaults:
    build: npx vite build
    out: dist
  apps:
    - { label: app, package: web }
```

`out:` is what makes it this kind.

> [!TIP] Point `build` at the bundler, not at the npm script
> A typical `npm run build` is `tsc -b && vite build`, so a branch that does not typecheck
> could not be sandboxed at all. Calling the bundler directly means a branch mid-refactor
> still gets a running app, and CI stays the thing that enforces types.

### Nothing is built when the sandbox starts

This is what makes a sandbox come up in seconds rather than minutes. A freshly started
sandbox has built nothing, and each static hostname answers with a page saying so:

```
app has not been built in this sandbox.
```

Then run:

```bash
sandboxr reload <slug> --web=app
```

A page rather than a 404, because a 404 at a sandbox hostname is indistinguishable from
broken DNS or a misconfigured router — you would go and debug the wrong layer. The page is
served with status 503.

> [!NOTE] That page names a command that does not exist
> The 503 page tells you to run `sandboxr build <slug> --app <label>`. There is no `build`
> verb in the CLI. `sandboxr reload <slug> --web=<label>` is the command that works.

Two fields shape a static app further, and both are covered in the reference:
[`static_mode`](sandboxr-yaml.md#static_mode) decides how unknown paths resolve, and
[`in_build_all`](sandboxr-yaml.md#in_build_all) decides whether "rebuild everything"
includes it.

<details class="failure">
<summary><b>If it goes wrong</b> — a build killed for memory says nothing about memory</summary>

A build that renders many pages across several worker processes is bounded by the container's
total memory, not by any single heap limit. The kernel kills it, and what you see is a bare
`Killed` and exit code 137.

Declare what the app actually needs:

```yaml
- { label: www, package: marketing, build: npm run build, out: out, memory: 6g }
```

The largest limit any runtime asks for becomes the whole sandbox's limit, over a floor of
4 GB. The build then also compares its declared limit against the container's real one and
refuses in a second, naming both, instead of dying part-way through.

The container's message suggests `SANDBOXR_MEMORY=6g sandboxr up`. Nothing on the host reads
that variable today; declaring `memory` in the config is the working fix.

</details>

## A served front-end

A long-running process that serves the app itself. `wrangler dev` is one. So is a framework
with no static export, and so is a CMS.

```yaml
frontends:
  apps:
    - label: cms
      package: cms
      prepare: npm run codegen
      serve: npx next dev --port 3000 --hostname 127.0.0.1
      port: 3000
      optional: true
```

`serve:` makes it this kind, and `port:` is required with it because the sandbox's router
has to have somewhere to forward to.

It is declared under `frontends` because it *is* the front-end for that label. At run time it
behaves like a backend: supervised, restarted if it exits, reached through a proxy.

The compensation for what it costs is that it needs no rebuild command at all. Your worktree
is mounted, so the server sees your edits and reloads itself.

`prepare` is the whole of a server's "build" — a codegen step, a schema pull — and it runs
as part of starting the server, not on demand.

### It is the most expensive thing in a sandbox

A dev server holds your project's whole module graph in memory for **as long as the
container lives**, whether or not anybody opens it. Commonly hundreds of megabytes, and
multiplied by every sandbox you are running.

So mark it `optional: true`, and it is defined but dormant until you ask for it:

```bash
sandboxr up --with cms
```

Nothing about `optional` is specific to servers — a backend can be optional too — but a
server is the usual reason to want it.

> [!CAUTION] A file database needs the server pointed at the sandbox's state
> With the `d1` or `sqlite` driver, both `serve` and `migrate` must direct the runtime at
> the sandbox's own state directory:
>
> ```yaml
> serve: npx wrangler dev --port 8787 --ip 127.0.0.1 --persist-to "$SANDBOXR_D1_DIR"
> ```
>
> Leave it out and the runtime writes its database **into your worktree**. Sandbox data then
> lands in your branch, and every sandbox of that project shares one file.
> `sandboxr doctor` warns when it cannot see the variable in the command. It does not
> refuse, because a project can point its runtime at the right place through a config file
> the tool cannot read.

Every server that is not the database's declared `owner` has the database's location
**removed** from its environment. A second process opening the same file does not error, it
deadlocks — a hang with nothing in any log. Withholding the location turns that into a loud
failure about a missing binding, in the process that was not supposed to have it.

## `optional` means dormant by choice, not broken

This deserves its own section, because getting it wrong trains people to ignore the panel
that tells them what is wrong.

An optional service is written into the plan and into its supervisor entry, and left
disabled unless it is named in `--with`. Three things follow, and all three are binding:

- **The router does not advertise it.** No app hostname, and no health route for it.
- **A path under `/__sandboxr/` that names nothing answers 404.** That is the router saying
  it has no route at all — which is a different answer from a service saying "no".
- **Nothing may report a dormant service as a fault.** The `optional` flag is carried out of
  the plan and all the way to the screen. The state derived for a dormant service is its own
  value, never `down`.

Anything drawing a sandbox should read a dormant service as **not started**, in the same grey
as an app that has not been built, and never count it among the services that are not
answering.

<details class="why">
<summary><b>Why it works this way</b> — the bug that made this a rule</summary>

A health route was written only for a service that was going to run, so the probe of a
dormant service arrived at a path with no route. A host matcher matches every path, so the
request fell through to the front-end's own site block.

What came back was that front-end's answer. An unbuilt app replied with its 503 "not built
yet" page, and whatever read those probes called every dormant service `down`. Once that app
*was* built, the same request got the single-page app's `index.html` and a 200 — and the same
never-started service read as `up`.

A service's reachability must not depend on whether an unrelated front-end has been built.
Reserving `/__sandboxr/*` and answering 404 there is what restores that.

</details>

## Why three kinds and not two

**A server is not a backend.** It produces no artefact, so there is nothing to rebuild. It
recompiles as it serves, so it needs no rebuild command. And it takes an *app label's*
hostname, not a service name's — which is exactly what a Workers project needs, because the
worker *is* the app.

**A static app is not a server.** No port, no process, no health check, no idle cost.
Building it is a discrete event with an exit code; serving it is a file read.

Fold them together and every piece of code that touches a runtime has to ask "but which
sort is this one really?" — precisely the branching that three explicit kinds make visible
in one place.

## Choosing

| What you have | Kind | Write |
|---|---|---|
| A compiled service with an HTTP port | backend | an entry under `backends.services` |
| A bundled single-page app | static | `out: dist` |
| A static-export site generator | static | `out: out`, `static_mode: html`, probably `memory:` |
| A component library's static build | static | `out: storybook-static`, `in_build_all: false` |
| A directory of assets with no app | static | `static_mode: files` |
| A framework with no static export | served | `serve:` and `port:`, probably `optional: true` |
| A Workers project under `wrangler dev` | served | `serve:` and `port:` |
| A worker with no HTTP interface at all | backend | an entry under `backends.services` |

**Next:** [sandboxr.yaml, field by field](sandboxr-yaml.md) for every field each kind
accepts, or [The edit–reload loop](../guides/edit-and-reload.md) for what you run after you
change something.
