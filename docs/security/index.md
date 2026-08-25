---
title: Access and security
description: Who can reach a sandbox's apps, who can control one, and the two things sandboxr refuses to do. Read this before you point a domain at anything.
---

sandboxr splits access in two, and the split is the whole security model.

**The apps a sandbox serves are public by default.** Someone who has the URL sees a preview of
unreleased work. That is usually the point — you want to send a link to a designer without giving
them an account on your machine.

**Everything that *controls* a sandbox is behind a password. Always.** The dashboard, the
terminal, start, stop, rebuild, migrate. There is no way to turn that off.

> [!CAUTION] The password is a root credential for the machine
> The dashboard talks to the Docker socket, because that is how it starts and stops containers.
> An action endpoint reachable without a session would be remote code execution on the host, not
> a misconfigured page. Treat the password accordingly.

| Page | What it covers |
|---|---|
| [The two tiers](two-tiers.md) | One mechanism used twice: how sessions work, how the router asks about them, and what a per-project password grants |
| [Public sandboxes](public-sandboxes.md) | The two things sandboxr **refuses** to start — real data behind a public URL, and real credentials in a public app — and the two ways to opt out |

Both refusals are refusals rather than warnings, because neither failure is recoverable. Leaked
records stay leaked; money spent on somebody else's API calls stays spent.

**Before a machine other people can reach:** [running on a server](../running-on-a-server.md).
