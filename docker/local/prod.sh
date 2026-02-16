#!/bin/sh
set -e
cd "$(dirname "$0")"
exec docker compose --profile prod up --build shipit-prod "$@"
