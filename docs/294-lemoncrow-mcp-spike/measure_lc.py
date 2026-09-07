#!/usr/bin/env python3
"""Measure the orientation-phase token cost of LemonCrow's `code_search` MCP tool
against ripwire's `--for` map and a grep-and-read baseline, on the same six tasks.

Tasks, gold sets, keywords and tokenizer are inherited from
docs/291-ripwire-context-map/measure.py so the arms are comparable (tiktoken
o200k_base, a proxy for Claude's non-public tokenizer). The SCORING is not
inherited — see the `score` block below for what changed and why.

What this measures: LOCATING and ORIENTING, at FILE granularity. It does not
measure whether the line pointed at is the right line, it does not measure
precision, and it never runs an agent — so it cannot see which tool a steered
model would actually reach for.

The grep+read arm is a REFERENCE POINT, not a floor. docs/291 called it a floor;
that is wrong in both directions. It gets oracle file selection, which no agent
has, and it is charged whole-file reads, which an agent can avoid with a targeted
range.

The token totals are RESPONSE SIZE. They exclude tool schemas, tool-call
arguments, model deliberation and reads that turn out to be wrong. plan.md states
what the schema would add if charged.
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


# --------------------------------------------------------------------------- #
# Scoring
#
# Two questions per gold file, asked identically of both arms:
#
#   surfaced  — is the path named anywhere in the answer? This is the check
#               docs/291's harness applied, so it is the number comparable with
#               its published table.
#   positioned — does the answer give a LINE NUMBER for that path? A bare path
#               is a pointer: the agent still has to open the file. The gap
#               between the two is deferred work, and hiding it inside one
#               "recall" number flatters whichever tool defers more.
#
# The criterion is identical; the extraction has to be per-format, because the
# two tools mark the distinction differently and BOTH of them do mark it:
#
#   ripwire  <sigs><d l="902" … p="orchestrator/preview-proxy.ts">  ← positioned
#            <tail><t p="orchestrator/session-namer.ts"/>            ← pointer,
#            and ripwire's own header calls the tail "WEAKER evidence … paths
#            only".
#   LemonCrow  "## src/…/foo.ts" + numbered source, or "…/foo.ts:L128"  ← positioned
#              "candidate_files: src/…/{a.ts,b.ts}"                     ← pointer
#
# An earlier version tested only "does the path appear before the
# candidate_files: marker". That gave ripwire positioned credit for its tail
# (no marker to cut at) and would score an ERROR STRING containing a gold
# filename as 100% positioned. Both are fixed here. What remains untestable by
# construction is stated in plan.md: this measures FILE-level retrieval, and
# never whether the line it points at is the right line.
# --------------------------------------------------------------------------- #

# A ripwire ranked/hop row: an element carrying both a line and a path.
_RW_ROW = re.compile(r"<[dh]\b[^>]*>")
_RW_LINE = re.compile(r'\bl="\d+"')
_RW_PATH = re.compile(r'\bp="([^"]+)"')


def rw_positioned_paths(out: str) -> set[str]:
    found = set()
    for row in _RW_ROW.findall(out):
        if not _RW_LINE.search(row):
            continue  # <t p="…"/> tail rows and anything else path-only
        m = _RW_PATH.search(row)
        if m:
            found.add(m.group(1))
    return found


def lc_positioned_region(out: str) -> str:
    """The part of a LemonCrow answer that carries positions.

    Everything before `candidate_files:`, minus any line that does not tie a
    path to a line number. Inline-source headers (`## path`) count, because the
    numbered source follows them.
    """
    body = expand_braces(out).split("candidate_files:")[0]
    keep = []
    for line in body.splitlines():
        if line.startswith("## ") or ":L" in line:
            keep.append(line)
    return "\n".join(keep)


def score(out: str, gold: list[str], arm: str) -> tuple[float, float]:
    """Return (surfaced, positioned) recall for one arm's answer."""
    full = expand_braces(out)
    if arm == "rw":
        positioned = "\n".join(rw_positioned_paths(out))
    else:
        positioned = lc_positioned_region(out)
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
    rw_recall, rw_located = score(rw_out, t["gold"], "rw")

    # --- Arm B: LemonCrow code_search ------------------------------------
    tb = time.time()
    msg = client.call("tools/call", {"name": "code_search",
                                     "arguments": {"query": t["phrase"], "paths": SCOPE}},
                      timeout=900)
    lc_s = time.time() - tb
    lc_out = result_text(msg)
    lc_tokens = toks(lc_out)
    lc_recall, lc_located = score(lc_out, t["gold"], "lc")

    # --- The follow-up each arm's own pointers imply ----------------------
    #
    # Both tools separate positioned answers from path-only pointers, and a
    # pointer is unfinished work. So charge each arm for opening the files IT
    # surfaced but did not position — and NOTHING else.
    #
    # The "and nothing else" is the load-bearing part. An earlier version chose
    # follow-up files from the gold set, which meant it read a file LemonCrow
    # had never mentioned (`post-turn-hold.ts` on the auto-push task) using
    # knowledge no agent could have, and repaired LemonCrow's miss while
    # leaving ripwire's identical miss unrepaired. That flattered LemonCrow
    # twice over. `followup_targets` can only ever return paths the arm's own
    # answer named.
    #
    # Each arm follows up with the tool it actually has: LemonCrow with its own
    # bounded `read` at `:outline`; ripwire with a plain whole-file read,
    # because ripwire ships no reader and a Claude agent's next move is `Read`.
    # The recall of each follow-up is SCORED, not assumed.
    def followup_targets(out: str, positioned_region: str) -> list[str]:
        full = expand_braces(out)
        return [g for g in t["gold"] if g in full and g not in positioned_region]

    # One call PER target rather than one batched call. The tool description
    # prefers a batch, so this over-charges LemonCrow slightly — deliberately,
    # because a batched response does not say which file each part came from
    # and success would have to be assumed. Erring against the tool under test
    # is the safe direction. (A first attempt DID assume it, by looking for the
    # path in the response; `read` does not echo the path, so every follow-up
    # scored as failed. Both failure modes are the same mistake, opposite sign.)
    lc_fu_targets = followup_targets(lc_out, lc_positioned_region(lc_out))
    lc_followup, lc_landed = 0, 0
    for g in lc_fu_targets:
        fu = client.call("tools/call", {
            "name": "read",
            "arguments": {"files": [f"{SCOPE}/{g}:outline"]},
        }, timeout=900)
        fu_text = result_text(fu)
        lc_followup += toks(fu_text)
        # Landed = a non-error response carrying more than the bare
        # "(outline; :full = source)" header, i.e. actual structure.
        if not fu.get("result", {}).get("isError") and len(fu_text.strip()) > 80:
            lc_landed += 1
    lc_after = lc_located + lc_landed / len(t["gold"])

    rw_fu_targets = followup_targets(rw_out, "\n".join(rw_positioned_paths(rw_out)))
    rw_followup, rw_after = 0, rw_located
    for g in rw_fu_targets:
        with open(os.path.join(ROOT, g), encoding="utf-8", errors="replace") as fh:
            rw_followup += toks(fh.read())
    if rw_fu_targets:
        rw_after = rw_located + len(rw_fu_targets) / len(t["gold"])

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
        rw_followup=rw_followup, rw_after=rw_after, rw_s=round(rw_s, 2),
        lc_tokens=lc_tokens, lc_recall=lc_recall, lc_located=lc_located,
        lc_followup=lc_followup, lc_after=lc_after, lc_s=round(lc_s, 2),
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
tot_rw_fu = sum(r["rw_tokens"] + r["rw_followup"] for r in rows)
tot_base = sum(r["base_total"] for r in rows)
mean = lambda k: 100 * sum(r[k] for r in rows) / n  # noqa: E731
print("\n=== AGGREGATE (6 tasks) ===")
print(f"grep+read baseline        : {tot_base:>9,} tokens")
print(f"ripwire                   : {tot_rw:>9,} tokens  "
      f"({100*tot_rw/tot_base:.1f}% of baseline, surfaced "
      f"{mean('rw_recall'):.1f}%, positioned {mean('rw_located'):.1f}%)")
print(f"ripwire   + its follow-up : {tot_rw_fu:>9,} tokens  "
      f"({100*tot_rw_fu/tot_base:.1f}% of baseline, positioned "
      f"{mean('rw_after'):.1f}%)")
print(f"LemonCrow code_search     : {tot_lc:>9,} tokens  "
      f"({100*tot_lc/tot_base:.1f}% of baseline, surfaced "
      f"{mean('lc_recall'):.1f}%, positioned {mean('lc_located'):.1f}%)")
print(f"LemonCrow + its follow-up : {tot_lc_fu:>9,} tokens  "
      f"({100*tot_lc_fu/tot_base:.1f}% of baseline, positioned "
      f"{mean('lc_after'):.1f}%)")
print(f"\nLemonCrow MCP schema advertised: {schema_tokens:,} tokens "
      f"({len(tool_names)} tools: {', '.join(tool_names)}). This is the size of "
      f"the tools/list payload, not a measured host prompt contribution.")
print(f"Index warm-up on an existing on-disk index: {index_warm_s:.1f}s "
      f"(NOT a cold-install index build — see plan.md)")
