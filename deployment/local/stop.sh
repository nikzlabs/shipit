#!/usr/bin/env bash
# Fully stop a local ShipIt install and clean up its session containers and
# networks. By default the workspace/credentials volumes are PRESERVED so your
# data and provider sign-ins survive a stop; pass --purge to also delete them
# (destructive). Cross-platform (macOS + Linux).
set -euo pipefail

SCRIPT_DIR="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"
SHIPIT_HOME="${SHIPIT_HOME:-$(cd "$SCRIPT_DIR/../.." && pwd)}"
export SHIPIT_HOME

PURGE=0
for arg in "$@"; do
  case "$arg" in
    --purge|--volumes) PURGE=1 ;;
    -h|--help) echo "Usage: stop.sh [--purge]"; exit 0 ;;
    *) echo "Unknown option: $arg" >&2; echo "Usage: stop.sh [--purge]" >&2; exit 1 ;;
  esac
done

# shellcheck source=/dev/null
. "$SHIPIT_HOME/deployment/local/lib.sh"

echo "==> Stopping ShipIt..."
if [ "$PURGE" -eq 1 ]; then
  echo "    --purge: workspace and credentials volumes will be DELETED."
  docker compose -f "$COMPOSE_FILE" down --volumes
else
  docker compose -f "$COMPOSE_FILE" down
fi

echo "==> Cleaning up session containers and networks..."
shipit_cleanup_sessions

echo "==> ShipIt stopped."
