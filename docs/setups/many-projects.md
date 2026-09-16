---
title: Several repositories at once
description: Letting sandboxr keep the repositories — the managed workspace, the project and worktree commands, and how hostnames work with more than one project.
---

Everything so far assumed you already had a checkout and were standing in it. This page is the other
arrangement: **sandboxr keeps the repositories itself**, and starting a sandbox is picking a project
and a branch. It is what you want when there is more than one repository on the machine, or when the
person starting a sandbox is not going to open a terminal at all.

```prompt
Put a repository into sandboxr's managed workspace and start a sandbox for one of its branches.

Read docs/setups/many-projects.md first. Run `sandboxr project available` to see what this
machine's gh can offer, clone the one I name, then `sandboxr worktree add`, then
`sandboxr up --project <name> --branch <branch>`. Show me the URLs at the end.

Stop and ask me which repository if the list has more than one plausible match. Stop and tell me
if `gh` is not installed or not logged in — you will need a clone URL from me instead. Stop if
the branch has no sandboxr.yaml, and tell me so before you start writing one.
```

## The workspace

One directory holds every project this machine can start a sandbox for:

```
~/.sandboxr/workspace/
  acme/
    repo.git/            a bare clone of acme
    wt/staging/          one worktree per branch, all peers
    wt/tkt-4821/
  demo/
    sandboxr.yaml        optional — see "a project that has not committed its config"
    repo.git/
    wt/main/
```

Default `~/.sandboxr/workspace`. `SANDBOXR_WORKSPACE` moves it, and it has its own variable because
the repositories are the one part of sandboxr's tree worth putting on a different disk.

**A project is a directory containing `repo.git`.** There is no list of projects anywhere. Adding one
is cloning it; removing one is deleting the directory. That is the same reasoning as
[state living in labels](../architecture/state.md): a listing that is a function of something already
on disk cannot go stale.

The clone is **bare**, and every checkout under `wt/` is a peer worktree. There is no primary working
copy to leave dirty, and no branch is blocked because a main checkout has it open.

The directory under `wt/` is named after the branch, put through the same cleaning a slug gets — so
branch `feat/tkt-4821` lives in `wt/feat-tkt-4821`. That is deliberate: one branch has one name in
the directory, the container and the hostname.

> [!NOTE] Bare, and never `--mirror`
> A mirror clone fetches `+refs/*:refs/*`, so every fetch force-updates `refs/heads/*` to match the
> remote — and that is exactly where worktree branches live. A routine `fetch` would reset a branch
> somebody was working on and discard their commits. sandboxr clones `--bare` and sets the ordinary
> remote-tracking refspec by hand, so a fetch can never touch local work.

## Adding a project

