#!/bin/sh
set -e
cd "$(dirname "$0")/prod"
# Kill stale session-worker containers from previous runs
docker rm -f $(docker ps -aq --filter "label=shipit-stack=shipit-prod") 2>/dev/null || true
# Build both images in parallel (session-worker is needed by SessionContainerManager at runtime)
docker compose build session-worker shipit
exec docker compose up --no-build shipit "$@"
