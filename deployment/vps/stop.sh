#!/bin/bash
# Host-side stop script for ShipIt on a VPS — fully shut down the orchestrator
# and clean up session containers + networks. The teardown counterpart to
# restart.sh. By default named volumes (workspace/credentials) are PRESERVED;
# pass --purge to also delete them (destructive — wipes session data + sign-ins).
set -euo pipefail

SHIPIT_DIR="/opt/shipit"
COMPOSE_FILE="$SHIPIT_DIR/deployment/vps/docker-compose.yml"

PURGE=0
for arg in "$@"; do
  case "$arg" in
    --purge|--volumes) PURGE=1 ;;
    -h|--help) echo "Usage: stop.sh [--purge]"; exit 0 ;;
    *) echo "Unknown option: $arg" >&2; echo "Usage: stop.sh [--purge]" >&2; exit 1 ;;
  esac
done

echo "$(date -Iseconds) ShipIt stop starting..."

cd "$SHIPIT_DIR"

# Remove session-worker + compose service containers for this stack and any
# compose children (same labels restart.sh sweeps).
# shellcheck disable=SC2046  # intentional word-splitting over the id list
docker rm -f $(docker ps -aq --filter "label=shipit-stack=shipit") 2>/dev/null || true
# shellcheck disable=SC2046
docker rm -f $(docker ps -aq --filter "label=shipit-parent-session") 2>/dev/null || true

# Bring the orchestrator stack down.
if [ "$PURGE" -eq 1 ]; then
  echo "$(date -Iseconds) --purge: workspace and credentials volumes will be DELETED."
  docker compose -f "$COMPOSE_FILE" down --volumes
else
  docker compose -f "$COMPOSE_FILE" down
fi

# Reclaim per-session network address space.
docker network prune -f

echo "$(date -Iseconds) ShipIt stopped."
