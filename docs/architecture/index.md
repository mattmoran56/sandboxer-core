---
title: The shape of it
description: The five pieces sandboxer is made of, what each one owns, and what each one is deliberately not allowed to know.
---

sandboxer is five pieces of code. This page names each one and says what it owns. Every other page
in this section is a detail of one of the boundaries drawn here.

One rule explains the whole layout. **One piece decides what a sandbox is, and everything else
asks it.** That piece is `packages/core`. The command line is one face over it, and anything that
embeds core is another. Neither is allowed a second opinion.

If you have not read [How it works, in five steps](../how-it-works.md), read that first. It tells
the same story from the outside, without naming a package.

## The one that decides

`packages/core` holds every decision. What a [slug](../reference/glossary.md) is. What a
container is called. Which files get mounted where. How much memory the container gets. Whether a
[sandbox](../reference/glossary.md) counts as running, starting or degraded. What a database
driver has to do. It talks to Docker and to git, and it answers questions.

Core is a library. It has no command line and no web server of its own.

## The face over it

`packages/cli` is the `sandboxer` command. It parses arguments, calls one core function, and
prints the result. That is all it does.

It is the only face this repository ships. An embedder that wants a web control plane writes its
own and puts it on the bare domain — [contracts](contracts.md) §7.2 is what that takes — and it
calls core **in the same process**, never the `sandboxer` command.

## The one that runs inside

`container/` is what lives *inside* a sandbox: the two Dockerfiles, the s6 service definitions and
the shell scripts. It is generic. It knows nothing about any particular project, and it reads
everything it needs from one file the host writes for it, [`plan.json`](plan-json.md).

This is the only directory in the repository that contains shell scripts. Everything on the host
side is TypeScript.

## The one that publishes these pages

`packages/docs` is the machinery that turns `docs/` into a website. The pages themselves are plain
Markdown in `docs/`, so they read on GitHub with no build step.

## The one that holds the palette

`packages/tokens` is a single stylesheet, `tokens.css`. It is what the documentation site is
drawn from, and it is shared with the product's dashboard in the other repository so the two look
like one thing.

## How they fit together

```mermaid
flowchart TB
  cli["packages/cli<br/>the sandboxer command"]
  emb["An embedder<br/>its own control plane"]
  core["packages/core<br/>every decision about a sandbox"]
  dk["Docker"]
  box["container/<br/>what runs inside a sandbox"]
  cli --> core
  emb -->|"in process"| core
  core -->|"labels, mounts, images"| dk
  dk --> box
  core -.->|"plan.json"| box
```

## What each one may not know

The prohibitions matter more than the responsibilities, because each one closes off a way for two
parts of sandboxer to disagree.

| Piece | May never |
|---|---|
| `packages/core` | Print for a human, or know that a web server exists |
| `packages/cli` | Decide anything. If an embedder could disagree with it, the logic is in the wrong place |
| `container/` | Read `sandboxer.yaml`, or name a service, port, package or route of its own |
| `packages/docs` | Be required for a page to be readable |
| `packages/tokens` | Contain a component, a script, or anything specific to one app |

<details class="why">
<summary><b>Why it works this way</b> — what a second implementation costs</summary>

Volume names keyed on a lockfile hash. Seed cache invalidation. Plan resolution. The worktree
cases. Every one of those is fiddly, and every one of them is needed by the command line and by
anything embedding the engine.

A second implementation of any of them drifts within a week. Then the two disagree about what a
sandbox is, and a person watching one of them is being told something false. So there is one
implementation, in core, and the advice to an embedder is the same shape: reach core through
exactly one file of your own, so a renamed export is a compile error in one place.

Two things core does not express, and an embedder that wants them talks to the Docker socket
itself: streaming an exec line by line, and hijacking a connection for a terminal.

</details>

## The contract behind all of this

[`docs/architecture/contracts.md`](contracts.md) is the authority on every boundary named above: naming, paths,
the config schema, the driver interface, the plan, access control. A package that disagrees with
it is a bug.

It is written for people changing the code, so it is deliberately not one of these pages.
[Read it in the repository](contracts.md).

**Next:** [Package by package](packages.md) for the same five pieces in full, including the
interfaces between them. Or [How a request arrives](request-path.md) if you are chasing a routing
problem right now.
