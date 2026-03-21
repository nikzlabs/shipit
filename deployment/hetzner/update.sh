#!/bin/bash
# Host-side update script for ShipIt.
# Called by the shipit-updater systemd path unit when .update-requested appears.
set -euo pipefail

SHIPIT_DIR="/opt/shipit"
TRIGGER_FILE="$SHIPIT_DIR/.update-requested"

# Remove trigger file immediately so we don't re-run
rm -f "$TRIGGER_FILE"

echo "$(date -Iseconds) ShipIt update starting..."

cd "$SHIPIT_DIR"

# Pull latest code
git fetch origin main
git reset --hard origin/main

# Build and restart
bash "$SHIPIT_DIR/deployment/hetzner/deploy.sh"

echo "$(date -Iseconds) ShipIt update complete."
