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

prepared_accounts() {
  # The artifact contains no application logins. Runtime settings may rotate
  # while a volume survives; apply them to both socket and loopback accounts.
  local user="$SANDBOXER_DB_USER" password="$SANDBOXER_DB_PASSWORD"
  [[ "$DB" =~ ^[a-zA-Z0-9_-]{1,64}$ && "$user" =~ ^[a-zA-Z0-9_-]{1,32}$ &&
     "${user,,}" != root ]] || { warn "invalid prepared database or app account"; return 1; }
  password=${password//\'/\'\'}
  # Pass SQL through stdin and use explicit quoting rules so the app password
  # is neither a process argument nor part of an error message.
  "${ROOT[@]}" --binary-mode >/dev/null 2>&1 <<SQL || { warn "could not provision the runtime app account"; return 1; }
SET SESSION sql_mode='NO_BACKSLASH_ESCAPES';
CREATE USER IF NOT EXISTS '$user'@'%' IDENTIFIED BY '$password';
CREATE USER IF NOT EXISTS '$user'@'localhost' IDENTIFIED BY '$password';
ALTER USER '$user'@'%' IDENTIFIED BY '$password';
ALTER USER '$user'@'localhost' IDENTIFIED BY '$password';
GRANT ALL PRIVILEGES ON \`${DB//_/\\_}\`.* TO '$user'@'%', '$user'@'localhost';
GRANT ALL PRIVILEGES ON \`${DB//_/\\_}\\_%\`.* TO '$user'@'%';
SQL
}

provision() {
  ready || return 1
  if [[ -n "$(plan .database.prepared_baseline)" || -f "$SANDBOXER_RUN/mysql-local-baseline" ]]; then
    # Physical seeds are complete even when their schema has no tables. Never
    # fall through to the logical seed cache for an unrelated sandbox.
    prepared_accounts
    return $?
  fi

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
