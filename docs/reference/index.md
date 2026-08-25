---
title: Reference
description: Exact surfaces, taken from the source — every command, every configuration field, every environment variable, every term, and an honest account of what is actually built.
---

Look-up pages. No narrative, no worked examples: the whole surface, transcribed from the code so
it can be trusted precisely. This is the section to open if you are an agent operating the system,
or a person who already knows what they are looking for.

| Page | What it holds |
|---|---|
| [CLI commands](cli.md) | Every `sandboxr` command, its flags, its exit codes, and what it touches |
| [Configuration schema](config-schema.md) | Every field of `sandboxr.yaml`: type, whether it is required, default, and the pattern it must match |
| [Environment variables](environment.md) | Three groups: what you set, what the host passes into a container, and what a sandbox computes for itself |
| [Glossary](glossary.md) | Every term these pages use precisely, with where it is defined in the code |
| [What is built](status.md) | Which claims on this site are measurements, which describe code that has never run, and which are plans |

**Read [what is built](status.md) first if you are about to rely on any of this.** sandboxr is
documented alongside code that is still being written, and that page is where the difference is
recorded rather than implied.

**The authority behind these pages** is the code itself:
`packages/cli/src/main.ts` for the commands, `packages/core/src/config/schema.ts` for the
configuration, `packages/core/src/sandbox/env.ts` and `container/README.md` for the environment,
and [`architecture/contracts.md`](../architecture/contracts.md) for every boundary between them.
