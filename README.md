# sandboxr

Turn a git worktree into a running copy of a whole project, on its own hostname. One
container per branch, with its own database, its own file storage and its own copy of every
service, reachable in a browser at `https://<branch>--<app>--<project>.sbx.localhost`.

**This is a command-line tool and it has no dashboard.** Everything below happens in a
terminal.

## What you need

| | Why | How to check |
|---|---|---|
| **Docker** | A sandbox is a container. Docker Desktop, OrbStack and Colima all work | `docker info` |
| **Node 22 or newer** | sandboxr is TypeScript | `node --version` |
| **git** | Sandboxes are built from git worktrees, and their names come from branches | `git --version` |
| **mkcert** *(optional)* | HTTPS instead of HTTP. Everything works without it | `mkcert -version` |

Give Docker at least 8 GB of memory and 40 GB of disk. Below that you will spend your time
having things killed for memory, and the thing the kernel picks may not be the sandbox.

## Install it

There is no published npm package, so you install from a checkout. Leave the checkout where
it is: sandboxr reads the Dockerfiles and the in-container scripts out of that directory
every time it builds an image.

```bash
git clone https://github.com/mattmoran56/sandboxer-core
cd sandboxer-core
npm install
npm run build
npm link --workspace @sandboxr/cli
```

`sandboxr version` should now answer.

## Set the machine up

```bash
sandboxr init
```

Run that once per machine. It creates `~/.sandboxr` and the shared Docker network, then
builds the base image every sandbox runs from. It issues a certificate when mkcert's root is
already trusted, and starts the shared Traefik router on `127.0.0.1:80` and `:443`. The
first run is slow, and that is Docker building the image.

`init` is idempotent. Run it again to change the domain, to pick up HTTPS after installing
mkcert, or to move the router with `--bind`, `--http-port` and `--https-port`.

The default domain is `sbx.localhost`. Every current browser, and macOS's own resolver,
answer any name ending in `.localhost` with the loopback address. So there is no DNS step
and nothing that needs an administrator password.

## Describe your project

A project says what it is in a `sandboxr.yaml` at its root. Only `project` and `sandboxr`
are required; everything else names something to run.

```yaml
project: acme
sandboxr: ">=0.1.0"

toolchain:
  node: "22"

deps:
  root: .

frontends:
  apps:
    - label: app
      package: .
      serve: npm run dev -- --port 5173 --host 127.0.0.1
      port: 5173
      health: /
```

`examples/` holds three fuller ones. `examples/demo-worker` is the only project proven end
to end, and its config is small enough to read line by line.

## Bring a branch up

```bash
cd ~/acme
git worktree add .worktrees/tkt-4821 -b tkt-4821
cd .worktrees/tkt-4821
sandboxr up
```

`up` prints one URL per app. Inside the container, `/workspace` *is* that worktree: edit a
file on either side and it changes on both, with no sync step and no watcher.

```bash
sandboxr ls        # every sandbox: state, ttl, branch, worktree
sandboxr status    # one in detail, with its URLs
sandboxr logs -f   # its log stream
sandboxr shell     # a shell inside it, starting in /workspace
sandboxr down      # remove it, its database and its uploads. Never your worktree
sandboxr doctor    # what is missing on this machine, and the command that fixes it
```

`sandboxr help` lists the rest: projects, worktrees, database and secrets.

## The documentation

[`docs/index.md`](docs/index.md) is the way in. The pages are plain Markdown, so they read
here on GitHub without a build, and `npm run docs:dev` publishes the same files as a site on
http://localhost:4321.

[`docs/architecture/contracts.md`](docs/architecture/contracts.md) is the single source of
truth for every boundary: naming, paths, the config schema, the driver interface, the plan,
access control. Read it before writing any code. A package that disagrees with it is a bug.
[`CLAUDE.md`](CLAUDE.md) has the working conventions.

## Working on it

```bash
npm test           # every package (vitest)
npm run typecheck
npm run build
npm run docs:dev   # the documentation site on http://localhost:4321/
```

## Licence

MIT.
