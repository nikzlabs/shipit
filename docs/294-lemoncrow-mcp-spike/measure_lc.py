#!/usr/bin/env python3
"""Measure the orientation-phase token cost of LemonCrow's `code_search` MCP tool
against ripwire's `--for` map and a grep-and-read baseline, on the same six tasks.

Method is inherited verbatim from docs/291-ripwire-context-map/measure.py so the
three arms are comparable: same tasks, same gold sets, same keywords, same
tokenizer (tiktoken o200k_base as a proxy for Claude's non-public tokenizer).

Scope note carried over unchanged: this measures LOCATING and ORIENTING, not the
cost of fully understanding a change. The baseline is a FLOOR (one well-chosen
grep, then reads only the gold files), not an average.

Asymmetry worth stating: ripwire returns signatures only, so an agent still opens
the bodies it edits. LemonCrow's code_search returns bounded source inline for the
top matches, so part of that follow-up read is already paid for inside its number.
"""
import json
import re
import os
import subprocess
import sys
import time

# tiktoken fetches its BPE table from openaipublic.blob.core.windows.net, which a
# ShipIt session container's egress allowlist does not resolve. TIKTOKEN_CACHE_DIR
# points at a pre-built cache (see prepare_tokenizer.mjs in this folder, which
# reconstructs the exact same o200k_base ranks from the js-tiktoken npm package).
# LemonCrow's own MCP server needs cl100k_base from the same host, so the same
# directory is handed to it below.
TIKTOKEN_CACHE_DIR = os.environ.setdefault("TIKTOKEN_CACHE_DIR", "/persist/tkcache")

import tiktoken  # noqa: E402

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from mcpclient import connect  # noqa: E402

WORKSPACE = "/workspace"
SCOPE = "src/server"
ROOT = os.path.join(WORKSPACE, SCOPE)
RIPWIRE = "/persist/rw/ripwire-0.4.0-linux-x64/ripwire"

ENC = tiktoken.get_encoding("o200k_base")


def toks(s: str) -> int:
    return len(ENC.encode(s))


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


def result_text(msg) -> str:
    """Flatten an MCP tools/call result into the text an agent would receive."""
    res = msg.get("result", msg.get("error", {}))
    if isinstance(res, dict) and "content" in res:
        return "".join(
            b.get("text", "") for b in res["content"] if isinstance(b, dict)
        )
    return json.dumps(res)


# LemonCrow compresses sibling paths into shell brace notation --
# `src/server/orchestrator/{a.ts,b.ts}`. A plain substring test for
# `orchestrator/b.ts` misses those and scores a real hit as a miss; the first
# version of this harness did exactly that and reported two false zeroes.
# Expanded on BOTH arms so the treatment stays symmetric.
_BRACE = re.compile(r"([\w./+-]*/)\{([^{}]*)\}")


def expand_braces(text: str) -> str:
    def sub(m: "re.Match[str]") -> str:
        prefix, inner = m.group(1), m.group(2)
        return " ".join(prefix + part.strip() for part in inner.split(","))
    return _BRACE.sub(sub, text)


def score(out: str, gold: list[str]) -> tuple[float, float]:
    """Return (surfaced, located) recall against the gold file set.

    `surfaced` — the gold path appears anywhere in the answer, including the
    trailing `candidate_files:` pointer list. This is what docs/291's harness
    measured for ripwire, so it is the comparable number.

    `located` — the gold path appears in the part of the answer that carries a
    position: inline source or the `related_symbols` map. A pointer that only
    says "this file might be relevant" costs another round trip, so the two
    numbers answer different questions and the gap between them matters.
    """
    full = expand_braces(out)
    marker = full.find("candidate_files:")
    positioned = full if marker < 0 else full[:marker]
    n = len(gold)
    return (sum(1 for g in gold if g in full) / n,
            sum(1 for g in gold if g in positioned) / n)


client, _init = connect(WORKSPACE)
tools = client.call("tools/list")["result"]["tools"]
schema_tokens = toks(json.dumps(tools))
tool_names = [t["name"] for t in tools]

# Warm the index once so the per-task timings measure search, not first-run
# indexing. The warm-up call itself is excluded from every number below.
t0 = time.time()
client.call("tools/call", {"name": "code_search",
                           "arguments": {"query": "warm up the index", "paths": SCOPE}},
            timeout=1800)
