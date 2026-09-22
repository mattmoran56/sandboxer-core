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
source "${SANDBOXER_SCRIPTS:-/opt/sandboxer/scripts}/lib.sh"

export MINIO_ROOT_USER="${SANDBOXER_S3_KEY:-sandboxer}"
export MINIO_ROOT_PASSWORD="${SANDBOXER_S3_SECRET:-sandboxerlocal}"

# Quiet the update check: a sandbox has no business reaching out.
export MINIO_UPDATE=off

mkdir -p "$SANDBOXER_STATE/blob"

exec minio server "$SANDBOXER_STATE/blob" \
  --address 127.0.0.1:9000 \
  --console-address 127.0.0.1:9001
