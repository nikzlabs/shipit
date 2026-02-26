#!/bin/sh
set -e
cd "$(dirname "$0")"
# Kill stale session-worker containers from previous runs
docker rm -f $(docker ps -aq --filter "label=shipit-session=true") 2>/dev/null || true
# Build session-worker image first (used by SessionContainerManager at runtime)
docker compose build session-worker
exec docker compose --profile prod up --build shipit-prod "$@"
