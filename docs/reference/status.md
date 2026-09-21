---
title: What is built
description: What has been run for real, what is written but unproven, and what does not exist at all.
---

sandboxr is early. This page is the honest inventory, so no other page has to carry a disclaimer.

Read it before you trust anything. Where a page describes something that has never been run, this is
where it says so.

## What has been run end to end

The Workers demo in `examples/demo-worker` has been taken all the way through.

- `sandboxr init` set up the network, built the base image, issued a certificate, and started the
  router and the dashboard.
- `sandboxr up` built a project image layer, started a container, created its D1 database, ran the
  project's own migrations, applied fixtures, and served a page over HTTPS.
- It was then run **twice at once**, from two git worktrees. Each had its own database, its own
  hostname and its own container.
- Bidirectional editing was checked. A file changed on the host appeared instantly inside the
  container. A file written inside the container appeared in `git status` on the host.
- `ls`, `logs`, `config` and `doctor` have all been run for real.
- **The mounted secrets file has been run end to end on a live sandbox.** A credential in
  `~/.sandboxr/secrets/<project>.env` reached a running application process, did not appear in
  `docker inspect`, and a changed value was picked up by a restart.
- The dashboard serves, redirects to HTTPS and refuses an unauthenticated request. A browser has
  loaded the login page. **That was the server-rendered dashboard this one replaced** — see below.

That is the only path proven end to end for a *project*.
[Run the demo project](../getting-started/demo-project.md) walks it, which makes it the honest
"does my machine work" check.

### A session's own lifecycle, in core

One more thing has been run against a real daemon, and it is worth stating separately because
nothing a person can type reaches it yet.

`packages/core/src/session/` was driven directly: the workstation image built, a session created,
its work volume and container inspected, a repository initialised and committed inside `/work`, the
workstation stopped and started again with the commit still there, a second session of the same
name given an id of its own, a taken id refused by name, and both sessions deleted — leaving no
container, no volume and no file behind. Inside the container, `git`, `gh` and `claude` answered,
the commit identity crossed as `GIT_AUTHOR_*` and `GIT_COMMITTER_*`, and **there was no Docker
client and no daemon socket**, which is the security claim §12.3 makes and the one worth checking
by hand rather than believing.

**What that does not settle** is everything a session is *for*: no runtime was created, no agent
ran, and no idle clock was involved. See the last section.

### A session on the dashboard's API

The dashboard now answers for a session over HTTP: `/api/sessions` lists them, makes one, fetches
one, deletes one, starts and stops a workstation, lists the repositories on a work volume, puts one
there, and serves the file explorer and the branch diff against a workstation rather than a sandbox.

**Putting a repository into a session has been run for real**, which matters because it was the one
thing missing: a session could be made and could say what was on its volume, and there was no way to
put anything there. A real repository — a monorepo of about a gigabyte — was cloned onto a real work
volume through the route, in twenty-four seconds, and then read back through the same API.

**Making and naming a session has been run for real too.** Against a live daemon, `POST
/api/sessions` with an **empty body** made four sessions in 0.37s, 0.60s, 0.64s and 1.39s — each one
coming back `running`, with an id core derived (`session`, then `session-vlfc` and two more carrying
a collision token). `PATCH /api/sessions/:session` then named one, a `GET` and the list both read the
name back, an empty name cleared it — removing the file rather than emptying it, so the answer's
`name` was `null` and the id was untouched — and a password covering one project was refused with
403 on both the rename and the clear while still being able to *list* the session. All four were
deleted through the API, leaving no container, no volume and no file behind.

Those timings are a machine whose workstation image was **already built**. A machine with no such
image still builds one on the first create, and that path was not timed here; what changed is that
`sandboxr init` now builds the image alongside the base and the dashboard, so an ordinary machine
does not meet it. That `init` builds it is covered by a unit test rather than by a real run — running
`sandboxr init` against the live machine was not something to do while somebody was using it.

The rest of the surface is still only exercised against a fake core and a fake Docker daemon, so for
those routes what is proven is the route table, the access rules and the shapes, rather than that the
call reaches a daemon and gets a container back.

<details>
<summary><b>Fact sheet</b> — the clone route, and what was checked by hand</summary>

**The route** is `POST /api/sessions/:session/repos`, with a body of `{ project, branch, start? }`.
`project` is the workspace directory name, which is also the key a password's grant is held against
— one name for both, deliberately, because a second one would be a second thing to get wrong and the
thing it would get wrong is an access check. It answers `201` with `{ repo, dir, branch, head }`,
where `head` is the full commit sha the checkout was created at.

**It is checked against that project's grant**, not against a password covering the whole machine.
Cloning a project into a session reaches into that project, exactly as the file explorer does. A
project the password does not cover answers `404` **in the same words** a project that is not in the
workspace gets, so a narrow password cannot learn which projects exist by reading the difference
between two refusals.

**An agent cannot reach it.** The workstation token opens five routes and this is deliberately not
one of them: a token covers every project of its session, so opening the clone to one would let an
agent pull any project on the machine onto its own volume and then run it. A session runs the code
it already has, and what it has is what a person put there.

**It answers synchronously and it is slow** — a fetch of the remote plus a clone that really copies
objects, because a work volume is a different filesystem and git's hardlink optimisation cannot
apply. There is no streaming form because the action table has no session scope yet.

