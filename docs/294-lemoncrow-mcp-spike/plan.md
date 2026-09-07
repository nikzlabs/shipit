---
issue: planning#521
title: LemonCrow as an added MCP retrieval tool — the spike planning#332 asked for
description: The MCP-only additive shape measured against ripwire and a grep baseline, what the installer really does in global mode, and the two things that still block adoption
---

# LemonCrow as an added MCP retrieval tool

Implements [requirements.md](requirements.md). Follow-up to planning#332, which
rejected LemonCrow's tool-replacement mode and recommended exactly this spike.
Compares against `docs/291-ripwire-context-map/`, whose task set, gold answers and
tokenizer this reuses so the two evaluations are on one method.

**Recommendation: the retrieval evidence is strong, and adoption is not yet
ready.** On the six tasks, LemonCrow reaches the same positioned recall as
ripwire — 91.7% in both arms — for **3,788 response tokens against 18,661**. That
result survived an adversarial review that found and corrected three scoring
flaws, which is the main reason to trust it. What is not ready is the
integration: the MCP server steers the agent to route edits and shell through
itself even with no plugin installed, ShipIt auto-allows an enabled server's
entire tool namespace, and enabled servers are account-wide rather than
per-session. The two questions those raise gate adopting any MCP retrieval server
rather than this one, so they are held in
`docs/291-ripwire-context-map/requirements.md` § "Open questions" as questions 2
and 3; [requirements.md](requirements.md) points there.

Numbers come from LemonCrow 0.7.2 (checkout `403ea9ba`, 2026-09-07) and ripwire
v0.4.0 (linux-x64, checksum verified) against `/workspace` at commit `1a51f23d`.

## The premise, checked (req 2)

The spike rests on a premise from `docs/291-ripwire-context-map/plan.md`: that
global mode without `--project` "registers the MCP server and does not write
project enforcement, so the `lc` tools would be *added* rather than substituted."

**The half about `--project` is true. The half about substitution is false.**

True: project enforcement is written only under `--project`.
`scripts/install_claude.sh:598` gates `configure_project_enforcement` on a
non-empty `PROJECT_ENFORCE`, which only `--project` sets. The script's own header
comment at line 11 — "In global mode without `--project`, asks interactively when
running in a git repo" — describes a code path that no longer exists. The comment
is stale; the code is the fact.

Also true, and new since planning#332: the native-tool deny list is now **empty by
default**. `install_claude.sh:147-151` writes `permissions.deny: []` unless
`LEMONCROW_ENFORCE_NATIVE_DENY=1`. planning#332's "hiding `Bash` disarms the
branch guard" no longer describes the default install.

False: global mode still substitutes tools, by a different mechanism. It runs two
more steps beyond the MCP registration:

- `claude plugin install lemoncrow@lemoncrow` (line 437). All ten plugin agents
  set `disallowedTools` including `Bash` — `agents/code.md:4` is
  `["Read","Edit","Write","Grep","Glob","Bash","WebFetch"]`, the other nine are
  the same or longer. This step *is* printed by `--print-only` (line 116-119).
- A write of `"agent": "lemoncrow:code"` into `~/.claude/settings.json`
  (lines 565-578), making that Bash-hiding agent the default. This step is **not**
  printed. It is also conditional: `lemoncrow_owned` (line 553) leaves an existing
  non-LemonCrow `agent` value alone, and the whole block is skipped when
  `statusline.sh` is absent. So it lands on a fresh install and not on one where
  the user already chose an agent.

Both steps sit outside the `if $WORKSPACE_SET` block, so both run in global mode.
A sandboxed `--dry-run` (`HOME=/persist/fakehome`) traces the settings writes:
`apply_enforcement_to_settings: merge deny+allow → …/.claude/settings.json` and
`set statusLine in …/.claude/settings.json`.

**So the premise survives only for a narrower shape than it stated:** register the
MCP server and nothing else — no plugin, no agents, no hooks, no settings writes.
That is the shape everything below measures. It is not what the vendor installer
does in global mode.

## The three blockers, re-tested against that shape (req 3)

### 1. The branch guard — **still fires**, by a new mechanism

Not because `Bash` is hidden. Because a second, unguarded shell is added.

`src/server/session/agents/claude/process.ts:448` maps every enabled user MCP
server to a whole-namespace glob:

```ts
const userMcpGlobs = (mcpServerNames ?? [])
  .map((name) => `mcp__${name}__*`)
  .join(",");
```

and `:461` appends it to `--allowedTools`. The resident-process path does the
same at `:887` and `:889`, so both spawn paths are affected. LemonCrow's `core`
profile advertises `bash`, `code_search`, `edit`, `read`, `tool`, `web_fetch`. So
enabling an `lc` server auto-allows `mcp__lc__bash`.

The guard cannot see it, for two independent reasons.
`docker/agent-hooks/managed-settings.json:50` registers the PreToolUse hook with
`"matcher": "Bash"`, so it is never invoked for an MCP tool name; and
`docker/agent-hooks/block-branch-ops.mjs:70` independently exits on
`payload?.tool_name !== "Bash"`. A `git reset --hard` through `mcp__lc__bash` is
unguarded.

**This is not LemonCrow-specific.** Any user MCP server exposing a shell-shaped
tool has the same effect today, with no LemonCrow involved. A pre-existing gap
this spike surfaced rather than created.

### 2. The transcript — **fires**, and more broadly than expected

`src/client/components/message-tools.tsx:80` and `:98` key inline diffs on the
literal `Edit` and `Write`; `:233` keys command cards on `Bash` (and `shell`).
Unchanged. An `mcp__lc__edit` call renders as a generic card with no diff.

In a purely additive shape this would be a small risk: the agent keeps using
native tools for the work the transcript renders. It is not purely additive.
**The MCP server ships substitution instructions of its own, with no plugin
installed** — `SERVER_INSTRUCTIONS` (`mcp_server.py:241`), returned in the
`initialize` response (`:11758`), 215 tokens:

> "LemonCrow replaces the grep→read→re-read loop. […] Inline source = already
> read; never shell-grep or re-verify indexed results. […] ALL edits in ONE
> `edit` edits[] array […] Never cat/sed/head/tail."

The vendor's own comment on that constant notes that hosts which render MCP
instructions — naming Claude Code — receive the full tool discipline, and that the
generated personas then ship only the host-specific remainder. So in a ShipIt
session on the Claude backend this steering lands in the system prompt. The tools
are added; the instruction to prefer them over the native ones arrives anyway.

That matters for product principles §1 and §2 in a way the token numbers cannot
show, and the harness cannot detect it: it never runs an agent, so it measures
what the tools return, never which tool a steered model would choose.

### 3. Writing into the user's PR — **does not fire** (improved since planning#332)

Verified empirically, not read. `lc` creates `/workspace/.lemoncrow/` on first
search, but ships it with its own `.gitignore` containing `*`:

```
# LemonCrow runtime data — keep the directory, ignore its contents
*
```

With 723 MB of index in that directory, `git status --short` is clean and
`git add -A --dry-run` lists nothing from it. The runtime root also moved to
`$HOME/.lemoncrow`. And because this shape never runs the installer, none of
`.mcp.json`, `.claude/settings.json` or `.claude/agents` is written into the
clone — those are written only under `--workspace` (`install_claude.sh:452-525`).

planning#332's third blocker is stale and should not be repeated.

## The measurement gate (req 4, req 5)

`measure_lc.py` in this folder is the harness. It reuses
`docs/291-ripwire-context-map/measure.py`'s six task phrases, gold answer sets and
grep keywords unchanged, and adds LemonCrow as a third arm driven over stdio MCP
by `mcpclient.py`. The ripwire arm reproduces docs/291's published total to within
a handful of tokens (18,661 against 18,667), which is the check that the two are
on the same method.

| Task | ripwire | +its follow-up | LemonCrow | +its follow-up | grep+read |
|---|---:|---:|---:|---:|---:|
| post-turn auto-push scheduler lease | 3,318 | 3,318 | 372 | 372 | 22,687 |
| preview subdomain proxy routing | 3,115 | 3,115 | 279 | 279 | 14,142 |
| persist chat transcript card to history | 3,171 | 3,171 | 332 | 332 | 12,398 |
| shared git tree ownership uid drop | 3,174 | 3,174 | 1,262 | 1,262 | 17,846 |
| message group boundaries at tool result | 2,661 | 2,661 | 527 | 851 | 7,807 |
| turn executor commit and pr terminal paths | 3,222 | 3,222 | 284 | 692 | 36,445 |
| **Total** | **18,661** | **18,661** | **3,056** | **3,788** | **111,325** |
| **% of baseline** | 16.8% | **16.8%** | 2.7% | **3.4%** | 100% |
| **gold surfaced** | 91.7% | — | 91.7% | — | — |
| **gold positioned** | 91.7% | **91.7%** | 58.3% | **91.7%** | — |