index_warm_s = time.time() - t0

rows = []
for t in TASKS:
    # --- Arm A: ripwire --------------------------------------------------
    ta = time.time()
    a = run([RIPWIRE, ROOT, f"--for={t['phrase']}"])
    rw_s = time.time() - ta
    rw_out = a.stdout
    rw_tokens = toks(rw_out)
    rw_recall, rw_located = score(rw_out, t["gold"])

    # --- Arm B: LemonCrow code_search ------------------------------------
    tb = time.time()
    msg = client.call("tools/call", {"name": "code_search",
                                     "arguments": {"query": t["phrase"], "paths": SCOPE}},
                      timeout=900)
    lc_s = time.time() - tb
    lc_out = result_text(msg)
    lc_tokens = toks(lc_out)
    lc_recall, lc_located = score(lc_out, t["gold"])

    # --- Arm B2: the follow-up `read` the pointers imply ------------------
    # code_search names some gold files only under `candidate_files:` — a
    # pointer, not a position. Closing that gap costs another call, so charge
    # it: one `read` with `:outline` (the mode the tool's own description
    # prescribes for "structure at any size") over the unlocated gold files.
    # This is one plausible follow-up, not an observed agent behaviour.
    unlocated = [g for g in t["gold"] if g not in expand_braces(lc_out).split("candidate_files:")[0]]
    lc_followup = 0
    if unlocated:
        fu = client.call("tools/call", {
            "name": "read",
            "arguments": {"files": [f"{SCOPE}/{g}:outline" for g in unlocated]},
        }, timeout=900)
        lc_followup = toks(result_text(fu))

    # --- Arm C: one grep, then read the gold files -----------------------
    b = run(["grep", "-rni", t["keyword"], ROOT, "--include=*.ts"])
    grep_out = b.stdout
    grep_tokens = toks(grep_out)
    read_tokens = 0
    for g in t["gold"]:
        with open(os.path.join(ROOT, g), encoding="utf-8", errors="replace") as fh:
            read_tokens += toks(fh.read())
    base_total = grep_tokens + read_tokens

    rows.append(dict(
        phrase=t["phrase"],
        rw_tokens=rw_tokens, rw_recall=rw_recall, rw_located=rw_located,
        rw_s=round(rw_s, 2),
        lc_tokens=lc_tokens, lc_recall=lc_recall, lc_located=lc_located,
        lc_followup=lc_followup, lc_s=round(lc_s, 2),
        grep_tokens=grep_tokens, read_tokens=read_tokens, base_total=base_total,
        rw_ratio=rw_tokens / base_total, lc_ratio=lc_tokens / base_total,
    ))

client.close()

print(json.dumps(dict(tools=tool_names, schema_tokens=schema_tokens,
                      index_warm_s=round(index_warm_s, 1), rows=rows), indent=2))

n = len(rows)
tot_rw = sum(r["rw_tokens"] for r in rows)
tot_lc = sum(r["lc_tokens"] for r in rows)
tot_lc_fu = sum(r["lc_tokens"] + r["lc_followup"] for r in rows)
tot_base = sum(r["base_total"] for r in rows)
mean = lambda k: 100 * sum(r[k] for r in rows) / n  # noqa: E731
print("\n=== AGGREGATE (6 tasks) ===")
print(f"grep+read baseline   : {tot_base:>9,} tokens")
print(f"ripwire              : {tot_rw:>9,} tokens  "
      f"({100*tot_rw/tot_base:.1f}% of baseline, surfaced "
      f"{mean('rw_recall'):.1f}%, located {mean('rw_located'):.1f}%)")
print(f"LemonCrow code_search: {tot_lc:>9,} tokens  "
      f"({100*tot_lc/tot_base:.1f}% of baseline, surfaced "
      f"{mean('lc_recall'):.1f}%, located {mean('lc_located'):.1f}%)")
print(f"LemonCrow + follow-up read : {tot_lc_fu:>9,} tokens  "
      f"({100*tot_lc_fu/tot_base:.1f}% of baseline, every gold file positioned)")
print(f"\nLemonCrow fixed MCP schema prefix: {schema_tokens:,} tokens per turn "
      f"({len(tool_names)} tools: {', '.join(tool_names)})")
print(f"First-run index warm-up: {index_warm_s:.1f}s")
