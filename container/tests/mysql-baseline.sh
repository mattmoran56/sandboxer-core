#!/usr/bin/env bash
# Run only inside a disposable, network-disabled MySQL sandbox image. Exercise
# independent rows and identities through live servers, and failed-copy recovery.
set -euo pipefail
scripts=/opt/sandboxer/scripts
prepare="$scripts/db/prepare-mysql-baseline.sh"
clone="$scripts/db/clone-mysql-baseline.sh"
root=/opt/sandboxer/mysql-baselines
work=$(mktemp -d /tmp/prepared-proof.XXXXXXXX)
chmod 755 "$work"
cd "$work"
printf 'CREATE TABLE example(id INT PRIMARY KEY); INSERT INTO example VALUES(1);\n' >seed.sql
key=$("$prepare" "$root" demo seed.sql)
[[ $("$prepare" --key "$root" demo seed.sql) == "$key" ]]
[[ $("$prepare" --key "$root" other seed.sql) != "$key" ]]
cp seed.sql another.sql; echo '-- next revision' >>another.sql
[[ $("$prepare" --key "$root" demo another.sql) != "$key" ]]
manifest="$root/$key/manifest.json"
mkdir -p one/.mysql-prepared.partial one/mysql two
touch one/.mysql-prepared.partial/interrupted
"$clone" "$key" demo "$work/one/mysql" & first=$!
"$clone" "$key" demo "$work/one/mysql" & second=$!
wait "$first"; wait "$second"
[[ ! -e one/.mysql-prepared.partial && ! -e one/mysql/interrupted && ! -e one/mysql/auto.cnf ]]
"$clone" "$key" demo "$work/two/mysql"
if "$clone" "$key" wrong "$work/wrong/mysql"; then exit 1; fi
[[ ! -e wrong/mysql ]]
mkdir -p unknown/mysql; echo keep >unknown/mysql/existing
if "$clone" "$key" demo "$work/unknown/mysql"; then exit 1; fi
[[ $(cat unknown/mysql/existing) == keep ]]
cp "$manifest" original.json
jq '.inputs.mysql_version="0.0.0"' original.json > "$manifest"
if "$clone" "$key" demo "$work/incompatible/mysql"; then exit 1; fi
[[ ! -e incompatible/mysql ]]
cat original.json > "$manifest"
# A truncated physical file must never be published, even with valid inputs.
printf x >"$root/$key/data/unexpected"
if "$clone" "$key" demo "$work/corrupt/mysql"; then exit 1; fi
[[ ! -e corrupt/mysql && ! -e corrupt/.mysql-prepared.partial ]]
rm "$root/$key/data/unexpected"

export SANDBOXER_PLAN="$work/plan.json" SANDBOXER_SCRIPTS="$scripts" SANDBOXER_DB_USER=app
export SANDBOXER_DB_PASSWORD="synthetic'quote\\slash"
jq -n --arg key "$key" '{project:"demo",database:{driver:"mysql",name:"demo",prepared_baseline:$key}}' > "$SANDBOXER_PLAN"
export MYSQL_UNIX_PORT="$work/mysql.sock"
client=(mysql --no-defaults --protocol=socket --socket="$MYSQL_UNIX_PORT" --batch --skip-column-names)
pid=
trap '[[ -z "$pid" ]] || { kill "$pid" 2>/dev/null || true; wait "$pid" || true; }' EXIT
start() {
  # The socket and pid are outside every datadir.
  install -d -o mysql -g mysql "$work/runtime"
  MYSQL_UNIX_PORT="$work/runtime/mysql.sock"
  client=(mysql --no-defaults --protocol=socket --socket="$MYSQL_UNIX_PORT" --batch --skip-column-names)
  mysqld --no-defaults --user=mysql --datadir="$work/$1/mysql" --socket="$MYSQL_UNIX_PORT" \
    --pid-file="$work/runtime/mysql.pid" --log-error="$work/runtime/mysql.log" \
    --skip-networking --mysqlx=OFF --skip-log-bin &
  pid=$!
  for ((i=0; i<200; i++)); do
    if "${client[@]}" -uroot -e 'SELECT 1' >/dev/null 2>&1; then return; fi
    kill -0 "$pid"; sleep .1
  done
  return 1
}
stop() {
  mysqladmin --no-defaults --protocol=socket --socket="$MYSQL_UNIX_PORT" -uroot shutdown
  wait "$pid"; pid=
}
rows() { MYSQL_PWD="$SANDBOXER_DB_PASSWORD" "${client[@]}" -uapp demo -e 'SELECT COUNT(*) FROM example'; }

start one
uuid=$("${client[@]}" -uroot -e 'SELECT @@server_uuid')
[[ $("${client[@]}" -uroot -e "SELECT COUNT(*) FROM mysql.user WHERE User IN ('seed_loader','app')") == 0 ]]
"$scripts/db/mysql.sh" provision
[[ $(rows) == 1 ]]
MYSQL_PWD="$SANDBOXER_DB_PASSWORD" "${client[@]}" -uapp demo -e 'INSERT INTO example VALUES(2)'
SANDBOXER_DB_PASSWORD=rotated
"$scripts/db/mysql.sh" provision
[[ $(rows) == 2 ]]
stop
# A new baseline key cannot overwrite an already initialized volume.
"$clone" "$(printf '%064d' 0)" demo "$work/one/mysql"
start two
[[ $("${client[@]}" -uroot -e 'SELECT @@server_uuid') != "$uuid" ]]
"$scripts/db/mysql.sh" provision
[[ $(rows) == 1 ]]
stop
start one
[[ $("${client[@]}" -uroot -e 'SELECT @@server_uuid') == "$uuid" && $(rows) == 2 ]]
stop
[[ $("$prepare" "$root" demo seed.sql) == "$key" ]]
echo "Verified two private MySQL servers, independent rows and identities, and interrupted-copy recovery."