Four fresh-daemon runs give 3,788 tokens at 91.7% positioned every time; ripwire
lands between 18,661 and 18,673 across the same runs.

A useful accident confirms the harness is really exercising the index: one run
against a deleted index returned 36 tokens at 0% on every task. The numbers above
are not being produced by something else.

### How recall is scored, and why it is scored twice

Both tools separate a positioned answer from a path-only pointer, and both say so
themselves. ripwire's ranked `<d l="902" … p="…">` rows carry a line; its `<tail>`
rows carry only a path, and ripwire's own header calls the tail "WEAKER evidence …
paths only". LemonCrow's inline source and `related_symbols` carry `:Lx-Ly`; its
`candidate_files:` list does not. So:

- **surfaced** — the path is named anywhere. This is the check docs/291 applied,
  so it is the number comparable with its table. Both tools tie at 91.7%.
- **positioned** — the answer gives a line number for that path. ripwire positions
  everything it surfaces. LemonCrow positions 58.3% and points at the rest.

The `+its follow-up` columns charge each arm for opening the files **it** named
but did not position — and nothing else. LemonCrow follows up with its own
bounded `read` at `:outline`; ripwire would follow up with a plain whole-file
`Read`, since it ships no reader. ripwire's follow-up cost is zero because it has
nothing to follow up on, which is a real quality advantage and is why the column
exists. Each follow-up's success is checked against the response, not assumed.

### What this does not establish

- **Orientation phase only.** ripwire returns signatures and LemonCrow returns
  bounded source, so in both arms an agent still reads the bodies it edits.
- **File-level retrieval only.** The scorer asks whether the answer gives a line
  number for the right *file*. It never checks that the line is the right line,
  and it measures recall, not precision — a tool that names twenty files
  including the gold one scores the same as one that names two.
- **The denominator is response text.** 3,788 against 18,661 compares what each
  tool *returns*. It excludes tool schemas, tool-call arguments, the model's own
  deliberation, and reads that turn out to be wrong. Charging LemonCrow's
  advertised schema once per task, for illustration, would add 6 × 1,689 = 10,134
  and put it at 13,922 — still below ripwire, but the honest headline is
  "response size", not "cost".
- **The baseline is not a floor**, despite docs/291 describing it that way. It is
  biased in both directions: it gets oracle file selection, which no agent has,
  but it is charged whole-file reads, which an agent can avoid with a targeted
  range. It is a reference point, not a bound. This doc inherits the number and
  not the claim.
- **tiktoken `o200k_base` is a proxy** for Claude's non-public tokenizer.
- **Six TypeScript architecture tasks on one repository.** No other language, no
  ambiguous or frontend queries, and no measurement of whether a task was
  actually completed. LemonCrow's `paths` argument is a *soft* scope while
  ripwire is given `src/server` as its crawl root, so the two corpora are not
  identical.

### Two scoring flaws that were found and fixed

Both were caught by review, both would have flattered LemonCrow, and both are
recorded because the same class of error has now occurred three times across this
doc and docs/291.

1. **Brace notation read as a miss.** LemonCrow compresses sibling paths into
   `src/server/orchestrator/{a.ts,b.ts}`. A substring test for
   `orchestrator/b.ts` does not match that, and the first harness scored two
   tasks at 0% — which would have produced the opposite recommendation. Both arms
   now expand braces before scoring.
2. **The follow-up used the answer key.** The first follow-up chose files from
   the gold set, so it read `post-turn-hold.ts` — a file LemonCrow never
   mentioned — using knowledge no agent has, and repaired LemonCrow's miss while
   leaving ripwire's identical miss unrepaired. It also asserted "every gold file
   positioned" without checking the response. The follow-up now draws only from
   what each arm's own answer named, and its success is scored. Fixing it cost
   LemonCrow nothing on the headline, which is why the headline is worth
   reporting.

A third correction went the other way: the repaired success check initially looked
for the path inside the `read` response, and `read` does not echo the path, so
every follow-up scored as failed. Same mistake, opposite sign.

