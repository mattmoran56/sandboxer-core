---
title: What is built
description: What has been run for real, what is written but unproven, and what does not exist at all.
---

sandboxr is early. This page is the honest inventory of the engine — the CLI, the container layer
and the code underneath them — so no other page has to carry a disclaimer.

Read it before you trust anything. Where a page describes something that has never been run, this is
where it says so.

## What has been run end to end

The Workers demo in `examples/demo-worker` has been taken all the way through.

- `sandboxr init` set up the network, built the base image, issued a certificate, and started the
  router.
- `sandboxr up` built a project image layer, started a container, created its D1 database, ran the
  project's own migrations, applied fixtures, and served a page over HTTPS.
- It was then run **twice at once**, from two git worktrees. Each had its own database, its own
  hostname and its own container.
- Bidirectional editing was checked. A file changed on the host appeared instantly inside the
  container. A file written inside the container appeared in `git status` on the host.
- `ls`, `logs`, `config` and `doctor` have all been run for real.
- **The mounted secrets file has been run end to end on a live sandbox.** A credential in
  `~/.sandboxr/secrets/<project>.env` reached a running application process, did not appear in
  `docker inspect`, and a changed value was picked up by a restart.

That is the only path proven end to end for a *project*.
[Run the demo project](../getting-started/demo-project.md) walks it, which makes it the honest
"does my machine work" check.

## What is written and tested, and has never been run against a real project

Nothing in this list is expected to be *structurally* wrong. All of it is expected to have at least
one thing wrong in the details.

| Area | What a real run would settle |
|---|---|
| **MySQL, all of it** | Data-directory initialisation, the app user and its grants against a live server, restoring a real dump, and the schema snapshot |
| **Compiled backends** | None has been built or run. The staleness check and the build-failure pause are untested against a real compiler |
| **Bundled front-end builds** | Nothing with a real bundler has been built in a sandbox. The memory refusal and the out-of-memory hint are untested against a real build |
| **Dependency seeding** | The seed from `/opt/deps`, the lockfile-hash mismatch that falls back to a real install, and the workspace bin re-linking |
| **Toolchain resolution** | That a prefix such as `1.26` or `24` picks the release a project meant, on both processor architectures |
| **The service graph under load** | It boots for a two-service plan. Five backends, a dev server and a first-boot restore have not been started together |
| **`sqlite`** | The `d1` path has run. The plain `sqlite` driver has not |
| **A sandbox expiring on its own over a full lifetime** | See below |
| **Removing an image** — `sandboxr prune --yes`, and the same images under `sandboxr gc` | See below |
| **`gh` against a private repository** | Pull requests list against a public repo. Cloning and fetching a private one from inside the dashboard container, using the mounted `gh` credentials, has not been done |

### Removing an image: `sandboxr prune --yes` and `sandboxr gc`

`prune`'s report has been run against a live daemon with two projects and 440 build cache records on
it, and its figures match `docker system df`.

**No image has been removed by either command.** `gc` now takes the same superseded project images
`prune` offers, and the decision — which image is replaced, which is protected, which is still held
by a container — is unit-tested against a fake daemon in both. What a real run would settle is that
`docker image rm` accepts the references the plan builds, and that the space the report promised is
the space that comes back.

The removals are deliberately separable: `gc` asks `docker system df` in a `try`, so a daemon that
will not answer costs the image reaping and not the sandbox reaping, which has been run for real.

## The project-level config

A project in the workspace may keep a `sandboxr.yaml` beside its mirror, for every worktree of it
that carries none of its own. The workspace itself is §4.1 of
[the contract](../architecture/contracts.md).

**Run for real:** against a private monorepo cloned into the workspace with two worktrees, both of
which had had the same draft config copied into them by hand. Moving the single copy up to the
project directory and deleting both worktree copies left every worktree resolving the same config —
with `root` equal to each worktree, never the project directory it read the file from — and
`sandboxr config` naming the file it used and warning that neither worktree carries its own.

**No sandbox has yet been started from a project-level config.** That project needs a database seed
and credentials that are not settled.

**Unit-tested only:** a worktree's own config winning over the project-level one; the error when the
project-level file is the malformed one; the refusal to run a config whose root would be the
workspace project directory; and that a repository outside the workspace is unaffected.

