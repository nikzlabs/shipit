#!/usr/bin/env bash
# Update a local ShipIt install: fetch the latest code for the configured
# release channel, rebuild the images, and restart (detached). Run this whenever
# you want to pick up new ShipIt versions — the local install does not
# self-update from the UI. Cross-platform (macOS + Linux).
#
# Choose the channel (stable/edge) in the ShipIt UI under
# Settings -> Advanced -> Software Updates; it's stored in $SHIPIT_HOME/.release-channel.
set -euo pipefail

SCRIPT_DIR="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"
# Default SHIPIT_HOME to this script's own checkout root, so running the in-repo
# script just works wherever the repo lives.
SHIPIT_HOME="${SHIPIT_HOME:-$(cd "$SCRIPT_DIR/../.." && pwd)}"
export SHIPIT_HOME

if [ ! -d "$SHIPIT_HOME/.git" ]; then
  echo "Error: no ShipIt git checkout found at $SHIPIT_HOME." >&2
  echo "Run deployment/local/setup.sh first, or set SHIPIT_HOME to your checkout." >&2
  exit 1
fi

# shellcheck source=/dev/null
. "$SHIPIT_HOME/deployment/local/lib.sh"

shipit_sync_checkout
shipit_build_and_up

echo ""
echo "==> ShipIt updated and running at http://localhost:4123"
