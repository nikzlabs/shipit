#!/bin/sh
set -e
cd "$(dirname "$0")/dev"
# Stack-scoped, never host-wide: a second ShipIt on this daemon keeps its resources (planning#584).
docker rm -f $(docker ps -aq --filter "label=shipit-stack=shipit-dev") 2>/dev/null || true
docker network rm $(docker network ls -q --filter "label=shipit-stack=shipit-dev") 2>/dev/null || true
docker compose build --pull session-worker shipit egress-sidecar compose-helper
# The Docker-capable image builds on the worker image above, which no registry has.
docker compose build session-worker-docker
exec docker compose up --no-build shipit "$@"
