#!/usr/bin/env bash
# Initialise the MySQL data directory on a sandbox's first boot.
#
# The official MySQL image does this from its own entrypoint, which s6 replaces
# as PID 1, so the sandbox does it here instead. Idempotent: a restart finds the
# directory populated and returns immediately.
set -euo pipefail

LOG_TAG="mysql-init"
# shellcheck source-path=SCRIPTDIR source=../lib.sh
source "${SANDBOXER_SCRIPTS:-/opt/sandboxer/scripts}/lib.sh"

DATADIR="$SANDBOXER_STATE/data/mysql"

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
#
# `run_quiet` rather than `>/dev/null 2>&1`, and the difference is worth three
# days: mysqld narrates a successful initialisation over stderr, so the redirect
# was right to keep a clean boot readable -- but it also took the message that
# explains a failure. When the host's Docker disk filled, mysqld's "no space left
# on device" went to /dev/null and the only surviving evidence was this oneshot
# exiting non-zero, which reads as a broken database image. The cause did not
# resemble the symptom, and the diagnosis is now kept and printed on failure
# alone.
run_quiet mysqld --initialize-insecure --user=mysql --datadir="$DATADIR"

log "done"
