#!/usr/bin/env bash
# Run a service with its output in its own file, so one process can be read on
# its own. `docker logs` interleaves every service in the container and cannot be
# filtered after the fact, which is what makes a busy sandbox unreadable -- for a
# person and for an agent.
#
# The redirection must NOT be a pipe. Piping to `tee` would leave this shell as
# the supervised process: s6 would signal the shell on restart, the service
# itself would survive still holding its port, and every replacement would die
# with "address already in use" while the old code carried on serving.
#
# `set -e` is deliberately absent. This script's whole job is to exec something
# else, and the trimming below is best-effort housekeeping that must never stop a
# service from starting.
set -uo pipefail

NAME="${1:?logged.sh needs a service name}"
shift

LOGS="${SANDBOXER_LOGS:-/var/log/sandboxer}"
LOG="$LOGS/$NAME.log"
mkdir -p "$LOGS"

# Trimmed rather than rotated: these are development logs, and a sandbox left up
# for days must not be able to fill its own disk.
if [[ -f "$LOG" ]] && [[ "$(stat -c %s "$LOG" 2>/dev/null || echo 0)" -gt 20000000 ]]; then
  tail -c 5000000 "$LOG" >"$LOG.trim" && mv "$LOG.trim" "$LOG"
fi

exec "$@" >>"$LOG" 2>&1
