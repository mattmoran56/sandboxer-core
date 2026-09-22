#!/usr/bin/env bash
# Serve the sandbox: static front-end builds by hostname, everything else proxied
# to the service that owns that host.
#
# The config is the one gen-caddyfile.sh wrote at boot, not a file in the image:
# host matchers depend on the slug and the domain, neither of which is known
# until the container starts.
set -euo pipefail

LOG_TAG="caddy"
# shellcheck source-path=SCRIPTDIR source=lib.sh
source "${SANDBOXER_SCRIPTS:-/opt/sandboxer/scripts}/lib.sh"

exec caddy run --config "$SANDBOXER_RUN/Caddyfile" --adapter caddyfile
