#!/usr/bin/env bash
# The environment a sandbox computes for itself.
#
# Contracts §5.2 forbids importing anything that describes *where* something
# runs: importing a developer's DB_HOST would point a disposable copy at their
# real database, and importing storage credentials would point it at real cloud
# storage. So the addresses are derived here, from the plan, and exported under a
# SANDBOXR_ prefix.
#
# What §5.2 does allow in is the project's own third-party credentials, and those
# arrive as a mounted file this reads rather than as anything docker was told —
# see "the project's secrets" below, which is the first thing that happens here.
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

# --- the project's secrets ----------------------------------------------------
#
# The project's third-party credentials, mounted read-only by the host at
# /sandboxr/secrets.env (contracts §5.2). A mount and not a second
# `docker run --env-file`: an env-file is read once, when the container is
# created, so a rotated key could never reach a running sandbox — `restart` and
# `stop`/`start` keep the environment `docker run` baked in. Read from a file
# here, every sourcing picks up whatever the file says now.
#
# First, and deliberately, for two reasons:
#   - the `envsubst` loop at the bottom can then expand a secret, which is what
#     makes a `secrets.rename` target usable as a plan `env:` value — see
#     examples/monorepo.sandboxr.yaml.
#   - everything the sandbox works out for itself still wins, because the
#     derivations below are all `${X:-default}` and the plan's `env:` map is
#     applied last. The host also refuses a reserved name outright rather than
#     leaving that to luck (`isReservedEnvName`, packages/core/src/secrets.ts):
#     Docker used to settle the argument by layering two env-files, and nothing
#     does now, so an imported DB_HOST would otherwise point a disposable copy at
#     a developer's real database.
#
# **A name that is already set is left alone**, which is what makes the rest of
# contracts §5.2's order true. Running first would otherwise make this the
# *strongest* source rather than the weakest: a `--env-file` value and a `-e`
# value are the host's own statement about this sandbox — the slug, the person's
# git identity, GH_TOKEN, CLAUDE_CONFIG_DIR — and a file the project supplies must
# not be able to replace one. The host's reserved-name list cannot be leaned on
# here, because it deliberately covers only the names the *sandbox* derives; it
# has no opinion on GIT_AUTHOR_EMAIL, and a secrets file quietly rewriting that
# would put the wrong author on a commit with nothing anywhere saying why. A
# project that really does want to override one has the plan's `env:` map, which
# is applied last and always wins.
#
# **Read as data, never sourced.** `source` would execute a value containing
# `$(...)` or a backtick, and these are strings somebody pasted out of a vendor's
# dashboard; contracts §5.2 is that a value is data and never a command. So: one
# line at a time, one `export`, nothing evaluated.
#
# One layer of matching quotes comes off, and `quoteSecret` in
# packages/core/src/secrets.ts is the other half of that. The host quotes every
# value unconditionally, because its own reader trims a value and strips a
# trailing ` #` from an unquoted one — right for a hand-written .env, and it
# silently truncated a password containing ` #`. If these two halves ever
# disagree, every credential reaches the application with quotes around it and
# fails as an authentication error, which looks nothing like a parsing problem.
sandboxr_env_secrets="${SANDBOXR_SECRETS:-/sandboxr/secrets.env}"
if [[ -f "$sandboxr_env_secrets" ]]; then
  # `|| [[ -n "$line" ]]` because a final line with no trailing newline leaves
  # `read` returning false with that line already in hand. A hand-edited file is
  # exactly where that happens, and the last credential would be the one
  # silently missing.
  while IFS= read -r sandboxr_env_line || [[ -n "$sandboxr_env_line" ]]; do
    [[ -z "$sandboxr_env_line" || "$sandboxr_env_line" == '#'* ]] && continue
    [[ "$sandboxr_env_line" != *=* ]] && continue
    sandboxr_env_name="${sandboxr_env_line%%=*}"
    # A malformed name is skipped rather than exported. This file is sourced by
    # scripts running under `set -e`, and `export '2 bad=x'` fails — so one stray
    # line in a hand-edited file would stop the entrypoint, every build and every
    # database verb, and none of them would say which file was at fault.
    [[ "$sandboxr_env_name" =~ ^[A-Za-z_][A-Za-z0-9_]*$ ]] || continue
    # Set already — by the image, by docker, or by the host — wins, per the
    # paragraph above. `${!name+set}` is non-empty exactly when the variable that
    # $sandboxr_env_name names is set, empty value included. `[[ -v ]]` says the
    # same thing and reads better, and it is bash 4.2+: bash 3.2 rejects it while
    # *parsing*, so a `bash -n` on macOS — the syntax check this repository's own
    # README prescribes — would fail on the whole file rather than on one line.
    [[ -n "${!sandboxr_env_name+set}" ]] && continue
    sandboxr_env_value="${sandboxr_env_line#*=}"
    sandboxr_env_quote="${sandboxr_env_value:0:1}"
    # Exactly one layer, and the inside is not trimmed: ` x ` is a legitimate
    # value and the host wrote it as `" x "`. A value that is itself `"abc` was
    # written `""abc"` and comes back as `"abc`.
    if [[ ${#sandboxr_env_value} -ge 2 &&
      ("$sandboxr_env_quote" == '"' || "$sandboxr_env_quote" == "'") &&
      "$sandboxr_env_value" == *"$sandboxr_env_quote" ]]; then
      sandboxr_env_value="${sandboxr_env_value:1:${#sandboxr_env_value}-2}"
    fi
    export "$sandboxr_env_name=$sandboxr_env_value"
  done < "$sandboxr_env_secrets"
fi
unset sandboxr_env_secrets sandboxr_env_line sandboxr_env_name sandboxr_env_value sandboxr_env_quote

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
  # The port only when the router is not on the scheme's default one, which the
  # host decides and passes in: a URL missing it points at whatever else owns
  # 443 on that machine.
  sandboxr_env_port="${SANDBOXR_PUBLIC_PORT:+:${SANDBOXR_PUBLIC_PORT}}"
  while read -r sandboxr_env_label; do
    [[ -z "$sandboxr_env_label" ]] && continue
    sandboxr_env_var="SANDBOXR_URL_$(printf '%s' "$sandboxr_env_label" | tr '[:lower:]-' '[:upper:]_')"
    export "$sandboxr_env_var=${SANDBOXR_SCHEME:-https}://$(fqdn "$sandboxr_env_label")${sandboxr_env_port}"
  done < <(jq -r '.services[]?.label // empty' "$SANDBOXR_PLAN" | sort -u)
  unset sandboxr_env_label sandboxr_env_var sandboxr_env_port
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
