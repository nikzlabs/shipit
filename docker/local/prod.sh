#!/bin/sh
# Run ShipIt locally in a PRODUCTION-like environment, for testing during
# development. Builds the prod images (docker/Dockerfile.prod +
# Dockerfile.session-worker.prod) from the CURRENT checkout and runs the prod
# Compose stack in the foreground — the prod counterpart of dev.sh, using the
# production environment variables from docker/local/prod/compose.yml.
#
# It does NOT fetch, update, or follow a release channel; it builds whatever is
# checked out right now. To install or update a long-lived local instance, use
# deployment/local/setup.sh and deployment/local/update.sh instead.
set -e
cd "$(dirname "$0")/prod"
# Kill stale session-worker and compose service containers from previous runs
docker rm -f $(docker ps -aq --filter "label=shipit-stack=shipit-prod") 2>/dev/null || true
docker rm -f $(docker ps -aq --filter "label=shipit-parent-session") 2>/dev/null || true
# Prune orphaned networks from previous sessions to reclaim address space
docker network prune -f
# Build both images in parallel (session-worker is needed by SessionContainerManager at runtime)
docker compose build --pull session-worker shipit
exec docker compose up --no-build shipit "$@"
