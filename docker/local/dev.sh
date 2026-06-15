#!/bin/sh
set -e
cd "$(dirname "$0")/dev"
# Kill stale session-worker and compose service containers from previous runs
docker rm -f $(docker ps -aq --filter "label=shipit-stack=shipit-dev") 2>/dev/null || true
# Prune orphaned networks from previous sessions to reclaim address space
docker network prune -f
# Build the images in parallel. session-worker is needed by SessionContainerManager
# at runtime; egress-sidecar (shipit-egress-sidecar:dev) is the SHI-90 egress firewall
# image — rebuilt here so a docker/egress-sidecar/ change actually ships to dev sessions
# instead of silently lagging a stale manual build (SHI-90 verification finding).
docker compose build --pull session-worker shipit egress-sidecar
exec docker compose up --no-build shipit "$@"
