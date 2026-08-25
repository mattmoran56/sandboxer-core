#!/usr/bin/env bash
# Run the sandbox's MySQL server.
#
# The flags trade durability for speed, which is safe because everything in this
# container is disposable and reproducible from the seed artifact.
#
# --sql-mode is deliberately absent so the server's own default for its version
# applies. Setting it here would change which of the project's migrations pass,
# and a migration is only meaningfully tested against the behaviour it will
# really run under.
set -euo pipefail

LOG_TAG="mysqld"
# shellcheck source-path=SCRIPTDIR source=../lib.sh
source "${SANDBOXR_SCRIPTS:-/opt/sandboxr/scripts}/lib.sh"

exec mysqld \
  --user=mysql \
  --datadir="$SANDBOXR_STATE/data/mysql" \
  --bind-address=127.0.0.1 \
  --skip-log-bin \
  --performance-schema=OFF \
  --innodb-buffer-pool-size=256M \
  --innodb-doublewrite=0 \
  --innodb-flush-log-at-trx-commit=2 \
  --innodb-redo-log-capacity=64M \
  --max-connections=200 \
  --character-set-server=utf8mb4 \
  --collation-server=utf8mb4_0900_ai_ci
