#!/bin/bash
# Mesa with no browser, then one browser on each Mesa. Results: one JSON line for each run.
# N: the number of programs (default 200). TMPDIR: where the test cache directories go (default /tmp).
# MESA25_LIB: the library directory of an extracted Mesa 25.0.7. Not set: the runs on that Mesa are skipped.
# A run that fails or crashes gives its JSON lines, its last message and a "## FAILED" line,
# and the script then exits with 1.
cd "$(dirname "$0")" || exit 1
M=${MESA25_LIB:-}
N=${N:-200}
T="${TMPDIR:-/tmp}"
G="--use-angle=gl-egl --ignore-gpu-blocklist --disable-gpu-compositing"
FAILED=0
load() { cut -d' ' -f1 /proc/loadavg; }
# report <title> <exit status> <output>: the JSON lines, and for a failure also the last message.
report() {
  printf '%s\n' "$3" | grep '^{'
  [ "$2" = 0 ] && return
  printf '%s\n' "$3" | grep -v -e '^{' -e '^$' | tail -3
  echo "## FAILED: $1 (exit status $2)"; FAILED=1
}
# direct <title> [VAR=value…] -- [arguments of mesa_direct.py…]
direct() {
  local title=$1 vars=() out; shift
  while [ "$1" != "--" ]; do vars+=("$1"); shift; done; shift
  echo "## $title"
  out=$(env "${vars[@]}" timeout 400 python3 mesa_direct.py --n "$N" "$@" 2>&1)
  report "$title" $? "$out"
}
# browser <title> <arguments of run-link.mjs…>
browser() {
  local title=$1 out; shift
  echo "## $title loadavg $(load)"
  out=$(timeout 600 node run-link.mjs "$@" $G --n=$N 2>&1)
  report "$title" $? "$out"
}
cache() { rm -rf "$T/$1"; mkdir -p "$T/$1"; }
files() { echo "## cache dir files: $(find "$T/$1" -type f | wc -l)"; }

direct "direct mesa22 d3d12 run 1 loadavg $(load)" GALLIUM_DRIVER=d3d12 --
direct "direct mesa22 d3d12 run 2 (new process, same sources)" GALLIUM_DRIVER=d3d12 --
cache mesa-cache-direct
direct "direct mesa22 d3d12 with MESA_SHADER_CACHE_DIR" GALLIUM_DRIVER=d3d12 MESA_SHADER_CACHE_DIR=$T/mesa-cache-direct --
files mesa-cache-direct
if [ -n "$M" ]; then
  direct "direct mesa25 d3d12 run 1 loadavg $(load)" LD_LIBRARY_PATH=$M GALLIUM_DRIVER=d3d12 --
  direct "direct mesa25 d3d12 run 2" LD_LIBRARY_PATH=$M GALLIUM_DRIVER=d3d12 --
  cache mesa-cache-direct25
  direct "direct mesa25 d3d12 with MESA_SHADER_CACHE_DIR" LD_LIBRARY_PATH=$M GALLIUM_DRIVER=d3d12 MESA_SHADER_CACHE_DIR=$T/mesa-cache-direct25 --
  files mesa-cache-direct25
else
  echo "## MESA25_LIB is not set: no direct run on Mesa 25.0.7"
fi
cache mesa-cache-lp
direct "direct mesa22 llvmpipe run 1 (empty cache dir)" GALLIUM_DRIVER=llvmpipe MESA_SHADER_CACHE_DIR=$T/mesa-cache-lp -- --binary
files mesa-cache-lp
direct "direct mesa22 llvmpipe run 2 (same cache dir)" GALLIUM_DRIVER=llvmpipe MESA_SHADER_CACHE_DIR=$T/mesa-cache-lp --
if [ -n "$M" ]; then
  browser "browser mesa25 d3d12" gpu-mesa25 --env=LD_LIBRARY_PATH=$M --env=GALLIUM_DRIVER=d3d12
else
  echo "## MESA25_LIB is not set: no browser on Mesa 25.0.7"
fi
browser "browser mesa22 d3d12 again" gpu-again --env=GALLIUM_DRIVER=d3d12
if [ "$FAILED" = 0 ]; then echo "## done"; else echo "## done, with failed runs"; fi
exit $FAILED
