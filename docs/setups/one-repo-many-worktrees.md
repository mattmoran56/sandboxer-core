---
title: One repo, many branches
description: The single-repository case in depth — where a sandbox's name comes from, what every sandbox of one project shares, and how many fit on a machine.
---

This is the common case: one repository, several branches you care about at the same time, and one
running copy of the project per branch. This page is about what happens when there are five of them
rather than one — where their names come from, what they share, and where they collide.

```prompt
Start a sandbox for every git worktree in this repository, then show me the URLs.

Read docs/setups/one-repo-many-worktrees.md first. Run `sandboxr up --worktree <path>` for each
worktree, one at a time rather than in parallel, then `sandboxr ls`. Tell me each sandbox's slug
and where it came from.

Stop and tell me if two worktrees would derive the same slug — that would make the second `up`
replace the first sandbox and adopt its database. Stop if Docker has under 8 GB of memory, and
tell me how many sandboxes you think will fit.
```

## The shape of it

You keep your worktrees wherever you already keep them. A common layout:

```
~/code/acme/                     the main checkout
~/code/acme/.worktrees/tkt-4821/
~/code/acme/.worktrees/tkt-4907/
~/code/acme/.worktrees/fix-nav/
```

One `up` per worktree, and each one gets a container, a database, a hostname and a URL of its own:

```bash
for wt in ~/code/acme/.worktrees/*/; do
  sandboxr up --worktree "$wt"
done
sandboxr ls
```

```
PROJECT  SLUG       STATE     TTL   BRANCH             WORKTREE
acme     tkt-4821   running   12h   tkt-4821           /home/dev/code/acme/.worktrees/tkt-4821
acme     tkt-4907   running   12h   tkt-4907*          /home/dev/code/acme/.worktrees/tkt-4907
acme     fix-nav    degraded  12h   fix/nav            /home/dev/code/acme/.worktrees/fix-nav
```

The star means the worktree had uncommitted changes when the sandbox started. `degraded` means the
container is up but something failed on the way — usually a migration.

## Where the name comes from

That `SLUG` column is the name of the sandbox, and it is the first label of its hostname. You never
have to choose it. sandboxr derives it, and the order it tries is fixed:

