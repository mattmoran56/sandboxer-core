#!/usr/bin/env bash
# Object storage inside the sandbox: the S3-compatible stand-in for whatever
# bucket the project uploads to in production.
#
# It exists so nothing a sandbox does can reach a real cloud bucket. A public
# sandbox driven by a stranger must not be able to write to production storage,
# and the only reliable way to guarantee that is for the endpoint the code sees
# to be local.
set -euo pipefail

LOG_TAG="minio"
# shellcheck source-path=SCRIPTDIR source=../lib.sh
source "${SANDBOXR_SCRIPTS:-/opt/sandboxr/scripts}/lib.sh"

export MINIO_ROOT_USER="${SANDBOXR_S3_KEY:-sandboxr}"
export MINIO_ROOT_PASSWORD="${SANDBOXR_S3_SECRET:-sandboxrlocal}"

# Quiet the update check: a sandbox has no business reaching out.
export MINIO_UPDATE=off

mkdir -p "$SANDBOXR_STATE/blob"

exec minio server "$SANDBOXR_STATE/blob" \
  --address 127.0.0.1:9000 \
  --console-address 127.0.0.1:9001
