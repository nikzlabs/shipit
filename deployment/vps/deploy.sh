#!/bin/bash
# Build and (re)start ShipIt in production.
# Called by setup.sh, update.sh, or manually:
#   bash /opt/shipit/deployment/vps/deploy.sh
set -euo pipefail

SHIPIT_DIR="/opt/shipit"
COMPOSE_FILE="$SHIPIT_DIR/deployment/vps/docker-compose.yml"

cd "$SHIPIT_DIR"

# Kill stale session-worker and compose service containers from previous runs
docker rm -f $(docker ps -aq --filter "label=shipit-stack=shipit") 2>/dev/null || true
docker rm -f $(docker ps -aq --filter "label=shipit-parent-session") 2>/dev/null || true

# Prune orphaned networks from previous sessions to reclaim address space
docker network prune -f

# Build both images (session-worker is a build-only profile, must be named explicitly).
# Reuses Docker's build cache by default; set FORCE_REBUILD=1 (or "true",
# "yes", "on") to bypass it.
#
# The agent CLIs (Claude/Codex/Playwright-MCP) are no longer refreshed by a
# per-deploy cache-bust. They install from a committed lockfile
# (docker/agent-cli/package-lock.json) with `npm ci`, so the shipped versions
# are deterministic and only change when that lockfile changes (bumped by the
# Renovate GitHub App with a cooldown, gated on the CLI contract test — see
# docs/141-cli-version-strategy). Docker's content hash of the COPYed lockfile
# invalidates the install layer automatically when versions change; nothing
# time-based is needed.
SHIPIT_BUILD_ID="$(git rev-parse HEAD 2>/dev/null || true)"
BUILD_ARGS=("--pull")
if [ -n "$SHIPIT_BUILD_ID" ]; then
  BUILD_ARGS+=("--build-arg" "SHIPIT_BUILD_ID=$SHIPIT_BUILD_ID")
fi
case "${FORCE_REBUILD:-0}" in
  1|true|TRUE|True|yes|YES|Yes|on|ON|On)
    BUILD_ARGS+=("--no-cache")
    ;;
esac
docker compose -f "$COMPOSE_FILE" build "${BUILD_ARGS[@]}" session-worker shipit

# docs/128 — build the docker-capable session image (Docker CLI + journalctl) on
# top of the :prod image we just built. It does `FROM shipit-session-worker:prod`,
# which now exists LOCALLY — so this is a SEPARATE build that must NOT pass
# --pull (that would try to fetch the local-only base from a registry and fail).
# It also must run AFTER session-worker so the base tag exists. FORCE_REBUILD
# still applies. The orchestrator selects this image (shipit-session-worker:docker)
# for `capabilities.docker` and ops sessions via SESSION_WORKER_DOCKER_IMAGE.
DOCKER_IMG_BUILD_ARGS=()
case "${FORCE_REBUILD:-0}" in
  1|true|TRUE|True|yes|YES|Yes|on|ON|On)
    DOCKER_IMG_BUILD_ARGS+=("--no-cache")
    ;;
esac
docker compose -f "$COMPOSE_FILE" build "${DOCKER_IMG_BUILD_ARGS[@]}" session-worker-docker

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
# cache entries unreferenced by any image — most of the accumulated
# cache (entries reachable from prior builds' intermediate stages) is
# skipped and the cache snowballs across deploys.
#
# Cap the cache at 10 GB via a size-based filter. Time-based filters
# (`--filter until=72h` / `--filter unused-for=72h`) do NOT work in our
# build → prune flow: both translate to BuildKit's `KeepDuration`,
# which is checked against `last_used`, and the build we just ran
# refreshed `last_used` on every layer it touched. Tested on prod:
# 0 B reclaimed against 83 GB of reclaimable cache. See the BuildKit
# source at moby/buildkit's cache/manager.go for the comparison logic.
#
# `--max-used-space` is the semantically-correct flag (caps total
# cache size, prunes oldest-by-last-used to stay under) but requires
# BuildKit v0.17+. `--keep-storage` is the deprecated alias for
# `--reserved-space` that works on every version: when used alone it
# also acts as a cap (keepBytes = max(MaxUsedSpace, ReservedSpace) in
# the GC, with MaxUsedSpace=0 when unset). The final unfiltered
# `-af` is the nuke fallback if neither flag is recognized.
docker builder prune -af --max-used-space 10GB \
  || docker builder prune -af --keep-storage 10GB \
  || docker builder prune -af \
  || true
