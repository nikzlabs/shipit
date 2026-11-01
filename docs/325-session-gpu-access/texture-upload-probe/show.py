#!/usr/bin/env python3
"""Prints the JSON lines of run-upload.mjs as a table: show.py results.txt…"""
import json
import sys

for path in sys.argv[1:]:
    for line in open(path, encoding="utf-8"):
        line = line.strip()
        if not line.startswith("{"):
            if line:
                print(line)
            continue
        r = json.loads(line)
        if "error" in r:
            print(f"  {r['label']:<14} {r['case']:<15} FAILED: {r['error']}")
            continue
        pressure = (r.get("cpuPressure") or "").split(" ")[1:2]
        print(
            f"  {r['label']:<14} {r['case']:<15} {r['layers']:>4} layers {r['bytes'] / 1048576:6.1f} MB"
            f"  to finish {r['finishMs']:6d} ms  to readPixels {r['syncMs']:6d} ms"
            f"  glErr {r['glError']}  cpu {pressure[0] if pressure else '-':<12} {r['renderer'][7:72]}"
        )
