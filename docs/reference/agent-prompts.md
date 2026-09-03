---
title: Every agent prompt
description: Every copy-and-paste prompt in this documentation, collected in one place so you can find the right one.
---

Every page that a person might arrive at cold opens with a prompt you can hand to a coding agent.
This page collects all of them, so you can find the one you want without hunting.

Each prompt says what it does, what it needs first, and links the page it came from. Read that page
if you want to know what the agent will actually do.

> [!TIP] Prompts name a documentation page, not a whole procedure
> Every prompt tells the agent which page to read. That is deliberate. The page is the instructions,
> and the prompt is the task plus the things an agent cannot work out for itself — including what
> should make it stop and ask you.

## Getting going

### Welcome

Installs sandboxr and starts a sandbox for the worktree you are in.

**Needs first:** Docker running, and a `sandboxr.yaml` at the worktree root.  
**From:** [Welcome](../index.md)

```prompt
Install sandboxr on this machine, then start a sandbox for the git worktree I am in.

Read docs/getting-started/install.md and work through it, then do the same with
docs/getting-started/first-sandbox.md. Stop and tell me if Docker is not running, if Docker
has under 8 GB of memory available, or if this worktree has no sandboxr.yaml at its root.
```

### What sandboxr is

Explains sandboxr and judges whether it fits a repository. Changes nothing.

**Needs first:** Nothing. Run it before you install.  
**From:** [What sandboxr is](../introduction.md)

```prompt
Explain sandboxr to me and tell me whether it fits this repository.

Read docs/introduction.md and docs/how-it-works.md. Then look at this repository and tell me
which services and front-ends a sandbox would need to run, and whether it uses a database
sandboxr supports. Stop and say so plainly if you think this project is a poor fit.
```

### Start here

The whole laptop setup, end to end, proved against the demo project.

**Needs first:** Docker, Node 22 or newer, git.  
**From:** [Start here](../getting-started/index.md)

```prompt
Set this machine up for sandboxr and prove it works.

Read docs/getting-started/install.md and then docs/getting-started/demo-project.md, and work
through them in that order. Install from the repository checkout, run `sandboxr init`, then bring
up the demo project in examples/demo-worker and confirm the page it serves loads in a browser.

Stop and ask me if:
- Docker is not running, or has under 8 GB of memory available to it.
- `mkcert` is missing and you would need my password to install its root certificate.
- You cannot decide what SANDBOXR_PASSWORD should be.
- `sandboxr doctor` reports anything it does not tell you how to fix.

Tell me the dashboard URL and the demo sandbox's URL when you are done.
```

### Install it

Installs the `sandboxr` command and runs `sandboxr init`.

**Needs first:** Docker, Node 22 or newer, git.  
**From:** [Install it](../getting-started/install.md)

```prompt
Install sandboxr on this machine and set it up.

Read docs/getting-started/install.md and follow it. Install from the repository checkout with
`npm link` — there is no published npm package. Then run `sandboxr init` and finish by running
`sandboxr doctor` and reporting every line of its output to me.

Stop and ask me if:
- Docker is not running, or has under 8 GB of memory available to it.
- `mkcert` is not installed, or its root certificate is not trusted. Do not run `mkcert -install`
  yourself; it needs my password.
- Port 80 or port 443 is already taken on this machine.
- You do not have a value for SANDBOXR_PASSWORD.
```

### Which setup is yours

Works out which of the five setups fits the machine. Installs nothing.

**Needs first:** Nothing.  
**From:** [Which setup is yours](../setups/index.md)

```prompt
Work out which sandboxr setup fits this machine and tell me which one, with your reasoning.

Read docs/setups/index.md, then read the page for the setup you pick. Check what is actually
here first: is Docker running, how much memory has it been given, is there a git repository in
this directory, and does anything already exist under ~/.sandboxr. Do not install anything yet.

Stop and ask me if the answer depends on whether other people need to open these URLs, or if
this machine looks like a shared server rather than somebody's laptop.
```

