#!/usr/bin/env bash
#
# Legacy agent-install hook for the ShipIt repo. This is kept for manually
# testing the dogfood-only prebake image, but the checked-in shipit.yaml uses a
# bare `npm install` so the generic feature-148 fast-install cache can engage.
#
# Plain `npm install` against ShipIt's package.json is a 60-180s job — it
# fetches Playwright + Chromium, builds better-sqlite3 / node-pty native
# modules, and extracts ~600MB of node_modules. For dogfooding ShipIt in
# ShipIt that wait shows up as the "Installing dependencies..." overlay
# and dominates session-creation latency.
#
# This script short-circuits the slow path when the agent container's
# image bakes a ShipIt-specific node_modules tree at /opt/shipit-prebake/
# (see docker/Dockerfile.session-worker.dogfood). Behaviour:
#
#   - If /workspace/node_modules is empty AND /opt/shipit-prebake/node_modules
#     exists, hardlink-copy the prebake into place. `cp -al` is sub-second
#     for a 600MB tree because it shares inodes; npm install can then mutate
#     individual files (which break the hardlink, leaving the originals at
#     /opt/shipit-prebake intact for the next session).
#   - Then `npm install` runs to reconcile any lockfile drift between the
#     baked tree and the current branch's package-lock.json. With the tree
#     already in place this is a fast "up to date" verify in the common
#     case.
#
# When the prebake isn't present (any non-dogfood image), this falls through to
# plain `npm install`. Do not wire this back into shipit.yaml unless the worker
# fast-install gate is updated too: shell wrappers are intentionally treated as
# arbitrary side-effectful commands and bypass the materialized node_modules
# cache.

set -euo pipefail

workspace_dir="${WORKSPACE_DIR:-/workspace}"
workspace_nm="$workspace_dir/node_modules"
prebake_nm="/opt/shipit-prebake/node_modules"

# Only seed when the workspace tree is empty. If the user's branch already
# installed deps (e.g. a previous session left node_modules behind), don't
# stomp on it — `npm install` below will reconcile any drift.
if [ ! -d "$workspace_nm" ] && [ -d "$prebake_nm" ]; then
  echo "[agent-install] seeding $workspace_nm from prebake ($prebake_nm)"
  # cp -al = hardlinks, near-instant on the same filesystem. The fallback
  # to cp -a covers the (unusual) case where workspace_dir lives on a
  # different filesystem from /opt and cross-device hardlinks fail.
  if ! cp -al "$prebake_nm" "$workspace_nm" 2>/dev/null; then
    echo "[agent-install] hardlink copy failed, falling back to full copy"
    cp -a "$prebake_nm" "$workspace_nm"
  fi
fi

echo "[agent-install] running npm install"
exec npm install
