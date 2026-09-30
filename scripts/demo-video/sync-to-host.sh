#!/usr/bin/env bash
# Copy the pipeline to the demo host — docs/296 plan §9. Runs where the repo
# is checked out; everything after it runs on the host (host/demo-take.sh).
#
#   sync-to-host.sh <ssh-host>
#
# ~/shipit-demo/pipeline on the host becomes this checkout's
# scripts/demo-video (tests and fixtures left out) and nothing older: the new
# tree is unpacked beside the old one and swapped in by two renames, so a
# broken transfer leaves the old tree in place. tar over ssh, because a session
# has ssh and no rsync.
set -euo pipefail

[ $# -eq 1 ] || { sed -n '2,11p' "$0" | sed 's/^# \{0,1\}//' >&2; exit 2; }
HOST=$1
HERE=$(cd "$(dirname "$0")" && pwd)

# The remote path is fixed: nothing the caller passes reaches the remote shell.
# shellcheck disable=SC2016
REMOTE_SWAP='set -e
d=shipit-demo/pipeline
rm -rf "$d.new" "$d.old"
mkdir -p "$d.new"
tar -xf - -C "$d.new"
if [ -e "$d" ]; then mv "$d" "$d.old"; fi
mv "$d.new" "$d"
rm -rf "$d.old"'

tar -C "$HERE" --exclude='*.test.ts' --exclude='__fixtures__' -cf - . | ssh "$HOST" "$REMOTE_SWAP"
echo "sync-to-host: $HERE -> $HOST:shipit-demo/pipeline"
