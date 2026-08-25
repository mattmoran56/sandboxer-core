#!/usr/bin/env bash
# Build if needed, then run one backend under s6 supervision.
#
# The `exec` at the end is what makes s6 supervise the backend itself rather than
# this shell. A supervised shell would survive `s6-svc -r`, keep its child alive,
# and hold the port -- so every replacement would die with "address already in
# use" while the old code carried on serving.
set -euo pipefail

LOG_TAG="run-backend"
# shellcheck source-path=SCRIPTDIR source=lib.sh
source "${SANDBOXR_SCRIPTS:-/opt/sandboxr/scripts}/lib.sh"

NAME="${1:?run-backend.sh needs a backend name}"
RECORD=$(service_by backend name "$NAME")
[[ -n "$RECORD" ]] || die "no backend called '$NAME' in the plan"

BIN="$SANDBOXR_STATE/bin/$(svc_id "$RECORD")"

# A build failure must not become a crash loop that hides its own error: the
# compiler output is already in this service's log, so pause and let s6 restart
# after the developer has had a chance to read it.
if ! "$SANDBOXR_SCRIPTS/build-backend.sh" "$NAME"; then
  warn "$NAME did not build; retrying shortly"
  sleep 10
  exit 1
fi

cd "$WORKSPACE/$(field "$RECORD" workdir .)"
exec "$BIN"
