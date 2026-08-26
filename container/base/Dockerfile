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
# for. The two binaries are the largest thing in this image by a wide margin;
# that is the price of the guarantee.
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

RUN caddy version && minio --version | head -1 && jq --version && ldd --version | head -1

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
