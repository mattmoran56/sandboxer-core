# syntax=docker/dockerfile:1.7
#
# The sandboxr base image: everything that is true of every sandbox and nothing
# that is true of one project.
#
# Build context is `container/`:
#     docker build -f base/Dockerfile -t sandboxr/base:<version> container/
#
# There is no toolchain here, no database engine and no project dependencies. A
# project's layer adds exactly what its `toolchain:` and `database:` blocks
# declare, on top of this. Keeping the split means one base serves a Go/MySQL
# monorepo and a single-worker project on a file database, and the second of those
# stays cheap -- most of why a Workers sandbox costs almost nothing is that it
# never installs a database server.

# --- caddy -------------------------------------------------------------------
# A static Go binary, so it is safe to lift out of an Alpine image into a
# glibc one.
FROM caddy:2-alpine AS caddy

# --- runtime -----------------------------------------------------------------
# Debian bookworm, and specifically NOT a vendor MySQL image.
#
# The obvious base for a project that needs MySQL is the official MySQL image
# with a toolchain layered on. It does not work: that image is Oracle Linux 9,
# whose glibc is 2.34, and Cloudflare's `workerd` -- which anything running
# miniflare or `wrangler dev` needs -- requires 2.35. It fails with
# `GLIBC_2.35 not found` and no amount of configuration helps.
#
# Bookworm has glibc 2.36 and satisfies workerd, sharp, and every other native
# Node module. The cost is installing MySQL separately, which the project layer
# does when a project asks for it.
FROM debian:bookworm-slim

ARG TARGETARCH
ARG S6_VERSION=3.2.1.0
# The same pin as dashboard/Dockerfile, deliberately. Two images sandboxr builds
# itself, both with a `gh` in them, is already one more than anybody wants to
# reason about; two *versions* of it would mean a pull request that works from
# the dashboard and not from a sandbox looks like a sandbox bug. Bump both or
# neither.
ARG GH_VERSION=2.63.2

SHELL ["/bin/bash", "-o", "pipefail", "-c"]
ENV DEBIAN_FRONTEND=noninteractive

