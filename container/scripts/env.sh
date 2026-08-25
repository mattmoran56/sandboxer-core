#!/usr/bin/env bash
# The environment a sandbox computes for itself.
#
# Contracts §5.2 forbids importing anything that describes *where* something
# runs: importing a developer's DB_HOST would point a disposable copy at their
# real database, and importing storage credentials would point it at real cloud
# storage. So the addresses are derived here, from the plan, and exported under a
# SANDBOXR_ prefix.
#
# Sourced, never executed, and sourced from lib.sh rather than only from the
# entrypoint. The entrypoint's exports reach every *supervised* service, because
# /init inherits them and S6_KEEP_ENV=1 hands them on — but `docker exec` does
# not: it gets the container's configured environment, which never saw them. The
# host reaches in that way for every migration, build and database verb, so a
# script that only worked under supervision would silently run with an empty
# $SANDBOXR_DB_FILE and open a temporary in-memory database instead of failing.
#
# Idempotent: sourcing it twice is a no-op, so the entrypoint and a script it
# later execs do not fight over the same names.

[[ "${SANDBOXR_ENV_READY:-}" == "1" ]] && return 0
# Without a plan there is nothing to derive. The entrypoint refuses in that case
# with a message; every other caller is a `docker exec` into a container that
# already booted, and failing here would only hide the real error.
[[ -f "$SANDBOXR_PLAN" ]] || return 0

export SANDBOXR_PROJECT="${SANDBOXR_PROJECT:-$(plan .project)}"
export SANDBOXR_DOMAIN="${SANDBOXR_DOMAIN:-sbx.localhost}"

SANDBOXR_DB_DRIVER="$(plan .database.driver none)"
export SANDBOXR_DB_DRIVER
SANDBOXR_DB_NAME="$(plan .database.name "$SANDBOXR_PROJECT")"
export SANDBOXR_DB_NAME
export SANDBOXR_DB_DIR="$SANDBOXR_STATE/data/$SANDBOXR_DB_DRIVER"

case "$SANDBOXR_DB_DRIVER" in
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
if [[ -n "${SANDBOXR_SLUG:-}" ]]; then
  while read -r sandboxr_env_label; do
    [[ -z "$sandboxr_env_label" ]] && continue
    sandboxr_env_var="SANDBOXR_URL_$(printf '%s' "$sandboxr_env_label" | tr '[:lower:]-' '[:upper:]_')"
    export "$sandboxr_env_var=${SANDBOXR_SCHEME:-https}://$(fqdn "$sandboxr_env_label")"
  done < <(jq -r '.services[]?.label // empty' "$SANDBOXR_PLAN" | sort -u)
  unset sandboxr_env_label sandboxr_env_var
fi

# One SANDBOXR_PORT_<ID> per port-holding service, so a project can address a
# sibling without duplicating the port in two files.
while read -r sandboxr_env_record; do
  [[ -z "$sandboxr_env_record" ]] && continue
  sandboxr_env_port=$(field "$sandboxr_env_record" port)
  [[ -z "$sandboxr_env_port" ]] && continue
  sandboxr_env_var="SANDBOXR_PORT_$(printf '%s' "$(svc_id "$sandboxr_env_record")" | tr '[:lower:]-' '[:upper:]_')"
  export "$sandboxr_env_var=$sandboxr_env_port"
done < <(jq -c '.services[]? | select(.kind != "static")' "$SANDBOXR_PLAN")
unset sandboxr_env_record sandboxr_env_port sandboxr_env_var

# --- project environment names ------------------------------------------------
#
# The names above are sandboxr's. A project reads its own — DB_HOST, S3_ENDPOINT,
# API_BASE_URL, whatever it happens to be — and the mapping between the two is per
# project, so it comes from the plan. Values go through envsubst, which expands
# ${...} against what was exported above and against the secrets the host passed
# in, and does not run a shell: a value is data, never a command.
while read -r sandboxr_env_name; do
  [[ -z "$sandboxr_env_name" ]] && continue
  sandboxr_env_value=$(jq -r --arg n "$sandboxr_env_name" '.env[$n] // ""' "$SANDBOXR_PLAN")
  export "$sandboxr_env_name=$(printf '%s' "$sandboxr_env_value" | envsubst)"
done < <(jq -r '.env // {} | keys[]' "$SANDBOXR_PLAN")
unset sandboxr_env_name sandboxr_env_value

export SANDBOXR_ENV_READY=1
