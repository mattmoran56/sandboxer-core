#!/usr/bin/env bash
# Populate the sandbox's node_modules on first boot.
#
# The project image installs dependencies under /opt/deps, deliberately outside
# the worktree: the worktree is bind-mounted over /workspace at run time, which
# hides anything the image installed there. This seeds the node_modules volume
# from /opt/deps instead.
#
# That volume is named after the lockfile hash (contracts §3.3), so every sandbox
# with the same dependencies shares one install, and a branch that changes its
# dependencies transparently gets its own. When the branch's lockfile does not
# match the image's, a real install runs instead of a copy.
#
# `set -e` is absent on purpose: no dependency problem is worth refusing to boot
# over. A sandbox whose front-end builds do not work is still worth opening.
set -uo pipefail

LOG_TAG="deps-init"
# shellcheck source-path=SCRIPTDIR source=lib.sh
source "${SANDBOXR_SCRIPTS:-/opt/sandboxr/scripts}/lib.sh"

ROOT=$(plan .deps.root)
[[ -n "$ROOT" ]] || {
  log "the plan declares no dependency tree"
  exit 0
}

INSTALL=$(plan .deps.install "npm ci --no-audit --no-fund")
LOCKFILE=$(plan .deps.lockfile package-lock.json)

DEPS_DIR="$WORKSPACE/$ROOT"
TARGET="$DEPS_DIR/node_modules"
SOURCE=/opt/deps/node_modules

[[ -d "$DEPS_DIR" ]] || {
  log "no $ROOT in this worktree"
  exit 0
}

# Recreate the node_modules/.bin entries that workspace packages declare.
#
# The image installs from manifests alone, and npm skips a `bin` whose target
# file does not exist yet -- so a build script one package exposes to another is
# missing, and the build fails with a bare `code 127` that names nothing. The
# symlink points into the live worktree, so linking here picks up whatever the
# branch's script currently says.
link_workspace_bins() {
  node - "$TARGET" <<'NODE'
const fs = require("fs");
const path = require("path");

const modules = process.argv[2];
const root = path.resolve(modules, "..");
const binDir = path.join(modules, ".bin");
fs.mkdirSync(binDir, { recursive: true });

const manifests = [];
const walk = (dir, depth) => {
  if (depth > 4) return;
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    if (entry.name === "node_modules" || entry.name.startsWith(".")) continue;
    const child = path.join(dir, entry.name);
    const pkg = path.join(child, "package.json");
    if (fs.existsSync(pkg)) manifests.push(pkg);
    walk(child, depth + 1);
  }
};
walk(root, 0);

let linked = 0;
for (const manifest of manifests) {
  let pkg;
  try { pkg = JSON.parse(fs.readFileSync(manifest, "utf8")); } catch { continue; }
  if (!pkg.bin) continue;
  const bins = typeof pkg.bin === "string" ? { [String(pkg.name).split("/").pop()]: pkg.bin } : pkg.bin;
  for (const [name, rel] of Object.entries(bins)) {
    const target = path.resolve(path.dirname(manifest), rel);
    const link = path.join(binDir, name);
    if (!fs.existsSync(target)) continue;
    try {
      if (fs.lstatSync(link, { throwIfNoEntry: false })) fs.rmSync(link, { force: true });
    } catch {}
    try {
      fs.symlinkSync(path.relative(binDir, target), link);
      fs.chmodSync(target, 0o755);
      linked++;
    } catch (e) {
      console.error(`could not link ${name}: ${e.message}`);
    }
  }
}
console.log(`deps-init: linked ${linked} workspace bin(s)`);
NODE
}

if [[ -d "$TARGET" ]] && [[ -n "$(ls -A "$TARGET" 2>/dev/null)" ]]; then
  log "node_modules already populated"
  # Still re-linked: the volume is shared between sandboxes and outlives any one
  # of them, so a bin added by a later branch would otherwise never appear.
  link_workspace_bins
  exit 0
fi

WANT=$(sha256sum "$DEPS_DIR/$LOCKFILE" 2>/dev/null | cut -c1-16)
HAVE=$(cat /opt/deps/.lockhash 2>/dev/null)

mkdir -p "$TARGET"

if [[ -n "$WANT" && "$WANT" != "$HAVE" ]]; then
  # The branch changed its dependencies, so the baked install is the wrong one.
  # Installing here is slow but correct, and it beats a sandbox that builds
  # against the wrong package versions and cannot say why.
  log "this worktree's $LOCKFILE differs from the image -- installing"
  cd "$DEPS_DIR" || exit 0
  if ! eval "$INSTALL"; then
    warn "'$INSTALL' failed; front-end builds will not work"
    exit 0
  fi
  log "dependencies installed"
  link_workspace_bins
  exit 0
fi

log "seeding node_modules from the image"
START=$(date +%s)
if ! cp -a "$SOURCE/." "$TARGET/"; then
  warn "could not seed node_modules"
  exit 0
fi
log "seeded in $(($(date +%s) - START))s"

link_workspace_bins
