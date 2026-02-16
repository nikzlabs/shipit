#!/bin/sh
set -e
cd "$(dirname "$0")"
exec docker compose up --build shipit "$@"