# jq is not optional: the plan is JSON, this image deliberately has no Node, and
# hand-rolling a JSON parser in shell is how these scripts would start lying
# about what the plan says. gettext-base supplies envsubst, which expands the
# plan's environment templates without running a shell.
RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      ca-certificates curl xz-utils zstd gzip \
      git procps psmisc iproute2 \
      jq gettext-base tzdata \
 && rm -rf /var/lib/apt/lists/*

# Architecture, resolved rather than assumed. Every arch switch in this image and
# in the generated project layer uses this shape, and the reason is worth the
# paragraph:
#
# `TARGETARCH` is a *BuildKit* built-in. The legacy builder never sets it, and
# `docker build` falls back to the legacy builder wherever buildx is absent --
# which is exactly the dashboard's container, since dashboard/Dockerfile ships
# the docker client alone, on purpose. So every image build started from the
# browser saw a `TARGETARCH` that was never declared, and the failure took
# whichever disguise the block wore: under `set -u` a hard `TARGETARCH: unbound
# variable` from bash before the case was even reached; without it, a fall
# through to the `*)` arm and "unsupported arch " with nothing after it; and
# where the value is interpolated into a URL rather than matched,
# `linux-${TARGETARCH}/minio` became `linux-/minio` -- a 404 that reads as a
# broken mirror. The first line of the output was the builder's own deprecation
# notice in every case, so the symptom named Go, or a download, or a
# deprecation. Never the architecture.
#
# Hence: take `TARGETARCH` when the builder supplied one, fall back to `uname -m`
# otherwise, and accept both spellings, because uname says x86_64/aarch64 where
# Docker says amd64/arm64. The host also passes `--build-arg TARGETARCH` (see
# `archBuildArgs` in packages/core/src/docker.ts); the fallback is what keeps a
# hand-run `docker build` working when nobody passes it.
#
# `${TARGETARCH:-}` and never a bare `${TARGETARCH}`: these run under `set -u`,
# where expanding an ARG the builder never declared exits 2 with "parameter not
# set" -- a second failure wearing the same disguise as the first.
RUN set -eux; \
    ARCH="${TARGETARCH:-}"; \
    if [ -z "$ARCH" ]; then ARCH="$(uname -m)"; fi; \
    case "$ARCH" in \
      arm64|aarch64) S6_ARCH=aarch64 ;; \
      amd64|x86_64)  S6_ARCH=x86_64  ;; \
      *) echo "unsupported arch $ARCH" >&2; exit 1 ;; \
    esac; \
    curl -fsSL "https://github.com/just-containers/s6-overlay/releases/download/v${S6_VERSION}/s6-overlay-noarch.tar.xz" \
      -o /tmp/s6-noarch.tar.xz; \
    curl -fsSL "https://github.com/just-containers/s6-overlay/releases/download/v${S6_VERSION}/s6-overlay-${S6_ARCH}.tar.xz" \
      -o /tmp/s6-arch.tar.xz; \
    tar -C / -Jxpf /tmp/s6-noarch.tar.xz; \
    tar -C / -Jxpf /tmp/s6-arch.tar.xz; \
    rm -f /tmp/s6-*.tar.xz

# Object storage, so nothing a sandbox does can reach a real cloud bucket. It is
# in the base rather than a project layer because a public sandbox writing to
# production storage is the kind of mistake that must be impossible rather than
# configurable -- the endpoint the code sees is local whatever the project asked
# for. The two binaries are the largest thing in this image after the agent
# binary below; that is the price of the guarantee.
#
# The arch goes straight into the download path here, so an unresolved one is a
# 404 rather than an error about architecture -- see the note above the s6 block.
RUN set -eux; \
    ARCH="${TARGETARCH:-}"; \
    if [ -z "$ARCH" ]; then ARCH="$(uname -m)"; fi; \
    case "$ARCH" in \
      arm64|aarch64) MINIO_ARCH=arm64 ;; \
      amd64|x86_64)  MINIO_ARCH=amd64 ;; \
      *) echo "unsupported arch $ARCH" >&2; exit 1 ;; \
    esac; \
    curl -fsSL "https://dl.min.io/server/minio/release/linux-${MINIO_ARCH}/minio" -o /usr/local/bin/minio; \
    curl -fsSL "https://dl.min.io/client/mc/release/linux-${MINIO_ARCH}/mc"      -o /usr/local/bin/mc; \
    chmod +x /usr/local/bin/minio /usr/local/bin/mc

# Claude Code, in the base rather than a project layer, because a session runs
# *inside* the sandbox: the host reaches in with `docker exec` and runs
# `claude -p --output-format stream-json ...` (see
# packages/core/src/agent/launch.ts). The binary therefore has to be in every
# image, not in the ones whose project happened to ask for an agent -- a sandbox
# that is missing it fails at the moment somebody opens a session, which is the
# worst possible time to discover a build decision.
#
# The native installer, and specifically not `npm install -g
# @anthropic-ai/claude-code`. This image has no Node and the paragraph at the top
# of the file is the reason it stays that way; pulling a whole runtime in for one
# binary that never calls it would undo that for nothing. The native installer
# ships a self-contained executable -- same binary the npm package downloads,
# without the runtime around it.
#
# No `TARGETARCH` case here, unlike every other download in this file, and that
# is deliberate rather than an omission: install.sh resolves the platform from
# `uname -m` itself, and it resolves it correctly under emulation, because a
# cross-arch buildx build executes this RUN on the target architecture. Passing
# it an arch is not a thing it accepts.
#
# HOME is forced because this is a home-directory installer: it puts a launcher
# at `$HOME/.local/bin/claude` pointing into `$HOME/.local/share/claude/versions`,
# and no `.local/bin` is on anyone's PATH here. Left at the default the install
# succeeds, prints its own warning about PATH, and then `docker exec <container>
# claude` fails with "executable file not found" -- a missing-binary error for a
# binary that is present, at the moment somebody opens a session.
#
# So: install under /opt, then symlink into /usr/local/bin, which the ENV below
# keeps on the PATH a non-login `docker exec` gets. A symlink rather than
# installing straight into /usr/local because the installer owns the shape of
# that tree -- launcher, `versions/`, whatever it grows next -- and we own one
# link into it. If the layout changes, the link moves; nothing else here knows
# what is behind it.
#
# The cost is roughly 240 MB, which makes this the largest single thing in the
# image. It buys a sandbox where a session is already possible rather than one
# more thing to install first.
RUN set -eux; \
    export HOME=/opt/claude-code; \
    mkdir -p "$HOME"; \
    curl -fsSL https://claude.ai/install.sh | bash; \
    ln -sf "$HOME/.local/bin/claude" /usr/local/bin/claude; \
    rm -rf "$HOME/.claude/downloads"

# An image is a pinned artefact and the agent binary is part of it. Left to
# itself Claude Code updates in the background, and in a container that update
# lands under the *session's* HOME (/root), not the /opt tree /usr/local/bin
# points at -- so it would neither take effect nor survive the container, while
# two sandboxes built from one image slowly disagreed about what they were
# running. Rebuild the image to move version.
ENV DISABLE_AUTOUPDATER=1

# --- gh, and a git that works ------------------------------------------------
#
# `gh` is in the base for the same reason `claude` is: the point of a sandbox is
# that the branch in it can be finished, and finishing a branch ends in a pull
# request. A sandbox that can run the tests and cannot open the PR sends you back
# to the host for the last step, which is the step you were trying to delegate.
#
# The release tarball rather than the apt repository: adding a repository means a
# key, a sources list and an `apt-get update` layer that invalidates on every
# rebuild, for one static Go binary. Measured on arm64 the binary is 50 MB and
# the image goes from 625 MB to 672 MB — the second-largest single thing here,
# after the ~240 MB `claude` costs.
#
# The arch switch is the shape the s6 block explains at length; the value goes
# straight into a download URL here, so an unresolved one is a 404 rather than an
# error mentioning architecture.
RUN set -eux; \
    ARCH="${TARGETARCH:-}"; \
    if [ -z "$ARCH" ]; then ARCH="$(uname -m)"; fi; \
    case "$ARCH" in \
      arm64|aarch64) GH_ARCH=arm64 ;; \
      amd64|x86_64)  GH_ARCH=amd64 ;; \
      *) echo "unsupported arch $ARCH" >&2; exit 1 ;; \
    esac; \
    curl -fsSL "https://github.com/cli/cli/releases/download/v${GH_VERSION}/gh_${GH_VERSION}_linux_${GH_ARCH}.tar.gz" \
      -o /tmp/gh.tgz; \
    tar -xzf /tmp/gh.tgz -C /usr/local --strip-components=1 \
      "gh_${GH_VERSION}_linux_${GH_ARCH}/bin/gh"; \
    rm -f /tmp/gh.tgz

# Send git's https credentials through gh, exactly as dashboard/Dockerfile does.
#
# This is the half of "an agent can open a pull request" that is not `gh`: `gh pr
# create` pushes the branch first, over https, and a `gh` that is logged in does
# nothing for `git` on its own. `gh auth setup-git` would write this, but it
# refuses to run without a credential and there is none at build time — so the
# line it would have written is written here, where it needs no credential of its
# own. It only says where to go and get one.
#
# With no GH_TOKEN in the container the helper simply answers nothing, and a push
# fails the way an unauthenticated push always did.
RUN git config --system credential.https://github.com.helper '!gh auth git-credential'

# git refuses to operate on a repository owned by another uid, which is what a
# bind-mounted worktree looks like from inside a container on Linux: the files
# belong to the host user and everything here runs as root. Without this, every
# git command fails with "detected dubious ownership" — which reads like
# corruption rather than a permission policy, and sends you looking for the wrong
# bug. (On Docker Desktop's macOS VM the files already appear as root, so this is
# the line that keeps a Linux host behaving like the laptop it was written on.)
#
# Blanket, and deliberately so, for the reason dashboard/Dockerfile gives: the
# protection waived is against operating on a repository *another user* planted,
# and the only repository here is the one worktree this sandbox was started for.
# The container is the boundary, not this setting.
RUN git config --system --add safe.directory '*'

# Never prune worktree admin entries, whatever their age.
#
# A sandbox mounts one worktree and the repository behind it, so from in here
# every *other* worktree of the same project — all of them alive on the host —
# has a `gitdir` file pointing at a path that does not exist, which is precisely
# git's definition of prunable. `git gc` prunes those, and `git commit` runs
# `gc --auto` on its own, so a single commit inside one sandbox could delete the
# host's registration of somebody else's worktree once it aged past the
# three-month default. Nothing in a sandbox has the information to make that
# judgement, so it never makes it.
RUN git config --system gc.worktreePruneExpire never

COPY --from=caddy /usr/bin/caddy /usr/local/bin/caddy

# /command is where s6-overlay puts s6-svc, s6-rc and with-contenv. It is on the
# PATH for supervised services but not for `docker exec`, which is how both the
# CLI and an agent reach in to restart one process.
ENV PATH="/command:/usr/local/bin:${PATH}"

COPY scripts/ /opt/sandboxr/scripts/
COPY base/s6/ /opt/sandboxr/s6/

RUN chmod -R 755 /opt/sandboxr/scripts

# The skeleton's bundle directories are empty, so git needs a placeholder in each
# to track them at all. s6-rc-compile reads a bundle's contents.d as a list of
# service names, so the placeholder is removed here rather than relying on the
# compiler to skip it.
RUN find /opt/sandboxr/s6 -name '.gitkeep' -delete

# /empty is where a migration command runs when the project declares no workdir,
# so no dotfile lying around the repo can shadow the environment the sandbox
# passed in.
RUN mkdir -p \
      /sandboxr \
      /run/sandboxr \
      /var/log/sandboxr \
      /var/lib/sandboxr/bin \
      /var/lib/sandboxr/data \
      /var/lib/sandboxr/blob \
      /var/lib/sandboxr/schema \
      /srv/www \
      /workspace \
      /empty \
 && chmod 555 /empty

RUN caddy version && minio --version | head -1 && jq --version && claude --version \
 && git --version && gh --version | head -1 && ldd --version | head -1

# STAGE2_FAILS=0 keeps the container alive when a oneshot fails, because a sandbox
# whose database or migrations broke is precisely the one worth opening a shell in.
# WAIT_FOR_SERVICES_MAXTIME=0 removes the start-up deadline: a first-boot restore
# legitimately takes minutes and must not be treated as a hung service.
ENV S6_BEHAVIOUR_IF_STAGE2_FAILS=0 \
    S6_KEEP_ENV=1 \
    S6_CMD_WAIT_FOR_SERVICES_MAXTIME=0 \
    SANDBOXR_SANDBOX=true

# The entrypoint composes the service tree from the plan and then execs /init.
# It cannot be /init directly: s6 compiles its service database once, before any
# service runs, so the set of services has to be settled first.
ENTRYPOINT ["/opt/sandboxr/scripts/entrypoint.sh"]
