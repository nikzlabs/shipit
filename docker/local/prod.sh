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
# Build the images in parallel. session-worker is needed by SessionContainerManager
# at runtime; egress-sidecar (shipit-egress-sidecar:prod) is required because the prod
# compose has egress containment ON by default (SESSION_EGRESS_SIDECAR_IMAGE set) — a
# contained session fails closed without it. To run with containment off instead, export
# SESSION_EGRESS_ENFORCE=0 before this script (compose substitutes it into the orchestrator env).
docker compose build --pull session-worker shipit egress-sidecar
exec docker compose up --no-build shipit "$@"