### Just the CLI, on my laptop

Sets the machine up with the CLI and no dashboard.

**Needs first:** Docker, Node 22 or newer, git.  
**From:** [Just the CLI, on my laptop](../setups/cli-only.md)

```prompt
Set this machine up to run sandboxr from the command line only, and start a sandbox from the
repository in this directory.

Read docs/getting-started/install.md, then docs/setups/cli-only.md, then work through them.
Add SANDBOXR_REAP_MINUTES=0 to my shell profile and tell me you did, because nothing enforces a
sandbox lifetime on a machine whose dashboard is not running.

Stop and tell me if Docker is not running, if it has under 8 GB of memory, or if this directory
has no sandboxr.yaml — I will need to write one before anything can start.
```

### The dashboard on my laptop

Adds the dashboard, with a password.

**Needs first:** `sandboxr init` has been run, and you have chosen a password.  
**From:** [The dashboard on my laptop](../setups/dashboard-on-a-laptop.md)

```prompt
Bring the sandboxr dashboard up on this machine and give me the URL to open.

Read docs/setups/dashboard-on-a-laptop.md and docs/access.md first. Generate a long random
password, set SANDBOXR_PASSWORD to it, run `sandboxr init`, then run `sandboxr doctor` and show
me every line of its output. Tell me the password once, plainly, and tell me where you put it.

Stop and ask me before you write the password into any file that a repository could contain.
Stop and tell me if `sandboxr init` reports that mkcert's root is not trusted, because that is
the difference between https and plain http and it needs my password to fix.
```

### The dashboard

Brings the dashboard up and confirms you can sign in.

**Needs first:** `SANDBOXR_PASSWORD` set, and `sandboxr init` run.  
**From:** [The dashboard](../guides/dashboard.md)

```prompt
Bring the sandboxr dashboard up on this machine and tell me the URL to open and how to
sign in.

Read docs/guides/dashboard.md and docs/access.md. Stop and tell me if no password is
set, if the dashboard container is not running, or if the browser bundle has not been
built — do not print the password itself back to me.
```

## Running sandboxes

### Your first sandbox

Starts a sandbox for the current worktree and confirms it serves.

**Needs first:** `sandboxr init` has been run.  
**From:** [Your first sandbox](../getting-started/first-sandbox.md)

```prompt
Start a sandbox for this worktree and confirm it serves.

Read docs/getting-started/first-sandbox.md and follow it. Run `sandboxr up` in the worktree, then
open the URL it prints and confirm it answers. Report the URL and the output of `sandboxr status`.

Stop and ask me if:
- There is no sandboxr.yaml in this project. Do not write one without asking.
- `sandboxr up` exits with code 3. That means the sandbox is up but its migrations failed — show
  me `sandboxr logs` and wait.
- It refuses to start because the project serves public apps and has real credentials on this
  machine.
- An app answers 503 with a page naming a build command. Ask before running a build; some cost
  minutes and gigabytes.

Do not run `sandboxr down` unless I ask. That deletes the sandbox's database.
```

### Run the demo project

Runs the one path proven end to end, as a check that the machine works.

**Needs first:** A checkout of the sandboxr repository, and `sandboxr init`.  
**From:** [Run the demo project](../getting-started/demo-project.md)

```prompt
Run the sandboxr demo project and confirm it serves a page.

Read docs/getting-started/demo-project.md and follow it. From the sandboxr checkout, cd into
examples/demo-worker, run `sandboxr up demo1`, then fetch
https://demo1--app--demo.sbx.localhost/api/notes and confirm it returns two seeded notes. Report the
JSON you got back.

Stop and ask me if:
- `sandboxr init` has not been run on this machine yet.
- `sandboxr up` exits with code 3, meaning the migrations failed. Show me `sandboxr logs demo1`.
- The URL returns anything other than 200, or the notes array is empty.

Leave the sandbox running when you are done unless I ask you to remove it.
```

