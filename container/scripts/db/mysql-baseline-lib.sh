#!/usr/bin/env bash
# Shared by the builder and the first-boot copy, so changes to the physical
# layout or initialization flags invalidate the same keys on both sides.
# Bump the format number whenever the preparation settings or recipe change.
baseline_error() { printf 'mysql baseline: %s\n' "$*" >&2; exit 1; }

baseline_descriptor() {
  local database=$1 sql_sha=$2 version arch
  [[ "$database" =~ ^[a-zA-Z0-9_-]{1,64}$ && "$sql_sha" =~ ^[a-f0-9]{64}$ ]] || baseline_error "invalid database or input digest"
  case "${database,,}" in mysql|information_schema|performance_schema|sys) baseline_error "system database is reserved";; esac
  version=$(mysqld --no-defaults --version)
  [[ "$version" =~ [[:space:]]Ver[[:space:]]([^[:space:]]+) ]] || baseline_error "unrecognized MySQL version"
  version=${BASH_REMATCH[1]}
  arch=$(uname -m)
  jq -cnS --arg db "$database" --arg sql "$sql_sha" --arg version "$version" --arg arch "$arch" \
    '{format:1,database:$db,input_sha256:$sql,mysql_version:$version,architecture:$arch}'
}

baseline_digest() { sha256sum | cut -d ' ' -f 1; }

# Hash a freshly enumerated tree. Never use paths read from a manifest to open
# files, and never follow a link or hard-link a file into a writable sandbox.
baseline_tree_digest() (
  set -euo pipefail
  cd "$1"
  [[ -d mysql && -f mysql.ibd && -f ibdata1 ]] || baseline_error "missing MySQL system files"
  [[ -z "$(find . ! -type f ! -type d -print -quit)" ]] || baseline_error "unexpected file type in datadir"
  LC_ALL=C find . -type f -print0 | LC_ALL=C sort -z | xargs -0 sha256sum -- | baseline_digest
)
