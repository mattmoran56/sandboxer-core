#!/usr/bin/env bash
# Disposable-container integration: cache misses, hits, isolated writable copies,
# and seed invalidation. No source database or runtime credentials are captured.
set -euo pipefail
scripts=/opt/sandboxer/scripts
work=$(mktemp -d /tmp/local-baseline-test.XXXXXXXX)
chmod 755 "$work"
cd "$work"
printf 'CREATE TABLE example(id INT PRIMARY KEY); INSERT INTO example VALUES(1);\n' > seed.sql
zstd -q seed.sql -o seed.sql.zst
export SANDBOXER_PLAN="$work/plan.json" SANDBOXER_SCRIPTS="$scripts" SANDBOXER_DB_USER=app
export SANDBOXER_DB_PASSWORD=first-private-password
jq -n --arg seed "$work/seed.sql.zst" '{project:"demo",database:{driver:"mysql",name:"demo",cache_baseline:true,seed:{path:$seed}}}' > "$SANDBOXER_PLAN"
init() {
  export SANDBOXER_STATE="$work/$1" SANDBOXER_RUN="$work/run-$1"
  "$scripts/db/mysql-init.sh"
  test -f "$SANDBOXER_RUN/mysql-local-baseline"
}
start=$(date +%s%3N)
init one
cold=$(($(date +%s%3N) - start))
start=$(date +%s%3N)
init two
warm=$(($(date +%s%3N) - start))
[[ ! -e "$work/one/data/mysql/auto.cnf" && ! -e "$work/two/data/mysql/auto.cnf" ]]
pid=
trap '[[ -z "$pid" ]] || { kill "$pid" 2>/dev/null || true; wait "$pid" || true; }' EXIT
boot() {
  export SANDBOXER_STATE="$work/$1" SANDBOXER_RUN="$work/run-$1"
  install -d -o mysql -g mysql "$work/runtime"
  export MYSQL_UNIX_PORT="$work/runtime/mysql.sock"
  client=(mysql --no-defaults --protocol=socket --socket="$MYSQL_UNIX_PORT" --batch --skip-column-names)
  mysqld --no-defaults --user=mysql --datadir="$work/$1/data/mysql" --socket="$MYSQL_UNIX_PORT" \
    --pid-file="$work/runtime/mysql.pid" --log-error="$work/runtime/mysql.log" \
    --skip-networking --mysqlx=OFF --skip-log-bin &
  pid=$!
  for ((i=0; i<200; i++)); do
    if "${client[@]}" -uroot -e 'SELECT 1' >/dev/null 2>&1; then break; fi
    kill -0 "$pid"; sleep .1
  done
  "$scripts/db/mysql.sh" provision
}
stop() {
  mysqladmin --no-defaults --protocol=socket --socket="$MYSQL_UNIX_PORT" -uroot shutdown
  wait "$pid"; pid=
}
rows() { MYSQL_PWD="$SANDBOXER_DB_PASSWORD" "${client[@]}" -uapp demo -e 'SELECT COUNT(*) FROM example'; }
boot one
uuid=$("${client[@]}" -uroot -e 'SELECT @@server_uuid')
[[ $(rows) == 1 ]]
MYSQL_PWD="$SANDBOXER_DB_PASSWORD" "${client[@]}" -uapp demo -e 'INSERT INTO example VALUES(2)'
stop
SANDBOXER_DB_PASSWORD=second-private-password
boot two
[[ $(rows) == 1 && $("${client[@]}" -uroot -e 'SELECT @@server_uuid') != "$uuid" ]]
[[ $("${client[@]}" -uroot -e "SELECT COUNT(*) FROM mysql.user WHERE User='seed_loader'") == 0 ]]
if MYSQL_PWD=first-private-password "${client[@]}" -uapp demo -e 'SELECT 1' >/dev/null 2>&1; then exit 1; fi
stop
printf 'INSERT INTO example VALUES(3);\n' >> seed.sql
zstd -q -f seed.sql -o seed.sql.zst
# Two fresh sandboxes requesting the same changed seed share one atomic cache
# publication, but receive different writable data directories.
init three & third=$!
init four & fourth=$!
wait "$third"; wait "$fourth"
boot three
[[ $(rows) == 2 ]]
stop
boot four
[[ $(rows) == 2 ]]
stop
# Restart preserves the old clone even after the seed changes.
init one
boot one
[[ $(rows) == 2 && $("${client[@]}" -uroot -e 'SELECT @@server_uuid') == "$uuid" ]]
stop
printf 'Verified local cache miss/hit, changed-seed invalidation, private data/credentials/identity; cold=%sms warm=%sms\n' "$cold" "$warm"
