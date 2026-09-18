#!/bin/bash
# Host-side update script run by the updater path unit.
set -euo pipefail

# Never prompt from the non-interactive systemd unit.
export GIT_TERMINAL_PROMPT=0

SHIPIT_DIR="${SHIPIT_DIR:-/opt/shipit}"
TRIGGER_FILE="$SHIPIT_DIR/.update-requested"
# Keep synchronized with UPDATE_FAILED_FILE in release-channel.ts.
FAILURE_FILE="$SHIPIT_DIR/.update-failed"
# This marker prevents rollback after the new container has started.
RESTART_MARKER="$SHIPIT_DIR/.deploy-restarted"
export SHIPIT_RESTART_MARKER="$RESTART_MARKER"

rm -f "$TRIGGER_FILE"

echo "$(date -Iseconds) ShipIt update starting..."

cd "$SHIPIT_DIR"

# Restore this commit if the new image does not start.
PRIOR_SHA="$(git rev-parse HEAD)"

REF="unknown"
TARGET_SHA="unknown"

rm -f "$FAILURE_FILE" "$RESTART_MARKER"

SUCCESS=0

cleanup() {
  local code=$?
  trap - EXIT
  if [ "$SUCCESS" -eq 1 ] || [ -f "$RESTART_MARKER" ]; then
    if [ "$SUCCESS" -ne 1 ]; then
      echo "$(date -Iseconds) ShipIt update interrupted (exit $code) AFTER the restart — the new image is live; keeping the checkout."
    fi
    rm -f "$FAILURE_FILE" "$RESTART_MARKER" || true
    exit 0
  fi
  echo "$(date -Iseconds) ShipIt update FAILED (exit $code) — rolling checkout back to $PRIOR_SHA"
  # Do not let rollback mask the original failure.
  git reset --hard "$PRIOR_SHA" >/dev/null 2>&1 || true
  printf '{"failedAt":"%s","runningSha":"%s","attemptedRef":"%s","attemptedSha":"%s","exitCode":%s}\n' \
    "$(date -Iseconds)" "$PRIOR_SHA" "$REF" "$TARGET_SHA" "$code" > "$FAILURE_FILE" 2>/dev/null || true
  exit "$code"
}
trap cleanup EXIT

# Preserve signal exit codes in the failure breadcrumb.
trap 'exit 143' TERM
trap 'exit 130' INT

FETCH_RETRY_DELAYS="${SHIPIT_FETCH_RETRY_DELAYS:-5 15 45}"

FETCH_TIMEOUT_SECONDS="${SHIPIT_FETCH_TIMEOUT_SECONDS:-120}"
FETCH_KILL_GRACE_SECONDS="${SHIPIT_FETCH_KILL_GRACE_SECONDS:-15}"

# Leave the final attempt outside `if` so set -e reaches the EXIT trap.
fetch_origin() {
  local delay
  # shellcheck disable=SC2086
  for delay in $FETCH_RETRY_DELAYS; do
    if timeout -k "$FETCH_KILL_GRACE_SECONDS" "$FETCH_TIMEOUT_SECONDS" git fetch origin --tags --prune; then
      return 0
    fi
    echo "$(date -Iseconds) git fetch origin --tags --prune failed — retrying in ${delay}s"
    sleep "$delay"
  done
  timeout -k "$FETCH_KILL_GRACE_SECONDS" "$FETCH_TIMEOUT_SECONDS" git fetch origin --tags --prune
}

CHANNEL="$(cat "$SHIPIT_DIR/.release-channel" 2>/dev/null || echo edge)"
echo "$(date -Iseconds) Updating on channel '$CHANNEL'"

fetch_origin

if [ "$CHANNEL" = "stable" ]; then
  # Select the highest final tag reachable from stable, never its untagged tip.
  REF="origin/stable"
  LATEST_TAG="$(git tag --merged origin/stable \
    | grep -E '^v[0-9]+\.[0-9]+\.[0-9]+$' \
    | sort -V \
    | tail -n1)"
  if [ -z "$LATEST_TAG" ]; then
    echo "$(date -Iseconds) No final release tag reachable from origin/stable — no stable release yet; refusing to update."
    exit 1
  fi
  TARGET_SHA="$(git rev-parse "${LATEST_TAG}^{commit}")"
  echo "$(date -Iseconds) Stable channel target: $LATEST_TAG ($TARGET_SHA)"
else
  REF="origin/main"
  TARGET_SHA="$(git rev-parse "$REF")"
  echo "$(date -Iseconds) Edge channel target: $REF ($TARGET_SHA)"
fi

git reset --hard "$TARGET_SHA"

DEPLOY_SCRIPT="${SHIPIT_DEPLOY_SCRIPT:-$SHIPIT_DIR/deployment/vps/deploy.sh}"
bash "$DEPLOY_SCRIPT"

SUCCESS=1
echo "$(date -Iseconds) ShipIt update complete."
