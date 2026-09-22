#!/usr/bin/env bash
# Prepare a long-running front-end.
#
# The third runtime kind builds nothing (contracts §5.1): a dev server compiles as
# it serves, which is exactly why it is a separate kind rather than a static build
# with a watcher bolted on.
#
# This script exists anyway, for two reasons. A project may declare a `prepare`
# step -- code generation, a type build, a schema push -- that has to run once
# before the server starts. And the asymmetry deserves somewhere to be stated: a
# caller iterating over the runtime kinds finds a build script for each, and the
# one that does nothing says so rather than being a missing file.
set -euo pipefail

LOG_TAG="build-server"
# shellcheck source-path=SCRIPTDIR source=lib.sh
source "${SANDBOXER_SCRIPTS:-/opt/sandboxer/scripts}/lib.sh"

LABEL="${1:?build-server.sh needs a front-end label}"
RECORD=$(service_by server label "$LABEL")
[[ -n "$RECORD" ]] || die "no long-running front-end labelled '$LABEL' in the plan"

PREPARE=$(field "$RECORD" prepare)
if [[ -z "$PREPARE" ]]; then
  log "'$LABEL' runs a server; there is nothing to build"
  exit 0
fi

PKG_DIR="$WORKSPACE/$(field "$RECORD" root .)/$(field "$RECORD" package .)"
[[ -d "$PKG_DIR" ]] || die "no package directory at $PKG_DIR"

log "preparing $LABEL"
cd "$PKG_DIR"
eval "$PREPARE"
log "prepared $LABEL"
