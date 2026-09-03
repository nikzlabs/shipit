#!/bin/bash
# Host-side update script for ShipIt.
# Called by the shipit-updater systemd path unit when .update-requested appears.
set -euo pipefail

# The host checkout carries no credential helper by design (the repo is public,
# and docs/266 keeps credentials out of root-owned trees), and systemd gives this
# script no terminal. Without this, an anonymous fetch that GitHub refuses with a
# 401 makes git try to PROMPT for a username and die with the misleading
# "could not read Username for 'https://github.com': No such device or address".
# With it, the same refusal reads "terminal prompts disabled" — the real cause.
export GIT_TERMINAL_PROMPT=0

# Override-able only so the test harness can point the whole script at a throwaway
# git checkout + bare "origin"; defaults to the real install path in production.
SHIPIT_DIR="${SHIPIT_DIR:-/opt/shipit}"
TRIGGER_FILE="$SHIPIT_DIR/.update-requested"
# Failure breadcrumb the orchestrator reads in checkForUpdates() to render a
# "Update failed — still running <sha>" banner. Lives on the host repo next to
# the other untracked trigger files so it survives image rebuilds. Keep this
# path in sync with UPDATE_FAILED_FILE in src/server/orchestrator/release-channel.ts.
FAILURE_FILE="$SHIPIT_DIR/.update-failed"
# Written by deploy.sh the moment `docker compose up -d` returns — i.e. once the
# new container has been STARTED (that is all it proves; there is no health gate).
# deploy.sh keeps working after that: its EXIT trap prunes the build cache, which
# can run for minutes. A kill landing in that tail must NOT roll the checkout
# back — the new image is already running, so rolling back would leave the
# checkout BEHIND it, the mirror of the bug this script exists to prevent.
#
# Its presence, NOT the exit status, is what decides the cleanup below. That is
# safe because everything which can fail runs before the restart; the only work
# after it is the prune, whose own failures deploy.sh swallows. Residual: a kill
# in the instant between `compose up` returning and this file appearing still
# rolls back. That window is milliseconds against a prune measured in minutes,
# which is the whole point of the marker — closing it entirely would mean asking
# a possibly-wedged Docker what is running, from inside the cleanup path.
RESTART_MARKER="$SHIPIT_DIR/.deploy-restarted"
export SHIPIT_RESTART_MARKER="$RESTART_MARKER"

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
# re-creates the marker if THIS attempt fails. Same for the restart marker: a
# leftover from a previous run would make this run's failure read as a success.
rm -f "$FAILURE_FILE" "$RESTART_MARKER"

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
  if [ "$SUCCESS" -eq 1 ] || [ -f "$RESTART_MARKER" ]; then
    if [ "$SUCCESS" -ne 1 ]; then
      echo "$(date -Iseconds) ShipIt update interrupted (exit $code) AFTER the restart — the new image is live; keeping the checkout."
    fi
    rm -f "$FAILURE_FILE" "$RESTART_MARKER" || true
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

# A kill from outside — systemd's TimeoutStartSec= firing, or an operator's
# `systemctl stop` — must land in cleanup with a code that says so. Bash already
# runs the EXIT trap on an untrapped SIGTERM, but `$?` there is 0, so the
# breadcrumb claimed "exit 0" for a run that was killed. Exiting explicitly makes
# it 143 (128+SIGTERM), 130 for SIGINT.
trap 'exit 143' TERM
trap 'exit 130' INT

# Backoff schedule between fetch attempts (attempts = delays + 1). GitHub
# intermittently answers an ANONYMOUS git request from this host's IP with a 401
# even for a public repo — observed as a fetch failing one second after an
# identical fetch succeeded — so a single refusal must not fail the whole update.
# Override-able only so the test harness can drive the retry path without
# sleeping; production always uses the default.
FETCH_RETRY_DELAYS="${SHIPIT_FETCH_RETRY_DELAYS:-5 15 45}"

