#!/usr/bin/env bash
# Shared helpers for every script inside a sandbox: reading the plan, naming
# services, and logging.
#
# Sourced, never executed, so it sets no shell options of its own -- doing so
# would silently change the caller's error handling.

# The plan is the container's whole view of the project. Everything else about
# the sandbox -- which services exist, which ports they hold, how the router is
# wired -- is derived from it, so nothing in here is hardcoded per project.
SANDBOXR_PLAN="${SANDBOXR_PLAN:-/sandboxr/plan.json}"

SANDBOXR_SCRIPTS="${SANDBOXR_SCRIPTS:-/opt/sandboxr/scripts}"
SANDBOXR_RUN="${SANDBOXR_RUN:-/run/sandboxr}"
SANDBOXR_LOGS="${SANDBOXR_LOGS:-/var/log/sandboxr}"
SANDBOXR_STATE="${SANDBOXR_STATE:-/var/lib/sandboxr}"
SANDBOXR_WWW="${SANDBOXR_WWW:-/srv/www}"
WORKSPACE="${WORKSPACE:-/workspace}"

log() { printf '%s: %s\n' "${LOG_TAG:-sandboxr}" "$*"; }
warn() { printf '%s: %s\n' "${LOG_TAG:-sandboxr}" "$*" >&2; }
die() {
  warn "$*"
  exit 1
}

# --- plan access -------------------------------------------------------------
#
# jq lives in the base image rather than being an optional extra: the plan is
# JSON, the base image deliberately has no Node, and hand-rolling a JSON parser
# in shell is how these scripts would start lying about what the plan says.

# plan <jq-filter> [default] -- a null or missing value yields the default
# (empty when none is given) rather than the string "null".
plan() {
  local filter="$1" fallback="${2-}" out
  out=$(jq -r "${filter} // empty" "$SANDBOXR_PLAN" 2>/dev/null) || out=""
  [[ -n "$out" ]] && printf '%s\n' "$out" || printf '%s\n' "$fallback"
}

# services <kind> -- one compact JSON object per line, so a caller can jq into
# each record without a second pass over the plan and without inventing a
# delimiter that a command string might contain.
services() {
  jq -c --arg kind "$1" '.services[]? | select(.kind == $kind)' "$SANDBOXR_PLAN" 2>/dev/null
}

# field <json> <key> [default]
field() {
  local out
  out=$(printf '%s' "$1" | jq -r ".${2} // empty" 2>/dev/null) || out=""
  [[ -n "$out" ]] && printf '%s\n' "$out" || printf '%s\n' "${3-}"
}

# service_by <kind> <field> <value> -- the one plan record matching, or empty.
service_by() {
  jq -c --arg k "$1" --arg f "$2" --arg v "$3" \
    '[ .services[]? | select(.kind == $k and (.[$f] // "") == $v) ][0] // empty' \
    "$SANDBOXR_PLAN" 2>/dev/null
}

# requested <json> -- whether this service runs in this sandbox.
#
# A service the plan marks optional is defined but dormant until it is named in
# SANDBOXR_WITH, a comma-separated list of names or labels. Optional exists for
# the things that are expensive to run and rarely wanted -- a dev server holding
# a whole module graph in memory, a service nothing under test talks to.
#
# Both generators consult this, so the router never advertises a hostname for a
# service that is not going to answer: the 404 then names the real cause.
requested() {
  local record="$1" with=",${SANDBOXR_WITH:-}," key
  [[ "$(field "$record" optional false)" != "true" ]] && return 0
  for key in "$(field "$record" name)" "$(field "$record" label)"; do
    [[ -n "$key" && "$with" == *",$key,"* ]] && return 0
  done
  return 1
}

# --- naming ------------------------------------------------------------------

# Same sanitising as a slug (contracts §3.1) minus the length ceiling, which
# only matters for names that reach a database lock.
sanitize() {
  printf '%s' "$1" |
    tr '[:upper:]' '[:lower:]' |
    sed -e 's/[^a-z0-9-]/-/g' -e 's/--*/-/g' -e 's/^-//' -e 's/-$//'
}

