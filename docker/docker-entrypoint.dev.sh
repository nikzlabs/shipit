#!/bin/sh
set -e

echo "[dev] Starting Vite dev server (HMR) on :3000..."
API_PORT=$PORT npx vite --host 0.0.0.0 --port 3000 &

echo "[dev] Starting Fastify server on :$PORT..."
exec npm run dev
