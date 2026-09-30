#!/usr/bin/env bash
# Copy the pipeline to the demo host — docs/296 plan §9. Runs where the repo
# is checked out; everything after it runs on the host (host/demo-take.sh).
#
#   sync-to-host.sh <ssh-host> [remote-dir]     default remote-dir: shipit-demo/pipeline
#
# The remote tree is replaced whole, so it is this checkout's
# scripts/demo-video (tests and fixtures left out) and nothing older. tar over
# ssh, because a session has ssh and no rsync.
set -euo pipefail

[ $# -ge 1 ] && [ $# -le 2 ] || { sed -n '2,10p' "$0" | sed 's/^# \{0,1\}//' >&2; exit 2; }
HOST=$1
REMOTE=${2:-shipit-demo/pipeline}
case "$REMOTE" in ""|/|.|..|*..*) echo "sync-to-host: refusing remote dir '$REMOTE'" >&2; exit 2 ;; esac
HERE=$(cd "$(dirname "$0")" && pwd)

tar -C "$HERE" --exclude='*.test.ts' --exclude='__fixtures__' -cf - . \
  | ssh "$HOST" "set -e; d='$REMOTE'; rm -rf \"\$d.new\"; mkdir -p \"\$d.new\"; tar -xf - -C \"\$d.new\"; rm -rf \"\$d\"; mv \"\$d.new\" \"\$d\""
echo "sync-to-host: $HERE -> $HOST:$REMOTE"
