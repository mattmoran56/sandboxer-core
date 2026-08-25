#!/usr/bin/env bash
# Compose /run/sandboxr/status.json, which the router serves at
# /__sandboxr/status.json and the dashboard reads.
#
# Every writer here records a *fact* in its own marker file and then calls this
# script; the overall state is derived rather than asserted, so two writers
# cannot disagree about whether the sandbox is degraded.
#
#   booting   -- db-init has not finished
#   ok        -- booted, and migrations either succeeded or were not configured
#   degraded  -- booted, but something the sandbox exists to show you failed
set -euo pipefail

LOG_TAG="status"
# shellcheck source-path=SCRIPTDIR source=lib.sh
source "${SANDBOXR_SCRIPTS:-/opt/sandboxr/scripts}/lib.sh"

mkdir -p "$SANDBOXR_RUN"
STATE="${1-}"

MIGRATIONS='{"state":"unknown","file":"","error":""}'
[[ -f "$SANDBOXR_RUN/migrate.json" ]] && MIGRATIONS=$(cat "$SANDBOXR_RUN/migrate.json")
MIGRATE_STATE=$(printf '%s' "$MIGRATIONS" | jq -r '.state')

if [[ -z "$STATE" ]]; then
  if [[ ! -f "$SANDBOXR_RUN/boot.ok" ]]; then
    STATE=booting
  elif [[ "$MIGRATE_STATE" == "failed" || -f "$SANDBOXR_RUN/boot.fail" ]]; then
    STATE=degraded
  else
    STATE=ok
  fi
fi

# bootedAt is the first time this container reached a terminal state, and must
# survive later recomputations -- a "Retry migrations" click is not a reboot.
BOOTED_AT=""
[[ -f "$SANDBOXR_RUN/status.json" ]] &&
  BOOTED_AT=$(jq -r '.bootedAt // empty' "$SANDBOXR_RUN/status.json" 2>/dev/null || true)
if [[ -z "$BOOTED_AT" && "$STATE" != "booting" ]]; then
  BOOTED_AT=$(date -u +%Y-%m-%dT%H:%M:%SZ)
fi

jq -n \
  --arg project "${SANDBOXR_PROJECT:-$(plan .project)}" \
  --arg slug "${SANDBOXR_SLUG:-}" \
  --arg domain "${SANDBOXR_DOMAIN:-sbx.localhost}" \
  --arg state "$STATE" \
  --arg driver "$(plan .database.driver none)" \
  --arg database "${SANDBOXR_DB_NAME:-$(plan .database.name)}" \
  --arg bootedAt "$BOOTED_AT" \
  --arg updatedAt "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
  --argjson migrations "$MIGRATIONS" \
  '{
    project: $project,
    slug: $slug,
    domain: $domain,
    state: $state,
    database: { driver: $driver, name: $database },
    migrations: $migrations,
    bootedAt: (if $bootedAt == "" then null else $bootedAt end),
    updatedAt: $updatedAt
  }' >"$SANDBOXR_RUN/status.json.new"

# Swapped rather than written in place: the dashboard polls this file and must
# never read a half-written one.
mv "$SANDBOXR_RUN/status.json.new" "$SANDBOXR_RUN/status.json"
