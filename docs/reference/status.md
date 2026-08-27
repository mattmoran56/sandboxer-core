---
title: What is built
description: What has been run for real, what is written and unproven, and what does not exist at all.
sidebar:
  order: 5
---

sandboxr is early. This page is the honest inventory, so no other page has to carry a disclaimer.

## What has been run end to end

The Workers demo in `examples/demo-worker` has been taken all the way through:

- `sandboxr init` set up the network, built the base image, issued a certificate and started the
  router and the dashboard.
- `sandboxr up` built a project image layer, started a container, created its D1 database, ran the
  project's own migrations, applied fixtures and served a page over HTTPS.
- It was then run **twice at once** from two git worktrees, each with its own database, its own
  hostname and its own container.
- Bidirectional editing was checked: a file changed on the host appeared instantly inside the
  container, and a file written inside the container appeared in `git status` on the host.
- `ls`, `logs`, `config` and `doctor` have all been run for real.
- The dashboard serves, redirects to HTTPS and refuses an unauthenticated request; a browser has
  loaded the login page. That was the server-rendered dashboard this one replaced — see below.

## What is written, tested, and has never been run against a real project

Nothing in this list is expected to be *structurally* wrong. All of it is expected to have at
least one thing wrong in the details.

| Area | What a real run would settle |
|---|---|
| **MySQL, all of it** | Data-directory initialisation, the app user and its grants against a live server, restoring a real dump, and the schema snapshot |
| **Compiled backends** | None has been built or run. The staleness check and the build-failure pause are untested against a real compiler |
| **Bundled front-end builds** | Nothing with a real bundler has been built in a sandbox. The memory refusal and the out-of-memory hint are untested against a real build |
| **Dependency seeding** | The seed from `/opt/deps`, the lockfile-hash mismatch that falls back to a real install, and the workspace bin re-linking |
| **Toolchain resolution** | That a prefix such as `1.26` or `24` picks the release a project meant, on both processor architectures |
| **The service graph under load** | It boots for a two-service plan. Five backends, a dev server and a first-boot restore have not been started together |
| **The dashboard's actions and terminal** | Its security properties are unit-tested. The terminal has not been opened against a real sandbox |
| **The dashboard's browser app** | All of it. `@sandboxr/web` replaced the server-rendered pages wholesale: the sidebar of worktrees and its groupings, the panes, the new-worktree routes, settings, the themes. Its pieces are unit-tested and its API is typed at both ends, but nobody has sat in front of it and taken a project through a day's work |
| **Agent sessions** | The base image's smoke check runs `claude --version` on the same PATH `docker exec` gets, so an image a session could not start in fails the build; the stream parser, the transcript store and the launch arguments are unit-tested; the command that reads a worktree's slash commands has been run against a live sandbox, and the list of built-ins was taken from the `claude` binary in the image and checked against the commands a live session announces on start, rather than written from memory. The shared credential volume has been run end to end on a live sandbox: a server added inside one `docker exec` was still there in the next, and still there after the container was restarted. What a real run would settle: whether a session opened from the dashboard does useful work on a branch, and how much the two known limits — no claude.ai connectors on a setup-token, and no way to answer a permission prompt — cost in practice |
| **`sqlite`** | The `d1` path has run; the plain `sqlite` driver has not |
| **A `private` project** | The forward-auth middleware and the dashboard's `/auth/verify` are both written; the pair has not been exercised together |
| **A sandbox expiring on its own over a full lifetime** | The reaper runs on a real machine on its timer, and `expire` has stopped and restarted a live sandbox against a clock moved forward by hand. Nothing has yet been stopped by the timer arriving on its own, hours later |
| **A full idle period against the router's log** | Last activity is read from the live router and moves when a real request arrives (below). What has not been watched is a sandbox going quiet for a whole ttl and being stopped for it, with no clock moved by hand |
| **`gh` against a private repository** | Pull requests list against a public repo. Cloning and fetching a private one from inside the dashboard container, using the mounted `gh` credentials, has not been done |

## The managed layer, as of this change

The workspace, worktree management, the lifetime and the pull-request listing are new. What has
actually been run, rather than merely written:

- **Run for real:** cloning a repository into the workspace; creating a worktree for a new branch
  off a base, for an existing branch, and for one already checked out elsewhere (which comes back
  detached, with its branch name recovered); find-or-create returning the same worktree twice;
  listing worktrees, branches and projects; `loadConfig` reading a config out of a created
  worktree; keep-alive stamping refusing to apply to a rebuilt sandbox with the same slug.
  Cloning, starting a sandbox from a branch and keeping one alive have all been driven from the
  browser, and the reaper's first pass has been observed in a real container log — but through the
  **server-rendered** dashboard, which the browser app has since replaced. The actions and their
  streams are unchanged; what has not been re-driven is the interface in front of them.
- **Unit-tested only:** the whole `gh` path, which is driven from recorded output rather than the
  real binary, and cloning or fetching a private repository with the mounted credentials.

### The project-level config

