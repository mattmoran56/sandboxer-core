---
title: Architecture
description: Why the system has the shape it has — the path a request takes, the order things start in, the one file between the host and the container.
---

Explanation rather than instruction. Nothing here tells you to do anything; it tells you why the
system has the shape it has, so a change you make fits it rather than fights it.

**A gentler start:** [how it works](../how-it-works.md) covers the same ground at a glance.

| Page | What it explains |
|---|---|
| [How a request arrives](request-path.md) | Two routers — one machine-wide, one inside each sandbox — and what each response code is telling you |
| [The startup graph](startup.md) | What runs first inside a container, what waits for what, and why the router deliberately does not wait for the database |
| [plan.json](plan-json.md) | The single boundary between the host and the container, field by field |
| [State lives in labels](state.md) | Why there is no list of sandboxes anywhere |
| [Design decisions](decisions.md) | For every choice you would want to reverse: the obvious approach, why it fails, what was done instead |
| [The contract](contracts.md) | **The source of truth for every boundary.** Not part of this site — read it on GitHub |
