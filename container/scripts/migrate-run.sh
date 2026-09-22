#!/usr/bin/env bash
# Run the project's own migration command and record what happened.
#
# What runs is always the project's program (contracts §6): this script never
# reads a migrations table, never decides what is pending, and never repairs
# bookkeeping. It shells out, watches, and reports.
#
# Separate from db-init.sh so it can be re-run on demand -- a "Retry migrations"
# action, or by hand after editing a migration file -- without repeating the
# restore, the grants or the seeding.
#
# It never exits non-zero. A sandbox whose migrations failed is still up and
# still worth opening, so the outcome is recorded and the sandbox reports
# `degraded` instead.
set -uo pipefail

LOG_TAG="migrate"
# shellcheck source-path=SCRIPTDIR source=lib.sh
source "${SANDBOXER_SCRIPTS:-/opt/sandboxer/scripts}/lib.sh"

LOG="$SANDBOXER_LOGS/migrate.log"
SCHEMA_DIR="$SANDBOXER_STATE/schema"
DRIVER=$(plan .database.driver none)
DB_SCRIPT="$SANDBOXER_SCRIPTS/db/$DRIVER.sh"

mkdir -p "$SANDBOXER_LOGS" "$SCHEMA_DIR" "$SANDBOXER_RUN"

record() {
  jq -n --arg state "$1" --arg file "$2" --arg error "$3" \
    '{ state: $state, file: $file, error: $error }' >"$SANDBOXER_RUN/migrate.json"
  "$SANDBOXER_SCRIPTS/status.sh"
}

COMMAND=$(plan .database.migrate.command)
if [[ -z "$COMMAND" ]]; then
  log "this project declares no migration command"
  record skipped "" ""
  exit 0
fi

# `workdir` as given, because a migration runner usually has to be inside its own
# module or package to resolve anything. With no workdir the command runs in an
# empty directory instead, so no dotfile lying around the repo can shadow the
# environment the sandbox passed in -- which is how a migration ends up pointed
# at a real database.
WORKDIR=$(plan .database.migrate.workdir)
if [[ -n "$WORKDIR" ]]; then
  WORKDIR="$WORKSPACE/$WORKDIR"
else
  WORKDIR=/empty
fi
[[ -d "$WORKDIR" ]] || {
  warn "migrate workdir $WORKDIR does not exist"
  record failed "" "The configured workdir does not exist in this worktree."
  exit 0
}

# Informational, not appended to the command. A runner's cutoff flag is its own
# interface, and guessing its spelling would be reimplementing the runner.
SINCE=$(plan .database.migrate.since)
export SANDBOXER_MIGRATE_SINCE="$SINCE"

# --- baseline -----------------------------------------------------------------
#
# DDL is not transactional in every engine, so a migration can fail with earlier
# statements already committed, and "what did that actually change?" is the
# question worth answering.
#
# For that, the baseline has to be the last schema known to be clean. It is taken
# only when there isn't one, and re-taken only after a success -- re-snapshotting
# on every attempt would overwrite it with the half-migrated state the failure
# left behind, and the diff would then show nothing exactly when it matters most.
if [[ ! -f "$SCHEMA_DIR/baseline.sql" ]]; then
  "$DB_SCRIPT" snapshot >"$SCHEMA_DIR/baseline.sql" 2>/dev/null || true
fi

# --- run ----------------------------------------------------------------------
log "running: $COMMAND"

# The command's status is PIPESTATUS[0], not the pipeline's: tee always succeeds,
# so testing the pipeline reports every failed migration as a success.
set +o pipefail
(cd "$WORKDIR" && eval "$COMMAND") 2>&1 | tee "$LOG"
RC=${PIPESTATUS[0]}
set -o pipefail

# The exit code is not trusted on its own. A runner that prints its own summary
# and then exits zero reports success while the schema is half-applied, and a
# sandbox builds that runner from the branch it is testing -- so the branch may
# be exactly the one with the bug. A project that has such a runner names the
# pattern in its config.
FAILURE_PATTERN=$(plan .database.migrate.failure_pattern)
if [[ -n "$FAILURE_PATTERN" ]] && grep -qE "$FAILURE_PATTERN" "$LOG" 2>/dev/null; then
  RC=1
fi

if [[ "$RC" -eq 0 ]]; then
  log "ok"
  "$DB_SCRIPT" snapshot >"$SCHEMA_DIR/baseline.sql.new" 2>/dev/null &&
    mv "$SCHEMA_DIR/baseline.sql.new" "$SCHEMA_DIR/baseline.sql"
  rm -f "$SCHEMA_DIR/baseline.sql.new"
  record ok "" ""
  exit 0
fi

# --- what failed --------------------------------------------------------------
# Both patterns are the project's to declare: only it knows what its migration
# files are called and what its engine's errors look like. The defaults cover the
# common shapes so a project that declares neither still gets something useful.
FILE_PATTERN=$(plan .database.migrate.file_pattern '[0-9]{6,}[^ ]*\.(sql|ts|js|go)')
# `.*` rather than a negated newline class: grep is line-based, so `.` never
# crosses a line anyway, and `[^\n]` inside an ERE bracket expression means "not a
# backslash and not the letter n" -- which truncates the message at its first `n`.
ERROR_PATTERN=$(plan .database.migrate.error_pattern '([Ee]rror|ERROR|FATAL).*')

FAILED_FILE=$(grep -oE "$FILE_PATTERN" "$LOG" 2>/dev/null | tail -1)
FAILED_ERROR=$(grep -oE "$ERROR_PATTERN" "$LOG" 2>/dev/null | tail -1)
[[ -z "$FAILED_ERROR" ]] && FAILED_ERROR="See the full log for what went wrong."

warn "FAILED -- the sandbox is degraded but still running"
record failed "$FAILED_FILE" "$FAILED_ERROR"
exit 0
