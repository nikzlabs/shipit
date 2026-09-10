#!/bin/sh
set -e
cd "$(dirname "$0")/dev"
docker rm -f $(docker ps -aq --filter "label=shipit-stack=shipit-dev") 2>/dev/null || true
docker network prune -f
docker compose build --pull session-worker shipit egress-sidecar
exec docker compose up --no-build shipit "$@"
