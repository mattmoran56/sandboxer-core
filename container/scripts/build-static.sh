#!/usr/bin/env bash
# Build one static front-end into the directory the router serves.
#
#   build-static.sh <label>   one app
#   build-static.sh --all     every app the plan does not exclude
#   build-static.sh --built   refresh only what this sandbox has already built
#
# Static builds are on demand, never at startup (contracts §5.1): a sandbox has to
# come up in seconds, and an app nobody opens should cost nothing.
#
# `--all` exists so a single edit does not trigger every build in the project, and
# `--built` exists because "rebuild the front-ends" means something different once
# a sandbox has built an expensive one: it refreshes what is there without ever
# starting a first build of something excluded from `--all`.
set -euo pipefail

LOG_TAG="build-static"
# shellcheck source-path=SCRIPTDIR source=lib.sh
source "${SANDBOXER_SCRIPTS:-/opt/sandboxer/scripts}/lib.sh"

BUILT_MANIFEST="$SANDBOXER_WWW/.built.json"

build_one() {
  local label="$1" record pkg_dir out build memory limit cache_key="" cache_entry="" started=$SECONDS
  record=$(service_by static label "$label")
  [[ -n "$record" ]] || die "no static front-end labelled '$label' in the plan"

  pkg_dir="$WORKSPACE/$(field "$record" root .)/$(field "$record" package .)"
  out=$(field "$record" out dist)
  build=$(field "$record" build)
  memory=$(field "$record" memory)

  [[ -d "$pkg_dir" ]] || die "no package directory at $pkg_dir"
  [[ -n "$build" ]] || die "front-end '$label' declares no build command"

  # Local CLI calls can overlap. Each label owns its served-directory swap;
  # util-linux flock is installed in the runtime image (optional on test hosts).
  if command -v flock >/dev/null; then
    mkdir -p "$SANDBOXER_WWW/.locks"
    exec 9>"$SANDBOXER_WWW/.locks/$label"
    flock 9 || return 1
  fi

  limit=$(mem_limit)

  # A declared memory requirement is refused up front rather than discovered.
  # A build that renders many pages across several worker processes is not bounded
  # by any single heap limit -- the cgroup total is what the kernel kills -- and
  # what that looks like from outside is a bare `Killed` and the package manager's
  # exit code 137, which say nothing at all about memory. Failing in a second and
  # naming the cause is the whole point of the check.
  if [[ -n "$memory" && "$limit" != "max" ]]; then
    local want
    want=$(to_bytes "$memory")
    if ((limit < want)); then
      warn ""
      warn "'$label' declares it needs $memory to build; this sandbox has $((limit / 1073741824)) GB."
      warn "Restart the sandbox with more and try again:"
      warn "    sandboxer down $SANDBOXER_SLUG"
      warn "    SANDBOXER_MEMORY=$memory sandboxer up"
      warn ""
      return 1
    fi
  fi

  # Kept under the container limit so a JS build gives up with a heap error naming
  # the problem, rather than the kernel killing it silently. This bounds one
  # process, not the sum of several, which is why the check above exists as well.
  if [[ "$limit" != "max" ]]; then
    export NODE_OPTIONS="${NODE_OPTIONS:-} --max-old-space-size=$((limit / 1048576 * 75 / 100))"
  fi

  local cache_root="${SANDBOXER_STATIC_CACHE:-/var/cache/sandboxer/static-builds}"
  if [[ "$(field "$record" cache false)" == true && "${SANDBOXER_FORCE_BUILD:-false}" != true ]]; then
    if mkdir -p "$cache_root" && cache_key=$(node "$SANDBOXER_SCRIPTS/static-cache.mjs" key "$label"); then
      cache_entry="$cache_root/$cache_key"
      if command -v flock >/dev/null; then
        mkdir -p "$cache_root/.locks"
        exec 7>"$cache_root/.locks/$cache_key"
        flock 7 || return 1
      fi
      if [[ -d "$cache_entry" ]] && node "$SANDBOXER_SCRIPTS/static-cache.mjs" verify "$cache_entry"; then
        publish_static "$cache_entry/files" "$label" || return 1
        record_built "$label"
        log "reused $label from cache in $((SECONDS - started))s"
        return 0
      fi
      # Invalid entries must not permanently poison this key. Writers/readers
      # hold the same key lock, so only this invocation can replace it now.
      [[ ! -d "$cache_entry" ]] || rm -rf "$cache_entry"
      log "cache miss for $label (checked in $((SECONDS - started))s)"
    else
      cache_key=""
      warn "cache unavailable for $label; building normally"
    fi
  fi

  log "building $label"
  cd "$pkg_dir"
  # This function is called from an || list, where Bash disables errexit even
  # inside functions. Do not publish or cache old output after a failed build.
  if ! eval "$build"; then return 1; fi

  [[ -d "$out" ]] || die "'$label' built but produced no $out/"

  if [[ -n "$cache_key" ]]; then
    local after_key
    if after_key=$(node "$SANDBOXER_SCRIPTS/static-cache.mjs" key "$label") && [[ "$after_key" == "$cache_key" ]]; then
      node "$SANDBOXER_SCRIPTS/static-cache.mjs" store "$out" "$cache_entry" || warn "could not cache $label"
    else
      log "inputs changed during build; did not cache $label"
    fi
  fi

  publish_static "$out" "$label" || return 1
  record_built "$label"
  log "built $label in $((SECONDS - started))s -> $SANDBOXER_WWW/$label"
}

