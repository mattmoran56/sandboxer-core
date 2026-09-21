#!/usr/bin/env bash
# The D1 driver's container-side half.
#
# A D1 database is a directory of SQLite files that miniflare owns, so seeding is
# a directory copy and there is no server to install or wait for.
#
# **One writer per file.** Two miniflare instances opening the same SQLite file
# deadlock on SQLITE_BUSY, which turns a slow boot into a hang with nothing in
# the log. The config names the single service that owns the database, and
# everything here either runs before that service starts or refuses to run at
# all.
set -uo pipefail

LOG_TAG="d1"
# shellcheck source-path=SCRIPTDIR source=../lib.sh
source "${SANDBOXR_SCRIPTS:-/opt/sandboxr/scripts}/lib.sh"

DIR="${SANDBOXR_D1_DIR:?}"

seed_artifact() {
  local named
  named=$(plan .database.seed.path)
  [[ -z "$named" ]] && return 0
  [[ "$named" == /* ]] && printf '%s\n' "$named" || printf '/sandboxr/cache/%s\n' "$named"
}

# The SQLite file inside miniflare's state directory. Located by glob rather than
# by a fixed path because the object-store directory name is miniflare's to
# choose; a missing match means "nothing has created the database yet", which is
# a normal first-boot state.
#
# **Scoped to the D1 backend, and `metadata.sqlite` excluded.** miniflare puts
# every backend it persists under the one directory -- D1, KV, R2, the cache --
# and each is a `*.sqlite`. An unscoped `find | head -1` therefore returned
# whichever the filesystem happened to list first, which on this machine was the
# cache backend's `metadata.sqlite`. Everything then *worked*: the fixtures
# applied cleanly, `snapshot` printed a schema, `db shell` opened a database.
# They were just the wrong file. The symptom was an API answering `[]` for rows
# the seed had definitely loaded, with nothing in any log, and the cause looked
# nothing like it.
#
# The fallback keeps a future layout working: if nothing is under a `d1/`
# directory, take any `*.sqlite` that is not miniflare's metadata. `sort` makes
# the choice the same on two machines; `sed -n 1p` rather than `head -1` because
# `head` closes the pipe and a writer still going dies of SIGPIPE.
d1_file() {
  local found
  found=$(find "$DIR" -type f -path '*/d1/*' -name '*.sqlite' ! -name 'metadata.sqlite' 2>/dev/null | sort | sed -n 1p)
  [[ -n "$found" ]] || found=$(find "$DIR" -type f -name '*.sqlite' ! -name 'metadata.sqlite' 2>/dev/null | sort | sed -n 1p)
  printf '%s\n' "$found"
}

provision() {
  mkdir -p "$DIR"

  if [[ -n "$(d1_file)" ]]; then
    log "the D1 state directory already holds a database, keeping it"
    return 0
  fi

  local artifact
  artifact=$(seed_artifact)
  if [[ -n "$artifact" && -e "$artifact" ]]; then
    log "seeding from $artifact"
    # A directory in the artifact, because miniflare's state is a tree; a single
    # file is accepted too, for a driver that snapshotted just the database.
    if [[ -d "$artifact" ]]; then
      cp -a "$artifact/." "$DIR/" || return 1
    else
      cp -f "$artifact" "$DIR/" || return 1
    fi
  else
    log "no seed artifact; the project's migrations will build the schema"
  fi
}

# Applied with sqlite3 directly rather than through wrangler. wrangler would open
# its own miniflare against the same file, and this runs at boot when the owning
# service is about to start -- exactly the two-writer situation that deadlocks.
# db-init gates every service, so nothing else holds the file at this moment.
fixtures() {
  local file
  file=$(d1_file)
  [[ -n "$file" ]] || {
    warn "no D1 database to apply fixtures to"
    return 1
  }
  sqlite3 "$file" <"$1" >/dev/null 2>&1
}

snapshot() {
  local file
  file=$(d1_file)
  [[ -n "$file" ]] || return 0
  sqlite3 "$file" .schema
}

shell() {
  local file
  file=$(d1_file)
  [[ -n "$file" ]] || die "no D1 database in $DIR yet"
  # The owning service holds this file while it runs, so a writable shell would
  # be the second writer. Read-only is the honest offer.
  exec sqlite3 -readonly "$file"
}

case "${1:-}" in
  ready) [[ -n "$(d1_file)" ]] ;;
  provision) provision ;;
  fixtures) fixtures "${2:?fixtures needs a file}" ;;
  snapshot) snapshot ;;
  shell) shell ;;
  *) die "usage: d1.sh ready|provision|fixtures <file>|snapshot|shell" ;;
esac
