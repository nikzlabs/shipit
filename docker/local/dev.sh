#!/bin/sh
set -e
cd "$(dirname "$0")"
# Build session-worker image first (used by SessionContainerManager at runtime)
docker compose build session-worker
exec docker compose up --build shipit "$@"
