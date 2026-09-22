#!/usr/bin/env bash
# The `none` driver: this project has no database.
#
# A real script rather than a branch in db-init, so the dispatch stays uniform
# and "no database" costs a sandbox nothing beyond one process that exits. Being
# cheap is the point of this driver.
set -uo pipefail

LOG_TAG="db"
# shellcheck source-path=SCRIPTDIR source=../lib.sh
source "${SANDBOXER_SCRIPTS:-/opt/sandboxer/scripts}/lib.sh"

case "${1:-}" in
  ready | provision)
    log "this project declares no database"
    ;;
  fixtures)
    warn "fixtures were configured but the driver is 'none' -- nothing to apply"
    ;;
  snapshot) ;;
  shell) die "this project declares no database" ;;
  *) die "usage: none.sh ready|provision|fixtures <file>|snapshot|shell" ;;
esac
