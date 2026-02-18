#!/bin/sh
set -e

# The node_modules named volume persists across rebuilds, so it can go stale
# when dependencies change.  Re-run npm ci on startup to keep it in sync.
echo "[dev] Installing dependencies..."
npm ci --prefer-offline

echo "[dev] Starting Vite dev server (HMR) on :3000..."
API_PORT=$PORT npx vite --host 0.0.0.0 --port 3000 &

echo "[dev] Starting Fastify server on :$PORT..."
exec npm run dev
