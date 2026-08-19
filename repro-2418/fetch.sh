#!/bin/sh
# Fetch the game for the #2418 harness. TEMPORARY — see README.md.
#
# Separate from `prepare.sh`, and it has to be: the service container that runs
# the game has **no DNS** (`Could not resolve host: github.com`), so the fetch
# can only happen on the agent's side of the session. `prepare.sh` therefore
# assumes the game is already on disk and says what to run when it is not.
#
# The clone is gitignored, so a workspace ShipIt reclaims for disk comes back
# without it, and the service then refuses to start with a message naming this
# script. Deliberately NOT wired into `agent.install`: that key is a bare
# `npm install` on purpose (see shipit.yaml), the session worker tunes exactly
# that shape, and a temporary harness does not get to slow every session's boot
# to save one command.
set -eu

here="$(cd "$(dirname "$0")" && pwd)"
if [ -d "$here/reward-tag/game" ]; then
  echo "[#2418] game already present"
  exit 0
fi

echo "[#2418] fetching nicolasalt/reward-tag…"
rm -rf "$here/reward-tag.tmp"
# --depth 1: the harness wants the current game, not its history. The `.git` is
# dropped so this never looks like a nested repository to the session's own git.
git clone --depth 1 https://github.com/nicolasalt/reward-tag.git "$here/reward-tag.tmp"
rm -rf "$here/reward-tag.tmp/.git"
mv "$here/reward-tag.tmp" "$here/reward-tag"
echo "[#2418] game fetched"
