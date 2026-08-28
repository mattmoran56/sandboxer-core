---
title: Three runtime kinds
description: Backend, static front-end and served front-end — what each costs, and how to choose.
sidebar:
  order: 2
---

Everything a sandbox runs is one of three kinds. Which one an entry is decides when it is built,
what it costs while idle, and what you run after you change it.

| | Declared with | Built | Cost while idle | Picks up an edit on its own |
|---|---|---|---|---|
| **backend** | an entry under `backends` | at startup | one process | no — `reload --go` |
| **static front-end** | `out:` | on demand, never at startup | nothing | no — `reload --web` |
| **served front-end** | `serve:` and `port:` | never — it *is* the server | hundreds of MB, permanently | yes |

The last column is why the first two have no automatic reload. It is not a missing feature; it is
the price of running six sandboxes on one laptop.

## A backend

A program that listens on a port: an API, a worker with an HTTP interface, anything you compile.

```yaml
backends:
  defaults:
    workdir: services
    build: go build -o {out} ./{name}
    health: /health
  services:
    - { name: api, port: 8001, label: api }
```

Built when the sandbox starts, then supervised — if it exits, it is started again. A compiled
service is cheap to build and useless until it exists, which is why this kind is built up front
while a front-end is not.

`health` gives the sandbox a way to answer "is this working" rather than only "is the process
alive". Without it, a service that started and immediately wedged still counts as up.

```bash
sandboxr reload --go api     # compile, then replace the process
```

A build failure is not allowed to become a crash-loop that scrolls its own error away: the run
script warns, sleeps ten seconds and exits, so the compiler output stays readable in that
service's log.

> [!TIP] Leave out a service that cannot start
> A service whose database exists on no developer machine, and that no migration creates, should
> be omitted rather than declared — otherwise it can only crash-loop.

## A static front-end

A build command that leaves files in a directory. No process, no port, and no memory cost once it
has been built — a request is a file read.

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
> A typical `npm run build` is `tsc -b && vite build`, so a branch that does not typecheck could
> not be sandboxed at all. Calling the bundler directly means a branch mid-refactor still gets a
> running app, and CI stays the thing that enforces types.

### Nothing is built when the sandbox starts

This is what makes a sandbox come up in seconds rather than minutes. A freshly started sandbox has
built nothing, and each static hostname answers with a page saying so and naming the command:

```bash
sandboxr reload --web app
```

A page rather than a 404, because a 404 at a sandbox hostname is indistinguishable from broken DNS
or a misconfigured router — you would go and debug the wrong layer.

See also [`static_mode` and `in_build_all`](sandboxr-yaml.md#static_mode).

## A served front-end

A long-running process that serves the app itself. `wrangler dev` is one; so is a framework with
no static export, and so is a CMS.

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

`serve:` makes it this kind, and `port:` is required with it because the sandbox's router has to
have somewhere to forward to. It is declared under `frontends` because it *is* the front-end for
that label, and it behaves like a backend at run time: supervised, restarted if it exits, reached
through a proxy.

The compensation for what it costs is that it needs no rebuild command at all. Your worktree is
mounted, so the server sees your edits and reloads itself.

`prepare` is the whole of a server's "build" — a codegen step, a schema pull — and it runs as part
of starting the server, not on demand.

### It is the most expensive thing in a sandbox

A dev server holds the whole of your project's module graph in memory for **as long as the
container lives**, whether or not anybody opens it. Commonly hundreds of megabytes, and multiplied
by every sandbox you are running.

So mark it `optional: true` and it is defined but dormant until asked for:

```bash
sandboxr up --with cms
```

Nothing about `optional` is specific to servers — a backend can be optional too — but a server is
the usual reason to want it.

On the dashboard a dormant service reads as **not started**, in the same grey as an app that has
not been built, and it is never counted among the services that are not answering. That
distinction is the whole reason `optional` is carried out of the plan and onto the screen: a
sandbox permanently captioned "2 services are not answering" for two services somebody chose not
to run is a warning people learn to ignore.

> [!CAUTION] A file database needs the server pointed at the sandbox's state
> With the `d1` or `sqlite` driver, both `serve` and `migrate` must direct the runtime at the
> sandbox's own state directory:
>
> ```yaml
> serve: npx wrangler dev --port 8787 --ip 127.0.0.1 --persist-to "$SANDBOXR_D1_DIR"
> ```
>
> Leave it out and the runtime writes its database **into your worktree**, so sandbox data lands
> in your branch and every sandbox of that project shares one file. `sandboxr doctor` warns when
> it cannot see the variable in the command; it does not refuse, because a project can point its
> runtime at the right place through a config file the tool cannot read.

Every server that is not the database's declared `owner` has the database's location **removed**
from its environment. A second process opening the same file does not error, it deadlocks — a hang
with nothing in any log. Withholding the location turns that into a loud failure about a missing
binding, in the process that was not supposed to have it.

## Why three kinds and not two

**A server is not a backend.** It produces no artefact, so there is nothing to rebuild; it
recompiles as it serves, so it needs no rebuild command; and it takes an *app label's* hostname,
not a service name's — which is exactly what a Workers project needs, because the worker *is* the
app.

**A static app is not a server.** No port, no process, no health check, no idle cost. Building it
is a discrete event with an exit code; serving it is a file read.

Fold them together and every piece of code that touches a runtime has to ask "but which sort is
this one really?" — precisely the branching that three explicit kinds make visible in one place.

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

## Related

- [sandboxr.yaml, field by field](sandboxr-yaml.md)
- [The edit–reload loop](../guides/edit-and-reload.md)
- [Two worked examples](examples.md)
