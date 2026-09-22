#!/usr/bin/env bash
# Run a long-running front-end under s6 supervision.
#
# The third runtime kind: a process that serves rather than a bundle that is
# built. It is the only way to sandbox a project whose app *is* a dev server, and
# it is the most expensive thing in a sandbox -- a dev server holds its whole
# module graph in memory for as long as the container lives, whether or not
# anyone opens it. That is why a project can mark one optional.
#
# The `exec` at the end is what makes s6 supervise the server itself rather than
# this shell. A supervised shell would survive `s6-svc -r`, keep its child alive,
# and hold the port -- so every replacement would die with "address already in
# use" while the old code carried on serving.
set -euo pipefail

LOG_TAG="run-server"
# shellcheck source-path=SCRIPTDIR source=lib.sh
source "${SANDBOXER_SCRIPTS:-/opt/sandboxer/scripts}/lib.sh"

LABEL="${1:?run-server.sh needs a front-end label}"
RECORD=$(service_by server label "$LABEL")
[[ -n "$RECORD" ]] || die "no long-running front-end labelled '$LABEL' in the plan"

SERVE=$(field "$RECORD" serve)
[[ -n "$SERVE" ]] || die "front-end '$LABEL' declares no serve command"

PKG_DIR="$WORKSPACE/$(field "$RECORD" root .)/$(field "$RECORD" package .)"
[[ -d "$PKG_DIR" ]] || die "no package directory at $PKG_DIR"

"$SANDBOXER_SCRIPTS/build-server.sh" "$LABEL"

# One writer per file-backed database (contracts §6.1). Two processes opening the
# same file deadlock, so the database's directory is handed only to the service the
# config names as its owner; every other server runs without it and fails loudly
# on a missing binding rather than quietly hanging on a lock.
if [[ "${SANDBOXER_DB_DRIVER:-none}" =~ ^(d1|sqlite)$ ]]; then
  OWNER=$(plan .database.owner)
  if [[ -z "$OWNER" ]]; then
    warn "the ${SANDBOXER_DB_DRIVER} driver needs 'database.owner' to name the one service"
    warn "that may open the database; without it two servers can deadlock on it"
  elif [[ "$OWNER" != "$LABEL" ]]; then
    unset SANDBOXER_D1_DIR SANDBOXER_DB_FILE
    log "'$LABEL' does not own the database; it is not exposed to this process"
  fi
fi

cd "$PKG_DIR"
# The command is the project's own, from its config. `exec` inside the eval so the
# server replaces this shell rather than becoming its child.
eval "exec $SERVE"