publish_static() {
  # Swapped rather than written in place, so a page load mid-build never sees a
  # half-written bundle.
  local source="$1" dest="$SANDBOXER_WWW/$2"
  rm -rf "$dest.new" "$dest.old"
  cp -a "$source" "$dest.new" || return 1
  mv "$dest" "$dest.old" 2>/dev/null || true
  mv "$dest.new" "$dest" || return 1
  rm -rf "$dest.old"
}

# The build time is recorded because a directory listing cannot carry it, and
# knowing a bundle is stale is most of the value of knowing it exists.
#
# It lives in the www volume rather than /run, which is a tmpfs: a container
# restart would throw the marker away while the bundles themselves survived, and
# every app would then report itself as never built.
record_built() {
  local now
  if command -v flock >/dev/null; then
    mkdir -p "$SANDBOXER_WWW/.locks"
    exec 8>"$SANDBOXER_WWW/.locks/manifest"
    flock 8 || return 1
  fi
  now=$(date -u +%Y-%m-%dT%H:%M:%SZ)
  local current='{}'
  [[ -f "$BUILT_MANIFEST" ]] && current=$(cat "$BUILT_MANIFEST" 2>/dev/null || echo '{}')
  printf '%s' "$current" |
    jq --arg l "$1" --arg t "$now" '. + { ($l): $t }' >"$BUILT_MANIFEST.new" &&
    mv "$BUILT_MANIFEST.new" "$BUILT_MANIFEST"
  exec 8>&-
}

labels_all() {
  jq -r '.services[]? | select(.kind == "static") | select(.in_build_all != false) | .label' \
    "$SANDBOXER_PLAN"
}

labels_built() {
  [[ -f "$BUILT_MANIFEST" ]] || return 0
  jq -r 'keys[]' "$BUILT_MANIFEST" 2>/dev/null
}

case "${1:?usage: build-static.sh <label>|--all|--built}" in
  --all) TARGETS=$(labels_all) ;;
  --built)
    TARGETS=$(labels_built)
    # Nothing built yet is not an error; it just means the sandbox is new.
    [[ -z "$TARGETS" ]] && TARGETS=$(labels_all)
    ;;
  *) TARGETS="$1" ;;
esac

# Each build runs in a subshell, so its `cd` and its NODE_OPTIONS cannot leak into
# the next one and a failure ends that build rather than the whole run: a broken
# app is exactly when the others are most worth having.
if [[ -n "$TARGETS" ]]; then
  "$SANDBOXER_SCRIPTS/wait-deps.sh"
fi
FAILED=""
for label in $TARGETS; do
  (build_one "$label") || FAILED+=" $label"
done

[[ -n "$FAILED" ]] && die "these did not build:$FAILED"
exit 0
