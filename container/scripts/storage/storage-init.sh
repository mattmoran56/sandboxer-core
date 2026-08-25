#!/usr/bin/env bash
# Create the buckets the project declares.
#
# Read access is anonymous so a front-end can render an uploaded avatar without a
# signed URL, which is what a hosted setup does for the same objects. Write still
# needs the key.
set -uo pipefail

LOG_TAG="storage-init"
# shellcheck source-path=SCRIPTDIR source=../lib.sh
source "${SANDBOXR_SCRIPTS:-/opt/sandboxr/scripts}/lib.sh"

ALIAS=sandboxr

for _ in $(seq 1 60); do
  if mc alias set "$ALIAS" "$SANDBOXR_S3_ENDPOINT" \
    "$SANDBOXR_S3_KEY" "$SANDBOXR_S3_SECRET" >/dev/null 2>&1; then
    while read -r bucket; do
      [[ -z "$bucket" ]] && continue
      mc mb --ignore-existing "$ALIAS/$bucket" >/dev/null 2>&1
      mc anonymous set download "$ALIAS/$bucket" >/dev/null 2>&1
      log "bucket $bucket ready"
    done < <(jq -r '.storage.buckets[]? // empty' "$SANDBOXR_PLAN")
    exit 0
  fi
  sleep 1
done

warn "MinIO never became ready"
exit 1
