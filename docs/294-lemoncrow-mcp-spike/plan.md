---
issue: planning#521
title: LemonCrow as an added MCP retrieval tool — the spike planning#332 asked for
description: The MCP-only additive shape measured against ripwire and a grep baseline, with the vendor installer's real global-mode behaviour and the one blocker that still fires
---

# LemonCrow as an added MCP retrieval tool

Implements [requirements.md](requirements.md). Follow-up to planning#332, which
rejected LemonCrow's tool-replacement mode and recommended exactly this spike.
Compares against `docs/291-ripwire-context-map/`, whose harness and task set this
reuses verbatim.

**Recommendation: the measurement gate is cleared, and one blocker still fires.**
LemonCrow's `code_search` reaches full parity on the gold answers for **3,878
tokens** where ripwire needs **18,679** — 4.8x cheaper for the same result. It
does not write anything into the user's PR. But enabling it through ShipIt's
existing MCP settings also adds `mcp__lc__bash`, which is auto-allowed and which
`block-branch-ops.mjs` cannot see. Adoption is blocked on a way to restrict an
MCP server to a subset of its tools, which is the open question in
[requirements.md](requirements.md).

All numbers come from LemonCrow 0.7.2 (`main` at 2026-09-07) and ripwire v0.4.0
(linux-x64, checksum verified) run against `/workspace` at commit `1a51f23d`.

## The premise, checked (req 2)

The spike rests on a premise from `docs/291-ripwire-context-map/plan.md`: that
global mode without `--project` "registers the MCP server and does not write
project enforcement, so the `lc` tools would be *added* rather than substituted."

**The narrow half is true. The wider half is false.**

True: project enforcement is written only under `--project`.
`scripts/install_claude.sh:598` gates `configure_project_enforcement` on a
non-empty `PROJECT_ENFORCE`, which only `--project` sets. The script's own header
comment at line 11 — "In global mode without `--project`, asks interactively when
running in a git repo" — describes a code path that no longer exists. The
comment is stale; the code is the fact.

Also true, and new since planning#332: the native-tool deny list is now **empty
by default**. `install_claude.sh:147-151` writes `permissions.deny: []` unless
`LEMONCROW_ENFORCE_NATIVE_DENY=1` is set. planning#332's "hiding `Bash` disarms
the branch guard" no longer describes the default install.

False: global mode still substitutes tools, by a different mechanism. Global mode
runs two more steps beyond the MCP registration:

- `claude plugin install lemoncrow@lemoncrow` (line 437). Every one of the
  plugin's ten agents sets `disallowedTools` including `Bash` —
  `integrations/claude/plugin/agents/code.md:4` is
  `["Read","Edit","Write","Grep","Glob","Bash","WebFetch"]`, and the other nine
  are the same list or longer.
- `"agent": "lemoncrow:code"` written into `~/.claude/settings.json`
  (lines 565-578), making that Bash-hiding agent the **default agent**.

Both sit outside the `if $WORKSPACE_SET` block, so both run in global mode.
Neither appears in what `--print-only` prints, which lists three commands and
stops. A sandboxed `--dry-run` (`HOME=/persist/fakehome`) traces both writes:
`apply_enforcement_to_settings: merge deny+allow → …/.claude/settings.json` and
`set statusLine in …/.claude/settings.json`.

**So the conclusion holds only for a narrower shape than the premise stated:**
register the MCP server and nothing else. Do not run the vendor installer at all.
That is the shape everything below measures — the `lc` MCP server registered on
its own, no plugin, no agents, no hooks, no settings writes.

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

and `:461` appends it to `--allowedTools`. LemonCrow's `core` profile advertises
six tools — `bash`, `code_search`, `edit`, `read`, `tool`, `web_fetch` (probed
over stdio; the `full` profile advertises the same set minus the broker, so this
is not a profile choice). So enabling an `lc` server auto-allows
`mcp__lc__bash`.

The guard cannot see it, for two independent reasons.
`docker/agent-hooks/managed-settings.json` registers the PreToolUse hook with
`"matcher": "Bash"`, so it is never invoked for an MCP tool name; and
`docker/agent-hooks/block-branch-ops.mjs:70` independently exits on
`payload?.tool_name !== "Bash"`. A `git reset --hard` issued through
`mcp__lc__bash` is unguarded.

**This is not LemonCrow-specific.** Any user MCP server exposing a shell-shaped
tool has the same effect today, with no LemonCrow involved. That is a
pre-existing gap this spike surfaced rather than created.

### 2. The transcript — **fires narrowly**

`src/client/components/message-tools.tsx:80` and `:98` key inline diffs on the
literal `Edit` and `Write`; `:233` keys command cards on `Bash` (and `shell`).
Unchanged.

