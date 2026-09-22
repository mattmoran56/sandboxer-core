#!/usr/bin/env bash
# Write the s6-rc service tree for this sandbox from the plan.
#
# Every service directory here is generated. A hardcoded list would only ever
# describe one project, and the whole point of the plan is that the same image
# runs a five-service MySQL monorepo and a single-worker D1 project.
#
# The graph, with the oneshots that gate the longruns:
#
#   mysql-init ──→ mysqld ──┐
#   minio ──────────────────┼──→ db-init ──→ every backend and server
#   deps-init ──────────────┘
#   caddy (no gate: the status surface must answer while the database restores)
set -euo pipefail

LOG_TAG="gen-services"
# shellcheck source-path=SCRIPTDIR source=lib.sh
source "${SANDBOXER_SCRIPTS:-/opt/sandboxer/scripts}/lib.sh"

# Overridable so the generator can be exercised against a scratch directory.
DST="${SANDBOXER_S6_DIR:-/etc/s6-overlay/s6-rc.d}"
SKEL="${SANDBOXER_S6_SKEL:-/opt/sandboxer/s6}"

# Merged rather than replacing the directory, so s6-overlay's own bundles survive
# alongside the generated ones.
mkdir -p "$DST"
cp -a "$SKEL/." "$DST/"

# --- service directories ------------------------------------------------------

# define <id> <type>
define() {
  mkdir -p "$DST/$1/dependencies.d"
  printf '%s\n' "$2" >"$DST/$1/type"
}

# enable <id> -- membership of the `user` bundle is what actually starts a
# service; a directory outside the bundle is inert.
enable() {
  touch "$DST/user/contents.d/$1"
}

needs() {
  local id="$1"
  shift
  for dep in "$@"; do
    [[ -d "$DST/$dep" ]] && touch "$DST/$id/dependencies.d/$dep"
  done
}

# longrun <id> <script> [args...]
#
# Anything in RUN_ENV ("NAME=value" entries) is exported ahead of the service and
# then cleared, so one caller's variables cannot leak into the next.
#
# The run script `exec`s all the way down to the service. logged.sh redirects
# with >> rather than piping, because a pipe would leave the shell as the
# supervised process: `s6-svc -r` would then signal the shell, the service would
# survive the restart still holding its port, and every replacement would die
# with "address already in use" while the old code carried on serving.
RUN_ENV=()
longrun() {
  local id="$1"
  shift
  define "$id" longrun
  {
    printf '#!/command/with-contenv bash\n'
    printf 'exec 2>&1\n'
    printf 'export SANDBOXER_SERVICE=%s\n' "$id"
    for kv in ${RUN_ENV[@]+"${RUN_ENV[@]}"}; do
      printf 'export %s\n' "$kv"
    done
    printf 'exec %s/logged.sh %s' "$SANDBOXER_SCRIPTS" "$id"
    printf ' %q' "$@"
    printf '\n'
  } >"$DST/$id/run"
  RUN_ENV=()
  chmod 755 "$DST/$id/run"

  # A crash loop that restarts instantly floods the log and hides its own first
  # line; the pause makes the failure readable.
  {
    printf '#!/command/with-contenv bash\n'
    printf 'echo "%s exited: code=$1 signal=$2"\n' "$id"
    printf 'sleep 2\n'
  } >"$DST/$id/finish"
  chmod 755 "$DST/$id/finish"
}

# oneshot <id> <script> [args...]
oneshot() {
  local id="$1"
  shift
  define "$id" oneshot
  printf '/command/with-contenv %s' "$1" >"$DST/$id/up"
  shift
  for arg in "$@"; do printf ' %q' "$arg" >>"$DST/$id/up"; done
  printf '\n' >>"$DST/$id/up"
}

# --- infrastructure -----------------------------------------------------------

GATES=()

DB_DRIVER=$(plan .database.driver none)
if [[ "$DB_DRIVER" == "mysql" ]]; then
  oneshot mysql-init "$SANDBOXER_SCRIPTS/db/mysql-init.sh"
  longrun mysqld "$SANDBOXER_SCRIPTS/db/mysqld.sh"
  needs mysqld mysql-init
  enable mysql-init
  enable mysqld
  GATES+=(mysqld)
fi

if [[ "$(plan .storage.driver none)" == "minio" ]]; then
  longrun minio "$SANDBOXER_SCRIPTS/storage/minio.sh"
  enable minio
  GATES+=(minio)
fi

# deps-init exists only when the project has a Node dependency tree to seed.
# A Go-only or database-only sandbox skips it entirely.
if [[ -n "$(plan .deps.root)" ]]; then
  oneshot deps-init "$SANDBOXER_SCRIPTS/deps-init.sh"
  enable deps-init
  GATES+=(deps-init)
fi

# db-init runs for every driver, `none` included: it is also what writes the
# status file the dashboard reads, so a sandbox with no database still reports
# whether it finished booting.
oneshot db-init "$SANDBOXER_SCRIPTS/db-init.sh"
enable db-init
[[ ${#GATES[@]} -gt 0 ]] && needs db-init "${GATES[@]}"

# Caddy deliberately does NOT wait for db-init. It serves the status surface and
# the "not built yet" pages, neither of which touches the database, and a restore
# can take minutes -- during which the dashboard most needs an answer. A backend
# that is not up yet is a 502, which is a truthful answer rather than a refused
# connection.
longrun caddy "$SANDBOXER_SCRIPTS/caddy.sh"
enable caddy

# --- the project's own services -----------------------------------------------

while read -r record; do
  [[ -z "$record" ]] && continue
  id=$(svc_id "$record")
  name=$(field "$record" name)
  port=$(field "$record" port)

  # PORT is injected rather than left to the project's own config: the plan is
  # the single place a port is declared, and the router reads the same number.
  [[ -n "$port" ]] && RUN_ENV=("PORT=$port")
  longrun "$id" "$SANDBOXER_SCRIPTS/run-backend.sh" "$name"
  needs "$id" db-init

  if requested "$record"; then
    enable "$id"
  else
    log "backend $name is optional and was not requested"
  fi
done < <(services backend)

while read -r record; do
  [[ -z "$record" ]] && continue
  id=$(svc_id "$record")
  label=$(field "$record" label)
  port=$(field "$record" port)

  [[ -n "$port" ]] && RUN_ENV=("PORT=$port")
  longrun "$id" "$SANDBOXER_SCRIPTS/run-server.sh" "$label"
  needs "$id" db-init deps-init

  if requested "$record"; then
    enable "$id"
  else
    log "front-end $label runs a server and is optional; it was not requested"
  fi
done < <(services server)

# Static front-ends get no service at all. They are built on demand into a
# directory Caddy serves, because a sandbox has to come up in seconds and an app
# nobody opens should cost nothing (contracts §5.1).

log "service tree ready: $(find "$DST/user/contents.d" -type f ! -name '.gitkeep' -printf '%f ' 2>/dev/null || true)"
