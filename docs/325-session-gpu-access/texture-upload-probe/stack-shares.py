#!/usr/bin/env python3
"""Counts the stacks that sample-gpu-process.sh wrote: stack-shares.py <out dir> [frames]

Each sample counts under its innermost frames that have a name, joined with " <- " (default: 4 frames).
A frame with no name counts under the file that it is in.
"""
import collections
import glob
import re
import sys

FRAME = re.compile(r"^#\d+\s+(?:0x[0-9a-f]+ in )?(\S+) \(.*?\)(?: from (\S+))?", re.M)

out_dir = sys.argv[1]
depth = int(sys.argv[2]) if len(sys.argv) > 2 else 4
shares = collections.Counter()
total = 0
for path in sorted(glob.glob(f"{out_dir}/s*.txt")):
    text = open(path, errors="replace").read()
    # gdb prints frame 0 one time for `thread 1` and again at the start of the backtrace.
    frames = FRAME.findall(text[max(text.rfind("\n#0 "), 0):])
    if not frames:
        continue
    total += 1
    names = [name if name != "??" else f"?? in {(lib or 'chrome').split('/')[-1]}" for name, lib in frames]
    shares[" <- ".join(names[:depth])] += 1

print(f"samples with a stack: {total}")
for stack, count in shares.most_common(25):
    print(f"{count:5d}  {100 * count / total:5.1f} %  {stack}")
