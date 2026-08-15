#!/bin/bash
# Host-side restart script for ShipIt — no git pull, no image rebuild.
# Called by the shipit-restarter systemd path unit when .restart-requested appears.
#
# This intentionally does NOT call deploy.sh. deploy.sh runs
# `docker compose build` plus an image/builder prune. Both are pointless for a
# pure restart where neither the source nor the image changed — they just add
# 30s+ of needless work, which makes the user wonder whether the restart
# actually happened. (The agent CLIs install from a committed lockfile now, so
# a build only changes them when that lockfile changes — see
# docs/141-cli-version-strategy.)
#
# All we need is to recreate the orchestrator container so the
# in-process state is reset.
set -euo pipefail

SHIPIT_DIR="/opt/shipit"
COMPOSE_FILE="$SHIPIT_DIR/deployment/vps/docker-compose.yml"
TRIGGER_FILE="$SHIPIT_DIR/.restart-requested"

# Load persisted operator env (e.g. SESSION_EGRESS_ENFORCE=0 from the egress
# preflight in setup.sh) BEFORE the compose recreate below, exactly as deploy.sh
# does. Without this, a "Just Restart" recreates the orchestrator with the var
# unset → compose's ${SESSION_EGRESS_ENFORCE:-} substitutes empty → egress
# enforcement flips back ON, and an incapable host that deliberately opted out
# fails closed on every session. The env file is the source of truth across both
# the deploy and restart paths.
SHIPIT_ENV_FILE="${SHIPIT_ENV_FILE:-/etc/shipit/shipit.env}"
if [ -f "$SHIPIT_ENV_FILE" ]; then
  set -a
  # shellcheck source=/dev/null
  . "$SHIPIT_ENV_FILE"
  set +a
fi

# planning#378 — the hostname the orchestrator answers to.
#
# api-origin-guard.ts refuses a request whose `Host` it cannot prove is ShipIt's
# own, which closes DNS rebinding. Every hostname docs/254 supports proves itself
# from its own shape (an IP literal, `*.ts.net`, an sslip.io name), so a loopback
# or tailnet install configures nothing. A **public domain** cannot: nothing about
# `shipit.example.com` distinguishes it from a name an attacker bought.
#
# So it is derived from the domain the operator already gave setup.sh /
# cloudflare.sh, rather than asked for a second time. Deriving it HERE rather
# than writing it once at setup time is what covers the installs that already
# exist: they update through update.sh -> deploy.sh and would otherwise start
# refusing their own domain, having never been asked anything. An explicit
# SHIPIT_ALLOWED_ORIGINS in the env file always wins.
if [ -z "${SHIPIT_ALLOWED_ORIGINS:-}" ] && [ -f /etc/shipit/setup.conf ]; then
  SHIPIT_SETUP_DOMAIN="$(sed -n 's/^DOMAIN="\{0,1\}\([^"]*\)"\{0,1\}$/\1/p' /etc/shipit/setup.conf | tail -n1)"
  if [ -n "$SHIPIT_SETUP_DOMAIN" ]; then
    export SHIPIT_ALLOWED_ORIGINS="https://$SHIPIT_SETUP_DOMAIN"
  fi
fi

# Remove trigger file immediately so we don't re-run
rm -f "$TRIGGER_FILE"

echo "$(date -Iseconds) ShipIt restart starting (no rebuild)..."

cd "$SHIPIT_DIR"

# docs/113 Phase 1 — session-worker and compose service containers are left
# running. A restart replaces only the orchestrator; the new process re-adopts
# the surviving containers at boot (`rediscoverContainers()`, and docs/240's
# `reattachInFlightTurns()` for turns that were mid-flight) and reaps true
# orphans itself (`cleanupOrphanContainers()`). The old comment here claimed
# the orchestrator "drops that state" across a restart — that predates docs/240
# and is no longer true.

# Force-recreate the orchestrator container using the existing image.
# --no-build skips the build step entirely; --force-recreate ensures the
# container is actually replaced even if its config hasn't changed.
docker compose -f "$COMPOSE_FILE" up -d --no-build --force-recreate shipit

echo "$(date -Iseconds) ShipIt restart complete."
