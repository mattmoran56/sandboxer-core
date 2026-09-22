#!/usr/bin/env bash
# Populate the sandbox's node_modules on first boot.
#
# The project image installs dependencies under /opt/deps, deliberately outside
# the worktree: the worktree is bind-mounted over /workspace at run time, which
# hides anything the image installed there. This seeds the node_modules volume
# from /opt/deps instead.
#
# Two trees come out of that install, not one, and both are needed: the root
# `node_modules`, which is the shared volume, and the per-workspace
# `packages/*/node_modules` npm writes for every dependency it could not hoist.
# The second lands in the worktree rather than the volume, so it is seeded on
# every boot rather than once -- see `seed_workspace_deps`.
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
source "${SANDBOXER_SCRIPTS:-/opt/sandboxer/scripts}/lib.sh"

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
WORKSPACE_SOURCE=/opt/deps

# What "already installed" means, and it is deliberately not "the directory has
# something in it".
#
# The volume is shared: every sandbox on this lockfile mounts the same one. A
# boot interrupted part-way through the copy below leaves a tree that is
# non-empty and short of packages, and a directory listing cannot tell that from
# a finished install -- so the volume reported itself populated forever, and
# every sandbox on the lockfile inherited it. It happened here: 29 packages and
# 1,524 files missing, including three workspace packages, and the only symptom
# was front-end builds failing to resolve imports that plainly exist.
#
# So the marker is written last, by rename, and nothing else counts as done. It
# holds the lockfile hash it was installed from -- the same key the host names
# the volume after -- so a volume that somehow holds a different tree repairs
# itself rather than being trusted. This is `partialPath`/`commitPartial` from
# packages/core/src/drivers/seed.ts, which solves exactly this for a half-written
# dump; deps-init simply never used it.
MARKER="$TARGET/.sandboxer-deps"

commit_marker() {
  # Renamed into place rather than written in place: a marker half-written by a
  # kill -9 would claim an install that is not there, which is the failure this
  # whole mechanism exists to prevent.
  printf '%s\n' "$1" >"$MARKER.partial" && mv "$MARKER.partial" "$MARKER"
}

[[ -d "$DEPS_DIR" ]] || {
  log "no $ROOT in this worktree"
  exit 0
}

# Copy the per-workspace node_modules the root tree does not contain.
#
# npm only hoists a dependency to the root when nothing disagrees about its
# version. Where two workspace packages want different versions of the same
# thing, the loser is installed *nested*, at `packages/<name>/node_modules`, and
# the lockfile records it there. Seeding only `$SOURCE` therefore copies a tree
# that npm never intended to be complete on its own.
#
# The symptom is indistinguishable from a corrupt install and sends you to the
# wrong place entirely: a front-end build fails to resolve a package that is in
# `package.json`, sits in the lockfile, and is plainly installed — just not where
# the resolver looks. It cost an afternoon here. `@vitejs/plugin-react` was
# declared by nine workspace packages and hoisted for none of them, so every one
# of four dev servers died on an import that every file in the repo agreed
# existed. Deleting the volume and reinstalling reproduced it exactly, because
# the image's own staging directory had the same shape.
#
# **This runs on every boot, not only when the volume is seeded.** The marker
# below lives in the node_modules volume, which is shared across every sandbox on
# a lockfile; these directories live in the *worktree*, which is not shared and is
# new for every sandbox. A marked volume therefore says nothing about whether
# this worktree has its nested packages, so gating this on the marker would fix
# the first sandbox on a lockfile and no other -- which is worse than not fixing
# it, because it would work when you tested it.
seed_workspace_deps() {
  [[ -d "$WORKSPACE_SOURCE" ]] || return 0

  local copied=0 src rel dest
  # -mindepth 2 skips `/opt/deps/node_modules` itself, which $SOURCE already
  # covers; the -path prune skips the nested trees *inside* it, which belong to
  # packages rather than to workspaces. What is left is exactly one entry per
  # workspace package that npm refused to hoist, at whatever depth the
  # workspace globs put it.
  while IFS= read -r src; do
    rel=${src#"$WORKSPACE_SOURCE"/}
    dest="$DEPS_DIR/$rel"
    # Never over the top of an existing tree: a real `npm ci` in the branch has
    # already written the right thing there, and the image's copy is by
    # definition the older one.
    [[ -e "$dest" ]] && continue
    mkdir -p "$(dirname "$dest")" || continue
    cp -a "$src" "$(dirname "$dest")/" && copied=$((copied + 1))
  done < <(find "$WORKSPACE_SOURCE" -mindepth 2 -type d -name node_modules -not -path "*/node_modules/*" 2>/dev/null)

  [[ "$copied" -gt 0 ]] && log "seeded $copied nested workspace node_modules"
  return 0
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

WANT=$(sha256sum "$DEPS_DIR/$LOCKFILE" 2>/dev/null | cut -c1-16)
HAVE=$(cat /opt/deps/.lockhash 2>/dev/null)

mkdir -p "$TARGET"

if [[ -f "$MARKER" ]] && [[ "$(cat "$MARKER" 2>/dev/null)" == "$WANT" ]]; then
  log "node_modules already populated"
  # Still seeded and re-linked: both of these live in the worktree rather than in
  # the volume the marker describes, so a populated volume tells us nothing about
  # whether this sandbox has them. A bin added by a later branch would otherwise
  # never appear, and a second sandbox on a lockfile would never get its nested
  # packages at all.
  seed_workspace_deps
  link_workspace_bins
  exit 0
fi

# Non-empty and unmarked: either an install this script was killed part-way
# through, or one made before the marker existed. Said out loud, because a
# silent repair of a volume several sandboxes share is worth seeing in a log.
if [[ -n "$(ls -A "$TARGET" 2>/dev/null)" ]]; then
  log "node_modules is not marked complete -- repairing it"
fi

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
  commit_marker "$WANT"
  # A real install writes its own nested trees, so this finds nothing to do and
  # is called anyway rather than reasoned about: the guard is per-directory, so
  # the no-op case costs one `find` and cannot overwrite what npm just wrote.
  seed_workspace_deps
  link_workspace_bins
  exit 0
fi

log "seeding node_modules from the image"
START=$(date +%s)
# Over the top rather than emptying first, and that is not laziness: another
# sandbox may be running against this same volume right now, and `cp -a` filling
# in what is missing never leaves it with less than it started with.
if ! cp -a "$SOURCE/." "$TARGET/"; then
  warn "could not seed node_modules"
  exit 0
fi
log "seeded in $(($(date +%s) - START))s"
commit_marker "$WANT"

seed_workspace_deps
link_workspace_bins