**What was checked on the live run**, beyond the clone succeeding: `origin` in the checkout is the
forge's URL and not the container-local source path; there is no `objects/info/alternates`, so the
clone is self-contained rather than depending on a host path no container can resolve; and the
branch has an upstream of `origin/main`, which is true only if the mirror's remote-tracking refs were
fetched on top — the half a plain clone of a bare mirror gets wrong, landing a session on whatever
the branch looked like the day the machine first saw the project.

**The refusals were each run once**: a second clone of a branch already there, a branch that resolves
nowhere, a project the workspace does not hold, a project a narrow password may not see, and two
branch names that want one directory — which is a `409` naming both branches rather than a checkout
written over somebody's work.

**What has not been run** is `start` on a stopped workstation, and the runtime routes below.

</details>

### A session in the dashboard

The browser app is organised around a session now, sidebar included. **New session** is in the
top bar of every screen, at the head of the session column, on the home page and on a project's
pane — and it asks for nothing: one click makes a session and lands you in it. The id is the
server's to choose, because the id is the address; the **name** is set afterwards, on the
session's own pane, and a session nobody has named shows its id as its title.

**The sidebar lists sessions.** It was the list of worktrees; the rows are drawn the same way —
a state dot at the head, the name, the id or what the session holds under it, one thing at the
right-hand end — so nothing about reading the column changed but what is in it. `/sessions` is
that same list given a screen, which is what the phone's tab bar switches to.

**`/sessions/<id>` opens on its agent**, with its checkouts, its runtimes and the controls over
its container in a column that slides out beside it. It is the shape a worktree's pane already
had, and literally the same two components.

**Worktrees are untouched in everything but where they are listed.** Every sandbox on this
machine is on a worktree and every one of them still has its own pane. `/worktrees` is the whole
list, at every width — linked from the foot of the session column and a tab on the phone — and a
project's own pane lists its worktrees with a **Start** beside each, which is where one is
managed from now.

**New worktree has gone as an action, and `/new` with it.** Code is added to a session instead,
from inside the session. The one thing that form could do and nothing else now can is cut a
*new* branch from a base; starting a branch that already exists is unchanged.

**A worktree can now be made into a session, and the uncommitted work comes with it.** **Make a
session** is beside the Start on a project's pane and in the Worktree panel of a worktree's own
pane. It copies: the worktree is not moved, emptied or removed, and whatever is running on it
carries on. The part that needed building rather than wiring is the uncommitted work — a session
holds a clone, and a clone carries committed state only — so the worktree's dirty state is read
as a patch and applied on top of the fresh checkout, untracked files included. Reading it writes
nothing into the worktree: the index is copied and git pointed at the copy, and the worktree is
never mounted into a container. A worktree that already has a session says so instead of offering
to make a second.

This has been run against a real daemon, on a real 1 GB project, both ways: a clean worktree in
eighteen seconds, and one with twenty uncommitted files — eighteen edits, a deletion and a rename —
in sixteen. The session's copy of that uncommitted work was compared with the worktree's and is
byte-identical. Both worktrees were untouched afterwards, and both sessions were deleted.

**The refusals have not been driven against a daemon** — a narrow password, a failed carry, an
unreadable volume — only against a fake one. And the buttons have not been opened in a browser;
they are tested in jsdom, like everything else in the app.

> [!WARNING] A session's conversation does not connect
> The pane dials `/sessions/<id>/agent`, which is the address the contract names, and the
> server's agent socket still only accepts a sandbox's `/p/<project>/s/<slug>/agent` — it
> refuses anything else with a 404 before it even checks the cookie. So a session's pane shows
> **disconnected** and a Reconnect that will keep failing. Everything in the column beside it
> works. Nothing was stubbed to hide this, and nothing about the server was changed to make it
> look otherwise.

**Nothing in the browser app has been opened in a browser.** It is tested in jsdom against the
shapes the server really answers with, which catches a pane wired to the wrong route and says
nothing at all about how any of it looks or feels. That is true of the two code views, the
session column and the session pane alike.

**The sidebar is sessions now**, and a session has a conversation. What it still has not got is a
terminal, any action from §8's table, or a voice — so a worktree remains the only place some of a
day's work can be done, and a project's own pane is where a worktree is managed.

### How an agent asks for a runtime

A session's agent lives in a container with no Docker socket, and is never getting one. So there is
now a way for it to *ask*: three routes that start, stop and remove a runtime, and a small MCP
server — `sandboxr` — whose tools are those routes and nothing else.

The rule the whole thing rests on is that **a session may only run a repository and branch already
on its own work volume**. The dashboard checks that against the volume's own listing, never against
what the request claimed, so an agent can run the code it has and nothing else. Its credential is a
token the dashboard mints for one session and one agent run — not the person's password, and not
usable against any other session, which comes back as "no such session" rather than as a refusal
that would confirm the other one exists.

<details>
<summary><b>Fact sheet</b> — the runtime routes and the <code>sandboxr</code> MCP server</summary>

**The server has been copied into a workstation and started by a real agent; no model has called a
tool through it.** See the section below for what a live run showed and where it stopped. What has
also been run is both halves in isolation: the routes over real HTTP against a fake core and a fake
daemon, and the MCP server as a child process over a real stdio pipe against a real HTTP server,
asserting the JSON-RPC exchange and the bearer on every call.