### Every worktree at once

Starts a sandbox for every worktree of a project and reports the URLs.

**Needs first:** Several worktrees, and enough memory for them.  
**From:** [Every worktree at once](../getting-started/every-worktree.md)

```prompt
Start a sandbox for every worktree of this project and report the URLs.

Read docs/getting-started/every-worktree.md and follow it. Start one sandbox per worktree, then run
`sandboxr ls` and give me the table plus one URL per sandbox.

Stop and ask me if:
- Any sandbox comes up degraded (exit code 3). Report which and show me its logs.
- There are more than five worktrees. Tell me how many and wait — each one costs memory.
- Docker reports it is out of disk or memory.

Do not run `sandboxr down` or `sandboxr gc` on anything. Both delete databases.
```

### One repo, many branches

Sets up several worktrees of one repository and runs them side by side.

**Needs first:** One repository, and `sandboxr init`.  
**From:** [One repo, many branches](../setups/one-repo-many-worktrees.md)

```prompt
Start a sandbox for every git worktree in this repository, then show me the URLs.

Read docs/setups/one-repo-many-worktrees.md first. Run `sandboxr up --worktree <path>` for each
worktree, one at a time rather than in parallel, then `sandboxr ls`. Tell me each sandbox's slug
and where it came from.

Stop and tell me if two worktrees would derive the same slug — that would make the second `up`
replace the first sandbox and adopt its database. Stop if Docker has under 8 GB of memory, and
tell me how many sandboxes you think will fit.
```

### Several repositories at once

Clones a repository into the managed workspace and starts a sandbox on a branch.

**Needs first:** `gh` signed in, or a clone URL.  
**From:** [Several repositories at once](../setups/many-projects.md)

```prompt
Put a repository into sandboxr's managed workspace and start a sandbox for one of its branches.

Read docs/setups/many-projects.md first. Run `sandboxr project available` to see what this
machine's gh can offer, clone the one I name, then `sandboxr worktree add`, then
`sandboxr up --project <name> --branch <branch>`. Show me the URLs at the end.

Stop and ask me which repository if the list has more than one plausible match. Stop and tell me
if `gh` is not installed or not logged in — you will need a clone URL from me instead. Stop if
the branch has no sandboxr.yaml, and tell me so before you start writing one.
```

### Day to day

Picks the right day-to-day guide for what you are trying to do.

**Needs first:** Nothing.  
**From:** [Day to day](../guides/index.md)

```prompt
I want to learn my way around sandboxr day to day.

Read docs/guides/index.md, then docs/guides/lifecycle.md and
docs/guides/edit-and-reload.md. Then tell me, in your own words: what `sandboxr down`
removes, what it can never remove, and what I have to run after I edit a file.

Stop and ask me if `sandboxr ls` reports no sandboxes — that means there is nothing
here to look at yet, and we should do docs/getting-started/first-sandbox.md instead.
```

### Start, stop, list, clean up

Reports what is running and what state each sandbox is in. Removes nothing.

**Needs first:** `sandboxr init` has been run.  
**From:** [Start, stop, list, clean up](../guides/lifecycle.md)

```prompt
Show me the sandboxes on this machine and explain what state each one is in.

Read docs/guides/lifecycle.md first. Run `sandboxr ls`, then `sandboxr status <slug>`
for anything that is not `running`, and tell me in plain words what is wrong with it.

Do not run `sandboxr down`, `sandboxr gc` or `sandboxr prune --yes` without asking me
first — those three remove things. Stop and tell me if Docker is not running.
```

### Projects, worktrees and lifetimes

Clones a project, starts a sandbox on a branch, and reports its lifetime.

**Needs first:** `gh` signed in, or a clone URL.  
**From:** [Projects, worktrees and lifetimes](../guides/managed-sandboxes.md)

