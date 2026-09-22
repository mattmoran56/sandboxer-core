#!/usr/bin/env bash
# Compose the sandbox, then hand off to s6.
#
# s6 compiles /etc/s6-overlay/s6-rc.d once, before any service runs, so which
# services exist must be settled before /init starts. That is why the service
# tree is generated here rather than baked into the image: one generic image
# serves every project, and the set of services is a function of the plan.
set -euo pipefail

LOG_TAG="entrypoint"
: "${SANDBOXER_SLUG:?SANDBOXER_SLUG is required}"

SANDBOXER_PLAN="${SANDBOXER_PLAN:-/sandboxer/plan.json}"
[[ -f "$SANDBOXER_PLAN" ]] || {
  echo "entrypoint: no plan at $SANDBOXER_PLAN -- the host must mount one" >&2
  exit 1
}
jq -e . "$SANDBOXER_PLAN" >/dev/null 2>&1 || {
  echo "entrypoint: $SANDBOXER_PLAN is not valid JSON" >&2
  exit 1
}

# lib.sh sources env.sh, which derives and exports everything the sandbox
# computes for itself: its own database location, its own object storage, its own
# hostnames, and the project's own names for all three. /init inherits this
# environment and S6_KEEP_ENV=1 hands it to every supervised service, which is
# why it has to happen here, before the exec.
# shellcheck source-path=SCRIPTDIR source=lib.sh
source "${SANDBOXER_SCRIPTS:-/opt/sandboxer/scripts}/lib.sh"

mkdir -p "$SANDBOXER_RUN" "$SANDBOXER_LOGS" "$SANDBOXER_WWW" \
  "$SANDBOXER_STATE/bin" "$SANDBOXER_STATE/data" "$SANDBOXER_STATE/blob"

log "$SANDBOXER_PROJECT/$SANDBOXER_SLUG on $SANDBOXER_DOMAIN, driver $SANDBOXER_DB_DRIVER"

"$SANDBOXER_SCRIPTS/status.sh" booting
"$SANDBOXER_SCRIPTS/gen-caddyfile.sh"
"$SANDBOXER_SCRIPTS/gen-services.sh"

exec /init "$@"
