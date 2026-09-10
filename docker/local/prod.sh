#!/bin/sh
# Build the current checkout; deployment/local/ manages installed release channels.
set -e
cd "$(dirname "$0")/prod"
docker rm -f $(docker ps -aq --filter "label=shipit-stack=shipit-prod") 2>/dev/null || true
docker rm -f $(docker ps -aq --filter "label=shipit-parent-session") 2>/dev/null || true
docker network prune -f
docker compose build --pull session-worker shipit egress-sidecar
exec docker compose up --no-build shipit "$@"