### A behaviour that makes the harness fragile

LemonCrow's MCP bridge talks to a resident singleton daemon, and results depend on
its warm state. Re-running the identical six queries against a **warm** daemon
returns 1,815 tokens at 41.7% positioned instead of 3,056 at 58.3% — it suppresses
results it believes the caller already has, and rides a `"saved": {"tokens": …,
"calls": …}` field alongside the response. Every number above is from a fresh
daemon. Anyone re-running this must kill the daemon between runs.

That suppression is also an unexamined correctness risk for a real integration.
`context_dedup.py:24` resets its epoch on a PostCompact signal and defaults to
epoch zero when the state is absent. This spike tests no compaction, no resumed
agent, no second reviewer sharing the daemon, and no edit/rename/branch-reset
against index freshness.

## Constraining the tool surface

LemonCrow can already be reduced to a retrieval-only advertised surface with no
ShipIt change. `LEMONCROW_HIDE_TOOLS` (`core/environment.py:105`) removes tools
from what the server advertises, and ShipIt's MCP settings form can carry it as an
`env` entry. Measured:

| Configuration | Advertised tools | Schema | Instructions |
|---|---|---:|---:|
| `core` profile, default | `bash, code_search, edit, read, tool, web_fetch` | 1,689 tok | 215 tok |
| `full` profile + `LEMONCROW_HIDE_TOOLS=bash,edit,web_fetch` | `code_search, read` | **568 tok** | 215 tok |

That is a real improvement: two-thirds off the standing schema cost, `bash` and
`edit` gone from the model's view, and blockers 1 and 2 no longer reachable by a
model choosing from what it can see.

**It is visibility filtering, not authorization.** Tested directly: with
`bash` hidden, a `tools/call` naming `bash` still executed and returned its
output. `mcp_server.py`'s dispatch resolves the registered handler without
consulting visibility, and ShipIt's `mcp__lc__*` glob allows the call. So the
branch-guard bypass survives for a model that knows the name — which the server's
own instructions and any prior exposure supply. Whether that residual risk is
acceptable is `docs/291-ripwire-context-map/requirements.md` question 2.

## Opt-in and existing sessions (req 6)

Not satisfiable through the existing settings surface.
`src/server/orchestrator/session-agent-run-params.ts:111` reads
`credentialStore.getAllMcpServers()` filtered on `enabled` while building each
turn's run parameters. The set is account-wide and read per turn, not snapshotted
when a session is created — so enabling an `lc` server changes what an *existing*
session's next turn is given. "Off by default" holds; "enabling it must not change
a session that already exists" does not. This is
`docs/291-ripwire-context-map/requirements.md` question 3.

## What a session container pays to run it (req 7)

| | Measured |
|---|---|
| Process shape | `lc mcp` is a thin bridge to a resident singleton daemon over a unix socket, not a self-contained stdio server |
| Daemon memory | ~370 MB RSS after a six-query run; a longer-lived daemon in this session reached ~990 MB |
| One-off index build | `lc code index --reindex` peaked at ~1.6 GB across the indexer plus 8 forkserver workers, and took minutes |
| Index on disk | 723–751 MB inside the clone after an explicit `lc code index`, for 3,217 files / 113,115 symbols — gitignored, but it is the session's disk. An early, partially-warmed index built lazily through MCP use alone was 576 KB and already gave the retrieval results above; what a fully lazy build settles at was not measured |
| Search latency | 0.1–0.3 s per `code_search` against a warm index. The 0.6 s "warm-up" the harness reports is against an index already on disk. **First use on a fresh checkout was not measured through the MCP path** — the closest figure is the explicit reindex row above |
| Standing context | 1,689 tokens of advertised schema plus 215 tokens of server instructions, or 568 + 215 with the hidden surface. These are payload sizes, not a measured host prompt contribution |
| Egress | `code_search` calls tiktoken for `cl100k_base` and fails closed without `openaipublic.blob.core.windows.net`, which this container's allowlist does not resolve. Avoidable — every measurement here ran against a pre-seeded `TIKTOKEN_CACHE_DIR` (`prepare_tokenizer.mjs` builds one offline) — but it must be arranged, or LemonCrow simply does not work in a default session container |
| Telemetry | Remote telemetry is **on by default** (`telemetry/config.py:69-77`). In practice the export that runs is the public rollup to `lemoncrow.com/api/telemetry/rollup`, which sends one-way-hashed ids; the PostHog path additionally needs an API key whose default is empty (`telemetry/emit.py:59-61`), so it does not run out of the box. A scrubber redacts repository URLs. `DO_NOT_TRACK=1` or `LEMONCROW_TELEMETRY=off` disables both |

