#!/usr/bin/env python3
"""Step 10 — rewrite this repository's Linear references from the mapping.

The *mechanical* half only. Files where `SHI-N` is test **data** rather than a
pointer are excluded wholesale and reviewed by hand at gate 3 — see plan.md →
"The sweep is not a blanket rewrite".

What is rewritten, everywhere else:
  - `roadmap#SHI-304`                      -> `planning#306`   (docs/248 name form)
  - `SHI-304`                              -> `planning#306`   (bare key)
  - `[SHI-57](https://linear.app/…/SHI-57/slug)` -> `planning#59`  (as a UNIT)
  - a bare `https://linear.app/…/issue/SHI-57/slug` -> `planning#59`

What is NOT rewritten:
  - **bare `#1354`.** In this repository that already means this repository's
    PR #1354 — the opposite of the planning repo, where Pass B had to qualify it.
  - non-issue `linear.app` URLs (docs, uploads, Slack) — no key to map.
  - a `SHI-N` with no mapping entry; reported instead of guessed at.

  --dry-run   report what would change, write nothing
"""
import os, re, subprocess, sys, collections

ROOT = "/workspace"
MAPPING = os.path.join(ROOT, "docs/247-shipit-private-planning/mapping.tsv")

# `SHI-N` here is the *shape of a Linear key*, which is what the code under test
# parses — not a pointer at an issue. Rewriting breaks or silently weakens them.
DATA_FILES = {
    "src/server/session/agent-shim/shipit.test.ts",
    "src/server/orchestrator/trackers/linear/adapter.test.ts",
    "src/client/stores/issues-store.test.ts",
    "src/client/components/message-markdown.test.tsx",
    "src/server/orchestrator/services/issues.test.ts",
    "src/server/orchestrator/integration_tests/issues-routes.test.ts",
    "src/client/components/IssuesViewer.test.tsx",
    "src/server/shared/pr-issue-refs.test.ts",
    "src/server/orchestrator/chat-history.test.ts",
    "src/client/components/IssueWriteCard.test.tsx",
    "src/server/shared/issue-ref-resolution.test.ts",
    "src/server/orchestrator/services/headless-sessions.test.ts",
    "src/client/utils/tracker-link.test.ts",
    "src/client/utils/tracker-link.ts",
    "src/client/utils/linkify-issues.test.ts",
    "src/client/utils/linkify-issues.ts",
    "src/server/session/agent-shim/shim-exit.test.ts",
    "src/server/shared/issue-ref.test.ts",
    "src/server/shared/issue-ref.ts",
    # Teaches the three reference forms in a user-facing error string. Those
    # examples are valid only while a Linear tracker is declared, so they move
    # with step 11, not this sweep.
    "src/server/shared/issue-ref-resolution.ts",
}

# This feature's own docs narrate the migration in terms of `SHI-N`, and the
# mapping file is `SHI-N` by definition.
EXCLUDE_DIRS = ("docs/247-shipit-private-planning/",)

MD_LINK = re.compile(r"\[([^\]]*)\]\((https://linear\.app/[^/\s]+/issue/(SHI-\d+)[^\s)]*)\)")
# The trailing-slug class must exclude every delimiter a URL can sit inside, not
# just whitespace and `)`. An earlier version used `[^\s)]*`, which swallowed the
# closing quote of `url: "https://linear.app/…/SHI-137"` and produced an
# unterminated string literal.
BARE_URL = re.compile(r"""(?<!\()https://linear\.app/[^/\s]+/issue/(SHI-\d+)[^\s)"'`<>\],]*""")
NAME_FORM = re.compile(r"(?<![\w-])roadmap#(SHI-\d+)(?![\w-])")
BARE_KEY = re.compile(r"(?<![\w-])(SHI-\d+)(?![\w-])")
TEST_FILE = re.compile(r"\.test\.[tj]sx?$|(^|/)integration_tests/|test-helpers")


def load_mapping():
    return {k: int(v) for k, v in
            (l.split("\t") for l in open(MAPPING).read().strip().split("\n"))}