## The idle clock

Expiry measures **idleness** rather than uptime, from the shared router's access log. That signal is
recent, so here is precisely what has been done with it on a real machine.

<details class="facts">
<summary><b>Fact sheet</b> — the idle clock, run for real and unit-tested only</summary>

**Run for real:**

- The parse against a live `docker logs sandboxr-router`, which reports one last-activity time per
  sandbox and none for the dashboard or for an unrouted 404.
- A single `curl` at one sandbox moved *that* sandbox's time to the second the request arrived, and
  left the other sandbox's untouched — over a period in which the dashboard was up and
  health-probing both.
- `sandboxr expire --dry-run --json` then reported `1h 59m left, idle 21s` for the one that had been
  visited and `3h 25m left, idle 34m` for the one that had not. `--json` is where those two lines
  are: the human dry-run prints only what it would stop, and neither sandbox was due to stop.
- `keep` and `unkeep` were driven end to end, and the ttl precedence chain was exercised against a
  real `config.yaml`.

**Unit-tested only:** a router that is not running, which must yield *no* activity times rather than
"nobody used anything"; clock skew in a log line; and a request path crafted to look like a router
name.

The parse is anchored on the format Traefik writes today. If a future Traefik changed it, every
sandbox would fall back to its start time — the old behaviour — rather than being expired wrongly.

</details>

**A sandbox expiring on its own over a full lifetime has not been watched.** The reaper runs on a
real machine on its timer, and `expire` has stopped and restarted a live sandbox against a clock
moved forward by hand. Nothing has yet been stopped by the timer arriving on its own, hours later.
Nor has a sandbox been watched going quiet for a whole ttl and being stopped for it, with no clock
moved by hand.

Three limits are worth stating plainly rather than discovering later.

**Expiry only ever stops a sandbox; it never removes one.** That reclaims memory and CPU and does
nothing about disk. The container and its volumes remain, so a machine left alone still accumulates.
`gc` and `prune` are what reclaim disk, and both are still manual. Automating `gc` means destroying
databases automatically, which is not a thing to switch on untested. `prune` is the safer of the two
to put on a timer, because everything it removes is rebuildable.

**`prune` has no dashboard action.** `gc` and `expire` are buttons; this is a CLI command only. The
decision lives in core, so a dashboard action is a small addition. It has not been made.

**Nothing enforces a lifetime while the dashboard is not running.** The reaper lives in the dashboard
process, which is the only always-on component holding the Docker socket. On a laptop whose dashboard
is usually stopped, sandboxes live until something stops them. `SANDBOXR_REAP_MINUTES=0` is the
honest way to say so.

## git and `gh` in a sandbox

Both were run against a real sandbox rather than reasoned about, because the bug being fixed was
invisible from the host.

<details class="facts">
<summary><b>Fact sheet</b> — git in a sandbox: run, not run, unit-tested only</summary>

**Run for real:** `git status`, `git log -1`, `git diff --cached` and a genuine `git commit` in a
restarted `demo` sandbox, the commit carrying the host's name and address. The commit was then reset
and the host's checkout confirmed to agree. `gh --version` and `gh auth status` reported an
authenticated account, and `git credential fill` plus an https `ls-remote` proved git's own
credential path end to end.

**Not run:** an actual `git push` and an actual `gh pr create`. Both were deliberately left undone
rather than tested against a real repository, so the last inch — a branch really arriving on a remote
from inside a container — is unproven.

**Not run:** any of this on a Linux host. The `safe.directory` line in the base image exists for
exactly that case — on Docker Desktop's macOS VM the mounted files already appear as root, so it does
nothing there — and it has been reasoned about, not exercised.

**Unit-tested only:** `gitMounts`'s four cases, the machine-config precedence for `github`, and the
mounts and variables `runArgs` produces.

</details>

Worth knowing: before this, **no git command worked in any sandbox**. A linked worktree's `.git`
names its repository by absolute path, and only the worktree was mounted. Agent sessions had been
allowlisted for `git status`, `git diff`, `git add` and `git commit` the whole time.

## Fixed after running it against a real project

