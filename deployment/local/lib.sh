#!/usr/bin/env bash
# Shared helpers for the local ShipIt install/update/stop scripts
# (deployment/local/setup.sh, update.sh, stop.sh). This file is SOURCED, not
# executed. Callers set/export SHIPIT_HOME first; we fill in sane defaults.

# Where the local checkout lives on the host. The container always sees it at
# /opt/shipit via the relative bind-mount in docker/local/prod/compose.yml, so
# the host path is free to be a per-user dir.
SHIPIT_HOME="${SHIPIT_HOME:-$HOME/.shipit}"
COMPOSE_FILE="$SHIPIT_HOME/docker/local/prod/compose.yml"
CHANNEL_FILE="$SHIPIT_HOME/.release-channel"
# Compose project name — matches `name:` in compose.yml and DOCKER_STACK, used
# as the shipit-stack label value on this install's containers.
COMPOSE_STACK="shipit-prod"

# Echo the git ref for the configured release channel. Mirrors
# deployment/vps/update.sh: stable -> origin/stable (falling back to origin/main
# until the first stable cut), edge -> origin/main. Default channel is stable.
shipit_channel_ref() {
  local channel
  channel="$(cat "$CHANNEL_FILE" 2>/dev/null || echo stable)"
  case "$channel" in
    stable)
      if git -C "$SHIPIT_HOME" ls-remote --exit-code --heads origin stable >/dev/null 2>&1; then
        echo "origin/stable"
      else
        echo "origin/main"
      fi
      ;;
    edge)
      echo "origin/main"
      ;;
    *)
      echo "Error: invalid release channel '$channel' in $CHANNEL_FILE (expected 'stable' or 'edge')." >&2
      return 1
      ;;
  esac
}

# Fetch the channel ref and hard-reset the checkout to it. Refuses to clobber
# uncommitted changes. Safe (effectively a no-op) right after a fresh clone.
shipit_sync_checkout() {
  if [ -n "$(git -C "$SHIPIT_HOME" status --porcelain)" ]; then
    echo "Error: $SHIPIT_HOME has uncommitted changes; commit, stash, or discard them first." >&2
    return 1
  fi
  local ref channel
  ref="$(shipit_channel_ref)" || return 1
  channel="$(cat "$CHANNEL_FILE" 2>/dev/null || echo stable)"
  echo "==> Syncing $SHIPIT_HOME to channel '$channel' (ref $ref)..."
  git -C "$SHIPIT_HOME" fetch origin --tags --prune
  git -C "$SHIPIT_HOME" fetch origin "${ref#origin/}"
  git -C "$SHIPIT_HOME" reset --hard "$ref"
}

# Build the prod images and start the orchestrator detached. session-worker is
# built (it's needed by SessionContainerManager at runtime) but not started; it
# lives under the build-only compose profile.
shipit_build_and_up() {
  echo "==> Building ShipIt images..."
  docker compose -f "$COMPOSE_FILE" build --pull session-worker shipit
  echo "==> Starting ShipIt (detached)..."
  docker compose -f "$COMPOSE_FILE" up -d --no-build shipit
}

# Remove orphan session containers (and their compose children) plus the
# per-session networks left behind by previous runs. Matches the labels the
# orchestrator stamps (compose-generator.ts, session-container.ts).
shipit_cleanup_sessions() {
  # shellcheck disable=SC2046  # intentional word-splitting over the id list
  docker rm -f $(docker ps -aq --filter "label=shipit-parent-session") 2>/dev/null || true
  # shellcheck disable=SC2046
  docker rm -f $(docker ps -aq --filter "label=shipit-stack=$COMPOSE_STACK") 2>/dev/null || true
  docker network prune -f >/dev/null 2>&1 || true
}
