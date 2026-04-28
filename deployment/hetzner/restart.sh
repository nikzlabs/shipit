#!/bin/bash
# Host-side restart script for ShipIt (no code update).
# Called by the shipit-restarter systemd path unit when .restart-requested appears.
set -euo pipefail

SHIPIT_DIR="/opt/shipit"
TRIGGER_FILE="$SHIPIT_DIR/.restart-requested"

# Remove trigger file immediately so we don't re-run
rm -f "$TRIGGER_FILE"

echo "$(date -Iseconds) ShipIt restart starting..."

# Build and restart (no git pull)
bash "$SHIPIT_DIR/deployment/hetzner/deploy.sh"

echo "$(date -Iseconds) ShipIt restart complete."