In a retrieval-only shape this would not matter: the agent keeps using native
`Edit`/`Write`/`Bash` for the work the transcript renders, and a `code_search`
call is legitimately a generic tool card. It fires only because the same glob
that admits `mcp__lc__bash` also admits `mcp__lc__edit` — so an agent that takes
LemonCrow's tool descriptions at their word ("Use instead of grep/find") can edit
through a path that renders no diff. Product principles §1 and §2 lose exactly as
much as they did before, just less often.

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
`docs/291-ripwire-context-map/measure.py`'s six task phrases, gold answer sets,
grep keywords and tokenizer unchanged, and adds LemonCrow as a third arm driven
over stdio MCP by `mcpclient.py`. The ripwire arm reproduces docs/291's published
totals to within 12 tokens, which is the check that the two are on the same
method.

| Task | ripwire | LemonCrow | +follow-up | grep+read |
|---|---:|---:|---:|---:|
| post-turn auto-push scheduler lease | 3,321 | 372 | 462 | 22,687 |
| preview subdomain proxy routing | 3,118 | 279 | 279 | 14,142 |
| persist chat transcript card to history | 3,174 | 332 | 332 | 12,398 |
| shared git tree ownership uid drop | 3,177 | 1,262 | 1,262 | 17,846 |
| message group boundaries at tool result | 2,664 | 527 | 851 | 7,807 |
| turn executor commit and pr terminal paths | 3,225 | 284 | 692 | 36,445 |
| **Total** | **18,679** | **3,056** | **3,878** | **111,325** |
| **% of baseline** | **16.8%** | **2.7%** | **3.5%** | 100% |
| **gold surfaced** | **91.7%** | **91.7%** | 91.7% | — |
| **gold positioned** | **91.7%** | **58.3%** | **91.7%** | — |

Recall is reported at two levels, because LemonCrow's cheapest answers defer work
rather than doing it:

- **surfaced** — the gold file appears anywhere in the answer, including the
  trailing `candidate_files:` pointer list. This is the check docs/291 applied to
  ripwire, so it is the comparable number, and the two tools tie at 91.7%.
- **positioned** — the gold file appears with a line number, in inline source or
  the `related_symbols` map. ripwire positions everything it surfaces; LemonCrow
  positions 58.3% and points at the rest.

The `+follow-up` column charges LemonCrow for closing that gap: one `read` with
`:outline` over the gold files it only pointed at — the mode its own tool
description prescribes for "structure at any size". At that point every gold file
is positioned in both arms and the comparison is like for like: **3,878 against
18,679**. The follow-up is one plausible agent action, not an observed one; it is
charged rather than assumed away because a cheap answer that misses is not a
saving.

The 8.3% both tools fail on is the same file, `orchestrator/post-turn-hold.ts` on
the auto-push task. docs/291 verified that miss by hand for ripwire; LemonCrow
misses it identically.

### Limits, carried over unchanged

- **Orientation phase only.** ripwire returns signatures and LemonCrow returns
  bounded source, so in both arms an agent still reads the bodies it edits. This
  measures the search phase that the tool replaces, and nothing else.
- **The baseline is a floor.** One grep with a well-chosen keyword, then reads
  only the gold files. A real agent greps several times and reads files that turn
  out to be irrelevant, so the true baseline is higher and both savings larger.
- **tiktoken `o200k_base` is a proxy** for Claude's non-public tokenizer. The
  absolute figures carry that error; the ratios are less sensitive to it.

### One correction worth recording

The first version of this harness scored two of the six tasks at 0% recall for
LemonCrow and would have produced the opposite recommendation. The fixture was
wrong, not the tool: LemonCrow compresses sibling paths into shell brace notation
(`src/server/orchestrator/{dispatched-turn.ts,turn-executor.ts}`), and a plain
substring test for `orchestrator/turn-executor.ts` does not match that. The
harness now expands brace notation on **both** arms before scoring. docs/291
records a fixture error of the same class, in the same direction.

### One behaviour that makes the harness fragile

LemonCrow's MCP bridge talks to a resident singleton daemon, and results depend
on that daemon's warm state. Re-running the identical six queries against a
**warm** daemon returns 1,815 tokens at 41.7% positioned instead of 3,056 at
58.3% — it suppresses results it believes the caller already has (`"saved":
{"tokens": …, "calls": …}` rides along in the response). Every number above is
from a **fresh** daemon, which is what a new session gets; three fresh runs agree
exactly. Anyone re-running this must kill the daemon between runs.

## What a session container pays to run it (req 7)

