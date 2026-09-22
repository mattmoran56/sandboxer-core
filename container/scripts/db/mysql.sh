#!/usr/bin/env bash
# The MySQL driver's container-side half: provision, fixtures, snapshot, shell.
#
# The hard case (contracts §6.1). A running server means install, start, wait,
# restore -- none of which the file-based drivers need.
#
# The server itself is started by the mysqld service, not from here; this script
# only ever talks to a server that is already up.
set -uo pipefail

LOG_TAG="mysql"
# shellcheck source-path=SCRIPTDIR source=../lib.sh
source "${SANDBOXER_SCRIPTS:-/opt/sandboxer/scripts}/lib.sh"

DB="${SANDBOXER_DB_NAME:?}"
ROOT=(mysql --protocol=socket -uroot)

ready() {
  for _ in $(seq 1 120); do
    mysqladmin --protocol=socket -uroot ping --silent >/dev/null 2>&1 && return 0
    sleep 1
  done
  warn "mysqld never became ready"
  return 1
}

# The newest artifact the host's prepareSeed left in the cache. Named in the plan
# when the host pinned one; otherwise the newest dump in the cache mount, so a
# `sandboxer db refresh` takes effect without regenerating the plan.
seed_artifact() {
  local named
  named=$(plan .database.seed.path)
  if [[ -n "$named" ]]; then
    [[ "$named" == /* ]] && printf '%s\n' "$named" || printf '/sandboxer/cache/%s\n' "$named"
    return
  fi
  ls -t /sandboxer/cache/*.sql.zst /sandboxer/cache/*.sql.gz /sandboxer/cache/*.sql 2>/dev/null | head -1
}

# zstd, gzip and plain, decided by extension rather than by sniffing: the host
# writes the name, so guessing would only hide a mismatch.
decompress() {
  case "$1" in
    *.zst) zstd -dc "$1" ;;
    *.gz) gzip -dc "$1" ;;
    *) cat "$1" ;;
  esac
}

provision() {
  ready || return 1

  # The escaped underscore matters: MySQL treats `_` and `%` as wildcards in the
  # database part of a GRANT. Escaping it makes `<db>\_%` match the sibling
  # databases a test suite creates and nothing else; leaving it bare grants far
  # more widely than intended, and putting the `%` in plain backticks grants on a
  # database literally named `<db>%`, after which every connection fails with
  # Error 1044.
  "${ROOT[@]}" -e "
    CREATE USER IF NOT EXISTS '${SANDBOXER_DB_USER}'@'%'         IDENTIFIED BY '${SANDBOXER_DB_PASSWORD}';
    CREATE USER IF NOT EXISTS '${SANDBOXER_DB_USER}'@'localhost' IDENTIFIED BY '${SANDBOXER_DB_PASSWORD}';
    GRANT ALL PRIVILEGES ON \`${DB}\`.*     TO '${SANDBOXER_DB_USER}'@'%';
    GRANT ALL PRIVILEGES ON \`${DB}\`.*     TO '${SANDBOXER_DB_USER}'@'localhost';
    GRANT ALL PRIVILEGES ON \`${DB}\\_%\`.* TO '${SANDBOXER_DB_USER}'@'%';
    FLUSH PRIVILEGES;" || {
    warn "could not create the app user"
    return 1
  }

  "${ROOT[@]}" -e "CREATE DATABASE IF NOT EXISTS \`${DB}\`
    CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci;" || return 1

  local tables
  tables=$("${ROOT[@]}" -N -B -e \
    "SELECT COUNT(*) FROM information_schema.tables WHERE table_schema='${DB}';")

  if [[ "${tables:-0}" -ne 0 ]]; then
    log "$DB already has $tables tables, keeping them"
    return 0
  fi

  local artifact
  artifact=$(seed_artifact)
  if [[ -z "$artifact" || ! -f "$artifact" ]]; then
    # An empty database is a legitimate starting point -- migrations build the
    # schema from nothing -- so this is a note, not a failure.
    log "no seed artifact in /sandboxer/cache; starting from an empty database"
    return 0
  fi

  log "restoring $(basename "$artifact")"
  local start
  start=$(date +%s)
  # The checks are off for the restore only: a dump's tables arrive in whatever
  # order it was written in, so a foreign key can legitimately point at a table
  # that does not exist yet.
  decompress "$artifact" | "${ROOT[@]}" \
    --default-character-set=utf8mb4 \
    --init-command="SET FOREIGN_KEY_CHECKS=0, UNIQUE_CHECKS=0" \
    "$DB" || {
    warn "restore failed"
    return 1
  }
  log "restored in $(($(date +%s) - start))s"
}

fixtures() {
  "${ROOT[@]}" -D"$DB" <"$1" >/dev/null 2>&1
}

# Structure only, so a diff before and after a migration shows schema changes and
# not row churn.
snapshot() {
  mysqldump --protocol=socket -uroot --no-data --skip-comments \
    --skip-dump-date --routines --events "$DB"
}

shell() {
  exec mysql --protocol=socket -uroot "$DB"
}

case "${1:-}" in
  ready) ready ;;
  provision) provision ;;
  fixtures) fixtures "${2:?fixtures needs a file}" ;;
  snapshot) snapshot ;;
  shell) shell ;;
  *) die "usage: mysql.sh ready|provision|fixtures <file>|snapshot|shell" ;;
esac
