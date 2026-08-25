#!/usr/bin/env bash
# Compose the sandbox, then hand off to s6.
#
# s6 compiles /etc/s6-overlay/s6-rc.d once, before any service runs, so which
# services exist must be settled before /init starts. That is why the service
# tree is generated here rather than baked into the image: one generic image
# serves every project, and the set of services is a function of the plan.
set -euo pipefail

LOG_TAG="entrypoint"
: "${SANDBOXR_SLUG:?SANDBOXR_SLUG is required}"

SANDBOXR_PLAN="${SANDBOXR_PLAN:-/sandboxr/plan.json}"
[[ -f "$SANDBOXR_PLAN" ]] || {
  echo "entrypoint: no plan at $SANDBOXR_PLAN -- the host must mount one" >&2
  exit 1
}
jq -e . "$SANDBOXR_PLAN" >/dev/null 2>&1 || {
  echo "entrypoint: $SANDBOXR_PLAN is not valid JSON" >&2
  exit 1
}

# lib.sh sources env.sh, which derives and exports everything the sandbox
# computes for itself: its own database location, its own object storage, its own
# hostnames, and the project's own names for all three. /init inherits this
# environment and S6_KEEP_ENV=1 hands it to every supervised service, which is
# why it has to happen here, before the exec.
# shellcheck source-path=SCRIPTDIR source=lib.sh
source "${SANDBOXR_SCRIPTS:-/opt/sandboxr/scripts}/lib.sh"

mkdir -p "$SANDBOXR_RUN" "$SANDBOXR_LOGS" "$SANDBOXR_WWW" \
  "$SANDBOXR_STATE/bin" "$SANDBOXR_STATE/data" "$SANDBOXR_STATE/blob"

log "$SANDBOXR_PROJECT/$SANDBOXR_SLUG on $SANDBOXR_DOMAIN, driver $SANDBOXR_DB_DRIVER"

"$SANDBOXR_SCRIPTS/status.sh" booting
"$SANDBOXR_SCRIPTS/gen-caddyfile.sh"
"$SANDBOXR_SCRIPTS/gen-services.sh"

exec /init "$@"
