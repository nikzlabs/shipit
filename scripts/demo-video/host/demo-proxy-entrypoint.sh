#!/bin/sh
# Starts proxy.mjs from the DEMO_PROXY_* env the image was built with
# (demo-proxy-image.sh), or idles on a misconfiguration (missing cassette, an
# already-recorded take) so the session's service reads as running and its log
# names the fix, instead of crash-looping.
set -eu

MODE="${DEMO_PROXY_MODE:-replay}"
CASSETTE="${DEMO_PROXY_CASSETTE:-/cassettes/dogfood-smoke}"
UPSTREAM="${DEMO_PROXY_UPSTREAM:-https://api.anthropic.com}"
PACE="${DEMO_PROXY_PACE:-120}"

idle() {
  echo "demo-proxy: idle — $1" >&2
  echo "demo-proxy: fix it, then rebuild the image on the demo host: demo-proxy-image.sh build <record|replay> <cassette>" >&2
  trap 'exit 0' TERM INT
  sleep infinity &
  wait
  exit 0
}

case "$MODE" in
  replay)
    [ -d "$CASSETTE" ] || idle "replay cassette not found at $CASSETTE"
    exec node /app/proxy.mjs --replay "$CASSETTE" --pace-chars-per-second "$PACE" --port 8787 --host 0.0.0.0
    ;;
  record)
    for lane in x-api-key bearer; do
      [ -e "$CASSETTE/$lane/001.sse" ] && idle "$CASSETTE already holds a $lane take"
    done
    exec node /app/proxy.mjs --record "$CASSETTE" --upstream "$UPSTREAM" --port 8787 --host 0.0.0.0
    ;;
  *)
    idle "unknown DEMO_PROXY_MODE=$MODE (record|replay)"
    ;;
esac
