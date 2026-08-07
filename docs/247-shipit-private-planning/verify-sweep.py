#!/usr/bin/env python3
"""Gate 3, mechanically: prove the sweep changed nothing but the references.

684 files is not reviewable by eye. The property that matters is checkable: a
changed line must differ from its original *only* where a Linear reference was
replaced by its mapped `planning#M`.

So: blank every reference token out of both sides — the four source forms on the
old side, `planning#M` on the new side — and require the remainders to be
byte-identical, and require each replaced token to agree with the mapping.
Anything else (a reflow, a dropped character, an unrelated edit riding along, a
mangled URL) survives blanking and shows up as a mismatch.
"""
import re, subprocess, sys, collections

BASE = sys.argv[1]
mapping = {k: int(v) for k, v in
           (l.split("\t") for l in open("docs/247-shipit-private-planning/mapping.tsv").read().strip().split("\n"))}

MD_LINK = re.compile(r"\[([^\]]*)\]\((https://linear\.app/[^/\s]+/issue/(SHI-\d+)[^\s)]*)\)")
URL = re.compile(r"""https://linear\.app/[^/\s]+/issue/(SHI-\d+)[^\s)"'`<>\],]*""")
NAME = re.compile(r"(?<![A-Za-z0-9_])roadmap#(SHI-\d+)(?![A-Za-z0-9_])")
KEY = re.compile(r"(?<![A-Za-z0-9_])(SHI-\d+)(?![A-Za-z0-9_])")
NEW = re.compile(r"(?<![A-Za-z0-9_])planning#(\d+)(?![A-Za-z0-9_])")
TOK = "\x00REF\x00"


def old_tokens(s):
    keys = []
    for pat, grp in ((MD_LINK, 3), (URL, 1), (NAME, 1), (KEY, 1)):
        def sub(m):
            keys.append(m.group(grp))
            return TOK
        s = pat.sub(sub, s)
    return s, keys


def new_tokens(s):
    nums = []
    def sub(m):
        nums.append(int(m.group(1)))
        return TOK
    return NEW.sub(sub, s), nums


diff = subprocess.run(["git", "diff", "-U0", BASE, "--", ".",
                       ":(exclude)docs/247-shipit-private-planning/"],
                      capture_output=True, text=True).stdout
removed, added, cur = [], [], None
for line in diff.split("\n"):
    if line.startswith("+++ b/"):
        cur = line[6:]
    elif line.startswith("-") and not line.startswith("---"):
        removed.append((cur, line[1:]))
    elif line.startswith("+") and not line.startswith("+++"):
        added.append((cur, line[1:]))

print(f"changed lines: -{len(removed)} +{len(added)}")
balanced = len(removed) == len(added)
if not balanced:
    print("!! line counts differ — lines were added or deleted, not just edited")

text_diff, map_diff, count_diff = [], [], []
subs = 0
for (f, old), (_, new) in zip(removed, added):
    o_txt, o_keys = old_tokens(old)
    n_txt, n_nums = new_tokens(new)
    if o_txt != n_txt:
        text_diff.append((f, old, new))
        continue
    if len(o_keys) != len(n_nums):
        count_diff.append((f, old, new))
        continue
    for k, n in zip(o_keys, n_nums):
        subs += 1
        if mapping.get(k) != n:
            map_diff.append((f, k, n, mapping.get(k)))

print(f"substitutions checked against the mapping: {subs}")
print(f"  lines differing outside a reference : {len(text_diff)}")
print(f"  lines with a different token count  : {len(count_diff)}")
print(f"  substitutions disagreeing with map  : {len(map_diff)}")
for f, old, new in (text_diff + count_diff)[:8]:
    print(f"\n  {f}\n    - {old.strip()[:140]}\n    + {new.strip()[:140]}")
for f, k, got, want in map_diff[:8]:
    print(f"\n  {f}: {k} -> planning#{got}, mapping says planning#{want}")

ok = balanced and not text_diff and not count_diff and not map_diff
print("\nVERDICT:", "PURE reference substitution — nothing else changed"
      if ok else "NOT pure — inspect above")
