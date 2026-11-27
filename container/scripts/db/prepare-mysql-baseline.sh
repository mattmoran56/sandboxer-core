#!/usr/bin/env bash
# Prepare reviewed synthetic SQL or an opted-in local dump in a private server.
# No existing server, host configuration or project credentials participate.
set -euo pipefail
source "$(dirname "$0")/mysql-baseline-lib.sh"

key_only=false
mode=synthetic
if [[ "${1:-}" == --key ]]; then key_only=true; shift; fi
if [[ "${1:-}" == --local-dump ]]; then mode=local-dump; shift; fi
[[ $# == 3 ]] || baseline_error 'usage: prepare-mysql-baseline.sh [--key] [--local-dump] OUTPUT_ROOT DATABASE SEED.sql[.zst|.gz]'
root=$1; database=$2; sql=$3
[[ -f "$sql" && ! -L "$sql" ]] || baseline_error "seed input must be a regular file"
descriptor=$(baseline_descriptor "$database" "$(baseline_digest < "$sql")" "$mode")
key=$(printf '%s' "$descriptor" | baseline_digest)
if $key_only; then printf '%s\n' "$key"; exit 0; fi
mkdir -p "$root"
exec 9>"$root/.$key.lock"
flock -w 300 9 || baseline_error "another writer is still preparing the same baseline"
artifact="$root/$key"
if [[ -e "$artifact" ]]; then
  existing_digest=$(baseline_tree_digest "$artifact/data") || baseline_error "could not verify existing artifact"
  [[ "$(jq -er .key "$artifact/manifest.json")" == "$key" &&
     "$(jq -cS '.inputs' "$artifact/manifest.json")" == "$descriptor" &&
     "$existing_digest" == "$(jq -er '.data_sha256' "$artifact/manifest.json")" ]] ||
    baseline_error "existing artifact is invalid; publish to a clean output root"
  printf '%s\n' "$key"
  exit 0
fi

work=$(mktemp -d /tmp/sandboxer-mysql.XXXXXXXX)
stage="$root/.$key.partial"
pid=
cleanup() {
  if [[ -n "$pid" ]]; then kill -TERM "$pid" 2>/dev/null || true; wait "$pid" || true; fi
  rm -rf -- "$work" "$stage"
}
trap cleanup EXIT
trap 'exit 1' HUP INT TERM
rm -rf -- "$stage"
mkdir -p "$stage" "$work/data"
# Import an immutable snapshot of the bytes named by the key.
cp -- "$sql" "$work/input.sql"
[[ "$(baseline_digest < "$work/input.sql")" == "$(jq -r .input_sha256 <<<"$descriptor")" ]] ||
  baseline_error "input changed before preparation"
chown mysql:mysql "$work" "$work/data"
socket="$work/mysql.sock"
server=(mysqld --no-defaults --user=mysql --datadir="$work/data" --log-error="$work/error.log")
"${server[@]}" --initialize-insecure || baseline_error "MySQL initialization failed"
"${server[@]}" --socket="$socket" --pid-file="$work/mysql.pid" --skip-networking --mysqlx=OFF \
  --skip-log-bin --local-infile=0 --secure-file-priv=NULL --innodb-fast-shutdown=0 &
pid=$!
client=(mysql --no-defaults --no-login-paths --skip-password --protocol=socket --socket="$socket" --local-infile=0 --binary-mode --batch)
for ((attempt=0; attempt<600; attempt++)); do
  if "${client[@]}" -uroot -e 'SELECT 1' >/dev/null 2>&1; then break; fi
  kill -0 "$pid" 2>/dev/null || baseline_error "isolated MySQL server exited before startup"
  sleep .1
done
"${client[@]}" -uroot -e "CREATE DATABASE \`$database\` CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci;
  CREATE USER 'seed_loader'@'localhost'; GRANT ALL ON \`${database//_/\\_}\`.* TO 'seed_loader'@'localhost';" >/dev/null
# A schema-scoped loader keeps the build input out of MySQL accounts and global
# settings. Its DEFINER must not be used by views or routines in the artifact.
seed_input() {
  if [[ "$mode" == local-dump ]]; then
    case "$sql" in
      *.zst) zstd -dc "$work/input.sql" ;;
      *.gz) gzip -dc "$work/input.sql" ;;
      *) cat "$work/input.sql" ;;
    esac
  else
    cat "$work/input.sql"
  fi
}
# A local dump follows the same isolation rules as synthetic input: it cannot
# create logins, change global settings or read host files. Incompatible dumps
# fall back to the ordinary restore path instead of weakening this boundary.
import_options=()
if [[ "$mode" == local-dump ]]; then
  import_options=(--default-character-set=utf8mb4 --init-command='SET FOREIGN_KEY_CHECKS=0, UNIQUE_CHECKS=0')
fi
seed_input | "${client[@]}" -useed_loader "${import_options[@]}" "$database" >/dev/null 2>&1 || baseline_error "schema-scoped SQL import failed"
"${client[@]}" -uroot -e "DROP USER 'seed_loader'@'localhost';" >/dev/null
mysqladmin --no-defaults --no-login-paths --skip-password --protocol=socket --socket="$socket" -uroot shutdown
wait "$pid" || baseline_error "MySQL shutdown failed"
pid=
# Each clone generates its own server identity, TLS certificates and RSA keys.
rm -f "$work/data/auto.cnf" "$work/data/"*.pem
cp -a --reflink=auto "$work/data" "$stage/data"
digest=$(baseline_tree_digest "$stage/data")
jq -n --argjson inputs "$descriptor" --arg key "$key" --arg data "$digest" \
  '{inputs:$inputs,key:$key,data_sha256:$data}' > "$stage/manifest.json"
chown -R root:root "$stage"
chmod -R a-w "$stage"
mv -T "$stage" "$artifact"
printf '%s\n' "$key"
