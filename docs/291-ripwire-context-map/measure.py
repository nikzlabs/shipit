#!/usr/bin/env python3
"""Measure the orientation-phase token cost of ripwire vs a grep-and-read pass.

Scope note: ripwire returns signatures, not bodies. So this measures the cost of
LOCATING and ORIENTING, not the cost of fully understanding a change. An agent
using ripwire still reads the bodies of files it actually edits. The claim this
supports is about the search phase only.

The baseline is deliberately generous: ONE grep with a well-chosen keyword, then
reading only the gold files. A real agent greps several times and reads files that
turn out to be irrelevant, so the baseline here is a FLOOR, not an average.
"""
import subprocess, sys, json, os
import tiktoken

ENC = tiktoken.get_encoding("o200k_base")
ROOT = "/workspace/src/server"
RIPWIRE = "/persist/rw/ripwire-0.4.0-linux-x64/ripwire"


def toks(s: str) -> int:
    return len(ENC.encode(s))


# Gold sets come from CLAUDE.md, which states these answers independently of
# ripwire. Keywords are derived ONLY from the words in the task phrase - no
# insider symbol names, which would make the baseline unrealistically precise.
TASKS = [
    dict(phrase="post-turn auto-push scheduler lease", keyword="autoPush",
         gold=["orchestrator/services/auto-push-scheduler.ts", "orchestrator/post-turn-hold.ts"]),
    dict(phrase="preview subdomain proxy routing", keyword="subdomain",
         gold=["orchestrator/preview-proxy.ts"]),
    dict(phrase="persist chat transcript card to history", keyword="chatCard",
         gold=["orchestrator/chat-card-persistence.ts"]),
    dict(phrase="shared git tree ownership uid drop", keyword="ownership",
         gold=["shared/git-tree-uid.ts", "orchestrator/shared-tree-ownership.ts"]),
    dict(phrase="message group boundaries at tool result", keyword="messageGroup",
         gold=["orchestrator/ws-handlers/agent-message-builder.ts"]),
    dict(phrase="turn executor commit and pr terminal paths", keyword="commitAndPr",
         gold=["orchestrator/turn-executor.ts"]),
]


def run(cmd, **kw):
    return subprocess.run(cmd, capture_output=True, text=True, **kw)


rows = []
for t in TASKS:
    # --- Arm A: ripwire ---------------------------------------------------
    a = run([RIPWIRE, ROOT, f"--for={t['phrase']}"])
    rw_out = a.stdout
    rw_tokens = toks(rw_out)
    # did it surface the gold files at all?
    hits = sum(1 for g in t["gold"] if g in rw_out)
    rw_recall = hits / len(t["gold"])

    # --- Arm B: one grep, then read the gold files ------------------------
    b = run(["grep", "-rni", t["keyword"], ROOT, "--include=*.ts"])
    grep_out = b.stdout
    grep_tokens = toks(grep_out)
    grep_lines = grep_out.count("\n")

    read_tokens = 0
    for g in t["gold"]:
        p = os.path.join(ROOT, g)
        with open(p, encoding="utf-8", errors="replace") as fh:
            read_tokens += toks(fh.read())

    base_total = grep_tokens + read_tokens
    rows.append(dict(
        phrase=t["phrase"], keyword=t["keyword"],
        rw_tokens=rw_tokens, rw_recall=rw_recall,
        grep_lines=grep_lines, grep_tokens=grep_tokens,
        read_tokens=read_tokens, base_total=base_total,
        ratio=(rw_tokens / base_total) if base_total else None,
    ))

print(json.dumps(rows, indent=2))

tot_rw = sum(r["rw_tokens"] for r in rows)
tot_base = sum(r["base_total"] for r in rows)
print("\n=== AGGREGATE ===")
print(f"ripwire total       : {tot_rw:>9,} tokens")
print(f"grep+read total     : {tot_base:>9,} tokens")
print(f"ripwire as % of base: {100*tot_rw/tot_base:>9.1f}%")
print(f"gold recall (mean)  : {100*sum(r['rw_recall'] for r in rows)/len(rows):>9.1f}%")
