---
title: Getting started
description: Install sandboxr, set your machine up with one command, and run your first sandbox — then run every worktree at once.
---

Three pages, in order. Together they take about twenty minutes, most of which is Docker building
an image.

| Page | What you get |
|---|---|
| [Install it](install.md) | `sandboxr` on your `PATH`, and a machine set up with `sandboxr init` |
| [Your first sandbox](first-sandbox.md) | One worktree running at its own URL, and thrown away again |
| [Every worktree at once](every-worktree.md) | The case the tool exists for: all your branches running side by side |

You need **Docker**, **Node 22 or newer** and **git**. Nothing else is required; `mkcert` is
optional and gets you HTTPS instead of HTTP.

> [!TIP] Try it on the demo project first
> `examples/demo-worker` in this repository is a real Cloudflare Worker on D1 with its own
> migrations and fixtures. It is the cheapest thing sandboxr can run and the fastest way to see
> the whole path work before you point it at your own project.
