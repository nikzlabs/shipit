#!/usr/bin/env bash
# Update from the selected release channel, rebuild, and restart.
set -euo pipefail

SCRIPT_DIR="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"
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
