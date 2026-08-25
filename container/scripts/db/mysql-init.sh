#!/usr/bin/env bash
# Initialise the MySQL data directory on a sandbox's first boot.
#
# The official MySQL image does this from its own entrypoint, which s6 replaces
# as PID 1, so the sandbox does it here instead. Idempotent: a restart finds the
# directory populated and returns immediately.
set -euo pipefail

LOG_TAG="mysql-init"
# shellcheck source-path=SCRIPTDIR source=../lib.sh
source "${SANDBOXR_SCRIPTS:-/opt/sandboxr/scripts}/lib.sh"

DATADIR="$SANDBOXR_STATE/data/mysql"

if [[ -d "$DATADIR/mysql" ]]; then
  log "data directory already initialised"
  exit 0
fi

log "initialising $DATADIR"
mkdir -p "$DATADIR" /run/mysqld
chown -R mysql:mysql "$DATADIR" /run/mysqld

# --initialize-insecure leaves root with no password. The server listens only on
# the container's loopback and its contents are disposable, so a password would
# protect nothing; the app user gets one anyway, because application config
# expects one.
mysqld --initialize-insecure --user=mysql --datadir="$DATADIR" >/dev/null 2>&1

log "done"