| | Measured |
|---|---|
| Process shape | `lc mcp` is a thin bridge to a resident singleton daemon over a unix socket, not a self-contained stdio server |
| Daemon memory | ~370 MB RSS after a six-query run; a longer-lived daemon in this session reached ~990 MB |
| One-off index build | `lc code index --reindex` peaked at ~1.6 GB across the indexer plus 8 forkserver workers |
| Index on disk | 723 MB inside the clone for 3,217 files / 113,115 symbols — gitignored, but it is the session's disk |
| Index time | Minutes for a full reindex; the lazy index the MCP path builds is sub-second to warm |
| Search latency | 0.1–0.3 s per `code_search` against a warm index |
| Always-on context | **1,702 tokens** of MCP tool schema in every turn, not just orientation turns. ripwire's standing cost is a skill description, which is smaller by an order of magnitude but was not measured here |
| Egress | **Hard requirement.** `code_search` calls tiktoken for `cl100k_base` and fails closed without `openaipublic.blob.core.windows.net`, which this container's allowlist does not resolve. Every measurement above needed a pre-seeded `TIKTOKEN_CACHE_DIR` (`prepare_tokenizer.mjs` builds one offline from the `js-tiktoken` npm package) |
| Telemetry | **Remote telemetry is on by default** (`src/lemoncrow/core/service/telemetry/config.py:69-77`), exporting to PostHog and `lemoncrow.com/api/telemetry/rollup`. A scrubber redacts repository URLs. `DO_NOT_TRACK=1` or `LEMONCROW_TELEMETRY=off` disables it |

Two of those are the kind of thing that has to be decided before adoption, not
after: a ~370 MB resident daemon inside a memory-budgeted session container
(docs/229 sizes containers from host capacity, and the idle enforcer reclaims the
longest-idle container when the host is over budget), and remote telemetry on by
default from a container holding the user's private repository.

## Project risk

Unchanged in direction from docs/291's read, and re-checked today.

- Repository created 2026-05-01 — about four months old.
- 973 commits from one account, 3 from another. Bus factor 1. 62 stars.
- Licence is **Apache-2.0 and not ambiguous.** `LICENSE` states that the whole
  repository, naming the `lemoncrow.pro` engine explicitly, is Apache-2.0, with
  the full text in `LICENSE-APACHE`. GitHub's `NOASSERTION` is a detection
  artifact of that wrapper file. planning#332's "licence is ambiguous" is stale.

The additive shape limits what the project risk can cost: an MCP server the user
enables can be un-enabled, and nothing in the transcript, the guards, or the
user's repository depends on it. That is the same argument docs/291 makes for
ripwire, and it applies here too.

## What would change the answer

- **A way to restrict an MCP server to a subset of its tools.** This is the one
  thing standing between the measured result and adoption. It is also worth more
  than this spike: it closes the same gap for every user MCP server, not just
  LemonCrow. See the open question in [requirements.md](requirements.md).
- **Vendoring the tokenizer data**, or an egress allowlist entry. Without one,
  `code_search` fails closed in a default session container.
- **`DO_NOT_TRACK=1` in the server's env**, which the existing MCP settings form
  can already carry.
- **A smaller resident footprint.** ~370 MB is affordable on a large host and is
  not on a small one; the honest test is whether a session's memory budget can
  absorb it alongside the dev server the user is actually running.

## Reproducing the measurement

```bash
uv venv --python 3.12 /persist/lc/venv
VIRTUAL_ENV=/persist/lc/venv uv pip install -e <lemoncrow-checkout> httpx "mcp>=1.0" tiktoken
node docs/294-lemoncrow-mcp-spike/prepare_tokenizer.mjs   # writes /persist/tkcache
# ripwire v0.4.0 extracted to /persist/rw/ripwire-0.4.0-linux-x64/
pkill -f "lemoncrow[.]gateway.*mcp daemon"                # fresh daemon, see above
/persist/lc/venv/bin/python docs/294-lemoncrow-mcp-spike/measure_lc.py
```

`prepare_tokenizer.mjs` exists because `openaipublic.blob.core.windows.net` is
not resolvable here; it rebuilds the identical `o200k_base` and `cl100k_base`
tables from the `js-tiktoken` npm package into tiktoken's own on-disk cache
format, so the Python tokenizer used is the real one.

## Key files

- `src/server/session/agents/claude/process.ts` — `:448` builds the
  `mcp__<name>__*` allowlist glob that admits LemonCrow's whole tool namespace.
- `docker/agent-hooks/managed-settings.json` — registers the branch-guard hook on
  `"matcher": "Bash"`, so no MCP tool name reaches it.
- `docker/agent-hooks/block-branch-ops.mjs` — `:70`, the second reason an MCP
  shell is unguarded.
- `src/client/components/message-tools.tsx` — `:80`, `:98`, `:233`, the literal
  tool names the transcript keys inline diffs and command cards on.
- `src/client/components/McpServerSettings/` — the existing user-facing surface an
  `lc` server would be added through. No new UI is needed for the additive shape.
- `docs/294-lemoncrow-mcp-spike/measure_lc.py`, `mcpclient.py`,
  `prepare_tokenizer.mjs` — the harness, the stdio MCP client, and the offline
  tokenizer builder.