```prompt
Clone a repository into the sandboxr workspace and start a sandbox on one of its
branches, then tell me when that sandbox will stop itself.

Read docs/guides/managed-sandboxes.md and follow it. Stop and tell me if `gh` is not
signed in on this machine, if the repository is already in the workspace, or if the
branch does not exist and I have not said what to cut it from.
```

### Cheat sheet

Summarises every sandbox on the machine. Read-only.

**Needs first:** `sandboxr init` has been run.  
**From:** [Cheat sheet](cheat-sheet.md)

```prompt
Give me a summary of the sandboxes on this machine and whether anything is wrong with them.

Read docs/reference/cheat-sheet.md first, then run the read-only commands from the "One command
per intent" table — sandboxr ls, sandboxr status, sandboxr doctor — with --json, and tell me what
you found. Do not start, stop or remove anything. Stop and tell me if Docker is not running or if
`sandboxr` is not on the PATH.
```

## Describing a project

### Build your config, step by step

Writes a `sandboxr.yaml` for a project from nothing.

**Needs first:** A repository you can read.  
**From:** [Build your config, step by step](../configuration/index.md)

```prompt
Write a sandboxr.yaml for this project.

Read docs/configuration/index.md, then docs/configuration/rules.md, then work through
the steps in order. Inspect the repository to find the real build commands, ports and
package directories — do not guess them. Show me the file after each block you add and
tell me what it buys.

Stop and ask me if: the project has a database and you cannot tell which engine; a
front-end has no build command you can find; or the project keeps secrets in .env files
and you cannot tell which of them are third-party credentials.
```

### sandboxr.yaml, field by field

Answers a question about one config field, without guessing.

**Needs first:** Nothing.  
**From:** [sandboxr.yaml, field by field](../configuration/sandboxr-yaml.md)

```prompt
Answer a question about a sandboxr.yaml field.

Read docs/configuration/sandboxr-yaml.md. Treat it as the field list, and
docs/configuration/rules.md as the list of constraints. If the answer is not on either
page, say so rather than guessing — the authority is
packages/core/src/config/schema.ts in the sandboxr repository.
```

### The rules a config must obey

Diagnoses a config that is being refused.

**Needs first:** The exact error text.  
**From:** [The rules a config must obey](../configuration/rules.md)

```prompt
Diagnose why a sandboxr config is being refused.

Read docs/configuration/rules.md and match the exact error text against the table there.
Run `sandboxr config` to see what the file resolved to. Fix the field the error names.

Stop and tell me if the fix would change what data the sandbox is seeded from, or would
make a public project private, or the reverse — those are decisions about who can see
real records, not typos.
```

### The three runtime kinds

Sorts every runnable thing in a project into the three kinds.

**Needs first:** A repository you can read.  
**From:** [The three runtime kinds](../configuration/runtime-kinds.md)

```prompt
Classify every runnable thing in this project into sandboxr's three runtime kinds.

Read docs/configuration/runtime-kinds.md. For each app or service, say which kind it is
and why, and write the sandboxr.yaml entry for it. Find the real build command, output
directory and port by reading the project — do not guess.

Stop and tell me if something is a long-running dev server with no static build, because
that is the expensive kind and I may want it marked optional.
```

### Secrets

Writes the `secrets` block and gets the project's credentials into sandboxr.

**Needs first:** The project's `.env` files, or the values themselves if it has none.  
**From:** [Secrets](../configuration/secrets.md)

```prompt
Set up this project's secrets block and get its credentials into sandboxr.

Read docs/configuration/secrets.md. Find the project's .env files, then write a `secrets`
block listing them under `read`, an exact-name allowlist under `keep`, and glob patterns
under `never` for anything describing where something runs. Then run
`sandboxr secrets import` and `sandboxr secrets check`.

If `check` still names something as missing, the value is on no file on this machine: tell
me which names those are and ask me for each one, then set it with
`printf '%s' "$VALUE" | sandboxr secrets set NAME` so it never reaches the shell history.

Never print a value from a .env file, in any output, for any reason. Stop and ask me if a
name could plausibly be either a credential or an address.
```

