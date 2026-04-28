#!/bin/bash
# Build and (re)start ShipIt in production.
# Called by setup.sh, update.sh, or manually:
#   bash /opt/shipit/deployment/hetzner/deploy.sh
set -euo pipefail

SHIPIT_DIR="/opt/shipit"
COMPOSE_FILE="$SHIPIT_DIR/deployment/hetzner/docker-compose.yml"

cd "$SHIPIT_DIR"

# Kill stale session-worker and compose service containers from previous runs
docker rm -f $(docker ps -aq --filter "label=shipit-stack=shipit") 2>/dev/null || true
docker rm -f $(docker ps -aq --filter "label=shipit-parent-session") 2>/dev/null || true

# Prune orphaned networks from previous sessions to reclaim address space
docker network prune -f

# Build both images (session-worker is a build-only profile, must be named explicitly)
docker compose -f "$COMPOSE_FILE" build --no-cache --pull session-worker shipit

# Start orchestrator (session-worker containers are spawned on demand)
docker compose -f "$COMPOSE_FILE" up -d --no-build shipit

# Clean up old images
docker image prune -f
