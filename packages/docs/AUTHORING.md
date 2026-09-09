# Authoring the documentation

The pages live in the repository's `docs/` directory as **plain Markdown**, and they have two
readers: a person browsing them on GitHub, and the React site in this package. Everything below
exists so one file serves both. This file is the contract between the content and the site; if
they disagree, one of them is a bug.

> [!IMPORTANT] This file is not a site page
> Like `README.md` and `docs/architecture/contracts.md`, it is excluded from the build.

## Who the pages are for

**Two readers, in this order.**

1. **A non-technical person** — a product manager who has been handed a URL and wants to know
   what this is, whether it helps them, and what to do next. They read the prose. The prose must
   be short sentences, one idea each, in a narrative order: introduce a thing, use it, then
   introduce the next thing. Never assume a term that has not been introduced on the page or
   linked to the glossary.
2. **A coding agent** — the reader who will actually install and operate sandboxr on the first
   reader's behalf. It needs exact paths, exact flags, exact schema fields, exact failure modes.
   All of that goes inside a `<details>` block, so it is present without being in the way.

The test for a page: a product manager can read only the prose, top to bottom, and understand
what is happening; an agent can read the prose plus every open block and operate the thing
without opening a source file.

## Frontmatter

Exactly two required keys, and one optional one. Nothing else.

```yaml
---
title: Your first sandbox
description: One sentence, used as the page's subtitle, its search summary and its meta description.
tableOfContents: false   # optional; omit unless the page has no useful headings
---
```

`title` is a short noun phrase, sentence case, and must match the sidebar label in
`packages/docs/src/nav.ts`. `description` is one sentence, ending in a full stop.

## The five markup conventions

### 1. A collapsible detail block

Plain HTML `<details>`, which GitHub renders natively and the site styles.

```md
<details class="agent">
<summary><b>Details for an agent</b> — every flag <code>sandboxr up</code> accepts</summary>

The body is ordinary Markdown. **A blank line above and below it is required** — without
it GitHub renders the body as literal text rather than Markdown.

| Flag | Means |
|---|---|
| `--ttl 12h` | Stop it once it has sat unused this long |

</details>
```

Rules:

- **The `class` is one of `agent`, `failure`, `why`, or `facts`.** The site styles each
  differently and labels it with an icon. GitHub strips the attribute, which is harmless.
- **The `<summary>` says who the block is for and what is inside**, in that order, separated by
  an em dash. Put the audience in `<b>`. A triangle labelled "More" tells a reader nothing.
  The four conventional openings are `Details for an agent`, `If it goes wrong`,
  `Why it works this way` and `Fact sheet`.
- **A collapsed block may never hold something the reader needs to get to the next step.** It
  holds precision, not prerequisites.
- **Never nest one inside another.**

### 2. An agent prompt

A fenced block tagged `prompt`. GitHub renders it as a plain code block; the site renders it as a
card with a copy button, so a person can hand it straight to their agent.

````md
```prompt
Install sandboxr on this machine and bring the dashboard up.

Read https://…/getting-started/install/ first, then work through it. Stop and
tell me if Docker is not running or has under 8 GB of memory available.
```
````

Rules:

- **Write it as an instruction to an agent, in the second person.** Not a description of one.
- **Name the doc page the agent should read.** The prompt is a pointer plus the constraints an
  agent cannot infer, not a copy of the page.
- **State what should make the agent stop and ask.** A prompt that cannot fail is a prompt that
  will do the wrong thing quietly.
- **Every page a person could arrive at cold opens with one**, immediately after the
  introductory sentences and before the manual instructions. The person who wants their agent to
  do it should never have to scroll.

### 3. Callouts

GitHub alerts, with a title after the marker.

```md
> [!WARNING] The password is a root credential
> Anyone who has it can run every action the dashboard offers.
```

`NOTE`, `TIP`, `IMPORTANT`, `WARNING`, `CAUTION`. Use them for things that are true regardless of
where the reader is in the page. A callout is not a place to hide an instruction.

### 4. Diagrams

` ```mermaid ` fences. GitHub renders them; the site renders them client-side so they follow the
theme. Keep them to one idea and under about ten nodes — a diagram nobody can read is worse than
the sentence it replaced.

### 5. Links and images

**Relative file paths, always** — `../reference/cli.md`, `getting-started/install.md`. That is the
only form GitHub can follow. A build plugin rewrites them for the site. An absolute site path
(`/reference/cli/`) breaks GitHub and is a bug.

Link the first use of any term that has a glossary entry.

**An image is the same rule, and it lives in `docs/assets/`.** Nothing else under `docs/` is
served as a file.

```md
![The sandboxr mark](assets/brand/mark.svg)
```

The path is relative to the page, exactly as a link's is, and it must land under `docs/assets/`.
`plugins/assets.ts` copies that directory into the build and `markdown/links.ts` rewrites the
path, so one string is a working relative path on GitHub and a working URL on the site. An image
written anywhere else is **left exactly as typed** rather than rewritten, so the mistake is
visible on both instead of tidy on one.

Prefer SVG, and prefer one that carries no font: a face the reader does not have is a word that
does not appear. Where an SVG has to set text, give it a fallback stack and say so on the page.
Give every image alt text that says what it shows, because it is read aloud and it is what
appears when the file does not.

## What must be true of every page

- **The first paragraph answers "what is this page for", in one or two sentences.** No preamble,
  no restating the title.
- **It ends with where to go next**, as a short `**Next:**` line naming one or two pages and why
  you would want each. A reader must never reach the bottom of a page with no idea what follows.
- **Sentences are short.** One idea each. If a sentence needs a second comma to hold itself
  together, it is two sentences.
- **Nothing is claimed to work that has not been run.** Where a feature is unproven, say so once
  and precisely, and link [what is built](../../docs/reference/status.md). Never as a banner.
- **The fictional projects are `acme` and `demo`.** Write about kinds of project — "a Go API with
  a React front-end" — never a real one.
- **`docs/architecture/contracts.md` outranks every page.** Where a page disagrees with it, the
  page is wrong.

## The sidebar is hand-maintained

`packages/docs/src/nav.ts` is a hand-written list. **Add, move or remove a page and you must
update it, or the page exists and is unreachable.** Its labels must match each page's `title`.
