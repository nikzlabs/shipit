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

# Build both images (session-worker is a build-only profile, must be named explicitly).
# Reuses Docker's build cache by default; set FORCE_REBUILD=1 (or "true",
# "yes", "on") to bypass it.
# NPM_GLOBALS_REBUILD is bumped every deploy so the Claude/Codex CLI install
# layer always picks up the latest published versions, even when the rest of
# the image is cache-reused. The npm cache mount keeps the download fast.
BUILD_ARGS=("--pull" "--build-arg" "NPM_GLOBALS_REBUILD=$(date +%s)")
case "${FORCE_REBUILD:-0}" in
  1|true|TRUE|True|yes|YES|Yes|on|ON|On)
    BUILD_ARGS+=("--no-cache")
    ;;
esac
docker compose -f "$COMPOSE_FILE" build "${BUILD_ARGS[@]}" session-worker shipit

# Start orchestrator (session-worker containers are spawned on demand)
docker compose -f "$COMPOSE_FILE" up -d --no-build shipit

# Clean up old images and stale builder cache to reclaim disk.
# --keep-storage was removed because the flag is deprecated in newer
# BuildKit versions; time-only filtering works across versions.
docker image prune -af --filter "until=168h" || true
docker builder prune -f --filter "until=72h" || true
