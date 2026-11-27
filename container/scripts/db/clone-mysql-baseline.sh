#!/usr/bin/env bash
# Install a private copy on an empty volume. Serialize concurrent first boots
# and reserve the sibling partial path for crash recovery on that same volume.
set -euo pipefail
source "$(dirname "$0")/mysql-baseline-lib.sh"
[[ $# == 3 ]] || baseline_error 'usage: clone-mysql-baseline.sh KEY DATABASE DATADIR'
key=$1; database=$2; datadir=$3
[[ "$key" =~ ^[a-f0-9]{64}$ ]] || baseline_error "invalid artifact key"
parent=$(dirname "$datadir")
mkdir -p "$parent"
exec 9>"$parent/.mysql-prepared.lock"
flock -w 300 9 || baseline_error "another writer is still initializing this volume"
[[ ! -L "$datadir" ]] || baseline_error "refusing a linked datadir"
if [[ -d "$datadir/mysql" && -f "$datadir/mysql.ibd" ]]; then
  printf 'mysql-init: keeping existing private MySQL data\n'
  exit 0
fi
if [[ -e "$datadir" ]]; then
  [[ -d "$datadir" && -z "$(find "$datadir" -mindepth 1 -maxdepth 1 -print -quit)" ]] || baseline_error "unrecognized nonempty datadir; preserving its contents"
fi

artifact="${SANDBOXER_MYSQL_BASELINES:-/opt/sandboxer/mysql-baselines}/$key"
manifest="$artifact/manifest.json"
[[ -f "$manifest" && ! -L "$manifest" && -d "$artifact/data" && ! -L "$artifact/data" && ! -L "$artifact" ]] || baseline_error "prepared artifact is missing"
input=$(jq -er '.inputs.input_sha256' "$manifest") || baseline_error "missing input digest"
mode=$(jq -r '.inputs.mode // "synthetic"' "$manifest")
[[ "$mode" == synthetic || "$mode" == local-dump ]] || baseline_error "unsupported artifact mode"
descriptor=$(baseline_descriptor "$database" "$input" "$mode")
[[ "$(printf '%s' "$descriptor" | baseline_digest)" == "$key" &&
   "$(jq -er .key "$manifest")" == "$key" &&
   "$(jq -cS .inputs "$manifest")" == "$descriptor" ]] || baseline_error "artifact key, MySQL version, architecture or database mismatch"
expected=$(jq -er '.data_sha256 | select(test("^[a-f0-9]{64}$"))' "$manifest") || baseline_error "invalid data checksum"

stage="$parent/.mysql-prepared.partial"
rm -rf -- "$stage"
trap 'rm -rf -- "$stage"' EXIT
cp -a --reflink=auto "$artifact/data" "$stage"
actual=$(baseline_tree_digest "$stage") || baseline_error "could not verify the private copy"
[[ "$actual" == "$expected" ]] || baseline_error "private copy failed integrity verification"
# cp --reflink=auto either allocates copy-on-write extents or copies bytes. No
# hard link ever connects the artifact to either writable database.
chmod -R u+rwX "$stage"
rm -f "$stage/auto.cnf" "$stage/"*.pem
chown -R mysql:mysql "$stage"
# rename(2) replaces an empty destination directory or creates it atomically.
mv -T "$stage" "$datadir"
printf 'mysql-init: installed verified private MySQL baseline\n'
