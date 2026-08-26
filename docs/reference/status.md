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
  loaded the login page.

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
| **The dashboard's actions and terminal** | Its security properties are unit-tested. No action has been driven from a browser against a real sandbox, and the terminal has not been opened in one |
| **`sqlite`** | The `d1` path has run; the plain `sqlite` driver has not |
| **A `private` project** | The forward-auth middleware and the dashboard's `/auth/verify` are both written; the pair has not been exercised together |
| **A sandbox expiring on its own over a full lifetime** | The reaper runs on a real machine on its timer, and `expire` has stopped and restarted a live sandbox against a clock moved forward by hand. Nothing has yet been stopped by the timer arriving on its own, hours later |
| **`gh` against a private repository** | Pull requests list against a public repo. Cloning and fetching a private one from inside the dashboard container, using the mounted `gh` credentials, has not been done |

## The managed layer, as of this change

The workspace, worktree management, the lifetime and the pull-request listing are new. What has
actually been run, rather than merely written:

- **Run for real:** cloning a repository into the workspace; creating a worktree for a new branch
  off a base, for an existing branch, and for one already checked out elsewhere (which comes back
  detached, with its branch name recovered); find-or-create returning the same worktree twice;
  listing worktrees, branches and projects; `loadConfig` reading a config out of a created
  worktree; pin stamping refusing to apply to a rebuilt sandbox with the same slug.
  Cloning, starting a sandbox from a branch and pinning have all been driven from the browser
  through the dashboard, and the reaper's first pass has been observed in a real container log.
- **Unit-tested only:** the whole `gh` path, which is driven from recorded output rather than the
  real binary, and cloning or fetching a private repository with the mounted credentials.

Two limits worth stating plainly rather than discovering later:

**Expiry only ever stops a sandbox; it never removes one.** That reclaims memory and CPU and does
nothing about disk — the container and its volumes remain, so a machine left alone still
accumulates. `gc` is what reclaims disk, and it is still manual. Automating it means destroying
databases automatically, which is not a thing to switch on untested.

**Nothing enforces a lifetime while the dashboard is not running.** The reaper lives in the
dashboard process, which is the only always-on component holding the Docker socket. On a laptop
whose dashboard is usually stopped, sandboxes live until something stops them. `SANDBOXR_REAP_MINUTES=0`
is the honest way to say so.

## What does not exist at all

**`db diff` and `db reset`.** The driver interface has `snapshot` but nothing that compares two,
and no verb that returns a database to a clean restore. Comparing before and after is two snapshots
and `diff`; starting clean is `down` then `up`. The container's own `db.sh` exposes a `diff` verb
the CLI does not.

**Remote deployment.** No code requests a certificate over ACME, writes a DNS record, or installs a
service unit. mkcert is the only certificate issuer. [Running on a server](../running-on-a-server.md)
is a plan with the arithmetic worked out, not instructions.

**A coding-agent service.** sandboxr does not install, declare or supervise a coding agent inside a
sandbox. [That page](../guides/agents-in-a-sandbox.md) describes running your own agent against the
bind mount, which is a way of working rather than a feature.

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
