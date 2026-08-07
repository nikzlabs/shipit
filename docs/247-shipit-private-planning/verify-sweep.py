#!/usr/bin/env python3
"""Gate 3, mechanically: prove the sweep changed nothing but the references.

684 files is not reviewable by eye. This asserts the property instead: a changed
line must differ from its original ONLY where a Linear reference was replaced by
its mapped `planning#M`. Blank the reference tokens out of both sides, and the
remainders must be byte-identical.

## What it does NOT prove — read this before trusting it

**It cannot tell a pointer from text that teaches what a pointer looks like.**
`(…/issue/SHI-28/redesign-the-auth-flow)` is an example of a Linear URL's *shape*;
rewriting the key inside it produces `…/issue/planning#30/redesign-the-auth-flow`,
which is nonsense — and this check passes it, because both sides tokenize
identically. Ten such lines shipped past an earlier version, and a Codex review
found them, not this script. Syntax examples need a human or a separate rule.

Everything below is a structural guarantee only.

Hardened after that review:
  - `--text` so a file git calls binary (a NUL byte in `useLazyToolInput.ts`)
    is not silently skipped.
  - lines are paired **per file and per hunk**, not zipped globally, so a line
    moving between files cannot pass.
  - `git diff` failure is fatal; a bad base can no longer print a clean verdict.
  - exits non-zero on any mismatch, so it is usable in a pipeline.
  - the mapping is validated (unique keys, unique numbers) rather than trusted.
  - the diff is read as **bytes** and decoded explicitly, so newline
    translation cannot hide a CRLF change behind a "byte-identical" claim.
"""
import re, subprocess, sys, collections

BASE = sys.argv[1] if len(sys.argv) > 1 else None
if not BASE:
    sys.exit("usage: verify-sweep.py <base-commit>")

MAP_PATH = "docs/247-shipit-private-planning/mapping.tsv"
rows = [l.split("\t") for l in open(MAP_PATH).read().strip().split("\n") if l.strip()]
mapping = {k: int(v) for k, v in rows}
if len(mapping) != len(rows):
    sys.exit(f"mapping has duplicate keys: {len(rows)} rows, {len(mapping)} unique")
if len(set(mapping.values())) != len(mapping):
    sys.exit("mapping has duplicate destination numbers")

MD_LINK = re.compile(r"\[([^\]]*)\]\((https://linear\.app/[^/\s]+/issue/(SHI-\d+)[^\s)]*)\)")
# A markdown autolink `<https://…>` loses its angle brackets too, because
# `<planning#166>` is not a valid autolink. Absorb them with the URL, or the
# remainders differ by exactly those two characters.
ANGLE = re.compile(r"<https://linear\.app/[^/\s]+/issue/(SHI-\d+)[^\s>]*>")
URL = re.compile(r"""https://linear\.app/[^/\s]+/issue/(SHI-\d+)[^\s)"'`<>\],]*""")
NAME = re.compile(r"(?<![A-Za-z0-9_])roadmap#(SHI-\d+)(?![A-Za-z0-9_])")
KEY = re.compile(r"(?<![A-Za-z0-9_])(SHI-\d+)(?![A-Za-z0-9_])")
NEW = re.compile(r"(?<![A-Za-z0-9_])planning#(\d+)(?![A-Za-z0-9_])")
TOK = "\x00REF\x00"
HUNK = re.compile(r"^@@ -\d+(?:,\d+)? \+\d+(?:,\d+)? @@")


def blank_old(s):
    keys = []
    for pat, grp in ((MD_LINK, 3), (ANGLE, 1), (URL, 1), (NAME, 1), (KEY, 1)):
        s = pat.sub(lambda m: (keys.append(m.group(grp)), TOK)[1], s)
    return s, keys


def blank_new(s):
    nums = []
    return NEW.sub(lambda m: (nums.append(int(m.group(1))), TOK)[1], s), nums


proc = subprocess.run(
    ["git", "diff", "-U0", "--text", "--no-renames", BASE, "--", ".",
     ":(exclude)" + MAP_PATH.rsplit("/", 1)[0] + "/"],
    capture_output=True)  # bytes, so no newline translation can hide a CRLF change
if proc.returncode != 0:
    sys.exit(f"git diff failed ({proc.returncode}): "
             f"{proc.stderr.decode('utf-8', 'replace').strip()[:400]}")
diff_text = proc.stdout.decode("utf-8", "replace")

# Group into (file, hunk) buckets so pairing can never cross a boundary.
buckets, cur_file, cur = collections.OrderedDict(), None, None
for line in diff_text.split("\n"):
    if line.startswith("+++ b/"):
        cur_file = line[6:]
    elif HUNK.match(line):
        cur = (cur_file, line)
        buckets.setdefault(cur, ([], []))
    elif line.startswith("-") and not line.startswith("---") and cur:
        buckets[cur][0].append(line[1:])
    elif line.startswith("+") and not line.startswith("+++") and cur:
        buckets[cur][1].append(line[1:])

text_diff, count_diff, map_diff, unbalanced = [], [], [], []
subs = nlines = 0
for (f, h), (rem, add) in buckets.items():
    if len(rem) != len(add):
        unbalanced.append((f, h, len(rem), len(add)))
        continue
    for old, new in zip(rem, add):
        nlines += 1
        o_txt, o_keys = blank_old(old)
        n_txt, n_nums = blank_new(new)
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

print(f"hunks: {len(buckets)}   changed lines: {nlines}   substitutions: {subs}")
print(f"  hunks where +/- counts differ      : {len(unbalanced)}")
print(f"  lines differing outside a reference: {len(text_diff)}")
print(f"  lines with a different token count : {len(count_diff)}")
print(f"  substitutions disagreeing with map : {len(map_diff)}")
for f, h, r, a in unbalanced[:6]:
    print(f"\n  {f} {h}  -{r} +{a}")
for f, old, new in (text_diff + count_diff)[:8]:
    print(f"\n  {f}\n    - {old.strip()[:140]}\n    + {new.strip()[:140]}")
for f, k, got, want in map_diff[:8]:
    print(f"\n  {f}: {k} -> planning#{got}, mapping says planning#{want}")

ok = not (unbalanced or text_diff or count_diff or map_diff)
print("\nVERDICT:", "structurally pure reference substitution"
      if ok else "NOT pure — inspect above")
print("NOTE: this does not check that a rewritten reference was a pointer rather "
      "than a syntax example. See the module docstring.")
sys.exit(0 if ok else 1)
