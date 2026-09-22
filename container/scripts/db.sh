#!/usr/bin/env bash
# The single entry point the host reaches through `exec` for database work
# (contracts §6: provision, migrate, snapshot, shell).
#
# One dispatcher rather than a script per verb, so the host side has one path to
# call and the driver in use is resolved in exactly one place.
set -euo pipefail

LOG_TAG="db"
# shellcheck source-path=SCRIPTDIR source=lib.sh
source "${SANDBOXER_SCRIPTS:-/opt/sandboxer/scripts}/lib.sh"

DRIVER=$(plan .database.driver none)
DB_SCRIPT="$SANDBOXER_SCRIPTS/db/$DRIVER.sh"
SCHEMA_DIR="$SANDBOXER_STATE/schema"

[[ -x "$DB_SCRIPT" ]] || die "no driver script for '$DRIVER'"

case "${1:-}" in
  shell) exec "$DB_SCRIPT" shell ;;
  snapshot) exec "$DB_SCRIPT" snapshot ;;
  migrate) exec "$SANDBOXER_SCRIPTS/migrate-run.sh" ;;
  provision) exec "$SANDBOXER_SCRIPTS/db-init.sh" ;;
  fixtures)
    FIXTURES=$(plan .database.fixtures)
    [[ -n "$FIXTURES" ]] || die "this project declares no fixtures"
    exec "$DB_SCRIPT" fixtures "$WORKSPACE/$FIXTURES"
    ;;
  diff)
    # Against the last schema known to be clean, which is why the baseline is not
    # re-taken after a failed migration.
    [[ -f "$SCHEMA_DIR/baseline.sql" ]] || die "no baseline yet -- run a migration first"
    "$DB_SCRIPT" snapshot >"$SCHEMA_DIR/current.sql"
    # diff exits 1 for "there is a difference", which is the expected answer
    # here, so its status is not this script's status.
    diff -u "$SCHEMA_DIR/baseline.sql" "$SCHEMA_DIR/current.sql" || true
    ;;
  *) die "usage: db.sh shell|snapshot|diff|migrate|provision|fixtures" ;;
esac
