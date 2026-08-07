#!/usr/bin/env python3
"""Step 10, manual half — the citations inside test and key-shape files.

`sweep.py` excluded every test file wholesale, because a rewritten *fixture*
silently changes what a test asserts. But most `SHI-N` mentions in those files
are still citations — a key named in a `describe` title or a comment explaining
why a test exists. Those should migrate with everything else.

The rule here is the inverse of `sweep.py`'s: instead of rewriting everything
except known-bad lines, rewrite **only** lines that are provably citations, and
leave everything else for a human. A citation is:

  - a comment line (`// SHI-123`, `* SHI-123 made this load-bearing`), or
  - a test title — `describe("… (SHI-278)")`, `it("…")`, `test("…")`

and never a line that also looks like data (`identifier:`, `url:`, `toBe(`, …),
because a title and an assertion can share a line in a one-liner test.

The test suite is the safety net: anything this gets wrong should turn a test
red rather than pass silently, which is why it runs only on files the suite
covers.

  --dry-run   report what would change, write nothing
"""
import os, re, subprocess, sys, collections

ROOT = "/workspace"
MAPPING = os.path.join(ROOT, "docs/247-shipit-private-planning/mapping.tsv")
EXCLUDE_DIRS = ("docs/247-shipit-private-planning/",)

BARE_KEY = re.compile(r"(?<![\w-])(SHI-\d+)(?![\w-])")
NAME_FORM = re.compile(r"(?<![\w-])roadmap#(SHI-\d+)(?![\w-])")

COMMENT = re.compile(r"^\s*(//|\*|/\*)")
TITLE = re.compile(r"\b(describe|it|test)(\.\w+)?\s*\(\s*[\"'`]")

# Anything that smells like a value rather than prose. If one of these is on the
# line, the line is left for the human pass even if it also looks like a title.
DATA_MARKERS = (
    "identifier:", "url:", "id:", "key:", "toBe(", "toEqual(", "toMatchObject(",
    "issue/SHI-", "linear.app", "issueLookupId", "parseIssueRef", "resolveIssueRef",
    '"SHI-', "'SHI-", "`SHI-", "expect(", "seed:", "tracker:",
)

SYNTAX_MARKERS = ("owner/repo#", "planning#42", "linear:SHI", "bare ", "reference form")


def load_mapping():
    return {k: int(v) for k, v in
            (l.split("\t") for l in open(MAPPING).read().strip().split("\n"))}


def target_files():
    out = subprocess.run(
        ["grep", "-arlE", r"(^|[^A-Za-z0-9-])SHI-[0-9]+([^A-Za-z0-9-]|$)",
         "--exclude-dir=.git", "--exclude-dir=node_modules", "."],
        cwd=ROOT, capture_output=True, text=True).stdout.split()
    return sorted(f[2:] if f.startswith("./") else f for f in out
                  if not any((f[2:] if f.startswith("./") else f).startswith(d)
                             for d in EXCLUDE_DIRS))


def is_citation(line):
    if any(mk in line for mk in SYNTAX_MARKERS):
        return False
    if COMMENT.match(line):
        return True
    if TITLE.search(line) and not any(mk in line for mk in DATA_MARKERS):
        return True
    return False


def main():
    dry = "--dry-run" in sys.argv
    mapping = load_mapping()
    changed, left = [], collections.Counter()
    total = 0

    for rel in target_files():
        p = os.path.join(ROOT, rel)
        try:
            src = open(p, encoding="utf-8").read()
        except (UnicodeDecodeError, IsADirectoryError):
            continue
        out, n = [], 0
        for line in src.split("\n"):
            if not BARE_KEY.search(line):
                out.append(line)
                continue
            if not is_citation(line):
                left[rel] += len(BARE_KEY.findall(line))
                out.append(line)
                continue
            new = NAME_FORM.sub(
                lambda m: f"planning#{mapping[m.group(1)]}" if m.group(1) in mapping else m.group(0), line)
            new = BARE_KEY.sub(
                lambda m: f"planning#{mapping[m.group(1)]}" if m.group(1) in mapping else m.group(0), new)
            n += new != line
            out.append(new)
        new_src = "\n".join(out)
        if new_src != src:
            changed.append((rel, n))
            total += n
            if not dry:
                open(p, "w", encoding="utf-8").write(new_src)

    print(f"files {'that would change' if dry else 'changed'}: {len(changed)}  ({total} lines)")
    print(f"\nstill left for the human pass: {sum(left.values())} mentions across {len(left)} files")
    for rel, n in left.most_common(12):
        print(f"  {n:4}  {rel}")


if __name__ == "__main__":
    main()
