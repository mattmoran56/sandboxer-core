#!/usr/bin/env bash
# The SQLite driver's container-side half.
#
# The easy case (contracts §6.1): the database is a file. Seeding is a copy,
# forking is a copy, there is no server, no version skew and no advisory lock.
# One rule applies -- one writer per file -- and it is the config's `owner` that
# names which service that is.
set -uo pipefail

LOG_TAG="sqlite"
# shellcheck source-path=SCRIPTDIR source=../lib.sh
source "${SANDBOXR_SCRIPTS:-/opt/sandboxr/scripts}/lib.sh"

FILE="${SANDBOXR_DB_FILE:?}"

seed_artifact() {
  local named
  named=$(plan .database.seed.path)
  [[ -z "$named" ]] && return 0
  [[ "$named" == /* ]] && printf '%s\n' "$named" || printf '/sandboxr/cache/%s\n' "$named"
}

provision() {
  mkdir -p "$(dirname "$FILE")"

  if [[ -s "$FILE" ]]; then
    log "$(basename "$FILE") already exists, keeping it"
    return 0
  fi

  local artifact
  artifact=$(seed_artifact)
  if [[ -n "$artifact" && -f "$artifact" ]]; then
    log "seeding from $(basename "$artifact")"
    cp -f "$artifact" "$FILE" || return 1
  else
    # An empty file is a valid starting point: the project's migrations build the
    # schema. Creating it here rather than letting the first writer do it means
    # the permissions are right before anything opens it read-only.
    log "starting from an empty database"
    sqlite3 "$FILE" "PRAGMA journal_mode=WAL;" >/dev/null || return 1
  fi
}

fixtures() {
  sqlite3 "$FILE" <"$1" >/dev/null 2>&1
}

snapshot() {
  sqlite3 "$FILE" .schema
}

shell() {
  exec sqlite3 "$FILE"
}

case "${1:-}" in
  ready) [[ -f "$FILE" ]] ;;
  provision) provision ;;
  fixtures) fixtures "${2:?fixtures needs a file}" ;;
  snapshot) snapshot ;;
  shell) shell ;;
  *) die "usage: sqlite.sh ready|provision|fixtures <file>|snapshot|shell" ;;
esac
