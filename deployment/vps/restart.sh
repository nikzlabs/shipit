#!/bin/bash
# Host-side restart script for ShipIt — no git pull, no image rebuild.
# Called by the shipit-restarter systemd path unit when .restart-requested appears.
#
# This intentionally does NOT call deploy.sh. deploy.sh runs
# `docker compose build` plus an image/builder prune. Both are pointless for a
# pure restart where neither the source nor the image changed — they just add
# 30s+ of needless work, which makes the user wonder whether the restart
# actually happened. (The agent CLIs install from a committed lockfile now, so
# a build only changes them when that lockfile changes — see
# docs/141-cli-version-strategy.)
#
# All we need is to recreate the orchestrator container so the
# in-process state is reset.
set -euo pipefail

SHIPIT_DIR="/opt/shipit"
COMPOSE_FILE="$SHIPIT_DIR/deployment/vps/docker-compose.yml"
TRIGGER_FILE="$SHIPIT_DIR/.restart-requested"

# Remove trigger file immediately so we don't re-run
rm -f "$TRIGGER_FILE"

echo "$(date -Iseconds) ShipIt restart starting (no rebuild)..."

cd "$SHIPIT_DIR"

# Kill stale session-worker and compose service containers from previous
# runs — same defensive cleanup deploy.sh does, since the orchestrator is
# the only thing that tracks those containers and a restart drops that state.
docker rm -f $(docker ps -aq --filter "label=shipit-stack=shipit") 2>/dev/null || true
docker rm -f $(docker ps -aq --filter "label=shipit-parent-session") 2>/dev/null || true

# Force-recreate the orchestrator container using the existing image.
# --no-build skips the build step entirely; --force-recreate ensures the
# container is actually replaced even if its config hasn't changed.
docker compose -f "$COMPOSE_FILE" up -d --no-build --force-recreate shipit

echo "$(date -Iseconds) ShipIt restart complete."
