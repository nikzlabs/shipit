#!/bin/sh
# Prepare the reward-tag game as a profiling target for nikzlabs/shipit#2418.
#
# TEMPORARY — this whole directory is a reproduction harness. See README.md.
#
# Idempotent, and safe to re-run: it fetches the game only if it is missing,
# installs only if node_modules is missing, and injects the profiler only if the
# marker is not already in index.html. The clone is gitignored, so a workspace
# that ShipIt reclaims for disk comes back without it — which is exactly why the
# fetch lives here rather than being a one-off the agent did by hand.
set -eu

here="$(cd "$(dirname "$0")" && pwd)"
game="$here/reward-tag/game"
marker="shipit-frame-profiler"

if [ ! -d "$game" ]; then
  # Deliberately not a clone. This script runs in the service container, which
  # has no DNS — a fetch here fails with "Could not resolve host: github.com"
  # and the useful thing to print is where it CAN be done. `fetch.sh` runs on
  # the agent's side, and `agent.install` calls it at session boot.
  echo "[#2418] the game is not here."
  echo "[#2418] run  repro-2418/fetch.sh  from the session terminal (or ask the agent to),"
  echo "[#2418] then: shipit service restart reward-tag"
  exit 1
fi

# Vite serves `public/` at the origin root. The game has no `public/`, so the
# profiler is added beside it rather than into the game's own source — nothing
# under `reward-tag/` is edited except the one script tag below.
mkdir -p "$game/public"
cp "$here/frame-profiler.js" "$game/public/$marker.js"

if ! grep -q "$marker" "$game/index.html"; then
  echo "[#2418] injecting the profiler into index.html"
  # Before </head>, so it is running before the game's module starts drawing.
  sed -i "s#</head>#  <script src=\"/$marker.js\"></script>\n  </head>#" "$game/index.html"
fi

if [ ! -d "$game/node_modules/three" ]; then
  echo "[#2418] installing the game's dependencies…"
  # A cache of our own, inside the harness. The shared `/dep-cache/npm` this
  # host hands out produced silently half-extracted packages here — `three` came
  # out as an empty directory and npm reported success, and the game then failed
  # to resolve it at run time. It is also not a path a service container is
  # promised, so pinning our own removes both problems at once.
  #
  # `node_modules/three` and not `node_modules` is the test, for the same
  # reason: the directory existing has already been shown not to mean the
  # install worked.
  (cd "$game" && npm ci --no-audit --no-fund --cache "$here/.npm-cache")
fi

echo "[#2418] ready — starting Vite on 5173"
