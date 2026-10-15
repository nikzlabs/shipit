#!/bin/bash
# Usage: GDB_ROOT=<dir> sample-gpu-process.sh <out dir> <max samples> -- <command that starts one Chromium…>
# Runs the command and, while it runs, attaches gdb to the newest Chromium GPU process again and again.
# Each attach writes the stack of the main thread to <out dir>/s<N>.txt. stack-shares.py counts them.
# The Chromium must have gl-call-times.so preloaded: without it, gdb is not allowed to attach.
# GDB_ROOT is where the Debian packages gdb-minimal, its libraries and the Mesa debug symbols were
# extracted with `dpkg -x` (plan.md, "To repeat the upload measurement").
# Each attach stops the process for a moment, so the command takes much longer than it does alone.
set -u
out=$1; max=$2; shift 3
: "${GDB_ROOT:?set GDB_ROOT}"
mkdir -p "$out"; rm -f "$out"/s*.txt

# Chromium 155 as Playwright starts it forks the GPU process from a zygote, which hides its type: find it by the renderer's libraries.
gpu_processes() {
  for p in $(pgrep -f '[c]hrome'); do
    if tr '\0' ' ' < "/proc/$p/cmdline" 2>/dev/null | grep -q -- '--type=gpu-process' \
      || grep -qE 'libvk_swiftshader|libEGL_mesa|libGLX_mesa|libgallium|_dri\.so|libd3d12' "/proc/$p/maps" 2>/dev/null; then
      echo "$p"
    fi
  done
}
before=" $(gpu_processes | tr '\n' ' ') "

"$@" > "$out/command.out" 2>&1 &
command_pid=$!
gpu=
deadline=$((SECONDS + 10))
while [ -z "$gpu" ] && [ "$SECONDS" -lt "$deadline" ]; do
  for p in $(gpu_processes); do
    case "$before" in *" $p "*) ;; *) gpu=$p ;; esac
  done
  [ -n "$gpu" ] || sleep 0.1
done
[ -n "$gpu" ] || { echo "no new GPU process within 10 s" >&2; wait "$command_pid"; exit 1; }
i=0
while kill -0 "$command_pid" 2>/dev/null && [ "$i" -lt "$max" ]; do
  LD_LIBRARY_PATH="$GDB_ROOT/usr/lib/x86_64-linux-gnu" timeout 20 "$GDB_ROOT/usr/bin/gdb" -q -batch -p "$gpu" \
    -iex "set auto-solib-add off" -iex "set debug-file-directory $GDB_ROOT/usr/lib/debug" -iex "set pagination off" \
    -ex "sharedlibrary _dri" -ex "sharedlibrary libgallium" -ex "sharedlibrary libd3d12" -ex "sharedlibrary libdxcore" \
    -ex "sharedlibrary libc.so" -ex "sharedlibrary libEGL" -ex "sharedlibrary libglapi" -ex "sharedlibrary libnv" \
    -ex "thread 1" -ex "bt 60" > "$out/s$i.txt" 2>&1
  i=$((i + 1))
  sleep 0.15
done
wait "$command_pid"
echo "samples: $i"
