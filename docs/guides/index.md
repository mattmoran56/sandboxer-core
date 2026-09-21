---
title: Day to day
description: The five things you actually do with a sandbox once you have one, and which page covers each.
---

You have a [sandbox](../reference/glossary.md) running. This section is everything you do with it
after that — start another, rebuild what you changed, read a log, test a migration against real
structure, and get the disk back.

Each page is one task. Start with the first one; the rest you can read when you need them.

```prompt
I want to learn my way around sandboxr day to day.

Read docs/guides/index.md, then docs/guides/lifecycle.md and
docs/guides/edit-and-reload.md. Then tell me, in your own words: what `sandboxr down`
removes, what it can never remove, and what I have to run after I edit a file.

Stop and ask me if `sandboxr ls` reports no sandboxes — that means there is nothing
here to look at yet, and we should do docs/getting-started/first-sandbox.md instead.
```

## The five pages

| Page | What it is for |
|---|---|
| [Start, stop, list, clean up](lifecycle.md) | The commands you run every day, and exactly what each one removes |
| [The edit–reload loop](edit-and-reload.md) | How a file you save becomes running code, and why there is no hot reload |
| [Logs, shells and terminals](logs-and-shells.md) | The three ways to see inside a sandbox, and which to reach for |
| [Testing a migration](testing-a-migration.md) | Pointing a half-written migration at real structure, safely |
| [Giving Docker the whole machine](docker-capacity.md) | Where Docker's disk and memory come from, and how to get space back |

If something is broken rather than unfamiliar, go to
[Troubleshooting](../troubleshooting.md) instead. It is organised by the message you saw,
which is usually not the same thing as the part that is actually wrong.

**Next:** [Start, stop, list, clean up](lifecycle.md) is the page to read first — it is the
handful of commands the rest of this section assumes. Then [The edit–reload
loop](edit-and-reload.md), which is what you will do most often.