If the machine has [`gh`](https://cli.github.com) logged in, you can pick from a list rather than
going to find a URL:

```bash
sandboxr project available
```

```
REPOSITORY         VISIBILITY  UPDATED     STATUS
acme/acme          private     2026-08-26  added
acme/api           private     2026-08-25  -
demo/site*         public      2026-02-11  -

* a fork
```

Most recently updated first, because the repository you want is nearly always one you have touched
recently. `added` means a project in the workspace was already cloned from it.

Then clone it:

```bash
sandboxr project clone git@github.com:acme/api.git
sandboxr project clone https://github.com/acme/api --name acme-api   # a different local name
sandboxr project ls
sandboxr project fetch acme-api
sandboxr project prs acme-api
```

A machine with no `gh`, or one that is not logged in, gets an empty list and is told which of those
it is. `project clone <url>` still works, and nothing else on the machine is affected.

## Cutting a worktree

```bash
sandboxr worktree ls acme
sandboxr worktree add acme tkt-4821
sandboxr worktree add acme tkt-5000 --base staging   # create the branch too
sandboxr worktree name acme tkt-4821 "the checkout flow rewrite"
sandboxr worktree rm acme tkt-4821          # the directory only
sandboxr worktree delete acme tkt-4821      # its sandbox first, then the directory
```

`worktree add` finds or creates: asking twice for the same branch gives you the same worktree, not a
second one beside it. It handles four cases without you choosing between them — a branch that exists
locally, one that exists only on the remote, one you are creating from a base, and one that is
already checked out somewhere else.

That last case is the interesting one. Git refuses to check a branch out twice, so sandboxr adds the
worktree **detached** and recovers the branch name from the commit. `worktree ls` marks it with a
`~`. The sandbox is still labelled with the branch and still answers on the hostname you expect.

`worktree rm` refuses a worktree with uncommitted work in it unless you pass `--force`. It removes
the directory and nothing else, so a sandbox running on that worktree is left behind for `gc`.

`worktree delete` is the one you usually want when you are finished with a branch: it tears the
sandbox down **first** — the container, its database, its uploads and the files on the host named
after it — and then removes the directory. The order is forced, because everything a sandbox owns is
named after the worktree it was cut from. It refuses, having removed nothing, when the worktree has
uncommitted changes or commits that are on no remote, and names them; `--force` overrides it. Where
two worktrees still answer to one slug — which a worktree cut before `worktree add` began guarding
against it can — deleting either **keeps** that sandbox and tells you which worktree is still using
it.

`worktree name` is the one that costs nothing. Ticket ids make good addresses and poor labels, so you
can call a worktree what the work actually is and see that in the listing instead. **Nothing else
changes**: the slug, the hostname, the container name and every URL still come from the branch and
the directory, and the command prints the slug alongside so you can see it did not move. An empty
name (`""`) hands the worktree back to its branch.

## Starting a sandbox from a branch

One command covers every case, because they differ only in what you pass:

```bash
# A branch that exists, locally or on the remote
sandboxr up --project acme --branch tkt-4821

# A new branch, cut from staging
sandboxr up --project acme --branch tkt-5000 --base staging

# A pull request: look up its head branch, then use exactly the first line
sandboxr project prs acme
```

With `--project` you do not have to be anywhere in particular. There is no worktree to be standing
in, so the current directory is not consulted at all. The worktree is created if it is missing and
reused if it is not.

From the dashboard, the same thing is a button: open the project and press **Start** beside the
branch, the worktree or the open pull request you want. See
[The dashboard](../guides/dashboard.md).

## `--project` on the other commands

Once there is more than one project, a slug is no longer unique on its own. Two projects can each
have a `tkt-4821`. `--project NAME` is how you say which:

| Command | What `--project` does |
|---|---|
| `up --project NAME --branch B` | Finds or cuts the worktree in that project. Required for this form |
| `ls --project NAME` | Lists only that project's sandboxes |
| `stop`, `start`, `keep`, `unkeep` | Picks which project's sandbox of that slug |
| `expire --project NAME` | Only that project's sandboxes are considered |
| `status`, `logs`, `shell`, `reload`, `db` | Narrows the search when a slug matches in two projects |
| `project`, `worktree` | Take the project name as an ordinary argument, not a flag |

`down` takes no `--project`; it resolves from the config in the current directory or from
`--worktree`.

## Hostnames with two projects

The hostname shape does not change. There is simply a project label in it, and now it varies:

```
https://tkt-4821--app--acme.sbx.localhost      acme's checkout branch
https://tkt-4821--api--acme.sbx.localhost      the same sandbox's api
https://main--app--demo.sbx.localhost          a different project entirely
https://sbx.localhost                        the dashboard, for all of them
```

[How it works](../how-it-works.md) introduces the shape. Two things about the project part matter
here:

- **It comes from the `project:` field in that repository's `sandboxr.yaml`, not from the workspace
  directory name.** The two need not match, and nothing forces them to. If you clone with
  `--name acme-api` but the config says `project: api`, the hostnames say `api`.
- **A label must be unique within a project**, since the label is what distinguishes two apps of one
  sandbox. Two different projects may both have an `app`. See
  [The rules a config must obey](../configuration/rules.md).

## A project that has not committed its config

A project describes itself in a `sandboxr.yaml` at its own root, versioned with its code. That is
where it belongs, and it is the rule everywhere else in these docs.

There is one exception, for one situation. Getting a config right takes a first draft, and a draft
gets written by hand in one worktree before anybody is ready to commit it. **A worktree is a separate
checkout, so that draft exists in that worktree and nowhere else.** The next branch you open has no
config at all.

So a project in the workspace may keep a config beside its mirror, and every worktree of it that has
none of its own uses that one:

```bash
mv ~/.sandboxr/workspace/demo/wt/main/sandboxr.yaml ~/.sandboxr/workspace/demo/sandboxr.yaml
```

Three things to know, and all three are load-bearing:

- **A worktree's own config always wins.** The project-level file is a fallback, never an override.
  The day the config is committed to the repository, every worktree that has it starts using its own
  and branches without it still fall back — so the changeover needs no flag day.
- **The worktree is still what runs.** The file is read for its contents only. `/workspace` is the
  branch's own checkout, and every path in the config resolves inside it. The project directory
  itself is never mounted — it holds `repo.git` and every sibling worktree — and a config whose root
  would be that directory is refused outright.
- **`sandboxr config` says so**, printing the file it used, the root it resolved to, and a warning
  that this worktree has none of its own.

Treat it as a stopgap with a clear end. It exists so a project can be tried before its config is
agreed, not so a config can live permanently outside the code it describes.

> [!NOTE] Some of this layer is newer than the rest
> The workspace, the worktree commands and the pull-request listing have been driven for real —
> cloning, cutting worktrees, listing, and starting a sandbox from a branch. The `gh` path is
> exercised from recorded output rather than the live binary, no sandbox has yet been *started* from
> a project-level config, and cloning a private repository from inside the dashboard's container has
> not been done. [What is built](../reference/status.md) is precise about each one.

<details class="agent">
<summary><b>Details for an agent</b> — every verb, every flag, every path</summary>

**Paths.** `SANDBOXR_WORKSPACE`, default `$SANDBOXR_HOME/workspace`, which is itself
`~/.sandboxr/workspace`.

```
<workspace>/<project>/sandboxr.yaml    optional project-level config
<workspace>/<project>/repo.git/        the bare clone — its presence is what makes this a project
<workspace>/<project>/wt/<slug>/       one worktree per branch, <slug> = sanitised branch name
```

**Project verbs:**

| Command | Flags | Notes |
|---|---|---|
| `project ls` | — | A `readdir` of the workspace, sorted by name. Skips any directory without a `repo.git`. Columns: name, base, origin |
| `project available` | — | `gh` listing of the account's repositories, newest-updated first, capped at **200** with a line saying so when it truncates. `added` is matched on repository identity, not URL string, so an ssh clone is recognised in an https listing |
| `project clone <url>` | `--name NAME` | `git clone --bare`, then `remote.origin.fetch` set to `+refs/heads/*:refs/remotes/origin/*`, then one `fetch`. Refuses an existing directory. A failed clone removes the whole project directory |
| `project fetch <name>` | — | `git fetch origin`. Safe at any time — it touches `refs/remotes/origin/*` only |
| `project prs <name>` | — | Open pull requests via `gh`, capped at **50**. Draft ones marked `*` |

A URL beginning with `-` is refused: `git clone --upload-pack=<cmd>` would execute `<cmd>`. A project
name containing `/`, `\`, `..` or equal to `.` is refused, because the name is joined onto the
workspace path and handed to `rm` on a failed clone.

**Worktree verbs:**

| Command | Flags | Notes |
|---|---|---|
| `worktree ls <project>` | — | Branch, short head, path. `~` marks detached; `(GONE)` marks an entry git still lists whose directory is not on disk |
| `worktree add <project> <branch>` | `--base REF` | Find-or-create. Refuses a branch name starting with `-` or containing `..` |
| `worktree rm <project> <branch>` | `--force` | Maps branch to path through the listing, then `worktree remove` followed by `worktree prune`. The disk decides success, not the exit code |
| `worktree delete <project> <branch>` | `--force` | `down` on the sandbox, then `worktree rm`, then the display name. Refuses on uncommitted changes or commits on no remote; keeps a sandbox another worktree resolves to |
| `worktree name <project> <branch> <name>` | — | Writes `~/.sandboxr/state/name/<project>/<slug>`. Bounded at 60 characters, no line breaks; `""` removes it. Touches no identifier |

`worktree add` picks its git invocation like this:

| Where the branch is | What runs |
|---|---|
| a base was given | `worktree add -b <branch> <path> <base>` |
| local, checked out nowhere | `worktree add <path> <branch>` |
| local, checked out somewhere else | `worktree add --detach <path> refs/heads/<branch>` |
| only on the remote | `worktree add -b <branch> <path> origin/<branch>` |
| nowhere | refused: *does not exist locally or on origin — pass a base to create it* |

**What a worktree reports**, and what it says when a field cannot be read:

| Field | Meaning | Unreadable |
|---|---|---|
| `path` | Absolute path to the top | — |
| `branch` | Branch name, never git's literal `HEAD` | `?` |
| `head` | Short commit sha | `?` |
| `detached` | Checked out detached | — |
| `exists` | Whether the directory is really on disk | — |
| `committed` | ISO 8601 of the HEAD commit | `""` |
| `created` | ISO 8601 of the directory's birth time | `""` |

`committed` and `created` answer different questions and must not be blurred into "last touched". A
worktree cut this morning off a branch nobody has touched since March is new by one and old by the
other. Both are `""` rather than a substituted value when unreadable, because a fabricated date sorts
a worktree somewhere it does not belong.

**Config resolution in a managed worktree.** The walk up from the starting directory stops at the top
of the worktree; the project-level file is the only sanctioned way to reach outside it. When it is
used, `ResolvedConfig.file` and `ResolvedConfig.root` name different trees — the one place that
happens — and `origin` is `project` rather than `repo`. `sandboxr config` prints all three.

**The dashboard.** It has the workspace bind-mounted read-write at the identical path inside and out,
which is what lets it clone and cut worktrees. Its project list is the workspace **unioned** with
projects that have running containers, never filtered by the workspace — a sandbox whose project is
not in the workspace must still appear.

</details>

<details class="failure">
<summary><b>If it goes wrong</b> — the five refusals you will actually hit</summary>

**`no project called X in the workspace`.** The directory has no `repo.git`, or the name is spelled
differently. `sandboxr project ls`.

**`project "X" already exists at …`.** Cloning over an existing directory is refused rather than
reused, because that directory may hold worktrees with uncommitted work in them. Delete it yourself
or clone under `--name`.

**`branch "X" does not exist locally or on origin — pass a base to create it`.** Either
`sandboxr project fetch <name>` first, or `worktree add … --base origin/main`.

**A config whose root would be the workspace project directory is refused.** That directory holds
`repo.git` and every sibling worktree, so mounting it as `/workspace` would put all of them inside
the sandbox and resolve every declared path one directory too high. Run from a worktree.

**An empty `project available` or `project prs`.** Four different causes, and the command tells you
which: no `gh` on the machine, `gh` not logged in, an origin that is not GitHub, or genuinely nothing
open. None of them is an error, and nothing else stops working.

</details>

**Next:** [Projects, worktrees and lifetimes](../guides/managed-sandboxes.md) for lifetimes and
keep-alive in depth, or [The dashboard on my laptop](dashboard-on-a-laptop.md) if you want all of
this as buttons rather than commands.
