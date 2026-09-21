---
title: What sandboxr is
description: The problem sandboxr solves, the two things people use it for, and the cases where it is the wrong tool.
---

This page is for deciding whether sandboxr is worth your time. No setup, no commands to run,
one example.

```prompt
Explain sandboxr to me and tell me whether it fits this repository.

Read docs/introduction.md and docs/how-it-works.md. Then look at this repository and tell me
which services and front-ends a sandbox would need to run, and whether it uses a database
sandboxr supports. Stop and say so plainly if you think this project is a poor fit.
```

## The problem

Some changes cannot be reviewed by reading them.

A change that moves a field between two services is one of those. So is one that adds a
database column and then starts using it. You can read the diff and still not know whether the
thing works. To know, somebody has to run it.

Running it is the awkward part. The change lives on a branch. Your machine runs one copy of the
project at a time, pointed at one database. Trying the branch means stopping what you were
doing, switching, migrating the database, and then undoing all of that afterwards. Most people
do it once and not again.

## The idea

**sandboxr turns a git worktree into a running copy of your whole project, on its own
hostname.** One container holds every service, every front-end, its own database and its own
file storage. Several run at once, so two branches can be open in two browser tabs.

A [worktree](reference/glossary.md) is git's own way of having two branches checked out in two
directories at the same time. sandboxr takes one of those directories and starts it.

```bash
cd .worktrees/tkt-4821
sandboxr up
```

A short while later the project is serving at
`https://tkt-4821--app--acme.sbx.localhost`. It has a database of its own, and your branch's
migrations have already run against it. Break it however you like. `sandboxr down` throws away
the container, the database and the uploaded files, and never touches the worktree itself.

That address has a shape, and the shape is the same for every project.
[How it works, in five steps](how-it-works.md) explains it.

The worktree is not copied. It is mounted, live and in both directions. A file you save in your
editor is inside the container immediately, and a file the container writes shows up in your
`git status`.

## The two things people use it for

### One branch, running

The everyday case. You are on a branch and you want to see it working, without disturbing
anything else you have set up.

Everything the project needs comes up together: the API, the front-end, the database with data
already in it, somewhere to put uploaded files. The point is that you did not have to arrange
any of that.

### Every branch at once

The case that makes the tool worth having. Each worktree gets a sandbox of its own, at an
address of its own, and they all run side by side.

That buys you things that were previously not worth the trouble:

- Two versions of a page compared in two tabs, with nothing stashed.
- A risky migration running in one sandbox while the old schema still serves in another.
- Three agents working in three worktrees, each with a URL you can refresh to see what it has
  actually done.

Each sandbox has its own container, its own database and its own file storage. A few things are
shared on purpose, because copying them would be wasteful: the installed dependencies for a
given lockfile, the Go build caches, and the git repository itself.
[Every worktree at once](getting-started/every-worktree.md) says exactly what is shared and
what is not.

<details class="facts">
<summary><b>Fact sheet</b> — what one sandbox contains, and what it costs</summary>

One sandbox is one Docker container, plus a few Docker volumes. Inside it:

| | |
|---|---|
| The code | your worktree, mounted live at `/workspace` |
| The project's services | as declared in its config — an API, a worker, a dev server |
| The project's front-ends | built on demand, served as static files |
| A database | its own, created and migrated at startup: `mysql`, `d1`, `sqlite` or `none` |
| File storage | its own S3-compatible bucket, for uploads |
| A small router | inside the container, deciding which app answers which hostname |

Sandbox containers publish no ports on the host. They join one shared Docker network, and a
single router in front of them handles every hostname.

Give Docker at least 8 GB of memory and 40 GB of disk. Each sandbox costs roughly a database
engine plus whatever the project's own services cost. See
[Giving Docker the whole machine](guides/docker-capacity.md).

</details>

## Who reaches what

There are two halves to that question, and they have different answers.

**The apps** a sandbox serves are public by default. Anyone who can reach the machine sees a
preview of unreleased work. Set `access.apps: private` and every one of that project's hostnames
goes through a check in the shared router first.

**The controls** — start, stop, rebuild, migrate — are the `sandboxr` command, run by whoever is
at the machine. sandboxr serves no controls over http at all.

> [!CAUTION] Anything you put in front of those controls is not negotiable
> The thing that starts and stops containers talks to the Docker socket. A control page reachable
> without a password is not a cosmetic mistake. It is the ability to run anything on the host.
> sandboxr prepares a bare domain and serves nothing on it; whatever you put there is yours to
> authenticate. [Access and security](access.md) is the whole story.

Making a project's apps public brings two refusals with it. The database may not be a copy of
live customer data, unless the dump is marked as anonymised. Real third-party credentials may not
be present, unless the config explicitly opts in.

sandboxr refuses to start rather than printing a warning. Neither of those mistakes can be undone
afterwards.

## When not to use it

| Situation | Do this instead |
|---|---|
| You want the page to update as you type | There is no hot reload. Run that one app's dev server locally, and keep the sandbox for checking the whole thing works together |
| A unit test would answer the question | Run the test. It is faster and it is repeatable |
| You need to reproduce a bug on real production data | A sandbox starts from fixtures or an anonymised dump. Debugging one customer's record is a different job, with different rules |
| You are measuring performance | Several sandboxes share one machine's processors and one Docker VM's memory. Numbers taken from a sandbox mean nothing |
| Docker has under 8 GB of memory | Below that you spend your time having things killed for memory, and the thing the kernel picks may not be the sandbox |
| The project cannot be started by a script | sandboxr runs what the project's config declares. If nobody can write down how the project starts, sandboxr cannot start it either |

## The limits, stated plainly

These are not bugs. They are how it behaves, and knowing them early saves an afternoon.

- **No hot reload.** The loop is: edit, rebuild the thing you touched, refresh. See
  [The edit–reload loop](guides/edit-and-reload.md).
- **Front-ends are built on demand, never at startup.** A sandbox that has just come up has
  built nothing. Each app answers `503` with a page naming the command that builds it.
- **A heavy front-end build needs headroom.** A static site rendering thousands of pages gets
  killed part-way through without it, and npm reports nothing more useful than `code 137`.
  Declare `memory:` on that app.
- **A failed migration leaves the sandbox running**, and marks it `degraded`. That is
  deliberate — inspecting a failed migration is one of the reasons a sandbox exists — but "the
  sandbox is up" is not the same as "the database is what I expected".
- **One writer per file-backed database.** Two processes opening the same D1 or SQLite file
  deadlock, so exactly one service may own it.
- **Nothing enforces a lifetime unless something runs `sandboxr expire`.** The engine has no
  reaper of its own and starts no daemon. On a machine where nothing runs that command — from
  cron, or by hand — sandboxes live until something stops them.

## One more thing, before you invest an afternoon

sandboxr is early software. One path has been run end to end: the Workers demo in
`examples/demo-worker`, which is why the docs use it as the "does my machine work" check. Plenty
else is written, unit-tested, and has never met a real project. Remote deployment does not exist
at all.

[What is built](reference/status.md) is the full inventory, kept honest on purpose. Read it
before you plan a team around this. No other page repeats this warning.

**Next:** [How it works, in five steps](how-it-works.md) for the mental model, or
[Start here](getting-started/index.md) to try it.
