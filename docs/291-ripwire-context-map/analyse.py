#!/usr/bin/env python3
"""Summarise the ripwire A/B runs.

Metric is contextTokens from `shipit agent run --json` minus the no-op control,
so the fixed per-run overhead (system prompt, tool definitions) is not counted as
task work. Cost is reported raw.
"""
import json, os, glob, sys

OUT = "/persist/bench/runs"


def load(p):
    try:
        with open(p) as fh:
            return json.load(fh)
    except Exception:
        return None


ctrl = load(f"{OUT}/control.json")
if not ctrl:
    sys.exit("no control run yet")
base_overhead = ctrl.get("contextTokens") or 0

rows = []
for taskfile in sorted(glob.glob(f"{OUT}/t*.task")):
    slug = os.path.basename(taskfile).split(".")[0]
    phrase = open(taskfile).read().strip()
    r = {}
    for arm in ("baseline", "ripwire"):
        d = load(f"{OUT}/{slug}.{arm}.json")
        if not d or d.get("status") != "success":
            r[arm] = None
            continue
        ctx = d.get("contextTokens") or 0
        r[arm] = dict(
            ctx=ctx,
            net=max(ctx - base_overhead, 0),
            cost=d.get("costUsd") or 0.0,
            ms=d.get("durationMs") or 0,
            text=(d.get("text") or ""),
        )
    rows.append((slug, phrase, r))

print(f"control overhead: {base_overhead:,} context tokens "
      f"(${ctrl.get('costUsd', 0):.3f})\n")
hdr = f"{'task':<44}{'base net':>10}{'rw net':>10}{'ratio':>8}{'base $':>9}{'rw $':>9}"
print(hdr)
print("-" * len(hdr))

tb = tr = cb = cr = 0
done = 0
for slug, phrase, r in rows:
    b, w = r["baseline"], r["ripwire"]
    if not b or not w:
        state = "baseline pending" if not b else "ripwire pending"
        print(f"{phrase[:43]:<44}{state:>46}")
        continue
    done += 1
    tb += b["net"]; tr += w["net"]; cb += b["cost"]; cr += w["cost"]
    ratio = (w["net"] / b["net"] * 100) if b["net"] else float("nan")
    print(f"{phrase[:43]:<44}{b['net']:>10,}{w['net']:>10,}{ratio:>7.1f}%"
          f"{b['cost']:>9.3f}{w['cost']:>9.3f}")

if done:
    print("-" * len(hdr))
    ratio = (tr / tb * 100) if tb else float("nan")
    print(f"{f'TOTAL ({done} complete)':<44}{tb:>10,}{tr:>10,}{ratio:>7.1f}%"
          f"{cb:>9.3f}{cr:>9.3f}")
    print(f"\nnet token saving : {100 - ratio:.1f}%")
    if cb:
        print(f"net cost saving  : {100 - cr / cb * 100:.1f}%")
