#!/usr/bin/env bash
# SHI-76 — git fetch overhead benchmark
# Mirrors ShipIt's git topology: a bare cache (repo-cache/<hash>) kept fresh by
# `git fetch --all --force --prune`, and per-session workspace clones cut from it
# with `git clone --local`, which then `git fetch origin` against the real remote.
#
# We measure the *marginal* cost of the git operations a pre-session fetch adds,
# under the scenarios ShipIt actually hits.
set -euo pipefail

REMOTE="https://github.com/nicolasalt/shipit.git"
ROOT=/tmp/bench
CACHE="$ROOT/cache.git"
RESULTS="$ROOT/results.csv"
export GIT_TERMINAL_PROMPT=0

# nanosecond timer around a command; appends "scenario,ms" to results.csv
time_cmd() {
  local label="$1"; shift
  local start end ms
  start=$(date +%s.%N)
  "$@" >/dev/null 2>&1
  end=$(date +%s.%N)
  ms=$(awk -v s="$start" -v e="$end" 'BEGIN{printf "%.1f",(e-s)*1000}')
  echo "$label,$ms" >> "$RESULTS"
  echo "  $label: ${ms}ms"
}

echo "scenario,ms" > "$RESULTS"

# --- Setup: build the bare cache the way ShipIt does -----------------------
echo "=== Setup: bare cache (local clone of /workspace, origin -> real remote) ==="
rm -rf "$CACHE"
git clone --bare /workspace "$CACHE" >/dev/null 2>&1
git -C "$CACHE" remote set-url origin "$REMOTE"
# ShipIt sets this refspec so `git fetch --all` advances local branches (repo-git.ts)
git -C "$CACHE" config remote.origin.fetch "+refs/heads/*:refs/heads/*"
# Warm it once so subsequent no-op fetches reflect steady state
git -C "$CACHE" fetch --all --force --prune >/dev/null 2>&1 || true
echo "  cache ready: $(du -sh "$CACHE" | cut -f1)"

# --- Scenario A: clone-from-cache (the per-session baseline, no extra fetch) -
echo "=== A. git clone --local from cache (per-session clone, the baseline work) ==="
for i in $(seq 1 12); do
  rm -rf "$ROOT/ws_a"
  time_cmd "clone_local" git clone --local "$CACHE" "$ROOT/ws_a"
done
rm -rf "$ROOT/ws_a"

# --- Scenario B: no-op bare-cache fetch (warm — nothing new on remote) -------
# This is the overwhelmingly common case: prefetcher keeps the cache current,
# so a pre-session `git fetch --all` transfers nothing and is pure round-trip.
echo "=== B. git fetch --all --force --prune on warm bare cache (NO-OP) ==="
for i in $(seq 1 25); do
  time_cmd "fetch_all_noop" git -C "$CACHE" fetch --all --force --prune
done

# --- Scenario C: no-op workspace fetch (what refreshClaimedSession runs) ------
echo "=== C. git fetch origin in a session clone (NO-OP, warm) ==="
git clone --local "$CACHE" "$ROOT/ws_c" >/dev/null 2>&1
git -C "$ROOT/ws_c" remote set-url origin "$REMOTE"
git -C "$ROOT/ws_c" fetch origin >/dev/null 2>&1 || true
for i in $(seq 1 25); do
  time_cmd "fetch_origin_noop" git -C "$ROOT/ws_c" fetch origin
done
rm -rf "$ROOT/ws_c"

# --- Scenario D: fetch WITH updates of varying size --------------------------
# Genuinely re-download M commits of objects from GitHub: rewind a fresh cache
# to HEAD~M, garbage-collect away the newer objects, then time the single fetch
# that pulls them back. Re-setup per sample so each fetch is a real transfer.
echo "=== D. git fetch --all with M commits behind remote (real object transfer) ==="
for M in 1 10 50; do
  for rep in 1 2 3; do
    RW="$ROOT/rw.git"
    rm -rf "$RW"
    git clone --bare /workspace "$RW" >/dev/null 2>&1
    git -C "$RW" remote set-url origin "$REMOTE"
    git -C "$RW" config remote.origin.fetch "+refs/heads/*:refs/heads/*"
    git -C "$RW" fetch --all --force --prune >/dev/null 2>&1 || true
    DEF=$(git -C "$RW" symbolic-ref --short HEAD 2>/dev/null || echo main)
    OLD=$(git -C "$RW" rev-parse "HEAD~$M")
    # Drop all refs except the default branch, rewind it, then prune newer objects
    git -C "$RW" for-each-ref --format='%(refname)' | grep -v "refs/heads/$DEF$" \
      | while read -r r; do git -C "$RW" update-ref -d "$r"; done
    git -C "$RW" update-ref "refs/heads/$DEF" "$OLD"
    git -C "$RW" reflog expire --expire=now --all >/dev/null 2>&1 || true
    git -C "$RW" gc --prune=now --quiet >/dev/null 2>&1 || true
    time_cmd "fetch_behind_${M}" git -C "$RW" fetch --all --force --prune
    rm -rf "$RW"
  done
done

echo "=== done ==="
