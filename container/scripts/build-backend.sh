#!/usr/bin/env bash
# Build one backend from the bind-mounted worktree into the binary volume.
#
# Built on demand rather than baked into the image, so a sandbox always runs the
# worktree's current code including uncommitted changes. The compiler cache is a
# volume, so this is incremental after the first boot.
set -euo pipefail

LOG_TAG="build-backend"
# shellcheck source-path=SCRIPTDIR source=lib.sh
source "${SANDBOXR_SCRIPTS:-/opt/sandboxr/scripts}/lib.sh"

NAME="${1:?build-backend.sh needs a backend name}"
RECORD=$(service_by backend name "$NAME")
[[ -n "$RECORD" ]] || die "no backend called '$NAME' in the plan"

ID=$(svc_id "$RECORD")
BIN="$SANDBOXR_STATE/bin/$ID"
WORKDIR="$WORKSPACE/$(field "$RECORD" workdir .)"
BUILD=$(field "$RECORD" build)

[[ -n "$BUILD" ]] || die "backend '$NAME' declares no build command"
[[ -d "$WORKDIR" ]] || die "workdir $WORKDIR does not exist in this worktree"

mkdir -p "$SANDBOXR_STATE/bin"

# Placeholders as documented in the config schema: {out} is where the binary must
# land, {name} is the service's own name.
BUILD=${BUILD//\{out\}/$BIN}
BUILD=${BUILD//\{name\}/$NAME}

# Rebuilt only when something under the workdir is newer than the binary.
# `-print -quit` stops at the first hit, so this stays cheap on a large tree even
# though it walks it. node_modules and .git are skipped because neither
# contributes to a compiled backend and both are large enough to dominate the
# walk.
needs_build() {
  [[ ! -x "$BIN" ]] && return 0
  [[ -n "$(find "$WORKDIR" -type f -newer "$BIN" \
    -not -path '*/node_modules/*' -not -path '*/.git/*' \
    -print -quit 2>/dev/null)" ]]
}

if [[ "${SANDBOXR_FORCE_BUILD:-false}" == "true" ]] || needs_build; then
  log "building $NAME"
  cd "$WORKDIR"
  # The command is the project's own, from its config; it is run as written so a
  # project never has to guess how the sandbox will mangle it.
  eval "$BUILD"
  log "built $NAME -> $BIN"
else
  log "$NAME is up to date"
fi
