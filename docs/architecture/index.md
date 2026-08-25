---
title: Architecture
description: How the pieces actually work — the path a request takes, the order things start in, the one file between the host and the container, and why each decision went the way it did.
---

Explanation rather than instruction. Nothing here tells you to do anything; it tells you why the
system has the shape it has, so that a change you make fits it rather than fights it.

| Page | What it explains |
|---|---|
| [How a request arrives](request-path.md) | Two routers, one machine-wide and one inside each sandbox, and what each response code is actually telling you |
| [The startup graph](startup.md) | What runs first inside a container, what waits for what, and why the router deliberately does not wait for the database |
| [plan.json](plan-json.md) | The single boundary between the host and the container, field by field |
| [State lives in labels](state.md) | Why there is no list of sandboxes anywhere, and how runtime state is derived instead of stored |
| [Design decisions](decisions.md) | For every choice you would want to reverse: the obvious approach, why it fails, and what was done instead |
| [The contract](contracts.md) | **The single source of truth for every boundary in the system.** Not part of this site — it is the engineering contract, read it on GitHub |

**A gentler start:** [the life of a sandbox](../orientation/life-of-a-sandbox.md) walks the same
ground as a story, and [the repository map](../orientation/repository-map.md) says which directory
implements which part.

> [!NOTE] These pages are the reasoning, not the reference
> A decision recorded here is a decision already taken. Where a page describes something that has
> not been run — and several do — it says so at the top, and
> [what is built](../reference/status.md) has the full picture.
