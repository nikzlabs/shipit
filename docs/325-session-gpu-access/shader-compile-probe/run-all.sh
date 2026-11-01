#!/bin/bash
# Runs each configuration one after the other. Results: one JSON line for each load.
# N: the number of programs (default 200). TMPDIR: where the test cache directory goes (default /tmp).
# A browser that fails gives its JSON lines, its last message and a "## FAILED" line,
# and the script then exits with 1.
cd "$(dirname "$0")" || exit 1
G="--use-angle=gl-egl --ignore-gpu-blocklist --disable-gpu-compositing"
N=${N:-200}
CACHE="${TMPDIR:-/tmp}/mesa-cache-test"
FAILED=0
run() {
  local out status
  echo "## $1 loadavg $(cut -d' ' -f1 /proc/loadavg)"
  out=$(timeout 600 node run-link.mjs "$@" --n=$N 2>&1); status=$?
  printf '%s\n' "$out" | grep '^{'
  [ "$status" = 0 ] && return
  printf '%s\n' "$out" | grep -v -e '^{' -e '^$' | tail -3
  echo "## FAILED: $1 (exit status $status)"; FAILED=1
}
run sw
run gpu --env=GALLIUM_DRIVER=d3d12 $G
run gpu-no-pin $G
run gpu-mesa-cache-off --env=GALLIUM_DRIVER=d3d12 --env=MESA_SHADER_CACHE_DISABLE=true $G
rm -rf "$CACHE"; mkdir -p "$CACHE"
run gpu-mesa-cache-dir-1 --env=GALLIUM_DRIVER=d3d12 --env=MESA_SHADER_CACHE_DIR=$CACHE $G
echo "## mesa cache dir after run 1: $(find "$CACHE" -type f | wc -l) files, $(du -sk "$CACHE" | cut -f1) kB"
run gpu-mesa-cache-dir-2 --env=GALLIUM_DRIVER=d3d12 --env=MESA_SHADER_CACHE_DIR=$CACHE $G
echo "## default mesa cache dir: $(find $HOME/.cache/mesa_shader_cache -type f 2>/dev/null | wc -l) files"
run gpu-no-program-cache --env=GALLIUM_DRIVER=d3d12 $G --disable-gpu-program-cache
run gpu-whole-page --env=GALLIUM_DRIVER=d3d12 --use-angle=gl-egl --ignore-gpu-blocklist
run llvmpipe-egl --env=GALLIUM_DRIVER=llvmpipe $G
run gpu-poll --env=GALLIUM_DRIVER=d3d12 $G --mode=poll
run sw-poll --mode=poll
if [ "$FAILED" = 0 ]; then echo "## done"; else echo "## done, with failed runs"; fi
exit $FAILED
