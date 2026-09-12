#!/usr/bin/env bash
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
VOL="ob-spike-vol"
IMG="ubuntu:24.04"

cleanup() { docker volume rm "$VOL" >/dev/null 2>&1 || true; }
trap cleanup EXIT

docker volume create "$VOL" >/dev/null
echo "Running overlay spike inside $IMG with scratch on named volume '$VOL'..."
docker run --rm --privileged \
  -v "$VOL:/scratch" \
  -v "$HERE/host-overlay-spike.sh:/spike.sh:ro" \
  "$IMG" bash -c '
    set -e
    export DEBIAN_FRONTEND=noninteractive
    apt-get update -qq >/dev/null
    apt-get install -y -qq git inotify-tools >/dev/null
    echo "scratch fstype: $(stat -f -c %T /scratch)"
    bash /spike.sh /scratch/run
  '
