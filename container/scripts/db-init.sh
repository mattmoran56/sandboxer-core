#!/usr/bin/env bash
# Get the sandbox's database from empty to seeded-and-migrated, provision object
# storage, and record the outcome.
#
# This is the oneshot that gates every backend and every long-running front-end,
# so nothing serves traffic against a database that is not ready.
#
# `set -e` is absent by design, and every step below either succeeds or records a
# failure and continues. A migration that failed is a reason to open the sandbox,
# not a reason to kill it (contracts §6), so this always exits zero and the
# sandbox reports `degraded` instead.
set -uo pipefail

LOG_TAG="db-init"
# shellcheck source-path=SCRIPTDIR source=lib.sh
source "${SANDBOXER_SCRIPTS:-/opt/sandboxer/scripts}/lib.sh"

mkdir -p "$SANDBOXER_RUN"
rm -f "$SANDBOXER_RUN/boot.ok" "$SANDBOXER_RUN/boot.fail"

DRIVER=$(plan .database.driver none)
DB="$SANDBOXER_SCRIPTS/db/$DRIVER.sh"

if [[ ! -x "$DB" ]]; then
  warn "no driver script for '$DRIVER'"
  : >"$SANDBOXER_RUN/boot.fail"
  "$SANDBOXER_SCRIPTS/status.sh"
  exit 0
fi

# --- database -----------------------------------------------------------------
if "$DB" provision; then
  log "$DRIVER provisioned"
else
  warn "$DRIVER provisioning failed -- migrations and fixtures are skipped"
  : >"$SANDBOXER_RUN/boot.fail"
  "$SANDBOXER_SCRIPTS/status.sh"
  exit 0
fi

# --- migrations ---------------------------------------------------------------
# Delegated so a "Retry migrations" action and this boot path run exactly the
# same thing.
"$SANDBOXER_SCRIPTS/migrate-run.sh"

# --- object storage -----------------------------------------------------------
if [[ "$(plan .storage.driver none)" == "minio" ]]; then
  "$SANDBOXER_SCRIPTS/storage/storage-init.sh" || warn "object storage is not ready -- uploads will fail"
fi

# --- fixtures -----------------------------------------------------------------
# Applied after migrations, and non-fatal: a fixture that no longer matches the
# schema is a useful signal, not a reason to refuse to start.
FIXTURES=$(plan .database.fixtures)
if [[ -n "$FIXTURES" && "${SANDBOXER_SEED:-true}" == "true" ]]; then
  if [[ -f "$WORKSPACE/$FIXTURES" ]]; then
    if "$DB" fixtures "$WORKSPACE/$FIXTURES"; then
      log "fixtures applied"
    else
      warn "fixtures did not apply cleanly (the sandbox is still usable)"
    fi
  else
    warn "no fixtures file at $FIXTURES"
  fi
fi

: >"$SANDBOXER_RUN/boot.ok"
"$SANDBOXER_SCRIPTS/status.sh"
log "done"
exit 0