| It looks for | Example | Result |
|---|---|---|
| 1. A name you passed | `sandboxr up checkout-demo` | `checkout-demo` |
| 2. A slug this worktree was given | see [when two worktrees want the same name](#when-two-worktrees-want-the-same-name) | `tkt-4821-7k2f` |
| 3. A ticket id in the **worktree directory** name | `.worktrees/tkt-4821` | `tkt-4821` |
| 4. A ticket id in the **branch** name | `feat/TKT-4821-rework` | `tkt-4821` |
| 5. The **branch** name | `chore/bump-deps` | `chore-bump-deps` |
| 6. The **worktree directory** name | `.worktrees/spike` | `spike` |

A ticket id is a run of letters, a dash, then digits — `TKT-4821`, `abc-77` — matched anywhere in
the name and in any case. It wins over the rest of the name because that is what makes a slug
readable: `tkt-4821` rather than `feat-tkt-4821-rework-the-checkout-flow`.

If your team spells tickets differently, the pattern is not something you configure in a file today;
pass the name you want instead.

### Then it is cleaned up

Whatever won, the same tidying happens to it. It is lowercased, every character that is not a
letter, a digit or a dash becomes a dash, runs of dashes collapse to one, and dashes at either end
are stripped. So `feat/Nav Overflow!` becomes `feat-nav-overflow`.

The result has to be usable in three places at once: a Docker container name, a hostname label, and
a database identifier. That is where the alphabet comes from.

A name that cleans up to nothing at all is refused with a message saying so.

### And it is capped at 31 characters

A slug may be at most **31 characters**. Over that, sandboxr keeps the first 22 characters and
appends a dash and eight hexadecimal characters of the SHA-256 of the original name:

```
branch   feature/rework-the-entire-checkout-flow-for-real
slug     feature-rework-the-ent-6730174e
```

**It hashes rather than truncating, and that is load-bearing.** The slug ends up inside a database
advisory lock name. MySQL silently truncates lock names past 64 characters, so two names that
truncate to the same thing become one lock. Long branch names very often share a prefix —
`feature/rework-the-entire-…` and `feature/rework-the-shipping-…` are the same for 19 characters —
and a plain truncation would have those two sandboxes fighting over one lock while their migrations
ran. The hash is taken from the raw name, so it differs even when the readable prefix does not.

## When two worktrees want the same name

Two worktrees can derive the same slug. The usual way is two branches that mention the same ticket:
`.worktrees/tkt-4821` and `.worktrees/tkt-4821-retry` both derive `tkt-4821`.

The slug is what names everything, so an identical slug means an identical container name and
identical volume names — one sandbox, shared by two unrelated branches. The second `up` replaces
the first sandbox and mounts the volumes it was using, so the second branch ends up looking at the
first branch's database.

**Which of these happens depends on who cut the worktree.**

When sandboxr cut it — `sandboxr worktree add`, or the dashboard's New worktree — it compares the
slug the new worktree would take against the ones its siblings already answer to, and on a match
gives it one of its own instead:

```
another worktree of acme already answers to "tkt-4821", so this one is "tkt-4821-7k2f"
```

Four random characters on the end, so the name is still readable and still fits the ceiling — the
project's own, which for a long project name and a long label is lower than 31. It is written down,
because random characters cannot be worked out again, and everything from then on — the hostname,
`sandboxr ls`, the dashboard — uses it.

When you cut the worktree yourself, in your own repository, sandboxr never saw it happen and
cannot warn you.

> [!WARNING] A collision between worktrees you cut yourself is not caught
> Nothing refuses it, because from the outside the second `up` looks exactly like restarting a
> sandbox after a config change, which is a thing people do constantly.

The fix is to name one of them yourself:

```bash
sandboxr up tkt-4821-retry --worktree ~/code/acme/.worktrees/tkt-4821-retry
```

`sandboxr ls` is how you spot it: two rows cannot have the same slug, so a slug you expected to see
twice appearing once is the symptom.

Worktrees that already collide are left alone. Renaming one that has a running sandbox would leave
its container and its volumes stranded under the old name, which is worse than the problem — so the
guard applies to worktrees cut from now on, and an existing pair is fixed by naming one.

## What every sandbox of one repo shares

Everything a branch can damage is private. Everything expensive to produce is shared. That is why
the second sandbox of a project starts far faster than the first.

| Shared by every sandbox of this project | Why it is safe to share |
|---|---|
| The **project image layer** | Content-addressed on the toolchain, the rendered Dockerfile and the lockfile. Two branches that changed none of those are asking for the identical image |
| The **dependency volume** | Named after a hash of the lockfile. Branches with matching lockfiles share one install; a branch that changes its dependencies transparently gets its own |
| The **seed cache** | Keyed on the source's content, so a database seed is produced once and every sandbox restores its own copy from it |
| The **git repository** | See below. This is the one that surprises people |
| The base image, the Go caches, the router, the dashboard, the Docker network | Shared by every sandbox on the machine, not just this project's |

| Private to one sandbox | Name |
|---|---|
| Its container | `sandboxr-<project>-<slug>` |
| Its database | `sandboxr-data-<project>-<slug>` |
| Its uploads, built binaries, built sites | `sandboxr-blob-…`, `sandboxr-bin-…`, `sandboxr-www-…` |
| Its hostnames and its TLS certificate | issued when it starts, removed when it goes |
| Its logs | `~/.sandboxr/logs/<project>/<slug>/`, and they outlive the container |
| Its worktree | bind-mounted at `/workspace`, so edits go both ways instantly |

### The git repository is shared, read-write

A git worktree is not self-contained. Its `.git` is a one-line file naming the real repository by
absolute path, and that repository is somewhere else on your disk. So a container holding only the
worktree fails every git command.

sandboxr therefore mounts **both** — the worktree and the repository it points at — at the
**identical path inside and outside** the container, so the absolute path git wrote down still
resolves. The repository mount is read-write, because `git commit` writes objects and refs into it.

Three consequences, and all three are real rather than theoretical:

- **Every sandbox of a project shares one object store and one set of refs with your host.** A
  commit made inside a sandbox is a commit in your repository. `git status` on the host will see it.
- **A sandbox can move a branch.** There is no isolation here. If something inside a sandbox runs
  `git reset --hard` on a branch, that happened to your repository.
- **`git gc` in one sandbox repacks what all of them read.** That is fine, and it is why the base
  image pins `gc.worktreePruneExpire` to `never`: from inside one sandbox every *other* worktree of
  the project looks missing, and `git commit` runs `gc --auto` on its own. Without the pin, one
  sandbox committing would delete your other worktrees' admin entries.

Commits made inside a sandbox carry your name and address, read from the host's `git config`. Your
`~/.gitconfig` itself is deliberately not mounted — it names a credential helper and a signing key
that do not exist in a container, which would break the very operations it was meant to enable.

`git push` and `gh` only work if the machine has opted this project in with `github: token` in
`~/.sandboxr/config.yaml`. That is off by default, and [Access and security](../access.md) explains
what it widens. `up` says so on every start when it is off, and names the key to write — key it on
the project's workspace directory, the name in its dashboard URL, or on the `project:` its
`sandboxr.yaml` declares. A key that is neither matches nothing; `sandboxr doctor` says so.

## How many fit on a machine

Memory is the limit that matters. Each sandbox gets one cap covering everything inside it: the
largest `memory:` any single app in the project declares, with a floor of **4 GB**.

That is a **ceiling, not a reservation**. A sandbox capped at 4 GB using 300 MB is using 300 MB, so
divide the memory Docker actually has by what a sandbox of *your* project really uses:

| Project shape | Roughly, per sandbox, at rest |
|---|---|
| A Worker, or one Node service on a file database | tens of megabytes |
| Several compiled services on a file database | a few hundred megabytes |
| The same, with a MySQL server of its own | add several hundred megabytes, and seconds to start |

The cap only bites at the moment something spikes, which in practice means a large front-end build.
If one app needs more, declare `memory:` on it — and note that this raises the ceiling for the
*whole* sandbox, because the kernel enforces the container total.

Disk grows more quietly and does not come back on its own.
[Giving Docker the whole machine](../guides/docker-capacity.md) has that arithmetic.

## Keeping the set tidy

A worktree you delete leaves its sandbox behind, because a sandbox is a container and nothing told
Docker. `gc` reaps them:

```bash
sandboxr gc --dry-run    # say what would go
sandboxr gc              # do it
```

It removes sandboxes whose recorded worktree is no longer on disk, then any `sandboxr-` volume that
nothing owns and nothing has mounted. Shared and dependency volumes are left alone.

<details class="agent">
<summary><b>Details for an agent</b> — the derivation rules exactly, and every name they produce</summary>

**Resolution** (`slugFor` in `packages/core/src/worktree-slug.ts`), first match wins:

1. `explicit` — the positional argument to `up`, or `--slug`. Trimmed; an empty string does not count.
2. The slug recorded at `$SANDBOXR_HOME/state/slug/<project>/<worktree dir>`, if there is one and
   it reads back as a slug. `<project>` is the workspace *directory* name, and the key is the
   worktree's directory name, never a slug. Only worktrees under `<workspace>/<project>/wt` can
   have one.

Rules 3 to 6 are the **derivation** (`deriveSlug` in `packages/core/src/naming.ts`), which is pure:

3. The first match of `/[a-z]+-[0-9]+/i` in the worktree directory's **basename**.
4. The first match of the same pattern in the branch name.
5. The branch name, unless it is the literal `HEAD` — which is what git reports for a detached
   worktree and names nothing.
6. The worktree directory's basename.

With none of those available it throws `NamingError: cannot derive a slug: no explicit name,
worktree or branch`.

**Every read path calls `slugFor`, not `deriveSlug`** — `up` in `packages/core/src/sandbox/index.ts`,
`worktreeView` in `packages/server/src/core/adapter.ts`, and `target`/`slugOf` in
`packages/cli/src/main.ts`. One of them deriving while another read the record would show one slug
on a page and start a container under a different one.

**The collision check** is in `addWorktree` (`packages/core/src/worktree.ts`), which already has the
project's other worktrees in hand. After the worktree exists on disk it resolves every sibling's
slug, and if the new one's derived slug is among them it calls
`uniqueSlug(base, taken, token, max)` — `<base>-<token>`, `token` being four characters of
`[a-z0-9]` from `node:crypto`, re-rolled if it is taken — and records it. `<base>` is trimmed to
`max - 5`, trailing dashes stripped, so the total stays inside the ceiling. **`max` is the
project's ceiling and not `SLUG_MAX`**: a given slug is five characters longer than the one it
replaces and sits in the same hostname, so sized against a flat 31 a collision would be the one
thing in a budget-bound project that pushes a hostname over 63 characters — which shows up as a
name that does not resolve, not as anything about slugs. `addWorktree` gets that number by loading
the config of the worktree it just cut, falling back to `SLUG_MAX` when there is none to read. A
UUID would blow both budgets and be unreadable. `removeWorktree` deletes the record.

**Sanitising** (`sanitizeSlug`), in order: lowercase; `[^a-z0-9-]+` → `-`; `-+` → `-`; strip leading
and trailing `-`. An empty result throws `NamingError: slug "<raw>" is empty after sanitising`.

**Ceiling:** `min(SLUG_MAX, 63 - len(longest label) - len(project) - 4)`, where `SLUG_MAX = 31`.
Over it: `folded.slice(0, ceiling - 9)` with trailing dashes trimmed, then `-`, then
`sha256(raw).hex.slice(0, 8)`. The hash is of the **raw** input, not the folded form. The
trailing-dash trim exists so the join never produces `--`, which is the separator inside a
flattened hostname.

**Why 31:** `lockName(project, slug)` builds `sandboxr_migrate_<project>_<slug>` and throws if it
exceeds 64 characters, which is where MySQL's `GET_LOCK` silently truncates. Raising `SLUG_MAX`
means re-checking every driver's lock-name budget.

**Why the subtraction:** a sandbox hostname is one DNS label — `<slug>--<label>--<project>` — and a
DNS label stops at 63 characters. It may only *lower* the ceiling: a project whose arithmetic
allows 40 still gets 31, because the lock budget still binds. See contracts §3.1.

**Every name derived from a slug:**

| Thing | Pattern |
|---|---|
| Hostname | `<slug>--<label>--<project>.<domain>` |
| Container | `sandboxr-<project>-<slug>` |
| Volumes | `sandboxr-{data,blob,bin,www}-<project>-<slug>` |
| Dependency volume | `sandboxr-deps-<first 16 hex of sha256 of the lockfile>` |
| Advisory lock | `sandboxr_migrate_<project>_<slug>`, non-alphanumerics folded to `_` |
| Logs | `$SANDBOXR_HOME/logs/<project>/<slug>/` |
| Generated environment | `$SANDBOXR_HOME/build/<project>/<slug>.env` |
| Plan | `$SANDBOXR_HOME/build/<project>/<slug>.plan.json` |
| Keep-alive marker | `$SANDBOXR_HOME/state/keep/<project>/<slug>` |
| Given slug | `$SANDBOXR_HOME/state/slug/<project>/<worktree directory>` — keyed on the directory, not the slug |

`<project>` here is the `project:` field in `sandboxr.yaml`, not a directory name.

**Git mounts** (`gitMounts` in `packages/core/src/git.ts`) returns two paths: the worktree, and the
repository's common dir. It returns **nothing** in three cases:

- A plain checkout, whose `.git` is a directory already inside the mount.
- A repository whose top is not the directory being mounted — a project in a subdirectory of a
  larger repository.
- A common dir that is already inside the worktree.

The second mount of the worktree, alongside `/workspace`, exists so that
`<repo>/worktrees/<name>/gitdir` resolves — without it git marks the worktree `prunable` and a
`gc --auto` would delete the host's admin entry for a live worktree.

**Dirty detection:** `git status --porcelain`, minus paths ending in `.env.local`, which is what a
sandbox's own build generates. Without that exclusion, merely running a sandbox would make its
worktree dirty.

**Detached worktrees:** git refuses to check one branch out twice, so running a branch that is open
in another checkout produces a detached worktree. The branch name is recovered with
`git branch --points-at HEAD`, so the label and the hostname are what you expect. This is the
documented route, not a workaround.

</details>

<details class="failure">
<summary><b>If it goes wrong</b> — four symptoms whose cause is in this page</summary>

**A hostname you did not expect.** Read the derivation order above, top to bottom, and stop at the
first rule that matches. A ticket id in a directory name beats the branch entirely, which is the
step people miss. `sandboxr ls` prints the slug it chose beside the branch it came from.

**A slug ending in eight random-looking characters.** The name was over 31 characters, so it was
hashed. Pass a shorter name explicitly if you want a readable URL.

**Two branches sharing one database.** They derived the same slug, and neither worktree was cut by
sandboxr, so nothing was there to notice. See the collision section above. `sandboxr down` one of
them and bring it back with an explicit name.

**A slug with four extra characters on the end that you did not ask for.** Another worktree of the
project already answered to the slug this one would have taken, so it was given
`<slug>-<4 characters>` when it was cut. `sandboxr worktree add` says so at the time, and the value
is in `$SANDBOXR_HOME/state/slug/<project>/<worktree directory>`.

**`fatal: not a git repository: /Users/…/repo.git/worktrees/x` inside a sandbox.** The repository was
not mounted. Normally that means the project is a subdirectory of a larger repository, which
`gitMounts` deliberately refuses to handle — mounting the enclosing repository would make git report
every file in the project as deleted. A clean failure beats that.

</details>

**Next:** [The edit–reload loop](../guides/edit-and-reload.md) for what to do once several are
running, or [Several repositories at once](many-projects.md) if you would rather sandboxr kept the
repositories for you.
