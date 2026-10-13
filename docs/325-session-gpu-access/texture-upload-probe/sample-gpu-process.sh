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

"$@" > "$out/command.out" 2>&1 &
command_pid=$!
sleep 2
gpu=$(pgrep -n -f -- '--type=[g]pu-process')
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
