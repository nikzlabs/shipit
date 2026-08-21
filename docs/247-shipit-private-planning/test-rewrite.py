#!/usr/bin/env python3
"""Rewrite rules for Pass B, checked against the traps docs/247 found the hard way.

Run: python3 test-rewrite.py   (exits non-zero on failure)
"""
import sys, os
sys.argv = ["x"]
here = os.path.dirname(os.path.abspath(__file__))
exec(open(os.path.join(here, "pass-b.py")).read().split("def main")[0])

M = {"SHI-31": 33, "SHI-127": 129, "SHI-145": 147}
CASES = [
    ("a markdown link is rewritten as a unit, not label-then-URL",
     "See [SHI-31](https://linear.app/shipit-ai/issue/SHI-31/non-root-worker) for detail.",
     "See planning#33 for detail."),
    ("a bare Linear issue URL maps to the new number",
     "Ref https://linear.app/shipit-ai/issue/SHI-127/retire-flag now.",
     "Ref planning#129 now."),
    ("bare keys map",
     "Blocked on SHI-31 and SHI-145.",
     "Blocked on planning#33 and planning#147."),
    ("a bare #N is qualified to the source repo, not this one",
     "Resolved by ShipIt on merge of PR #1354: overlay fix",
     "Resolved by ShipIt on merge of PR nikzlabs/shipit#1354: overlay fix"),
    ("non-issue linear.app URLs are left alone — no key to map",
     "Attachment https://uploads.linear.app/fe63-abc/f.mp4 and https://linear.app/docs/how-to",
     "Attachment https://uploads.linear.app/fe63-abc/f.mp4 and https://linear.app/docs/how-to"),
    ("inline code is not a reference",
     "Run `grep #1354 log` and see SHI-31.",
     "Run `grep #1354 log` and see planning#33."),
    ("fenced code is not a reference",
     "```\ncurl -s api/#1354\nSHI-31\n```\nAfter: SHI-31",
     "```\ncurl -s api/#1354\nSHI-31\n```\nAfter: planning#33"),
    ("an already-qualified reference is not rewritten twice",
     "See nikzlabs/shipit#1354 and planning#33.",
     "See nikzlabs/shipit#1354 and planning#33."),
]

fails = 0
for name, src, want in CASES:
    got, _ = rewrite(src, M)
    ok = got == want
    fails += not ok
    print(f"{'ok  ' if ok else 'FAIL'}  {name}")
    if not ok:
        print(f"        want: {want!r}\n        got : {got!r}")

# The migration header carries the origin key req 9 requires; a blanket sweep
# would rewrite it into a pointer at the issue itself.
body = "> Migrated from Linear **SHI-145**, created 2026-06-14.\n\n---\n\nBlocked on SHI-31."
got, _ = rewrite_body(body, M)
ok = got.startswith("> Migrated from Linear **SHI-145**") and "planning#33" in got
fails += not ok
print(f"{'ok  ' if ok else 'FAIL'}  the body header's own key survives the sweep")

print(f"\n{len(CASES) + 1 - fails}/{len(CASES) + 1} passed")
sys.exit(1 if fails else 0)
