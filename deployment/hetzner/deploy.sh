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

# Clean up dangling images and stale builder cache to reclaim disk.
#
# IMPORTANT: do NOT use `-a` on `image prune`. `docker image prune -a`
# deletes any image without a running container, and the session-worker
# image only runs on-demand (no container between sessions) — so `-a`
# deletes the image the orchestrator needs to spawn new sessions. `-f`
# alone prunes only dangling (untagged) images, which is what we want:
# when a fresh build takes the `:prod` tag, the prior image becomes
# dangling automatically and is reclaimed.
docker image prune -f || true
#
# DO use `-a` on `builder prune`. Without it BuildKit only reclaims
# cache entries unreferenced by any image — which means most of the
# accumulated build cache (entries reachable from a previous build's
# intermediate stages) is skipped and the cache snowballs across
# deploys. The original `--filter until=72h` form silently reclaimed
# almost nothing on prod for this exact reason.
#
# `unused-for=72h` keeps anything touched in the last 72 h so the next
# deploy still hits warm cache for active layers, but evicts entries
# that haven't been accessed in three days.
docker builder prune -af --filter "unused-for=72h" || true
