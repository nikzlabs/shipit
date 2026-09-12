#!/bin/bash
# Stop ShipIt; --purge also deletes workspace and credential volumes.
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

# shellcheck disable=SC2046 -- Intentional word splitting over container IDs.
docker rm -f $(docker ps -aq --filter "label=shipit-stack=shipit") 2>/dev/null || true
# shellcheck disable=SC2046
docker rm -f $(docker ps -aq --filter "label=shipit-parent-session") 2>/dev/null || true

if [ "$PURGE" -eq 1 ]; then
  echo "$(date -Iseconds) --purge: workspace and credentials volumes will be DELETED."
  docker compose -f "$COMPOSE_FILE" down --volumes
else
  docker compose -f "$COMPOSE_FILE" down
fi

docker network prune -f

echo "$(date -Iseconds) ShipIt stopped."
