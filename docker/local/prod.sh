#!/bin/sh
# Build the current checkout; deployment/local/ manages installed release channels.
set -e
# Resolved before the cd below, which moves off this path.
REPO_DIR="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$(dirname "$0")/prod"
docker rm -f $(docker ps -aq --filter "label=shipit-stack=shipit-prod") 2>/dev/null || true
docker rm -f $(docker ps -aq --filter "label=shipit-parent-session") 2>/dev/null || true
docker network prune -f
# Stamp the image with the commit it is built from; see compose.yml's build args.
SHIPIT_BUILD_ID="$(git -C "$REPO_DIR" rev-parse HEAD 2>/dev/null || true)"
export SHIPIT_BUILD_ID
docker compose build --pull session-worker shipit egress-sidecar
exec docker compose up --no-build shipit "$@"
