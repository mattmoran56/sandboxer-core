# Working on sandboxr

sandboxr turns a git worktree into a running copy of a whole project, on its own hostname.
A project describes itself in `sandboxr.yaml`; sandboxr resolves that into a `plan.json`,
runs one Docker container per sandbox, and puts a shared Traefik router in front. It is a
command-line tool: `sandboxr.yaml`, the `sandboxr` CLI, `~/.sandboxr`, the `sandboxr.*`
Docker labels and every `SANDBOXR_*` variable are its, and there is no dashboard in this
repository.

**A product is built on this engine, and it lives in another repository.** It embeds
`@sandboxr/core` in process and runs its own dashboard, its own agent sessions and its own
containers on the bare domain. Nothing here imports anything from it, and nothing here may
start to. Where a back-reference looks necessary, invert it: the engine takes a parameter
instead of reaching for a session, an agent or a dashboard. contracts §2 is the statement
of it and names the test that enforces it.

## Read this first

**[`docs/architecture/contracts.md`](docs/architecture/contracts.md) is the single source of
truth for every boundary**: naming, paths, the config schema, the driver interface, the
plan, access control. A package that disagrees with it is a bug. To change a boundary,
change the contract first and say so in the commit message.

## Layout

| Path | What it is | Language |
|---|---|---|
| `packages/core` | **Where the work happens.** Config, drivers, Docker orchestration, the access layer, lifecycle | TypeScript |
| `packages/cli` | A thin face over core. One thing per command, prints the result | TypeScript |
| `packages/docs` | The machinery that publishes `docs/` as a site. React, Tailwind, Vite, prerendered to static HTML | TypeScript |
| `packages/tokens` | `tokens.css`: the palette, the colour schemes, the fonts. Shared with the product's dashboard so the two look like one thing | CSS |
| `container/` | What runs *inside* a sandbox: Dockerfiles, s6 services, scripts | Bash |
| `docs/` | The pages themselves, so they read on GitHub without a build | Markdown |
| `examples/` | Example configs, and `demo-worker`, a project that really runs | — |

Three rules that follow from that table:

- **Only `container/` contains bash.** Everything host-side is TypeScript.
- **React is the only frontend framework.** The documentation site is the one browser app
  here, and it renders from `@sandboxr/tokens`. A second framework, or a second palette, is
  how the engine and the product stop looking like one thing.
- **Logic belongs in core.** If the CLI and an embedder could disagree about what a sandbox
  is, the logic is in the wrong package.

## Standing instructions

**Documentation is updated as part of the change that makes it true, not afterwards.**
A pull request that changes behaviour and leaves `docs/` describing the old behaviour is
incomplete. This applies to the contract too.

**Tests come with the change.** Vitest, colocated as `*.test.ts` beside the source. Each
test file opens with a comment listing what it covers, so a reader knows the shape of the
file before reading it.

**Comments say why, not what.** The codebase is heavy with reasoning, and much of it
records something that went subtly wrong once — a redirect that pointed at the wrong port,
a wildcard certificate that cannot cover a sandbox hostname, a slug truncation that let two
sandboxes collide on one database lock. Those comments are load-bearing. Do not tidy them
away, and add one when you fix something whose cause did not resemble its symptom.

**Never claim something works that has not been run.** Where a feature is unimplemented,
say so once and precisely, on the page it affects — not as a banner on every page.

## Commands

```bash
npm test           # every package (vitest)
npm run typecheck  # core, cli, docs
npm run build      # every package
npm run lint       # where a package defines it
npm run docs:dev   # the documentation site on http://localhost:4321/
```

A root `npm run build` is always enough, because it builds every workspace — but **not
because `npm run --workspaces` knows about dependencies. It runs the workspaces in directory
order.** What orders a build against another package's output is TypeScript: a package's
`tsconfig.json` lists what it needs under `references`, and `tsc -b` builds those first. A
package whose reference is missing passes on a warm tree and fails on a cold clone, with
`Cannot find module` — which reads like a missing install rather than a build order.
Building one package on its own is where it bites.

## Changing the documentation

**[`packages/docs/AUTHORING.md`](packages/docs/AUTHORING.md) is the contract between the
content and the site.** It defines who the pages are for, the frontmatter, and the five
markup conventions. Read it before writing a page; the summary here is only the shape.

- Pages live in `docs/`, as plain Markdown. No imports, no JSX — GitHub has to render them.
- **Two readers, in this order:** a non-technical person, who gets short narrative prose; and
  a coding agent, which gets the exact flags, paths and failure modes inside a `<details>`
  block. A page whose prose has swallowed the detail has lost the first reader.
- **Every page a person can arrive at cold opens with a ` ```prompt ` block** they can hand
  to their agent. `docs/reference/agent-prompts.md` collects every one of them, and it is
  **maintained by hand** — there is no generator and no test — so a prompt edited in place
  has to be edited there too, or the two silently disagree.
- **The sidebar is a hand-maintained list in `packages/docs/src/nav.ts`.** Add, move or
  remove a page and you must update it, or the page exists and is unreachable. A test
  asserts the two agree, so this fails rather than rots.
- Links between pages are **relative file paths** (`../reference/cli.md`); a build plugin
  rewrites them for the site. An absolute site path breaks GitHub.
- Callouts are GitHub alerts (`> [!WARNING]`). Diagrams are ` ```mermaid ` fences. Both
  render natively on GitHub and are transformed for the site.
- `docs/architecture/contracts.md`, `packages/docs/AUTHORING.md` and any `README.md` are
  deliberately **not** site pages.
- Keep the docs project-agnostic. Write about kinds of project — "a Go API with a React
  front-end" — and use the fictional `acme` and `demo` projects, never a real one.

## Commit authorship

**Every commit is authored by the person whose work it is — never by Claude.** Claude may
run `git commit`; it just commits under the git identity already configured in the
repository, and nothing else. Never add a `Co-Authored-By: Claude …` trailer, and never set
an author or committer naming Claude or any other agent.

A commit carries authorship: the person named in it is accountable for it, and that only
holds while the name is theirs. The convention below applies to every commit, whoever ran
the command.

## Commit messages

`type(scope): what changed, in the imperative` — then bullets explaining *why*, not
restating the diff. Types in use: `feat`, `fix`, `docs`, `test`, `chore`. Scopes are
package names without the prefix: `core`, `cli`, `docs`, `tokens`, `container`, `examples`,
`access`.
