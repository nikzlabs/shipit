#!/bin/bash
# Build and restart ShipIt in production.
set -euo pipefail

SHIPIT_DIR="/opt/shipit"
COMPOSE_FILE="$SHIPIT_DIR/deployment/vps/docker-compose.yml"

cd "$SHIPIT_DIR"

# shellcheck source=../lib/docker-build-retry.sh
. "$SHIPIT_DIR/deployment/lib/docker-build-retry.sh"

# Load operator settings that survive checkout resets.
SHIPIT_ENV_FILE="${SHIPIT_ENV_FILE:-/etc/shipit/shipit.env}"
if [ -f "$SHIPIT_ENV_FILE" ]; then
  set -a
  # shellcheck source=/dev/null
  . "$SHIPIT_ENV_FILE"
  set +a
fi

# shellcheck source=../lib/sync-systemd-units.sh
. "$SHIPIT_DIR/deployment/lib/sync-systemd-units.sh"

# Derive the public origin for the DNS-rebinding guard; explicit settings win.
if [ -z "${SHIPIT_ALLOWED_ORIGINS:-}" ] && [ -f /etc/shipit/setup.conf ]; then
  SHIPIT_SETUP_DOMAIN="$(sed -n 's/^DOMAIN="\{0,1\}\([^"]*\)"\{0,1\}$/\1/p' /etc/shipit/setup.conf | tail -n1)"
  if [ -n "$SHIPIT_SETUP_DOMAIN" ]; then
    export SHIPIT_ALLOWED_ORIGINS="https://$SHIPIT_SETUP_DOMAIN"
  fi
fi

# Do not kill session containers or prune networks here. Startup reconciliation
# preserves active work and removes only resources that no live session owns.

# The EXIT trap must reclaim artifacts after successful and failed builds.
prune_build_artifacts() {
  # Never use image prune -a; session-worker images can be idle but required.
  docker image prune -f || true
  # Use version-compatible flags to cap all BuildKit cache at 15 GB.
  docker builder prune -af --max-used-space 15GB \
    || docker builder prune -af --keep-storage 15GB \
    || docker builder prune -af \
    || true
}
trap prune_build_artifacts EXIT

# Fail before package tools report misleading errors on a full disk.
MIN_FREE_GB="${SHIPIT_MIN_FREE_GB:-5}"
DOCKER_ROOT="$(docker info --format '{{.DockerRootDir}}' 2>/dev/null || true)"
[ -d "$DOCKER_ROOT" ] || DOCKER_ROOT="/"
# Skip the check if Docker's filesystem cannot be measured.
AVAIL_GB="$(df -BG --output=avail "$DOCKER_ROOT" 2>/dev/null | tail -1 | tr -dc '0-9' || true)"
if [ -n "$AVAIL_GB" ] && [ "$AVAIL_GB" -lt "$MIN_FREE_GB" ]; then
  echo "ERROR: only ${AVAIL_GB} GB free on the Docker filesystem (${DOCKER_ROOT}); need at least ${MIN_FREE_GB} GB to rebuild." >&2
  echo "Free up disk space (e.g. 'docker builder prune -af', 'docker image prune -f') and retry the update." >&2
  exit 1
fi

# Build all runtime images; FORCE_REBUILD bypasses the cache.
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
shipit_docker_build_with_retry docker compose -f "$COMPOSE_FILE" build "${BUILD_ARGS[@]}" session-worker shipit egress-sidecar

# Build the Docker-capable image after its local base, without --pull.
DOCKER_IMG_BUILD_ARGS=()
case "${FORCE_REBUILD:-0}" in
  1|true|TRUE|True|yes|YES|Yes|on|ON|On)
    DOCKER_IMG_BUILD_ARGS+=("--no-cache")
    ;;
esac
shipit_docker_build_with_retry docker compose -f "$COMPOSE_FILE" build "${DOCKER_IMG_BUILD_ARGS[@]}" session-worker-docker

docker compose -f "$COMPOSE_FILE" up -d --no-build shipit

# Mark the new image live before slow cleanup can be interrupted.
if [ -n "${SHIPIT_RESTART_MARKER:-}" ]; then
  echo "$SHIPIT_BUILD_ID" > "$SHIPIT_RESTART_MARKER" 2>/dev/null || true
fi

# Install units only after their matching image is live.
shipit_sync_systemd_units \
  "$SHIPIT_DIR/deployment/vps" "${SHIPIT_SYSTEMD_UNIT_DIR:-/etc/systemd/system}"