# Wall-clock bound on ONE fetch attempt. Git has no timeout of its own, so a
# connection that stalls rather than refusing would hang the whole run forever.
# A stall is treated exactly like a refusal: `timeout` exits 124 (137 when it had
# to escalate to SIGKILL), which the retry below sees as a failed attempt. An
# incremental fetch of this repo takes seconds, so 120 is generous.
# Override-able only for the test harness.
FETCH_TIMEOUT_SECONDS="${SHIPIT_FETCH_TIMEOUT_SECONDS:-120}"
# `timeout` alone only SIGTERMs, and then waits — forever, if what it is waiting
# on is deaf to TERM. `-k` is what makes the bound hard: SIGKILL this long after
# the TERM. So the bound is really FETCH_TIMEOUT + KILL_GRACE, both bounded.
FETCH_KILL_GRACE_SECONDS="${SHIPIT_FETCH_KILL_GRACE_SECONDS:-15}"

# Fetch from origin, retrying on failure. The LAST attempt is the only one NOT
# inside an `if`, so its non-zero status trips `set -e` and the EXIT trap above
# records the real exit code (128 for a refusal, 124 or 137 for a stall) and
# rolls the checkout back. HEAD still moves only after a fetch succeeds — this
# only changes how many failures it takes to give up.
fetch_origin() {
  local delay
  # Unquoted on purpose: the delay list is whitespace-separated.
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

# Resolve the release channel (feature 162). Default to edge when the
# preference file is absent so existing installs keep tracking main.
CHANNEL="$(cat "$SHIPIT_DIR/.release-channel" 2>/dev/null || echo edge)"
echo "$(date -Iseconds) Updating on channel '$CHANNEL'"

# ONE fetch per run, for both channels. `--tags --prune` with the default
# `remote.origin.fetch` refspec (+refs/heads/*:refs/remotes/origin/*) already
# updates origin/main AND origin/stable and brings the release tags, so the
# per-channel `git fetch origin <branch>` that used to follow was a second
# anonymous round-trip that fetched nothing new — it only doubled the exposure to
# GitHub's intermittent 401 on anonymous requests from this host's IP.
# We resolve a COMMIT to reset to (not a branch ref) so build-id stays a SHA and
# the checkout never points ahead of the image for longer than the build.
fetch_origin

if [ "$CHANNEL" = "stable" ]; then
  # Option A (docs/214): the stable channel advances ONLY to the latest final
  # (non-prerelease) tag REACHABLE FROM origin/stable — never the branch tip,
  # which is transiently an un-published merge commit after a release PR merges
  # (before CI tags + publishes). `git tag --merged` is reachability;
  # `grep -E '^v[0-9]+\.[0-9]+\.[0-9]+$'` keeps strict final tags (drops
  # vX.Y.Z-rc.N); `sort -V | tail -n1` picks the highest. NOT `git describe`
  # (nearest tag by distance — wrong on a branch with multiple tags).
  REF="origin/stable"
  LATEST_TAG="$(git tag --merged origin/stable \
    | grep -E '^v[0-9]+\.[0-9]+\.[0-9]+$' \
    | sort -V \
    | tail -n1)"
  if [ -z "$LATEST_TAG" ]; then
    # Fail closed: no vetted release to move to. Never reset to the branch tip.
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

# Advance the checkout to the resolved commit so the build bakes the new
# SHIPIT_BUILD_ID. If the build fails the EXIT trap rolls this back to PRIOR_SHA,
# so the window in which the checkout is "ahead" of the image lasts only as long
# as the build. On stable this leaves HEAD detached at the tag's commit, which is
# fine for build-id (a SHA) and lets `git describe --exact-match` name the tag.
git reset --hard "$TARGET_SHA"

# Build and restart. A non-zero exit here trips `set -e`, firing the cleanup
# trap (rollback + failure marker) before the script aborts. The deploy command
# is override-able (SHIPIT_DEPLOY_SCRIPT) so the test harness can substitute a
# stub for the Docker build that exercises both the success and failure paths;
# production leaves it unset and runs the real deploy.sh. This step gets no
# `timeout` of its own: a build's honest duration varies too much to bound here,
# so its backstop is TimeoutStartSec= on shipit-updater.service, whose SIGTERM
# reaches this script's TERM trap and rolls the checkout back.
DEPLOY_SCRIPT="${SHIPIT_DEPLOY_SCRIPT:-$SHIPIT_DIR/deployment/vps/deploy.sh}"
bash "$DEPLOY_SCRIPT"

# Build + restart succeeded: keep the advanced checkout and let the trap drop
# any failure marker.
SUCCESS=1
echo "$(date -Iseconds) ShipIt update complete."
