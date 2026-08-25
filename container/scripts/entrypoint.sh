#!/usr/bin/env bash
# Compose the sandbox, then hand off to s6.
#
# s6 compiles /etc/s6-overlay/s6-rc.d once, before any service runs, so which
# services exist must be settled before /init starts. That is why the service
# tree is generated here rather than baked into the image: one generic image
# serves every project, and the set of services is a function of the plan.
set -euo pipefail

LOG_TAG="entrypoint"
# shellcheck source-path=SCRIPTDIR source=lib.sh
source "${SANDBOXR_SCRIPTS:-/opt/sandboxr/scripts}/lib.sh"

[[ -f "$SANDBOXR_PLAN" ]] || die "no plan at $SANDBOXR_PLAN -- the host must mount one"
jq -e . "$SANDBOXR_PLAN" >/dev/null 2>&1 || die "$SANDBOXR_PLAN is not valid JSON"

: "${SANDBOXR_SLUG:?SANDBOXR_SLUG is required}"
export SANDBOXR_PROJECT="${SANDBOXR_PROJECT:-$(plan .project)}"
export SANDBOXR_DOMAIN="${SANDBOXR_DOMAIN:-sbx.lcl}"

mkdir -p "$SANDBOXR_RUN" "$SANDBOXR_LOGS" "$SANDBOXR_WWW" \
  "$SANDBOXR_STATE/bin" "$SANDBOXR_STATE/data" "$SANDBOXR_STATE/blob"

# --- the environment a sandbox computes for itself ---------------------------
#
# Contracts §5.2: anything describing *where* something runs is never imported
# from the developer's machine, because importing it would point the sandbox at
# their own database or at real cloud storage. So the addresses are derived here,
# from the plan, and exported under a SANDBOXR_ prefix.
#
# /init inherits this environment, and S6_KEEP_ENV=1 hands it on to every
# supervised service -- which is why these exports have to happen here, before the
# exec, rather than anywhere a service could read them from a file.

DB_DRIVER=$(plan .database.driver none)
export SANDBOXR_DB_DRIVER="$DB_DRIVER"
SANDBOXR_DB_NAME="$(plan .database.name "$SANDBOXR_PROJECT")"
export SANDBOXR_DB_NAME
export SANDBOXR_DB_DIR="$SANDBOXR_STATE/data/$DB_DRIVER"

case "$DB_DRIVER" in
  mysql)
    # Loopback only, and a password only because application config expects one:
    # the server is unreachable from outside the container and its contents are
    # disposable.
    export SANDBOXR_DB_HOST=127.0.0.1
    export SANDBOXR_DB_PORT=3306
    export SANDBOXR_DB_USER="${SANDBOXR_DB_USER:-sandboxr}"
    export SANDBOXR_DB_PASSWORD="${SANDBOXR_DB_PASSWORD:-sandboxr}"
    ;;
  sqlite)
    export SANDBOXR_DB_FILE="$SANDBOXR_DB_DIR/$SANDBOXR_DB_NAME.sqlite"
    ;;
  d1)
    # A directory rather than a file: miniflare owns the layout inside it, and
    # exactly one service may open it (contracts §6.1).
    export SANDBOXR_D1_DIR="$SANDBOXR_DB_DIR"
    SANDBOXR_D1_OWNER="$(plan .database.owner)"
    export SANDBOXR_D1_OWNER
    ;;
esac

if [[ "$(plan .storage.driver none)" == "minio" ]]; then
  export SANDBOXR_S3_ENDPOINT=http://127.0.0.1:9000
  export SANDBOXR_S3_KEY="${SANDBOXR_S3_KEY:-sandboxr}"
  export SANDBOXR_S3_SECRET="${SANDBOXR_S3_SECRET:-sandboxrlocal}"
  export SANDBOXR_S3_REGION="${SANDBOXR_S3_REGION:-us-east-1}"
fi

# One SANDBOXR_URL_<LABEL> per app, because only the container knows both the
# slug and the domain at the moment a build runs. Cross-app navigation needs an
# absolute, slug-bearing URL; same-origin API calls do not, which is what keeps
# CORS out of the picture entirely.
while read -r label; do
  [[ -z "$label" ]] && continue
  var="SANDBOXR_URL_$(printf '%s' "$label" | tr '[:lower:]-' '[:upper:]_')"
  export "$var=https://$(fqdn "$label")"
done < <(jq -r '.services[]?.label // empty' "$SANDBOXR_PLAN" | sort -u)

# One SANDBOXR_PORT_<ID> per port-holding service, so a project can address a
# sibling without duplicating the port in two files.
while read -r record; do
  [[ -z "$record" ]] && continue
  port=$(field "$record" port)
  [[ -z "$port" ]] && continue
  var="SANDBOXR_PORT_$(printf '%s' "$(svc_id "$record")" | tr '[:lower:]-' '[:upper:]_')"
  export "$var=$port"
done < <(jq -c '.services[]? | select(.kind != "static")' "$SANDBOXR_PLAN")

# --- project environment names ------------------------------------------------
#
# The names above are sandboxr's. A project reads its own -- DB_HOST, S3_ENDPOINT,
# API_BASE_URL, whatever it happens to be -- and the mapping between the two is
# per project, so it comes from the plan. Values go through envsubst, which
# expands ${...} against what was exported above and against the secrets the host
# passed in, and does not run a shell: a value is data, never a command.
while read -r name; do
  [[ -z "$name" ]] && continue
  value=$(jq -r --arg n "$name" '.env[$n] // ""' "$SANDBOXR_PLAN")
  export "$name=$(printf '%s' "$value" | envsubst)"
done < <(jq -r '.env // {} | keys[]' "$SANDBOXR_PLAN")

# --- generate -----------------------------------------------------------------
"$SANDBOXR_SCRIPTS/status.sh" booting
"$SANDBOXR_SCRIPTS/gen-caddyfile.sh"
"$SANDBOXR_SCRIPTS/gen-services.sh"

exec /init "$@"