def candidate_files():
    out = subprocess.run(
        ["grep", "-arlE", r"(^|[^A-Za-z0-9-])SHI-[0-9]+([^A-Za-z0-9-]|$)|linear\.app",
         "--exclude-dir=.git", "--exclude-dir=node_modules", "."],
        cwd=ROOT, capture_output=True, text=True).stdout.split()
    keep = []
    for f in out:
        rel = f[2:] if f.startswith("./") else f
        if rel in DATA_FILES or any(rel.startswith(d) for d in EXCLUDE_DIRS):
            continue
        # Every test file, wholesale. A citation left as `SHI-N` in a `describe`
        # name is harmless and gets picked up by the manual review; a rewritten
        # *fixture* silently changes what the test asserts. An earlier version
        # excluded a hand-built list of data files and still broke
        # `session-actions.test.ts`, whose expectation was rewritten while the
        # fixture producing it was not. The blunt rule is the safe one.
        if TEST_FILE.search(rel):
            continue
        keep.append(rel)
    return sorted(keep)


# A line that *teaches* reference syntax rather than citing an issue. These sit
# beside ordinary citations in the same file (`shipit-issue.ts` has both), so the
# exclusion has to be per line, not per file. Every skipped line is reported for
# review at gate 3.
SYNTAX_MARKERS = ("owner/repo#", "planning#42", "linear:SHI", "bare ", "reference form")


def is_syntax_example(line):
    return BARE_KEY.search(line) and any(mk in line for mk in SYNTAX_MARKERS)


def rewrite(text, mapping, unmapped):
    counts = collections.Counter()

    def to_ref(key):
        n = mapping.get(key)
        if n is None:
            unmapped[key] += 1
            return None
        return f"planning#{n}"

    def md(m):
        r = to_ref(m.group(3))
        if not r:
            return m.group(0)
        counts["url"] += 1
        return r
    text = MD_LINK.sub(md, text)

    def url(m):
        r = to_ref(m.group(1))
        if not r:
            return m.group(0)
        counts["url"] += 1
        return r
    text = BARE_URL.sub(url, text)

    def name(m):
        r = to_ref(m.group(1))
        if not r:
            return m.group(0)
        counts["name"] += 1
        return r
    text = NAME_FORM.sub(name, text)

    def key(m):
        r = to_ref(m.group(1))
        if not r:
            return m.group(0)
        counts["key"] += 1
        return r
    return BARE_KEY.sub(key, text), counts


def main():
    dry = "--dry-run" in sys.argv
    mapping = load_mapping()
    unmapped = collections.Counter()
    tot = collections.Counter()
    changed = []
    skipped = []

    for rel in candidate_files():
        p = os.path.join(ROOT, rel)
        try:
            src = open(p, encoding="utf-8").read()
        except (UnicodeDecodeError, IsADirectoryError):
            continue
        out = []
        for i, line in enumerate(src.split("\n"), 1):
            if is_syntax_example(line):
                skipped.append(f"{rel}:{i}  {line.strip()[:110]}")
                out.append(line)
                continue
            nl, c = rewrite(line, mapping, unmapped)
            tot.update(c)
            out.append(nl)
        new = "\n".join(out)
        if new == src:
            continue
        c = collections.Counter()
        changed.append((rel, sum(1 for a, b in zip(src.split("\n"), new.split("\n")) if a != b)))
        if not dry:
            open(p, "w", encoding="utf-8").write(new)

    print(f"files {'that would change' if dry else 'changed'}: {len(changed)}")
    print(f"rewrites — bare key: {tot['key']}, name form: {tot['name']}, "
          f"linear.app issue URLs: {tot['url']}, total: {sum(tot.values())}")
    print(f"excluded: {len(DATA_FILES)} data files + docs/247-shipit-private-planning/")
    if unmapped:
        print(f"\nUNMAPPED keys left untouched ({len(unmapped)}): "
              f"{dict(unmapped.most_common(10))}")
    if skipped:
        open("/persist/pilot/sweep-skipped.txt", "w").write("\n".join(skipped) + "\n")
        print(f"\nsyntax-example lines SKIPPED (review at gate 3): {len(skipped)}"
              f"  -> /persist/pilot/sweep-skipped.txt")
        for x in skipped[:8]:
            print("   ", x)
    print("\nlargest diffs:")
    for rel, n in sorted(changed, key=lambda x: -x[1])[:12]:
        print(f"  {n:5}  {rel}")


if __name__ == "__main__":
    main()
