#!/usr/bin/env bash
# Manual frontend builds run outside the s6 graph. Wait for this boot's oneshot
# to finish without starting a second install or taking a lock on other services.
set -euo pipefail
LOG_TAG=wait-deps
# shellcheck source-path=SCRIPTDIR source=lib.sh
source "${SANDBOXER_SCRIPTS:-/opt/sandboxer/scripts}/lib.sh"

[[ -n "$(plan .deps.root)" ]] || exit 0
timeout=${1:-300}
[[ "$timeout" =~ ^[0-9]{1,4}$ ]] || die "expected a timeout in seconds"
deadline=$((SECONDS + 10#$timeout))
marker="$SANDBOXER_RUN/deps-finished"
while [[ ! -f "$marker" ]]; do
  (( SECONDS < deadline )) || die "dependency initialization is still pending; check the deps-init container logs and retry the build"
  sleep 1
done

# deps-init deliberately lets the sandbox boot after an install failure. Keep
# its diagnostics and let a requested build try the installed tree as before.
if [[ "$(<"$marker")" == failed ]]; then
  warn "dependency initialization reported a failure; see the deps-init container logs"
fi