### Worked examples

Adapts the closest shipped example config to a project.

**Needs first:** A checkout of the sandboxr repository.  
**From:** [Worked examples](../configuration/examples.md)

```prompt
Pick the closest example config for this project and adapt it.

Read docs/configuration/examples.md, then open the example file it points at in the
sandboxr repository. Adapt it to this project by reading the project's own build scripts,
ports and package layout. Explain each change you make.

Stop and tell me if this project has a database engine none of the three examples uses.
```

### Databases

Writes the `database` block and tests a migration in a sandbox.

**Needs first:** A repository with migrations.  
**From:** [Databases](../databases.md)

```prompt
Set this project up so each sandbox gets its own database, and test a migration in one.

Read docs/databases.md first, then docs/guides/testing-a-migration.md. Work out which
driver the project needs, write the `database` block, and take one sandbox through
`up`, `db snapshot`, `db migrate`, `db snapshot` and a diff.

Stop and tell me before you point `seed_from.local` at anything: forking a live database
is only permitted for a `private` project, and I need to confirm which database that is.
```

## Working in a sandbox

### The edit–reload loop

Rebuilds whatever you changed and confirms the new code is serving.

**Needs first:** A running sandbox.  
**From:** [The edit–reload loop](../guides/edit-and-reload.md)

```prompt
I have edited a file in this worktree. Get the sandbox serving the new version.

Read docs/guides/edit-and-reload.md first. Work out from the project's sandboxr.yaml
which runtime the file belongs to, then run the right `sandboxr reload` for it and tell
me what you ran and what it printed.

Stop and ask me if I changed sandboxr.yaml or the lockfile — those need `sandboxr up`,
which replaces the container. Stop and tell me if the build output contains `Killed` or
`137`: that is the sandbox running out of memory, not a broken build.
```

### Logs, shells and terminals

Finds out why a sandbox is not answering, from its logs.

**Needs first:** A sandbox that exists.  
**From:** [Logs, shells and terminals](../guides/logs-and-shells.md)

```prompt
A sandbox on this machine is not behaving. Find out why.

Read docs/guides/logs-and-shells.md first. Start with `sandboxr status <slug>` to see
which services answer, then read the logs — `~/.sandboxr/logs/<project>/<slug>/` on the
host is the same directory the container writes to, so read the files directly rather
than shelling in. Report what you found before changing anything.

Stop and ask me before running anything that writes: no migrations, no rebuilds, no
`down`. Stop and tell me if `sandboxr ls` shows the sandbox as `stopped` — a stopped
container has no live processes to inspect.
```

### Testing a migration

Runs a migration against a sandbox and shows what it did to the schema.

**Needs first:** A sandbox with a database, and a migration to test.  
**From:** [Testing a migration](../guides/testing-a-migration.md)

```prompt
I am writing a database migration on this branch. Set up a sandbox for it and run the
snapshot-migrate-snapshot loop so I can see exactly what the migration changed.

Read docs/guides/testing-a-migration.md and follow it. Take a schema snapshot before
you run anything. Stop and tell me if the sandbox comes up `degraded`, or if the
migration fails — do not try to fix my migration unless I ask.
```

### Your own agent in a sandbox

Cuts a worktree and a sandbox for a ticket, ready for an agent to work in.

**Needs first:** A repository, and `sandboxr init`.  
**From:** [Your own agent in a sandbox](../guides/agents-in-a-sandbox.md)

```prompt
Set me up a worktree and a sandbox for the ticket I am about to describe, then work on
the branch in that worktree while I watch the app running.

Read docs/guides/agents-in-a-sandbox.md first. Use a new worktree, never my main
checkout. Stop and tell me the sandbox's URLs once it is up, and stop and ask before
running anything that would delete a sandbox or touch another one.
```

### Agent sessions in the dashboard

Opens an agent session on a sandbox from the dashboard.

