---
title: Start here
description: The one prompt that sets a laptop up, a table of where to go for what you want, and the four steps in order.
---

This is the front door to actually running sandboxr. Pick the row below that matches what you
want, or hand the prompt to your agent and let it do the whole laptop setup.

If you have not yet read [What sandboxr is](../introduction.md), that page is three minutes and
explains why any of this is worth doing.

## Hand this to your agent

```prompt
Set this machine up for sandboxr and prove it works.

Read docs/getting-started/install.md and then docs/getting-started/demo-project.md, and work
through them in that order. Install from the repository checkout, run `sandboxr init`, then bring
up the demo project in examples/demo-worker and confirm the page it serves loads in a browser.

Stop and ask me if:
- Docker is not running, or has under 8 GB of memory available to it.
- `mkcert` is missing and you would need my password to install its root certificate.
- `sandboxr doctor` reports anything it does not tell you how to fix.

Tell me the demo sandbox's URL when you are done.
```

You need **Docker**, **Node 22 or newer** and **git**. Everything else is optional.

If a word on any of these pages is unfamiliar, [the glossary](../reference/glossary.md) defines
every one of them in a sentence.

## What do you want to do

| I want to… | Go to |
|---|---|
| Try it on my laptop | [Install it](install.md) |
| Set up my own project | [Build your config, step by step](../configuration/index.md) |
| Run every branch at once | [Every worktree at once](every-worktree.md) |
| Work on several repositories | [Several repositories at once](../setups/many-projects.md) |
| Put it on a server for my team | [On a server, for a team](../setups/shared-server.md) |

Not sure which of those you are? [Which setup is yours](../setups/index.md) lays the four out
side by side, with what each costs.

## The four things you will do, in order

1. **[Install it](install.md).** Get the `sandboxr` command, then run `sandboxr init` once. That
   builds the container image every sandbox runs from and starts the shared router that gives
   every sandbox its hostname. Budget ten minutes, most of it Docker building.
2. **[Start your first sandbox](first-sandbox.md).** Make a git worktree, run `sandboxr up` in it,
   and open the URL it prints. Then throw it away with `sandboxr down` and watch the database go
   with it.
3. **[Run the demo project](demo-project.md).** `examples/demo-worker` is the only project that
   has been taken all the way through, so it is the honest check that your machine works. It is
   also a config small enough to read line by line, which is the fastest way to understand the
   file you will write for your own project.
4. **[Run every worktree at once](every-worktree.md).** Three branches, three URLs, three
   databases, all live together. This is the thing the tool exists for.

Step 3 is the one to do first if step 2 does not go well. It removes your own project from the
question entirely.

<details class="agent">
<summary><b>Details for an agent</b> — the whole laptop setup as commands</summary>

Run from a checkout of the sandboxr repository. There is no published npm package; see
[Install it](install.md) for why.

```bash
# 1. Build the tool and put `sandboxr` on PATH.
npm install
npm run build
npm link --workspace @sandboxr/cli
sandboxr version

# 2. Set the machine up. Idempotent — run it again to change anything.
sandboxr init

# 3. Check it.
sandboxr doctor

# 4. Prove it end to end on the demo project.
cd examples/demo-worker
sandboxr up demo1
curl -s https://demo1--app--demo.sbx.localhost/api/notes

# 5. Clean up.
sandboxr down demo1
```

Exit codes worth handling: `sandboxr up` returns `3` when the sandbox is up but its migrations
failed, and `0` when it is healthy. `sandboxr status` does the same. Anything else non-zero is a
real failure.

Human-readable output goes to **stderr**. `--json` puts the machine-readable result on
**stdout**, so `sandboxr ls --json | jq` works while progress still shows.

</details>

**Next:** [Install it](install.md) — the prerequisites and the one setup command. If you would
rather understand the machinery first, [How it works, in five steps](../how-it-works.md) is the
mental model in one page.
