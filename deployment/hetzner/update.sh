#!/bin/bash
# Host-side update script for ShipIt.
# Called by the shipit-updater systemd path unit when .update-requested appears.
set -euo pipefail

SHIPIT_DIR="/opt/shipit"
TRIGGER_FILE="$SHIPIT_DIR/.update-requested"
COMPOSE_FILE="$SHIPIT_DIR/deployment/hetzner/docker-compose.yml"

# Remove trigger file immediately so we don't re-run
rm -f "$TRIGGER_FILE"

echo "$(date -Iseconds) ShipIt update starting..."

cd "$SHIPIT_DIR"

# Pull latest code
git fetch origin main
git reset --hard origin/main

# Rebuild and restart
docker compose -f "$COMPOSE_FILE" build session-worker shipit
docker compose -f "$COMPOSE_FILE" up -d --no-build shipit

# Clean up old images
docker image prune -f

echo "$(date -Iseconds) ShipIt update complete."