**The routes** are `POST /api/sessions/:session/runtimes`, `POST /api/sessions/:session/r/:runtime/stop`
and `DELETE /api/sessions/:session/r/:runtime`, plus `GET /api/sessions/:session` and
`…/repos`, which an agent needs to know what it may run. All five accept either the workstation
token or an ordinary dashboard login; everything else on the server refuses the token. The list is
pinned by a test, because a route added to it is a capability handed to the least supervised process
on the machine.

**The tools** are `list_repositories`, `list_runtimes`, `start_runtime`, `stop_runtime` and
`delete_runtime`, in `packages/server/src/session-mcp.js` once built. It reads
`SANDBOXR_SESSION_API`, `SANDBOXR_SESSION_TOKEN` and `SANDBOXR_SESSION` from its environment, and
says which of them is missing rather than calling a URL with a hole in it.

**Refusals, and what each one means.** A checkout that is not on the volume is a `404` naming what
was asked for. A volume that could not be *read* is a `503` carrying the reason and starts nothing —
"no repositories" is never an answer, because an agent told its own code does not exist will try to
clone it again. A runtime name already in use is a `409` in core's words: a name is unique within a
session, so the second is refused rather than replacing the first. A delete takes no `force`.

**The slug is never derived by the route.** It is a function of the session, the runtime name and
that project's DNS ceiling, and the ceiling is declared by a `sandboxr.yaml` inside the work volume
the host has no copy of. The answer carries the runtime core really started.

**What a real run would still settle:** whether a model can drive these tools usefully — whether
`start_runtime` refusals read as actionable, and whether an agent reaches for `stop_runtime` rather
than leaving containers running.

</details>

### Talking to the agent in a session

A session opens into a conversation with its own agent, at `WS /sessions/<session>/agent`. It is
the worktree's agent socket in a different container: the same messages in both directions, so the
dashboard draws the two conversations with one component. The agent starts at `/work`, the top of
the session's own disk, rather than inside any one checkout — a session can hold several
repositories or none, and the answer to "where am I" must not change the next time somebody clones
something.

It is handed a credential of its own: a token minted for that one agent run, which opens that one
session's routes and nothing else on the machine, and is handed back the moment the process ends.
The `sandboxr` tools reach it as a single file copied into the container when the agent starts —
never mounted, because a workstation may not be given a path back into the installation.

<details>
<summary><b>Fact sheet</b> — what the live run showed, and where it stopped</summary>

**Run against a live daemon.** A session was created (`POST /api/sessions`), the socket opened, and
one message sent. `claude` started inside `sandboxr-ws-<session>` and reported `cwd=/work`, forty
tools, and `mcp: [{ name: "sandboxr", status: "connected" }]` — the MCP server was copied in,
executed by the agent's own process, and completed its handshake. The turn ran and returned a
`result`.