Two of these want a decision before adoption rather than after: a ~370 MB resident
daemon inside a memory-budgeted session container (docs/229 sizes containers from
host capacity, and the idle enforcer reclaims the longest-idle one when the host
is over budget), and telemetry on by default from a container holding the user's
private repository.

## Project risk

Re-checked today against the GitHub API.

- Repository created 2026-05-01 — about four months old.
- 973 commits from one account, 3 from another. Bus factor 1. 62 stars.
- Licence is **Apache-2.0 and not ambiguous.** `LICENSE` states that the whole
  repository, naming the `lemoncrow.pro` engine explicitly, is Apache-2.0, with
  the full text in `LICENSE-APACHE`. GitHub's `NOASSERTION` is a detection
  artifact of that wrapper file. planning#332's "licence is ambiguous" is stale.

The additive shape limits what that risk can cost: an MCP server the user enabled
can be un-enabled, and nothing in the transcript, the guards, or the user's
repository depends on it.

## What would change the answer

- **A decision on authorization versus visibility.** `LEMONCROW_HIDE_TOOLS`
  already gets the advertised surface to `code_search` + `read`. If hiding is
  judged sufficient, the remaining work is small. If it is not, ShipIt needs a
  real per-server tool boundary — worth more than this spike, because it closes
  the same gap for every user MCP server.
- **A decision on what "must not change an existing session" requires.**
- **An agent-in-the-loop trial.** Everything above measures tool responses. The
  substitution steering in `SERVER_INSTRUCTIONS`, the warm-daemon suppression
  across compaction, and whether inline diffs actually survive can only be
  settled by running a real session and reading the transcript.
- **Arranging the tokenizer data** (vendor it, or allowlist the host).
- **`DO_NOT_TRACK=1`** in the server's env, which the existing MCP settings form
  can already carry.

## Reproducing the measurement

```bash
uv venv --python 3.12 /persist/lc/venv
VIRTUAL_ENV=/persist/lc/venv uv pip install -e <lemoncrow@403ea9ba> httpx "mcp>=1.0" tiktoken
node docs/294-lemoncrow-mcp-spike/prepare_tokenizer.mjs   # writes /persist/tkcache
# ripwire v0.4.0 extracted to /persist/rw/ripwire-0.4.0-linux-x64/
pkill -f "lemoncrow[.]gateway.*mcp daemon"                # fresh daemon, see above
/persist/lc/venv/bin/python docs/294-lemoncrow-mcp-spike/measure_lc.py
```

`prepare_tokenizer.mjs` exists because `openaipublic.blob.core.windows.net` is not
resolvable here; it rebuilds the identical `o200k_base` and `cl100k_base` tables
from the `js-tiktoken` npm package into tiktoken's own on-disk cache format, so
the Python tokenizer used is the real one.

## Key files

- `src/server/session/agents/claude/process.ts` — `:448` and `:887` build the
  `mcp__<name>__*` allowlist glob that admits LemonCrow's whole tool namespace,
  once per spawn path.
- `src/server/orchestrator/session-agent-run-params.ts` — `:111`, why enabling a
  server reaches sessions that already exist.
- `docker/agent-hooks/managed-settings.json` — registers the branch-guard hook on
  `"matcher": "Bash"`, so no MCP tool name reaches it.
- `docker/agent-hooks/block-branch-ops.mjs` — `:70`, the second reason an MCP
  shell is unguarded.
- `src/client/components/message-tools.tsx` — `:80`, `:98`, `:233`, the literal
  tool names the transcript keys inline diffs and command cards on.
- `src/client/components/McpServerSettings/` — the existing user-facing surface an
  `lc` server would be added through, and where `LEMONCROW_HIDE_TOOLS` and
  `DO_NOT_TRACK` would be set.
- `docs/294-lemoncrow-mcp-spike/measure_lc.py`, `mcpclient.py`,
  `prepare_tokenizer.mjs` — the harness, the stdio MCP client, and the offline
  tokenizer builder.
