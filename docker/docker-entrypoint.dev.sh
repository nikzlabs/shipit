#!/bin/sh
set -e

# The node_modules named volume persists across rebuilds, so it can go stale
# when dependencies change.  Only re-install when package-lock.json changes.
LOCK_HASH=$(sha256sum package-lock.json | cut -d' ' -f1)
MARKER=node_modules/.package-lock-hash

if [ -f "$MARKER" ] && [ "$(cat "$MARKER")" = "$LOCK_HASH" ]; then
  echo "[dev] Dependencies up to date, skipping install."
else
  echo "[dev] Installing dependencies..."
  npm ci --prefer-offline
  echo "$LOCK_HASH" > "$MARKER"
fi

CLIENT_DEV_PORT="${CLIENT_DEV_PORT:-3000}"
echo "[dev] Starting Vite dev server (HMR) on :$CLIENT_DEV_PORT..."
API_PORT=$PORT npx vite --host 0.0.0.0 --port "$CLIENT_DEV_PORT" &

echo "[dev] Starting Fastify server on :$PORT..."
exec npm run dev
