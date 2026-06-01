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

# Resolve the release channel (feature 162). Default to edge when the
# preference file is absent so existing installs keep tracking main.
CHANNEL="$(cat "$SHIPIT_DIR/.release-channel" 2>/dev/null || echo edge)"
case "$CHANNEL" in
  stable) REF="origin/stable" ;;
  *)      REF="origin/main" ;;
esac
echo "$(date -Iseconds) Updating on channel '$CHANNEL' (ref $REF)"

# Pull latest code for the channel's ref. Tags are fetched so the version
# resolver can name the stable release. We only ever reset a tracking branch
# ref, never checkout a tag, so HEAD stays on a branch and build-id stays a SHA.
git fetch origin --tags --prune
git fetch origin "${REF#origin/}"
git reset --hard "$REF"

# Build and restart
bash "$SHIPIT_DIR/deployment/vps/deploy.sh"

echo "$(date -Iseconds) ShipIt update complete."