**Needs first:** The dashboard running, and a credential for Claude Code.  
**From:** [Agent sessions in the dashboard](../guides/agent-sessions.md)

```prompt
Open an agent session on this sandbox from the dashboard and tell me what it can and
cannot reach on this machine.

Read docs/guides/agent-sessions.md first. Check whether this machine has a Claude
credential the dashboard can use before you try. Stop and tell me if there is none, or
if opening a session fails — do not put a token anywhere except the dashboard's own
environment.
```

## Looking after the machine

### On a server, for a team

Sizes a server for a team. It does not deploy one — that does not exist yet.

**Needs first:** Nothing.  
**From:** [On a server, for a team](../setups/shared-server.md)

```prompt
Assess whether this project could run on a shared server, and produce a sizing plan.

Read docs/setups/shared-server.md and docs/guides/docker-capacity.md. From this project's
sandboxr.yaml, work out the per-sandbox memory cap, then tell me the memory, disk and CPU a
server would need for the number of concurrent sandboxes I name, and list the DNS records it
would need.

Do not try to deploy anything. Remote deployment does not exist in sandboxr: there is no ACME
client, no DNS writer and no service unit. Stop and tell me if I ask you to install it anyway.
```

### Giving Docker the whole machine

Finds where Docker's disk went and reclaims it safely.

**Needs first:** Docker running.  
**From:** [Giving Docker the whole machine](../guides/docker-capacity.md)

```prompt
Docker on this machine is out of space. Work out where it went and reclaim it.

Read docs/guides/docker-capacity.md first. Run `sandboxr prune` and `docker system df`
and show me both reports before removing anything. Then reclaim in the order that page
gives, least destructive first.

Never run `docker system prune -a --volumes` — it deletes the shared volumes sandboxr
protects, including an agent session's credentials. Stop and ask me before anything with
`--yes` or `-a` in it.
```

### Access and security

Audits every project's access settings before the machine is exposed.

**Needs first:** `sandboxr init` has been run.  
**From:** [Access and security](../access.md)

```prompt
Review the access settings for every project on this machine before I expose it beyond
localhost.

Read docs/access.md and work through the checklist at the bottom of it. Report, per
project, its `access.apps`, its `access.credentials`, and which seed source it would
actually use. Check whether SANDBOXR_PASSWORD is set and whether the router is serving
https.

Stop and tell me — do not change anything — if any project is `public` while seeding from
a live database or carrying real credentials.
```

### Troubleshooting

Diagnoses a symptom and proposes a fix.

**Needs first:** A description of what you are seeing.  
**From:** [Troubleshooting](../troubleshooting.md)

```prompt
Something is wrong with a sandbox on this machine. Work out what.

Read docs/troubleshooting.md first. Start with the ladder at the top of that page — sandboxr doctor,
docker system df, sandboxr ls, sandboxr status, sandboxr logs — then match what you find against the
symptom headings. Tell me the symptom, the cause and the fix before you change anything. Stop and
ask me before running anything that removes a container, a volume or an image.
```

## Changing sandboxr itself

### Package by package

Decides which package a change belongs in, before writing any code.

**Needs first:** A checkout of the sandboxr repository.  
**From:** [Package by package](../architecture/packages.md)

```prompt
I want to change how sandboxr behaves. Before you write anything, work out which package the
change belongs in.

Read docs/architecture/packages.md, then docs/architecture/contracts.md. Follow these rules:
logic about what a sandbox is goes in packages/core, never in packages/cli, packages/server or
packages/web; only container/ may contain shell; the browser app renders what the API sends and
decides nothing. Documentation is updated in the same change that makes it true.

Tell me which package you picked and why before you edit anything. Stop and ask me if the change
would alter a boundary described in contracts.md — that file has to change first, in its own
commit message.
```

**Next:** [Cheat sheet](cheat-sheet.md) for the commands these prompts run, or
[Start here](../getting-started/index.md) if you have not set the machine up yet.
