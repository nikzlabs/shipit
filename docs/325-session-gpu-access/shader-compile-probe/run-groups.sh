#!/bin/bash
# Animation frames while the page links and first draws its programs, each with the built-in browser's flags and the pin:
# the two modes that send all programs (controls), programs sent in groups, first draws in groups,
# the program counts and pair sets around the limit of the poll mode, and a page that draws in each frame.
# Results: one JSON line for each load.
# A browser that fails gives its JSON lines, its last message and a "## FAILED" line, and the script then exits with 1.
cd "$(dirname "$0")" || exit 1
G="--env=GALLIUM_DRIVER=d3d12 --use-angle=gl-egl --ignore-gpu-blocklist --disable-gpu-compositing"
FAILED=0
run() {
  local out status
  echo "## $1"
  out=$(timeout 900 node run-link.mjs "$@" $G 2>&1); status=$?
  printf '%s\n' "$out" | grep '^{'
  [ "$status" = 0 ] && return
  printf '%s\n' "$out" | grep -v -e '^{' -e '^$' | tail -3
  echo "## FAILED: $1 (exit status $status)"; FAILED=1
}
run sync-200 --n=200
run poll-200 --n=200 --mode=poll
for g in 25 50 100; do run groups-$g-draw-1 --n=200 --mode=groups --group=$g --draw-group=1; done
for d in 3 10; do run groups-50-draw-$d --n=200 --mode=groups --group=50 --draw-group=$d; done
for n in 100 110 120 128 129 130 140 150; do run poll-$n --n=$n --mode=poll; done
for n in 120 127 128 129 130 150 200 300 400; do run poll-small-$n --n=$n --mode=poll --pairs=small; done
for n in 60 80 100 120 128 129 130; do run poll-large-$n --n=$n --mode=poll --pairs=large; done
run sync-200-animate --n=200 --animate
for g in 1 5 25 50 100; do run groups-$g-draw-1-animate --n=200 --mode=groups --group=$g --draw-group=1 --animate; done
for n in 100 128 129; do run poll-$n-animate --n=$n --mode=poll --animate; done
if [ "$FAILED" = 0 ]; then echo "## done"; else echo "## done, with failed runs"; fi
exit $FAILED
