#!/bin/sh
set -e

SCRIPT_DIR="$(CDPATH= cd -- "$(dirname "$0")" && pwd)"
REPO_DIR="$(CDPATH= cd -- "$SCRIPT_DIR/../.." && pwd)"
CHANNEL_FILE="$REPO_DIR/.release-channel"

cd "$REPO_DIR"

CHANNEL="$(cat "$CHANNEL_FILE" 2>/dev/null || echo stable)"
case "$CHANNEL" in
  stable) REF="origin/stable" ;;
  edge) REF="origin/main" ;;
  *)
    echo "Error: invalid release channel '$CHANNEL' in $CHANNEL_FILE; expected 'stable' or 'edge'." >&2
    exit 1
    ;;
esac

if git rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  if [ -n "$(git status --porcelain)" ]; then
    echo "Error: local production update would overwrite uncommitted changes." >&2
    echo "Commit, stash, or discard them before re-running docker/local/prod.sh." >&2
    exit 1
  fi

  echo "==> Updating ShipIt local production checkout (channel=$CHANNEL, ref=$REF)..."
  git fetch origin --tags --prune
  if ! git fetch origin "${REF#origin/}"; then
    if [ "$CHANNEL" = "stable" ]; then
      echo "==> Stable branch not found on origin; falling back to edge (origin/main)."
      REF="origin/main"
      git fetch origin main
    else
      exit 1
    fi
  fi
  git reset --hard "$REF"
  printf "%s\n" "$CHANNEL" > "$CHANNEL_FILE"
fi

cd "$SCRIPT_DIR/prod"
# Kill stale session-worker and compose service containers from previous runs
docker rm -f $(docker ps -aq --filter "label=shipit-stack=shipit-prod") 2>/dev/null || true
docker rm -f $(docker ps -aq --filter "label=shipit-parent-session") 2>/dev/null || true
# Prune orphaned networks from previous sessions to reclaim address space
docker network prune -f
# Build both images in parallel (session-worker is needed by SessionContainerManager at runtime)
docker compose build --no-cache --pull session-worker shipit
exec docker compose up --no-build shipit "$@"