**A named sandbox no longer needs `--worktree`.** `status`, `logs`, `shell` and `reload` take the
worktree from the sandbox's own label when a slug names exactly one, so they work from any directory.
Verified by running `sandboxr status <slug>` from an unrelated directory. Not unit-tested: resolving
it reads the container list, and `docker` is a module singleton the CLI tests deliberately do not
reach.

## What does not exist at all

**`db diff` and `db reset`.** The driver interface has `snapshot` but nothing that compares two, and
no verb that returns a database to a clean restore. Comparing before and after is two snapshots and
`diff`; starting clean is `down` then `up`. The container's own `db.sh` exposes a `diff` verb the CLI
does not.

**Remote deployment.** No code requests a certificate over ACME, writes a DNS record, or installs a
service unit. mkcert is the only certificate issuer.
[On a server, for a team](../setups/shared-server.md) is a plan with the arithmetic worked out, not
instructions.

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
| `container/` | Written; `bash -n` and `shellcheck -x -S warning` clean. The base image, the D1 path and the generated router have been exercised |
| `packages/docs` | This site |

<details class="facts">
<summary><b>Fact sheet</b> — what was exercised against the base image and hand-written plans</summary>

- Both example plans generate a service tree and a router config, and both generated Caddyfiles pass
  `caddy validate`.
- A built app serves, a deep path falls back to `index.html`, an unbuilt app answers 503 with
  instructions, `/__sandboxr/live` answers on any hostname, and an unknown host answers 404 naming
  the host it was asked for.
- The database-init → migrate → status chain produces the right verdict for each outcome: no
  migration command gives `ok`/`skipped`; a command that fails gives `degraded`/`failed` with the
  file and error extracted; a command that exits zero while printing its own failure summary gives
  `degraded`, via `failure_pattern`; a clean run gives `ok`.
- `build-static.sh` refuses a declared memory requirement the container cannot meet, and builds and
  swaps in a directory when it can.
- The project image template renders to a lint-clean Dockerfile for three block combinations: Go +
  Node + MySQL, Node + SQLite, and Go alone.
- The base image builds and boots: s6 compiles the generated tree, the ungated services start
  immediately, `db-init` runs the driver dispatch and provisions buckets, an on-demand build lands in
  `/srv/www` and is served through the generated router, and every computed and aliased environment
  variable reaches each supervised service.

</details>

## Gaps still open in the contract

Recorded here rather than papered over. Each is a documentation bug worth fixing in
[the contract itself](../architecture/contracts.md), which lives in the repository and is
deliberately not one of these pages.

1. **§5's YAML example does not parse.** `backends:` is shown as a block sequence with a `defaults:`
   mapping key as a sibling of the list items, which is invalid YAML. The schema accepts the mapping
   form the real examples use (`backends: { defaults, services }`) *and* a bare list, so this is an
   error in the contract's prose only. These docs follow the schema.
2. **No CLI surface is pinned.** §3.4 names `ls` and `gc`; Jef's §6 says the dashboard's actions are
   a closed table but does not enumerate it. The CLI is now much larger than either, and nothing
   prevents it drifting.
3. **`env:` and `deps:` are in the schema and not in the contract.** Both are load-bearing — `env` is
   the only thing joining the sandbox's computed addresses to the project's own variable names — and
   §5 does not mention either.
4. **Seed precedence is decided in code, not in the contract.** `local`, then `file`, then
   `fixtures`, filtered by what the access rules permit. §5 lists the sources without saying which
   wins.
5. **The access layer is not in the contract.** The shared router, its label scheme, the per-sandbox
   certificate and the `init` and `teardown` verbs are all implemented in
   `packages/core/src/access` and unnamed in the contract.
6. **The forge is not in the contract.** Pull-request listing shells out to `gh`, and §5 and §6 name
   every other external the tool depends on. Which forge is supported, and what a machine without one
   is expected to do, belong there. Gap 2 covers the new `project` and `worktree` verbs but not this.
7. **§3.2 and `container/README.md` give the default domain as `sbx.lcl`.** The code says
   `sbx.localhost`, and the code is what runs. These docs follow the code.

---

**Next:** [Run the demo project](../getting-started/demo-project.md) to exercise the one proven path
on your own machine, or [Troubleshooting](../troubleshooting.md) if you have already hit one of the
gaps above.