# The s6 service name for one plan record.
#
# Backends are named after the service; long-running front-ends are prefixed
# `web-` and named after their hostname label. Keeping the two in separate
# namespaces means a backend called `api` and a front-end labelled `api` cannot
# collide on one service directory -- which they would, since the example
# configs pair exactly that name with exactly that label.
svc_id() {
  local record="$1" kind
  kind=$(field "$record" kind)
  case "$kind" in
    backend) sanitize "$(field "$record" name)" ;;
    server) printf 'web-%s\n' "$(sanitize "$(field "$record" label)")" ;;
    static) printf 'web-%s\n' "$(sanitize "$(field "$record" label)")" ;;
    *) die "unknown runtime kind '$kind'" ;;
  esac
}

# The hostname a label is served on. The domain comes from the environment so
# one image serves every domain; baking it in is what made the source
# implementation's domain override a no-op.
#
# One DNS label above the domain, its three parts joined by `--` (contracts
# §3.2). It used to be three dotted labels, and what changed it was TLS rather
# than DNS: a TLS wildcard covers exactly one label, so the deeper shape could be
# covered by no wildcard certificate and needed one per sandbox. This has to
# agree character for character with `hostFor` in packages/core/src/naming.ts --
# the router outside is matching the same string, and a mismatch is a 404 from
# Caddy on a request the router was right to forward.
fqdn() {
  printf '%s--%s--%s.%s\n' \
    "${SANDBOXR_SLUG:?SANDBOXR_SLUG is required}" \
    "$1" \
    "$(plan .project)" \
    "${SANDBOXR_DOMAIN:-sbx.localhost}"
}

# --- misc --------------------------------------------------------------------

# The container's memory ceiling in bytes, or `max` when it is unlimited. cgroup
# v2 only: every Docker release that can run this image uses it.
mem_limit() {
  cat /sys/fs/cgroup/memory.max 2>/dev/null || printf 'max\n'
}

# run_quiet <command> [args...] -- silent when it works, loud when it does not.
#
# The output is buffered rather than thrown away, and printed only on a non-zero
# exit. Returns the command's own status, so a caller keeps whatever it already
# does about failure.
#
# **`>/dev/null 2>&1` is what this replaces, and the difference is not cosmetic.**
# Several commands in here are noisy on the path where nothing is wrong -- mysqld
# narrates its own initialisation over stderr -- so the redirect was added to keep
# a clean boot readable, which is a real thing to want. What it also did was
# discard the one message that explains a failure. When a host's disk filled, the
# error mysqld wrote went to /dev/null and all that survived was a oneshot exiting
# non-zero, so a full disk surfaced as "the database will not initialise" and cost
# three days of looking in the wrong place. A diagnosis that names its own cause
# has to outlive the noise suppression, not be bundled in with it.
run_quiet() {
  local out status=0
  # Both streams into one capture, in order: which of the two a tool writes its
  # error to is not something a caller can rely on, and interleaving is how the
  # failing line keeps the context above it.
  out=$("$@" 2>&1) || status=$?
  if [[ "$status" -ne 0 ]]; then
    warn "$1 failed (exit $status)"
    # An `if` rather than `[[ ... ]] && printf`: the caller runs under
    # `set -e`, where an and-list ending false is itself a failure, and an
    # empty capture would abort before the status below could be returned.
    if [[ -n "$out" ]]; then printf '%s\n' "$out" >&2; fi
  fi
  return "$status"
}

# to_bytes 6g -> 6442450944. Accepts a bare byte count too.
to_bytes() {
  local v="${1,,}" n
  n="${v%[kmg]*}"
  case "$v" in
    *g) printf '%s\n' "$((n * 1073741824))" ;;
    *m) printf '%s\n' "$((n * 1048576))" ;;
    *k) printf '%s\n' "$((n * 1024))" ;;
    *) printf '%s\n' "$n" ;;
  esac
}

# --- the computed environment -------------------------------------------------
#
# Sourced last, because it uses the helpers above. Every script gets it, not just
# the entrypoint: `docker exec` inherits the container's *configured* environment
# and never sees the entrypoint's exports, so a script reached that way would
# otherwise run with an empty $SANDBOXR_DB_FILE or $SANDBOXR_D1_DIR and point the
# runtime at nothing.
# shellcheck source-path=SCRIPTDIR source=env.sh
source "$SANDBOXR_SCRIPTS/env.sh"