A project in the workspace may keep a `sandboxr.yaml` beside its mirror, for every worktree of it
that carries none of its own
([how it works](../guides/managed-sandboxes.md#a-config-for-a-project-that-has-not-committed-one)).

- **Run for real:** against a private monorepo cloned into the workspace with two worktrees, both
  of which had had the same draft config copied into them by hand. Moving the single copy up to the
  project directory and deleting both worktree copies left every worktree resolving the same
  config — with `root` equal to each worktree, never the project directory it read the file from —
  and `sandboxr config` naming the file it used and warning that neither worktree carries its own.
  No sandbox has yet been *started* from a project-level config: that project needs a database seed
  and credentials that are not settled.
- **Unit-tested only:** a worktree's own config winning over the project-level one, the error when
  the project-level file is the malformed one, the refusal to run a config whose root would be the
  workspace project directory, and that a repository outside the workspace is unaffected.

### Building an image from the dashboard

Every Dockerfile sandboxr ships switches on the processor architecture, and `TARGETARCH` — the
variable those switches read — is set by BuildKit and by nothing else. The dashboard's image carries
the Docker client without buildx, so its builds run on the legacy builder, which sets no such
variable ([the symptom, and why it does not look like this](../troubleshooting.md#an-image-build-fails-and-the-first-line-is-a-deprecation-notice)).

- **Run for real, on the legacy builder inside the dashboard's own container:** the old form
  reproduced the failure (`TARGETARCH: unbound variable`, exit 1). The new form built a project
  layer with a Go 1.25 and a Node 24 toolchain on it *with no architecture argument at all*,
  resolving `x86_64` from `uname -m`, and the resulting image reported `go version go1.25.14
  linux/amd64` and `v24.20.0`. The same layer was then built again with `--build-arg TARGETARCH`,
  which is what core now passes, and the trace shows the argument winning over `uname`.
- **Not fixed by this, and confirmed by the same experiment:** a project whose layer contains a
  cache mount — one is generated for a Go module warm-up and one for a dependency install — still
  cannot be built by the legacy builder, which stops at `the --mount option requires BuildKit`. So
  the architecture is no longer what fails; the cache mounts are. Building that project's image once
  from the host, where buildx is installed, is enough, because the tag is content-addressed and the
  dashboard reuses it.

### The idle clock, and what has actually been run

Expiry measures **idleness** rather than uptime, from the shared router's access log. That signal is
new, so here is precisely what has been done with it on a real machine:

- **Run for real:** the parse against a live `docker logs sandboxr-router`, which reports one
  last-activity time per sandbox and none for the dashboard or for an unrouted 404. A single `curl`
  at one sandbox moved *that* sandbox's time to the second the request arrived and left the other
  sandbox's untouched, over a period in which the dashboard was up and health-probing both.
  `sandboxr expire --dry-run` then reported `1h 59m left, idle 21s` for the one that had been
  visited and `3h 25m left, idle 34m` for the one that had not. `keep` / `unkeep` were driven end to
  end, and the ttl precedence chain was exercised against a real `config.yaml`.
- **Unit-tested only:** a router that is not running (which must yield *no* activity times rather
  than "nobody used anything"), clock skew in a log line, and a request path crafted to look like a
  router name.

The parse is anchored on the format Traefik writes today. If a future Traefik changed it, every
sandbox would fall back to its start time — the old behaviour — rather than being expired wrongly.

Two limits worth stating plainly rather than discovering later:

**Expiry only ever stops a sandbox; it never removes one.** That reclaims memory and CPU and does
nothing about disk — the container and its volumes remain, so a machine left alone still
accumulates. `gc` is what reclaims disk, and it is still manual. Automating it means destroying
databases automatically, which is not a thing to switch on untested.

**Nothing enforces a lifetime while the dashboard is not running.** The reaper lives in the
dashboard process, which is the only always-on component holding the Docker socket. On a laptop
whose dashboard is usually stopped, sandboxes live until something stops them. `SANDBOXR_REAP_MINUTES=0`
is the honest way to say so.

### git and `gh` in a sandbox

Both were run against a real sandbox rather than reasoned about, because the bug being fixed was
invisible from the host.

- **Run for real:** `git status`, `git log -1`, `git diff --cached` and a genuine `git commit` in a
  restarted `demo` sandbox, the commit carrying the host's name and address; the commit was then
  reset and the host's checkout confirmed to agree. `gh --version` and `gh auth status` reported an
  authenticated account, and `git credential fill` plus an https `ls-remote` proved git's own
  credential path end to end.
- **Not run:** an actual `git push` and an actual `gh pr create`. Both were deliberately left
  undone rather than tested against a real repository, so the last inch — a branch really arriving
  on a remote from inside a container — is unproven.
- **Not run:** any of this on a Linux host. The `safe.directory` line in the base image exists for
  exactly that case (on Docker Desktop's macOS VM the mounted files already appear as root, so it
  does nothing there), and it has been reasoned about, not exercised.
- **Unit-tested only:** `gitMounts`'s four cases, the machine-config precedence for `github`, and
  the mounts and variables `runArgs` produces.

Worth knowing: before this, **no git command worked in any sandbox** — a linked worktree's `.git`
names its repository by absolute path, and only the worktree was mounted. Agent sessions had been
allowlisted for `git status`, `git diff`, `git add` and `git commit` the whole time.

### Fixed after running it against a real project

- **A named sandbox no longer needs `--worktree`.** `status`, `logs`, `shell` and `reload` take the
  worktree from the sandbox's own label when a slug names exactly one, so they work from any
  directory. Verified by running `sandboxr status <slug>` from an unrelated directory. Not
  unit-tested: resolving it reads the container list, and `docker` is a module singleton the CLI
  tests deliberately do not reach.
- **The server's typecheck now covers its tests and fakes.** `tsconfig.check.json` inherited
  `exclude` through `extends`, so `fakes.test-utils.ts` — which implements `CoreApi` — was never
  checked against it. A fake missing a newly added method compiled cleanly and failed only when
  vitest ran it, which is exactly how it went wrong here. Closing the gap surfaced six real type
  errors, including a `testConfig` that had never gained three fields added to `ServerConfig`.

## What does not exist at all

**`db diff` and `db reset`.** The driver interface has `snapshot` but nothing that compares two,
and no verb that returns a database to a clean restore. Comparing before and after is two snapshots
and `diff`; starting clean is `down` then `up`. The container's own `db.sh` exposes a `diff` verb
the CLI does not.

**Remote deployment.** No code requests a certificate over ACME, writes a DNS record, or installs a
service unit. mkcert is the only certificate issuer. [Running on a server](../running-on-a-server.md)
is a plan with the arithmetic worked out, not instructions.

**A supervised coding-agent service.** No `sandboxr.yaml` block declares an agent and nothing in a
sandbox's service tree runs one. What does exist is `claude` in the base image and a dashboard
session that starts it with `docker exec` — see [agent sessions](../guides/agent-sessions.md), and
the row for it in the table above. [Agents in a sandbox](../guides/agents-in-a-sandbox.md) describes
the other arrangement, running your own agent against the bind mount, which is a way of working
rather than a feature.

**Continuous integration.** Nothing runs the tests, the shell linting or the docs build
automatically.

**A `lint` script.** The root `npm run lint` fans out to the workspaces and no package defines one,
so it is currently a no-op.

## Where the pieces stand

| Part | State |
|---|---|
| `docs/architecture/contracts.md` | **Settled.** The authority. A package that disagrees with it is a bug |
| `packages/core` | Written and unit-tested. Run end to end once, against the Workers demo |
| `packages/cli` | Written and unit-tested. `init`, `up`, `ls`, `logs`, `config`, `doctor` run for real |
| `packages/server` | Written and unit-tested, including every security property. Partly run |
| `container/` | Written; `bash -n` and `shellcheck -x -S warning` clean. The base image, the D1 path and the generated router have been exercised |
| `packages/docs` | This site |

Also exercised, against the base image and hand-written plans: both example plans generate a
service tree and a router config; a built app serves, a deep path falls back to `index.html`, an
unbuilt app answers 503 with instructions, `/__sandboxr/live` answers on any hostname, and an
unknown host answers 404 naming the host it was asked for; the database-init → migrate → status
chain produces the right verdict for each outcome, including a command that exits zero while
printing its own failure summary; and the project image template renders lint-clean for three block
combinations.

## Gaps still open in the contract

Recorded here rather than papered over. Each is a documentation bug worth fixing in
[`docs/architecture/contracts.md`](../architecture/contracts.md).

1. **§5's YAML example does not parse.** `backends:` is shown as a block sequence with a `defaults:`
   mapping key as a sibling of the list items, which is invalid YAML. The schema accepts the mapping
   form the real examples use (`backends: { defaults, services }`) *and* a bare list, so this is an
   error in the contract's prose only. These docs follow the schema.
2. **No CLI surface is pinned.** §3.4 names `ls` and `gc`; §8 says the dashboard's actions are a
   closed table but does not enumerate it. The CLI is now much larger than either, and nothing
   prevents it drifting.
3. **`env:` and `deps:` are in the schema and not in the contract.** Both are load-bearing — `env`
   is the only thing joining the sandbox's computed addresses to the project's own variable names —
   and §5 does not mention either.
4. **Seed precedence is decided in code, not in the contract.** `local`, then `file`, then
   `fixtures`, filtered by what the access rules permit. §5 lists the sources without saying which
   wins.
5. **The access layer is not in the contract.** The shared router, its label scheme, the
   per-sandbox certificate and the `init` / `teardown` verbs are all implemented in
   `packages/core/src/access` and unnamed in the contract.
6. **The forge is not in the contract.** Pull-request listing shells out to `gh`, and §5 and §6
   name every other external the tool depends on. Which forge is supported, and what a machine
   without one is expected to do, belong there — gap 2 above (no pinned CLI surface) covers the
   new `project` and `worktree` verbs but not this.
