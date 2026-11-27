#!/usr/bin/env bash
# Initialise the MySQL data directory on a sandbox's first boot.
#
# The official MySQL image does this from its own entrypoint, which s6 replaces
# as PID 1, so the sandbox does it here instead. Idempotent: a restart finds the
# directory populated and returns immediately.
set -euo pipefail

LOG_TAG="mysql-init"
# shellcheck source-path=SCRIPTDIR source=../lib.sh
source "${SANDBOXER_SCRIPTS:-/opt/sandboxer/scripts}/lib.sh"

DATADIR="$SANDBOXER_STATE/data/mysql"

prepared=$(plan .database.prepared_baseline)
if [[ -n "$prepared" ]]; then
  if ! "$SANDBOXER_SCRIPTS/db/clone-mysql-baseline.sh" "$prepared" "$SANDBOXER_DB_NAME" "$DATADIR"; then
    mkdir -p "$SANDBOXER_RUN"
    touch "$SANDBOXER_RUN/boot.fail"
    "$SANDBOXER_SCRIPTS/status.sh" degraded
    die "prepared baseline could not initialize this sandbox"
  fi
  install -d -o mysql -g mysql /run/mysqld
  exit 0
fi

if [[ -d "$DATADIR/mysql" ]]; then
  if [[ -f "$DATADIR/.sandboxer-local-baseline" ]]; then
    mkdir -p "$SANDBOXER_RUN"
    touch "$SANDBOXER_RUN/mysql-local-baseline"
  fi
  log "data directory already initialised"
  exit 0
fi

if [[ "$(plan .database.cache_baseline)" == true ]]; then
  seed=$(plan .database.seed.path)
  [[ -z "$seed" || "$seed" == /* ]] || seed="/sandboxer/cache/$seed"
  if [[ -n "$seed" && -f "$seed" ]]; then
    cache=/opt/sandboxer/local-mysql-baselines
    start=$(date +%s)
    key=$("$SANDBOXER_SCRIPTS/db/prepare-mysql-baseline.sh" --key --local-dump "$cache" "$SANDBOXER_DB_NAME" "$seed")
    if [[ -f "$cache/$key/manifest.json" ]]; then
      log "reusing cached database baseline"
    else
      log "preparing database baseline (first use of this seed and MySQL version)"
    fi
    # Preparation and cloning are both serialized and publish only after a clean
    # shutdown/integrity check. The shared volume is never a running datadir.
    if { [[ -d "$cache/$key" ]] || "$SANDBOXER_SCRIPTS/db/prepare-mysql-baseline.sh" --local-dump "$cache" "$SANDBOXER_DB_NAME" "$seed" >/dev/null; } &&
       SANDBOXER_MYSQL_BASELINES="$cache" "$SANDBOXER_SCRIPTS/db/clone-mysql-baseline.sh" "$key" "$SANDBOXER_DB_NAME" "$DATADIR"; then
      mkdir -p "$SANDBOXER_RUN"
      touch "$DATADIR/.sandboxer-local-baseline" "$SANDBOXER_RUN/mysql-local-baseline"
      install -d -o mysql -g mysql /run/mysqld
      log "private cached database ready in $(($(date +%s) - start))s"
      exit 0
    fi
    warn "database cache unavailable; using ordinary isolated SQL restore"
  fi
fi

log "initialising $DATADIR"
mkdir -p "$DATADIR" /run/mysqld
chown -R mysql:mysql "$DATADIR" /run/mysqld

# --initialize-insecure leaves root with no password. The server listens only on
# the container's loopback and its contents are disposable, so a password would
# protect nothing; the app user gets one anyway, because application config
# expects one.
#
# `run_quiet` rather than `>/dev/null 2>&1`, and the difference is worth three
# days: mysqld narrates a successful initialisation over stderr, so the redirect
# was right to keep a clean boot readable -- but it also took the message that
# explains a failure. When the host's Docker disk filled, mysqld's "no space left
# on device" went to /dev/null and the only surviving evidence was this oneshot
# exiting non-zero, which reads as a broken database image. The cause did not
# resemble the symptom, and the diagnosis is now kept and printed on failure
# alone.
run_quiet mysqld --initialize-insecure --user=mysql --datadir="$DATADIR"

log "done"
