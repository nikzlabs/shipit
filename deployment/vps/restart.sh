#!/bin/bash
# Recreate the orchestrator without pulling or rebuilding.
set -euo pipefail

SHIPIT_DIR="/opt/shipit"
COMPOSE_FILE="$SHIPIT_DIR/deployment/vps/docker-compose.yml"
TRIGGER_FILE="$SHIPIT_DIR/.restart-requested"

# Load persisted settings before Compose substitutes its environment.
SHIPIT_ENV_FILE="${SHIPIT_ENV_FILE:-/etc/shipit/shipit.env}"
if [ -f "$SHIPIT_ENV_FILE" ]; then
  set -a
  # shellcheck source=/dev/null
  . "$SHIPIT_ENV_FILE"
  set +a
fi

# Derive the public origin for the DNS-rebinding guard; explicit settings win.
if [ -z "${SHIPIT_ALLOWED_ORIGINS:-}" ] && [ -f /etc/shipit/setup.conf ]; then
  SHIPIT_SETUP_DOMAIN="$(sed -n 's/^DOMAIN="\{0,1\}\([^"]*\)"\{0,1\}$/\1/p' /etc/shipit/setup.conf | tail -n1)"
  if [ -n "$SHIPIT_SETUP_DOMAIN" ]; then
    export SHIPIT_ALLOWED_ORIGINS="https://$SHIPIT_SETUP_DOMAIN"
  fi
fi

rm -f "$TRIGGER_FILE"

echo "$(date -Iseconds) ShipIt restart starting (no rebuild)..."

cd "$SHIPIT_DIR"

# Leave session containers running so the new orchestrator can adopt them.
docker compose -f "$COMPOSE_FILE" up -d --no-build --force-recreate shipit

echo "$(date -Iseconds) ShipIt restart complete."