**No model answered, and no tool call was made.** The turn ended on `Failed to authenticate: OAuth
session expired and could not be refreshed`. That is the machine's credential, not the socket: the
dashboard shares the host's Claude login as `~/.claude/.credentials.json`, and on macOS that file
is a *copy* of a credential the login keychain holds. The copy's refresh was rejected and Claude
Code wrote the file back with its tokens blanked — which is exactly what the server's `hasLogin`
is written about, reached from a workstation for the first time. Every sandbox on such a machine
shares that one file, so the fix is the machine's: put a login back in it, or run `claude
setup-token` on the host and set `SANDBOXR_CLAUDE_TOKEN`.

**Two things were found by running it rather than by reading it.** The sandbox's `with-env` prefix
is fatal in a workstation, whose image ships no `/opt/sandboxr/scripts`: the exec failed before
`claude` was reached and the stream reported it as "Claude Code exited without starting a session".
And the copied MCP file has to be `.mjs` — an ES module named `.js`, with no `package.json` beside
it, is read by node as CommonJS and dies on its first `import`, which Claude Code reports only as a
server that failed to start.

**What is not there.** No side questions: `/btw` forks a worktree's conversation and a session is
not on a worktree, so it is refused with a sentence. No session terminal and no session actions —
neither exists yet. Opening a conversation needs a password that covers every project, because a
workstation carries the machine's GitHub token and the shared Claude credential store.

</details>

## What is written and tested, and has never been run against a real project

Nothing in this list is expected to be *structurally* wrong. All of it is expected to have at least
one thing wrong in the details.

| Area | What a real run would settle |
|---|---|
| **MySQL, all of it** | Data-directory initialisation, the app user and its grants against a live server, restoring a real dump, and the schema snapshot |
| **Compiled backends** | None has been built or run. The staleness check and the build-failure pause are untested against a real compiler |
| **Bundled front-end builds** | Nothing with a real bundler has been built in a sandbox. The memory refusal and the out-of-memory hint are untested against a real build |
| **Dependency seeding** | The seed from `/opt/deps`, the lockfile-hash mismatch that falls back to a real install, and the workspace bin re-linking |
| **Toolchain resolution** | That a prefix such as `1.26` or `24` picks the release a project meant, on both processor architectures |
| **The service graph under load** | It boots for a two-service plan. Five backends, a dev server and a first-boot restore have not been started together |
| **The dashboard's actions and terminal** | Its security properties are unit-tested. The terminal has not been opened against a real sandbox |
| **The dashboard's browser app** | All of it. See below |
| **`sqlite`** | The `d1` path has run. The plain `sqlite` driver has not |
| **A `private` project** | The forward-auth middleware and the dashboard's `/auth/verify` are both written. The pair has not been exercised together |
| **Agent sessions** | See below |
| **Side questions (`/btw`)** | See below |
| **A sandbox expiring on its own over a full lifetime** | See below |
| **Removing an image** — `sandboxr prune --yes`, and the same images under `sandboxr gc` | See below |
| **`gh` against a private repository** | Pull requests list against a public repo. Cloning and fetching a private one from inside the dashboard container, using the mounted `gh` credentials, has not been done |
| **The orchestrator, voice and Telegram** | See below |

### The dashboard's browser app

**All of it is unproven.** `@jef/web` replaced the server-rendered pages wholesale: the
sidebar, the worktree list and its groupings, the panes, settings, the themes.

Its pieces are unit-tested and its API is typed at both ends. **Nobody has sat in front of it and
taken a project through a day's work.**

#### On a phone

**Nothing here has been run on a phone.** The dashboard declares itself installable, lays itself out
for a narrow screen, and carries the touch behaviour a native app has — a tab bar that floats over
the pane and recedes as you scroll, swipe-to-go-back, dialogs that are sheets inset from the display
and drag away by the header, the notch and the home indicator accounted for.

**Checked:** the manifest, the service worker and the four icons are served with the right types and
cache headers, and everything not on that list of six is refused. The gesture thresholds, the
keyboard-inset arithmetic, the tab bar's current-section logic, the rule that decides when it recedes
and the sheet's drag all have unit tests.

**Checked, and worth naming separately because it is the part that fails invisibly: the contrast
arithmetic.** Every ink in `packages/tokens/tokens.css` is a hex chosen against a ratio rather than
by eye, and `packages/web/src/app.css.test.ts` does the sums: the three inks against every neutral
surface in both themes, each status colour against its own tint and against the surface, and each
scheme's brand as link text and as the fill under a primary button's label. It pins one *failure* as
a failure — `ink-subtle` does not clear AA on a tinted surface — because that is the rule the token
is used under, and a rule nobody can fail is a rule that gets forgotten.

**Checked: the build emits what the stylesheet declares.** The bundle really does contain the sheet
radius and the coarse-pointer and safe-area rules. That is worth checking because a Tailwind utility
that never reaches the build has no symptom on a desktop.

**Checked: the material carries no glass.** There is no `--sb-glass` token, no `glass` utility and no
`[data-transparency]` block, and a test asserts their absence rather than their behaviour. The bars
and sheets are solid surfaces with a hairline; `--shadow-card` and `--shadow-panel` are `none`.

**Not checked: how any of it looks or feels on a device.** Nobody has added it to a Home Screen and
launched it; nobody has confirmed the status bar reads correctly in both themes; nobody has seen a
hairline at a real pixel density, over a scrolling log, at a real refresh rate. The swipe thresholds,
the scroll hysteresis that decides when the bar draws back, and the sheet's settle animation are
judgements about a thumb that have been reasoned about and not felt. The icons have been looked at as
images but never as an icon on a wallpaper.

**What a real run would settle:** whether the back gesture ever fights the log tail or the terminal
in practice, whether the tab bar's four sections are the right four, whether a bar that recedes on
scroll is a relief or a thing you keep chasing, whether a one-pixel line holds a card together at
arm's length on a phone, and whether a sheet dragged from its header is discoverable without the
handle being explained.

### Agent sessions

<details class="facts">
<summary><b>Fact sheet</b> — exactly what has been run, and what has not</summary>

**Run for real:**

- The base image's smoke check runs `claude --version` on the same PATH `docker exec` gets, so an
  image a session could not start in fails the build.
- The command that reads a worktree's slash commands has been run against a live sandbox. The list of
  built-ins was taken from the `claude` binary in the image, and checked against the commands a live
  session announces on start, rather than written from memory.
- The shared credential volume has been run end to end on a live sandbox. A server added inside one
  `docker exec` was still there in the next, and still there after the container was restarted.
- **Permission prompts have been run end to end against a live `claude` in a sandbox.** A question
  reached the host, each of the three answers was sent back, the tool ran or did not, and an "always"
  stopped the next identical call asking. That was against a local stand-in for the API, so the
  exchange is proven and no model wrote any of it.

**Unit-tested only:** the stream parser, the transcript store and the launch arguments.

**What a real run would settle:** whether a session opened from the dashboard does useful work on a
branch; how often `auto`'s classifier escalates in practice; and how much the one remaining known
limit — no claude.ai connectors on a setup-token — costs.

</details>

### Side questions (`/btw`)

<details class="facts">
<summary><b>Fact sheet</b> — built and unit-tested; the one thing that has not been run</summary>

**Built and unit-tested end to end on the host side:** the argument vector, the second process and
its key, the empty tool set, the parent-to-fork link surviving a reload, and the conversation
staying untouched and usable while a fork runs.

The flags were checked against the shipped `claude` rather than assumed. `--session-id` with
`--resume` is refused unless `--fork-session` is also given, which is the binary confirming the
combination sandboxr uses, and the id sandboxr chooses is the one the run reports back.

**What has not been run is a real fork against a real conversation.** Proving that the forked session
actually inherits what was said before it costs a model turn, and none has been spent. Until it has,
treat "the fork sees the conversation so far" as Claude Code's documented behaviour rather than as
something sandboxr has watched happen.

</details>

### Removing an image: `sandboxr prune --yes` and `sandboxr gc`

`prune`'s report has been run against a live daemon with two projects and 440 build cache records on
it, and its figures match `docker system df`.

**No image has been removed by either command.** `gc` now takes the same superseded project images
`prune` offers, and the decision — which image is replaced, which is protected, which is still held
by a container — is unit-tested against a fake daemon in both. What a real run would settle is that
`docker image rm` accepts the references the plan builds, and that the space the report promised is
the space that comes back.

The removals are deliberately separable: `gc` asks `docker system df` in a `try`, so a daemon that
will not answer costs the image reaping and not the sandbox reaping, which has been run for real.

## The orchestrator, voice and Telegram

The newest layer, and the one whose split between "run" and "not run" is sharpest, because
half of it is host software and half of it is a microphone.

**What is built and tested in software, end to end.** The whole decision path is exercised by
the test suites, with the microphone and the phone replaced by test doubles that speak the real
wire protocols:

- The orchestrator noticing a change — a session finishing, blocking, stalling, erroring, a
  subagent failing — from the run index, the event stream and Claude Code's hooks, and deciding
  whether it is worth telling you and whether to tell or to ask.
- The voice layer speaking an update, asking a question, and — the subtle part — tracking to the
  character how much of an announcement you heard before you cut in, and rewriting the session
  history to match what you actually know.
- The Telegram layer placing a call, waiting for you to join, asking over the call, and hanging
  up; a call nobody answers treated as an unanswered question.
- The end-to-end test drives the real notifier stack through a real orchestrator: a finished
  session is announced at the desk, and an urgent notification places a Telegram call, asks over
  it, captures a barge-in, and rewrites the on-call history.

The Python sidecars' logic — the message protocols, the on-device end-of-speech endpointer, the
engine state machine, the call frame bridge — is covered by `pytest` with no audio and no
network.

The orchestrator also runs **inside the dashboard**, behind `SANDBOXR_ORCHESTRATOR`, as a
conversation you talk to — and one that raises what it noticed in that same conversation, rather
than in a list beside it. The server side of it — the notifier, the
fork-backed summariser, the Telegram config store, the sockets — is unit-tested, as is the panel
itself (the conversation, the microphone, the home page's block, the Telegram form), and the
routing of an escalation through the agent. The whole dashboard suite stays
green with the feature off, which is the safety story: unset, none of it exists.

The **conversation** is a real Claude Code session, running in its own `sandboxr-orchestrator`
container and reached with `docker exec` the way a sandbox session is. Its argument vector, its
model and mode changes, and its socket's gate are unit-tested against a fake Docker; the browser
renders it with the same component a sandbox session uses, whose own suite is unchanged. What
those tests do not cover is a real model on the other end — that needs the container built and a
Claude login on the machine.

**What has not been run, and needs your Linux VM to be.** The audio itself: Whisper, Piper and
the microphone have not been exercised by these tests, because they need a real device and real
models. Silero is the exception — its chunking and its recurrent state are checked against
faster-whisper's own batch pass wherever the model is installed, and skipped where it is not. The **browser audio** — capturing the microphone, streaming it to the
sidecar, playing the reply — is written and its toggle is tested, but the sound itself needs a
real browser and a running sidecar. A **live Telegram call** has not been placed — it needs real
credentials and a real account, and pytgcalls' audio API must be confirmed against the installed
version. Treat the `spokenChars` heard-boundary as an estimate until a real voice has been talked
over.

One thing that follows from where the voice work lives, because it is easy to read as a stronger
claim than it is. The pace, the resampling, the recogniser's filters and the moment a turn ends
are all in the engines every audio path shares (contracts §10.3.1), so a Telegram call gets them
by construction. That is not the same as having heard them on one, and nobody has.

[The orchestrator guide](../guides/orchestrator.md) has the steps to run all of this on a VM.

## The managed layer

The workspace, worktree management, the lifetime and the pull-request listing are all recent. What
has actually been run, rather than merely written:

<details class="facts">
<summary><b>Fact sheet</b> — the managed workspace, run for real and unit-tested only</summary>

**Run for real:**

- Cloning a repository into the workspace.
- Creating a worktree: for a new branch off a base, for an existing branch, and for one already
  checked out elsewhere — which comes back detached, with its branch name recovered.
- Find-or-create returning the same worktree twice.
- Listing worktrees, branches and projects.
- `loadConfig` reading a config out of a created worktree.
- Keep-alive stamping refusing to apply to a rebuilt sandbox with the same slug.
- Cloning, starting a sandbox from a branch and keeping one alive have all been driven from the
  browser, and the reaper's first pass has been observed in a real container log. **But through the
  server-rendered dashboard, which the browser app has since replaced.** The actions and their
  streams are unchanged; what has not been re-driven is the interface in front of them.

**Unit-tested only:** the whole `gh` path, which is driven from recorded output rather than the real
binary; and cloning or fetching a private repository with the mounted credentials.

**Pulling a worktree** — `sandboxr worktree pull` and the dashboard's Pull from Git — is
**unit-tested only.** Every decision it makes is driven from a fake git rather than a real
repository, and neither the command nor the button has been run against a real remote. What *has*
been run against real git is the other half: cutting a worktree fetches first, and the test suite
drives both outcomes on a real repository — a local branch behind the remote being fast-forwarded
onto its tip, and a diverged one being checked out where it stands with nothing moved.

</details>

### The project-level config

A project in the workspace may keep a `sandboxr.yaml` beside its mirror, for every worktree of it
that carries none of its own. See
[Projects, worktrees and lifetimes](../guides/managed-sandboxes.md).

**Run for real:** against a private monorepo cloned into the workspace with two worktrees, both of
which had had the same draft config copied into them by hand. Moving the single copy up to the
project directory and deleting both worktree copies left every worktree resolving the same config —
with `root` equal to each worktree, never the project directory it read the file from — and
`sandboxr config` naming the file it used and warning that neither worktree carries its own.

**No sandbox has yet been started from a project-level config.** That project needs a database seed
and credentials that are not settled.

**Unit-tested only:** a worktree's own config winning over the project-level one; the error when the
project-level file is the malformed one; the refusal to run a config whose root would be the
workspace project directory; and that a repository outside the workspace is unaffected.

### Building an image from the dashboard

Every Dockerfile sandboxr ships switches on the processor architecture, and `TARGETARCH` — the
variable those switches read — is set by BuildKit and by nothing else. The dashboard's image carries
the Docker client without buildx, so its builds run on the legacy builder, which sets no such
variable.

The symptom, and why it does not look like this:
[an image build fails and the first line is a deprecation notice](../troubleshooting.md#an-image-build-fails-and-the-first-line-is-a-deprecation-notice).

**Run for real, on the legacy builder inside the dashboard's own container:** the old form reproduced
the failure (`TARGETARCH: unbound variable`, exit 1). The new form built a project layer with a Go
1.25 and a Node 24 toolchain on it *with no architecture argument at all*, resolving `x86_64` from
`uname -m`. The resulting image reported `go version go1.25.14 linux/amd64` and `v24.20.0`. The same
layer was then built again with `--build-arg TARGETARCH`, which is what core now passes, and the
trace shows the argument winning over `uname`.

**Not fixed by this, and confirmed by the same experiment:** a project whose layer contains a cache
mount — one is generated for a Go module warm-up and one for a dependency install — still cannot be
built by the legacy builder, which stops at `the --mount option requires BuildKit`. So the
architecture is no longer what fails; the cache mounts are.

Building that project's image once from the host, where buildx is installed, is enough. The tag is
content-addressed, so the dashboard reuses it.

### The idle clock

Expiry measures **idleness** rather than uptime, from the shared router's access log. That signal is
recent, so here is precisely what has been done with it on a real machine.

<details class="facts">
<summary><b>Fact sheet</b> — the idle clock, run for real and unit-tested only</summary>

**Run for real:**

- The parse against a live `docker logs sandboxr-router`, which reports one last-activity time per
  sandbox and none for the dashboard or for an unrouted 404.
- A single `curl` at one sandbox moved *that* sandbox's time to the second the request arrived, and
  left the other sandbox's untouched — over a period in which the dashboard was up and
  health-probing both.
- `sandboxr expire --dry-run --json` then reported `1h 59m left, idle 21s` for the one that had been
  visited and `3h 25m left, idle 34m` for the one that had not. `--json` is where those two lines
  are: the human dry-run prints only what it would stop, and neither sandbox was due to stop.
- `keep` and `unkeep` were driven end to end, and the ttl precedence chain was exercised against a
  real `config.yaml`.

**Unit-tested only:** a router that is not running, which must yield *no* activity times rather than
"nobody used anything"; clock skew in a log line; and a request path crafted to look like a router
name.

The parse is anchored on the format Traefik writes today. If a future Traefik changed it, every
sandbox would fall back to its start time — the old behaviour — rather than being expired wrongly.

</details>

**A sandbox expiring on its own over a full lifetime has not been watched.** The reaper runs on a
real machine on its timer, and `expire` has stopped and restarted a live sandbox against a clock
moved forward by hand. Nothing has yet been stopped by the timer arriving on its own, hours later.
Nor has a sandbox been watched going quiet for a whole ttl and being stopped for it, with no clock
moved by hand.

Three limits are worth stating plainly rather than discovering later.

**Expiry only ever stops a sandbox; it never removes one.** That reclaims memory and CPU and does
nothing about disk. The container and its volumes remain, so a machine left alone still accumulates.
`gc` and `prune` are what reclaim disk, and both are still manual. Automating `gc` means destroying
databases automatically, which is not a thing to switch on untested. `prune` is the safer of the two
to put on a timer, because everything it removes is rebuildable.

**`prune` has no dashboard action.** `gc` and `expire` are buttons; this is a CLI command only. The
decision lives in core, so a dashboard action is a small addition. It has not been made.

**Nothing enforces a lifetime while the dashboard is not running.** The reaper lives in the dashboard
process, which is the only always-on component holding the Docker socket. On a laptop whose dashboard
is usually stopped, sandboxes live until something stops them. `SANDBOXR_REAP_MINUTES=0` is the
honest way to say so.

#### The same clock, for a session's workstation

A session's workstation runs on this clock as well, on the same twelve-hour default, and it is the
same code: one planner decides about both, and stopping a workstation is the only thing that
happens — no volume and no file is removed, ever, at any age.

<details class="facts">
<summary><b>Fact sheet</b> — a workstation's idle clock, unit-tested only</summary>

**Not run at all.** No workstation has been stopped by this on any machine, with a real clock or a
moved one. Everything below is unit tests against a fake docker daemon.

**Three of the four signals, because a workstation has no hostname.** A dashboard route naming the
session, an agent run in it, and a terminal or agent socket held open on it. The missing fourth is
a request to its own hostnames, and a workstation has none. Its absence is *not* read as a zero: a
session no signal reaches runs its clock from the moment its container started, which is the same
fallback a sandbox gets when its log lines have scrolled out of the window.

**Nothing writes the agent signal yet.** The join is on a run's `session` field, and no agent runs
in a workstation yet, so that field is read and never supplied. The other two signals are fed by
routes and a heartbeat that do not exist either, because there is no dashboard route for a session.
In practice a workstation's clock therefore runs from its start time today.

**Only the dashboard reaps sessions.** `sandboxr expire` still covers sandboxes alone, because the
CLI has no session surface at all.

</details>

### git and `gh` in a sandbox

Both were run against a real sandbox rather than reasoned about, because the bug being fixed was
invisible from the host.

<details class="facts">
<summary><b>Fact sheet</b> — git in a sandbox: run, not run, unit-tested only</summary>

**Run for real:** `git status`, `git log -1`, `git diff --cached` and a genuine `git commit` in a
restarted `demo` sandbox, the commit carrying the host's name and address. The commit was then reset
and the host's checkout confirmed to agree. `gh --version` and `gh auth status` reported an
authenticated account, and `git credential fill` plus an https `ls-remote` proved git's own
credential path end to end.

**Not run:** an actual `git push` and an actual `gh pr create`. Both were deliberately left undone
rather than tested against a real repository, so the last inch — a branch really arriving on a remote
from inside a container — is unproven.

**Not run:** any of this on a Linux host. The `safe.directory` line in the base image exists for
exactly that case — on Docker Desktop's macOS VM the mounted files already appear as root, so it does
nothing there — and it has been reasoned about, not exercised.

**Unit-tested only:** `gitMounts`'s four cases, the machine-config precedence for `github`, and the
mounts and variables `runArgs` produces.

</details>

Worth knowing: before this, **no git command worked in any sandbox**. A linked worktree's `.git`
names its repository by absolute path, and only the worktree was mounted. Agent sessions had been
allowlisted for `git status`, `git diff`, `git add` and `git commit` the whole time.

### Fixed after running it against a real project

**A named sandbox no longer needs `--worktree`.** `status`, `logs`, `shell` and `reload` take the
worktree from the sandbox's own label when a slug names exactly one, so they work from any directory.
Verified by running `sandboxr status <slug>` from an unrelated directory. Not unit-tested: resolving
it reads the container list, and `docker` is a module singleton the CLI tests deliberately do not
reach.

**The server's typecheck now covers its tests and fakes.** `tsconfig.check.json` inherited `exclude`
through `extends`, so `fakes.test-utils.ts` — which implements `CoreApi` — was never checked against
it. A fake missing a newly added method compiled cleanly and failed only when vitest ran it, which is
exactly how it went wrong here. Closing the gap surfaced six real type errors, including a
`testConfig` that had never gained three fields added to `ServerConfig`.

## What does not exist at all

**The half of the session model a person could reach.** §12 of
[the contract](../architecture/contracts.md) defines a **session** — an agent with a container,
holding zero or more repositories and zero or more running copies of a project — as the unit the
product is organised around, replacing the worktree. A good deal of it now exists in
`packages/core`, and none of it is reachable: no CLI command and no dashboard route creates a
session, so every page on this site still describes the worktree model, and the worktree model is
the one anybody actually uses.

What has been run against a real daemon, rather than merely written:

The **session and its workstation**. `packages/core/src/session/` makes a session, lists them,
fetches one and deletes it, and starts and stops the workstation the agent runs in. A session was
created, exec'd into, stopped, started again and deleted, and the stop removed nothing — §12.8's
first rule, and the one the whole design rests on.

The **work volume**. `session/work.ts` knows the `/work/<repo>/<branch>` layout, refuses a second
branch that would share a directory with the first, clones into `sandboxr-work-<session>` from a
short-lived container, and is the only code that may remove one. With it, `gc` and `prune` leave a
work volume alone under every rule they have — which had to land in the same change, because a work
volume the collector did not know about is somebody's uncommitted work waiting for the next
housekeeping run.

The **runtime**. `session/runtime.ts` derives a runtime's slug from its session and its name, and
`up` will start a sandbox whose `/workspace` is a checkout on a work volume rather than a bind mount
from the host. The Workers demo was cloned into a work volume, brought up as a runtime, and served
its health endpoint over HTTP — and the same project was brought up the old way from a host checkout
beside it, so the two paths were compared rather than assumed. Inside the runtime, `.git` was a real
directory, `git log` and `git status` worked with **no** second mount, and `origin` pointed at the
forge.

The **idle clock**, over a workstation as well as a sandbox. A session's activity is read from
dashboard routes naming it, an agent run joined on its session id, and a held socket's heartbeat. A
workstation has no hostname, so the router's access log says nothing about one — that signal is an
absence rather than a zero, and the clock falls back to the start time, which is the floor a sandbox
whose log lines have scrolled out of the window already relies on. Stopping on the clock removes
nothing and leaves the session's runtimes running.

Four things are not finished. The idle clock is **unit-tested only and has never stopped a
workstation on any machine** — and two of its three signals have no producer yet, because nothing
writes a run's session id and there is no `/sessions/:session` route to log, so in practice a
workstation's clock runs from its start time. `status` cannot fill in a runtime's URLs or service
health, because it reads the project's config from the sandbox's recorded workspace and a runtime's
is a path inside a volume; a caller that already has the config can pass it. There is no CLI command
for any of this. And nothing above `packages/core` calls it.



The dashboard's **API** for a session exists too, and is described above: it is tested over real
HTTP against a fake core and a fake daemon, and has not been driven against a real one.

What is still missing is the *decision* to run something. Nothing asks for a runtime — there is no
route that creates one and no tool an agent can call to ask for one — and there is no CLI command,
no session in the closed action table, and no socket into a workstation. The browser app draws none
of it, so there is no way for a person to reach a session without typing `curl`: every page on this
site describes the worktree model, and the worktree model is the one that runs.

**`db diff` and `db reset`.** The driver interface has `snapshot` but nothing that compares two, and
no verb that returns a database to a clean restore. Comparing before and after is two snapshots and
`diff`; starting clean is `down` then `up`. The container's own `db.sh` exposes a `diff` verb the CLI
does not.

**Remote deployment.** No code requests a certificate over ACME, writes a DNS record, or installs a
service unit. mkcert is the only certificate issuer.
[On a server, for a team](../setups/shared-server.md) is a plan with the arithmetic worked out, not
instructions.

**A supervised coding-agent service.** No `sandboxr.yaml` block declares an agent, and nothing in a
sandbox's service tree runs one. What does exist is `claude` in the base image and a dashboard session
that starts it with `docker exec` — see
[Agent sessions in the dashboard](../guides/agent-sessions.md), and the entry for it above.
[Your own agent in a sandbox](../guides/agents-in-a-sandbox.md) describes the other arrangement,
running your own agent against the bind mount, which is a way of working rather than a feature.

**Continuous integration.** Nothing runs the tests, the shell linting or the docs build
automatically.

**A `lint` script.** The root `npm run lint` fans out to the workspaces and no package defines one,
so it is currently a no-op.

## Where the pieces stand

| Part | State |
|---|---|
| `docs/architecture/contracts.md` | **Settled.** The authority. A package that disagrees with it is a bug |
| `packages/core` | Written and unit-tested. Run end to end once, against the Workers demo |
| `packages/cli` | Written and unit-tested. `init`, `up`, `ls`, `logs`, `config`, `doctor` run for real |
| `packages/server` | Written and unit-tested, including every security property. Partly run |
| `container/` | Written; `bash -n` and `shellcheck -x -S warning` clean. The base image, the D1 path and the generated router have been exercised |
| `packages/docs` | This site |

<details class="facts">
<summary><b>Fact sheet</b> — what was exercised against the base image and hand-written plans</summary>

- Both example plans generate a service tree and a router config, and both generated Caddyfiles pass
  `caddy validate`.
- A built app serves, a deep path falls back to `index.html`, an unbuilt app answers 503 with
  instructions, `/__sandboxr/live` answers on any hostname, and an unknown host answers 404 naming
  the host it was asked for.
- The database-init → migrate → status chain produces the right verdict for each outcome: no
  migration command gives `ok`/`skipped`; a command that fails gives `degraded`/`failed` with the
  file and error extracted; a command that exits zero while printing its own failure summary gives
  `degraded`, via `failure_pattern`; a clean run gives `ok`.
- `build-static.sh` refuses a declared memory requirement the container cannot meet, and builds and
  swaps in a directory when it can.
- The project image template renders to a lint-clean Dockerfile for three block combinations: Go +
  Node + MySQL, Node + SQLite, and Go alone.
- The base image builds and boots: s6 compiles the generated tree, the ungated services start
  immediately, `db-init` runs the driver dispatch and provisions buckets, an on-demand build lands in
  `/srv/www` and is served through the generated router, and every computed and aliased environment
  variable reaches each supervised service.

</details>

## Gaps still open in the contract

Recorded here rather than papered over. Each is a documentation bug worth fixing in
[the contract itself](../architecture/contracts.md), which lives in the repository and is
deliberately not one of these pages.

1. **§5's YAML example does not parse.** `backends:` is shown as a block sequence with a `defaults:`
   mapping key as a sibling of the list items, which is invalid YAML. The schema accepts the mapping
   form the real examples use (`backends: { defaults, services }`) *and* a bare list, so this is an
   error in the contract's prose only. These docs follow the schema.
2. **No CLI surface is pinned.** §3.4 names `ls` and `gc`; §8 says the dashboard's actions are a
   closed table but does not enumerate it. The CLI is now much larger than either, and nothing
   prevents it drifting.
3. **`env:` and `deps:` are in the schema and not in the contract.** Both are load-bearing — `env` is
   the only thing joining the sandbox's computed addresses to the project's own variable names — and
   §5 does not mention either.
4. **Seed precedence is decided in code, not in the contract.** `local`, then `file`, then
   `fixtures`, filtered by what the access rules permit. §5 lists the sources without saying which
   wins.
5. **The access layer is not in the contract.** The shared router, its label scheme, the per-sandbox
   certificate and the `init` and `teardown` verbs are all implemented in
   `packages/core/src/access` and unnamed in the contract.
6. **The forge is not in the contract.** Pull-request listing shells out to `gh`, and §5 and §6 name
   every other external the tool depends on. Which forge is supported, and what a machine without one
   is expected to do, belong there. Gap 2 covers the new `project` and `worktree` verbs but not this.
7. **§3.2 and `container/README.md` give the default domain as `sbx.lcl`.** The code says
   `sbx.localhost`, and the code is what runs. These docs follow the code.

---

**Next:** [Run the demo project](../getting-started/demo-project.md) to exercise the one proven path
on your own machine, or [Troubleshooting](../troubleshooting.md) if you have already hit one of the
gaps above.
