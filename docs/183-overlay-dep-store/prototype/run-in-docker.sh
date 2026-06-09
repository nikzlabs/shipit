#!/usr/bin/env bash
# Run host-overlay-spike.sh INSIDE a privileged Linux container on the local
# Docker daemon, with the scratch dir on a Docker NAMED VOLUME.
#
# This is the Mac-specific check (and a superset of the bare-host run): on macOS
# the real overlay mount happens inside Docker Desktop's Linux VM, on the fs that
# backs Docker volumes — NOT on the host bind-mount path (overlayfs refuses a
# FUSE/virtiofs upperdir). Putting scratch on a named volume reproduces exactly
# where ShipIt's `workspace` volume + overlay layers would live, so this
# confirms:
#   - overlayfs works on Docker Desktop's volume-backing fs (Mac-specific),
#   - the native-ext4-not-FUSE upperdir requirement is satisfied,
#   - the inotify file-watcher check runs (we install inotify-tools here).
#
# --privileged grants CAP_SYS_ADMIN inside the container so mount(2) works. That
# is a STAND-IN for however the orchestrator eventually gets mount capability
# (see FINDINGS.md "two topology constraints"); it only validates the substrate,
# it does not bless --privileged as the production mechanism.
#
# Works on any Docker host (Linux or Mac). Run from the repo root:
#   bash docs/183-overlay-dep-store/prototype/run-in-docker.sh
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
    bash /spike.sh /scratch
  '
