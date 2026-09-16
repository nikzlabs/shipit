#!/bin/sh
# Starts proxy.mjs from the DEMO_PROXY_* env, or idles on a misconfiguration
# (missing cassette, missing key, an already-recorded take) so `compose up`
# never crash-loops under restart: unless-stopped.
set -eu

MODE="${DEMO_PROXY_MODE:-replay}"
CASSETTE="${DEMO_PROXY_CASSETTE:-/cassettes/dogfood-smoke}"
UPSTREAM="${DEMO_PROXY_UPSTREAM:-https://api.anthropic.com}"
PACE="${DEMO_PROXY_PACE:-120}"

idle() {
  echo "demo-proxy: idle — $1" >&2
  echo "demo-proxy: fix it, then: sudo docker compose -f ~/shipit-demo/demo-proxy.compose.yml up -d --force-recreate demo-proxy" >&2
  exec sleep infinity
}

case "$MODE" in
  replay)
    [ -d "$CASSETTE" ] || idle "replay cassette not found at $CASSETTE (host: ~/shipit-demo/cassettes/)"
    exec node /app/proxy.mjs --replay "$CASSETTE" --pace-chars-per-second "$PACE" --port 8787 --host 0.0.0.0
    ;;
  record)
    [ -n "${DEMO_PROXY_ANTHROPIC_API_KEY:-}" ] || idle "record mode needs DEMO_PROXY_ANTHROPIC_API_KEY in /root/shipit-demo-proxy.env"
    for lane in x-api-key bearer; do
      [ -e "$CASSETTE/$lane/001.sse" ] && idle "$CASSETTE already holds a $lane take; delete it or point DEMO_PROXY_CASSETTE elsewhere"
    done
    exec node /app/proxy.mjs --record "$CASSETTE" --upstream "$UPSTREAM" --port 8787 --host 0.0.0.0
    ;;
  *)
    idle "unknown DEMO_PROXY_MODE=$MODE (record|replay)"
    ;;
esac
