#!/bin/bash
# Host-side update script for ShipIt.
# Called by the shipit-updater systemd path unit when .update-requested appears.
set -euo pipefail

SHIPIT_DIR="/opt/shipit"
TRIGGER_FILE="$SHIPIT_DIR/.update-requested"
# Failure breadcrumb the orchestrator reads in checkForUpdates() to render a
# "Update failed — still running <sha>" banner. Lives on the host repo next to
# the other untracked trigger files so it survives image rebuilds. Keep this
# path in sync with UPDATE_FAILED_FILE in src/server/orchestrator/release-channel.ts.
FAILURE_FILE="$SHIPIT_DIR/.update-failed"

# Remove trigger file immediately so we don't re-run
rm -f "$TRIGGER_FILE"

echo "$(date -Iseconds) ShipIt update starting..."

cd "$SHIPIT_DIR"

# Capture the commit the running image was built from BEFORE we touch the
# checkout (issue #1047). The invariant this whole script protects: the on-disk
# checkout must NEVER point ahead of the image the orchestrator is actually
# running. resolveVersion()/checkForUpdates() read the checkout HEAD to name the
# running version, so if `git reset --hard` advanced the checkout and the build
# then failed, the UI would report a version that was never built — and a plain
# "Just Restart" would re-resolve against the advanced checkout and make the
# failed update look successful. We therefore roll the checkout back to PRIOR_SHA
# on any failure below.
PRIOR_SHA="$(git rev-parse HEAD)"

# Set later (REF after channel resolution, TARGET_SHA after fetch); declared here
# so the failure trap can reference them under `set -u` even if we never get that
# far.
REF="unknown"
TARGET_SHA="unknown"

# Clear any stale failure marker — a fresh attempt starts clean and only
# re-creates the marker if THIS attempt fails.
rm -f "$FAILURE_FILE"

# Flag flipped to 1 only once the build+restart fully succeed. The EXIT trap
# reads it to decide between the success path (drop the marker) and the failure
# path (roll back + record).
SUCCESS=0

# Runs on every exit (normal or via `set -e`). On failure it restores the
# checkout to the running image's commit and writes the breadcrumb the UI reads.
# We trap EXIT (not just ERR) so an unexpected early termination is also caught.
cleanup() {
  local code=$?
  # Disarm so the `exit` below can't re-enter this handler.
  trap - EXIT
  if [ "$SUCCESS" -eq 1 ]; then
    rm -f "$FAILURE_FILE" || true
    exit 0
  fi
  echo "$(date -Iseconds) ShipIt update FAILED (exit $code) — rolling checkout back to $PRIOR_SHA"
  # Restore the checkout so HEAD matches the still-running image. Best-effort:
  # never let the rollback itself mask the original failure code.
  git reset --hard "$PRIOR_SHA" >/dev/null 2>&1 || true
  # Record what failed so the UI can surface it. Best-effort write.
  printf '{"failedAt":"%s","runningSha":"%s","attemptedRef":"%s","attemptedSha":"%s","exitCode":%s}\n' \
    "$(date -Iseconds)" "$PRIOR_SHA" "$REF" "$TARGET_SHA" "$code" > "$FAILURE_FILE" 2>/dev/null || true
  exit "$code"
}
trap cleanup EXIT

# Resolve the release channel (feature 162). Default to edge when the
# preference file is absent so existing installs keep tracking main.
CHANNEL="$(cat "$SHIPIT_DIR/.release-channel" 2>/dev/null || echo edge)"
case "$CHANNEL" in
  stable) REF="origin/stable" ;;
  *)      REF="origin/main" ;;
esac
echo "$(date -Iseconds) Updating on channel '$CHANNEL' (ref $REF)"

# Pull latest code for the channel's ref. Tags are fetched so the version
# resolver can name the stable release. We only ever reset a tracking branch
# ref, never checkout a tag, so HEAD stays on a branch and build-id stays a SHA.
git fetch origin --tags --prune
git fetch origin "${REF#origin/}"
TARGET_SHA="$(git rev-parse "$REF")"

# Advance the checkout to the new tip so the build bakes the new SHIPIT_BUILD_ID.
# If the build fails the EXIT trap rolls this back to PRIOR_SHA, so the window in
# which the checkout is "ahead" of the image lasts only as long as the build.
git reset --hard "$REF"

# Build and restart. A non-zero exit here trips `set -e`, firing the cleanup
# trap (rollback + failure marker) before the script aborts.
bash "$SHIPIT_DIR/deployment/vps/deploy.sh"

# Build + restart succeeded: keep the advanced checkout and let the trap drop
# any failure marker.
SUCCESS=1
echo "$(date -Iseconds) ShipIt update complete."
