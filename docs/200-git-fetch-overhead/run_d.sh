#!/usr/bin/env bash
# Scenario D (fixed): fetch WITH updates of varying size, against the real remote.
# Rewind a fresh bare cache to main~M, gc away newer objects, time the fetch that
# pulls them back. Operate explicitly on `main` (the remote default branch).
set -euo pipefail
REMOTE="https://github.com/nikzlabs/shipit.git"
ROOT=/tmp/bench
RESULTS="$ROOT/results.csv"
export GIT_TERMINAL_PROMPT=0

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

echo "=== D. git fetch --all with M commits behind remote (real object transfer) ==="
for M in 1 10 50; do
  for rep in 1 2 3; do
    RW="$ROOT/rw.git"
    rm -rf "$RW"
    # Mirror-clone just main from the real remote so it's a clean, real-remote cache
    git clone --bare --single-branch --branch main "$REMOTE" "$RW" >/dev/null 2>&1
    git -C "$RW" config remote.origin.fetch "+refs/heads/*:refs/heads/*"
    OLD=$(git -C "$RW" rev-parse "main~$M")
    NEWCOUNT=$(git -C "$RW" rev-list --count "${OLD}..main")
    # Rewind main and prune the newer objects so the fetch must re-download them
    git -C "$RW" update-ref refs/heads/main "$OLD"
    git -C "$RW" reflog expire --expire=now --all >/dev/null 2>&1 || true
    git -C "$RW" gc --prune=now --quiet >/dev/null 2>&1 || true
    echo "  (M=$M, rewound $NEWCOUNT commits, cache=$(du -sh "$RW"|cut -f1))"
    time_cmd "fetch_behind_${M}" git -C "$RW" fetch --all --force --prune
    rm -rf "$RW"
  done
done
echo "=== done ==="
