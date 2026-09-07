---
issue: planning#520
title: Retrieval tools for session agents — ripwire and LemonCrow, measured
description: Three measurements of ripwire and LemonCrow against a grep-and-read baseline, why the cheap measurement inverted the real one, and why neither tool is adopted yet
---

# Retrieval tools for session agents — ripwire and LemonCrow, measured

Implements [requirements.md](requirements.md).

[ripwire](https://github.com/redhat-et/ripwire) is a single C++23 binary, Apache-2.0,
from the `redhat-et` organisation. It parses a repository with vendored tree-sitter
grammars for 21 languages, ranks symbols with Personalized PageRank, and prints a
minified XML map. It needs no API key, no embeddings, no index server and no daemon.
It also exposes an MCP server.

**Recommendation: adopt neither tool yet, for different reasons.**

- **ripwire — do not adopt.** Retrieval is accurate, but it does not pay for itself:
  83.5% of baseline context, a ~5% median saving, and *more* expensive than plain
  grep-and-read on 3 of 6 tasks.
- **LemonCrow — better tool, not yet adoptable.** Its retrieval advantage survives
  end-to-end where ripwire's did not (72.8% of baseline context, beating ripwire on
  4 of 6 tasks), but it is the most expensive arm measured — 7% dearer than using no
  tool at all — and two integration blockers remain live. Evidence in
  `docs/294-lemoncrow-mcp-spike/`; the questions that gate it are questions 2 and 3 in
  [requirements.md](requirements.md).

This reverses an earlier draft of this doc, which recommended baking in a pinned
ripwire binary and one skill. That recommendation rested on a token saving that
measurement did not support.

On ripwire specifically: accuracy was never the question. It returns the right symbols
with exact line numbers in about 2.6 s. The question was whether it saves an agent
work, and a ~5% median saving is too small and too unreliable to justify a dependency
on a six-week-old project with one author (req 6, and the project risk below).

What would change that verdict: evidence the tool can be invoked *conditionally*, on
diffuse multi-file questions only, where it did win clearly. The blanket "run it first"
shape the vendor's skills teach is measurably wrong here. If it is adopted anyway, the
narrow shape still holds — a pinned binary and one skill, never the vendor's 19 skills,
`--test-gate`, or `--doc-drift`.

## How to read this doc — three measurements, three numbers

This doc quotes ripwire at 16.8%, 83.5% and (for LemonCrow) 72.8% of a baseline.
Those are not revisions of one another. They are **three different measurements**,
and the disagreement between them is the main result.

| # | What it measures | Answers | ripwire | LemonCrow |
|---|---|---|---:|---:|
| 1 | **Response size** — tokens the tool returns, against a scripted grep-and-read pass | "How compact is the answer?" | 16.8% | 3.4% |
| 2 | **End-to-end context** — `contextTokens` a real sub-agent accumulates | "Does it save the agent work?" | 83.5% | 72.8% |
| 3 | **End-to-end cost** — `costUsd` for the same runs | "Does it save money?" | 89.4% | **107.0%** |

Two lessons sit behind that table, and both generalise beyond these tools.

**Measurement 1 does not predict measurement 2.** Pricing a tool's output against a
scripted baseline credits it with replacing reads the agent goes on to make anyway.
For ripwire it was wrong by roughly a factor of five, and in the flattering direction.

**Measurement 2 does not predict measurement 3.** LemonCrow ends each task with a
*smaller* context and still costs more money, because `cacheReadTokens` bills per turn
and it reaches its tighter answer over more turns. Context-window pressure and spend
are different constraints with different winners.

Measurement 1 is retained throughout rather than deleted. Keeping the measurement that
turned out to mislead is what makes the correction legible.

## Measurements

All ripwire numbers come from release v0.4.0 (linux-x64, checksum verified) run
against `/workspace` at commit `4e120fe5a` on 2026-09-07. LemonCrow numbers are
version 0.7.1 unless stated.

### Retrieval is accurate and cheap (req 1, req 2, req 3)

Three queries were chosen because `CLAUDE.md` already states their answers, so the
result could be marked right or wrong without judgement.

| Query | Top-ranked results | Correct |
|---|---|---|
| `post-turn auto-push scheduler lease` | `beginPostTurnWork` (r1), `AutoPushScheduler` (r3), `arm`, `releaseHold`, `armPendingPush` | Yes — the symbols post-turn invariant 5 names |
| `preview subdomain proxy routing` | `registerPreviewProxy` (r1), `parsePreviewSubdomain` (r2) | Yes |
| `persist chat transcript card to history` | `CardPersistCtx` (r1), `emitChatCard` (r5) | Yes |

The first query ran cold in 2.6 s and cost about 4.1K tokens. Every reported line
number and signature was checked against the source and was exact, including
`orchestrator/services/auto-push-scheduler.ts:322` and
`orchestrator/session-runner.ts:1337`. This satisfies req 2.

### Token saving, measured without integrating anything (req 1)

The saving can be measured with no change to ShipIt at all. The binary runs against
a checkout from outside the repository, so the whole measurement is a
read-only exercise. `measure.py` in this folder is the harness; it needs `tiktoken`
and the extracted release binary, and it writes nothing.

Six tasks, each with a gold answer set taken from `CLAUDE.md` and verified against
the real definition sites rather than trusted:

| Task | ripwire | grep + read | ripwire as % | gold recall |
|---|---:|---:|---:|---:|
| post-turn auto-push scheduler lease | 3,319 | 22,687 | 14.6% | 50% |
| preview subdomain proxy routing | 3,116 | 14,142 | 22.0% | 100% |
| persist chat transcript card to history | 3,172 | 12,398 | 25.6% | 100% |
| shared git tree ownership uid drop | 3,175 | 17,846 | 17.8% | 100% |
| message group boundaries at tool result | 2,662 | 7,807 | 34.1% | 100% |
| turn executor commit and pr terminal paths | 3,223 | 36,445 | 8.8% | 100% |
| **Total** | **18,667** | **111,325** | **16.8%** | **91.7%** |

**Read this as an orientation-phase number, not a task-cost number.** ripwire returns
signatures, not bodies, so an agent still reads the bodies of the files it edits. The
measurement covers the search phase that the map replaces, and nothing else.

#### Measurement 2 — end-to-end, and it contradicts measurement 1

The number above prices an *artificial* baseline. To see what agents actually spend,
the same tasks were given to real sub-agents twice — once with ripwire on PATH and
one paragraph saying so, once with the normal tools only — with an identical
read-only prompt otherwise. `shipit agent run --json` reports `contextTokens` and
`costUsd` per run, so this is observed, not estimated. A no-op control run fixes the
per-run overhead at 47,858 context tokens, which is subtracted.

| Task | baseline net | ripwire net | ratio | baseline $ | ripwire $ |
|---|---:|---:|---:|---:|---:|
| post-turn auto-push scheduler lease | 23,590 | 26,261 | **111.3%** | 0.261 | 0.274 |
| preview subdomain proxy routing | 25,027 | 7,553 | 30.2% | 0.282 | 0.196 |
| persist chat transcript card to history | 12,601 | 16,591 | **131.7%** | 0.196 | 0.215 |
| shared git tree ownership uid drop | 16,373 | 10,415 | 63.6% | 0.246 | 0.191 |
| message group boundaries at tool result | 2,286 | 6,610 | **289.2%** | 0.155 | 0.187 |
| turn executor commit and pr terminal paths | 12,940 | 10,116 | 78.2% | 0.279 | 0.206 |
| **Total** | **92,817** | **77,546** | **83.5%** | **1.420** | **1.269** |

Aggregate saving **16.5%** of tokens and 10.6% of cost. Median ratio **94.7%**, so
the typical task saves about 5%. **Ripwire cost more on 3 of the 6 tasks.**

**This corrects measurement 1 above, and nearly inverts it.** Response size said
ripwire costs 16.8% of a grep-and-read pass. Measured against real agents it costs
**83.5%**. Measurement 1 was not wrong about what it measured; it was wrong as a proxy
for what an agent spends, because it credited ripwire with replacing file reads that
the agent goes on to make anyway.

The mechanism is visible in the spread, which matters more than the total:

- **The map is a fixed charge of roughly 3,000 tokens**, incurred whether or not the
  task needed it. It pays for itself only when it prevents reading a large file.
- **Task 5 is the clearest case against.** The baseline solved it in 2,286 tokens
  because one grep was enough. Adding ripwire cost 6,610 — nearly three times as
  much — pure overhead on an easy question.
- **Tasks 2 and 4 are the case for.** Both are diffuse questions spanning several
  files, where the ranked map genuinely replaced an exploration.
- The aggregate 16.5% saving exists only because the total is dominated by the
  expensive tasks. It is not what a typical task sees.

Note also that the baseline agent on task 1 located `post-turn-hold.ts` — the file
ripwire's own map missed, and the reason that task scores 50% recall above. On that
task ripwire was both more expensive and less complete.

**What this rules out:** a blanket "run ripwire first" instruction, which is exactly
what the vendor's bundled skills teach. On this codebase that instruction loses on
half the tasks. Any adoption would have to fire *conditionally* — on diffuse,
multi-file questions only — and nothing in a skill description reliably makes that
distinction in advance.

Measurement 1 is retained above, deliberately. It is the measurement that misled, and
keeping it beside the one that corrected it is what makes the correction legible.
Where the two disagree, **the end-to-end number governs**.

Three things bound how far the number can be pushed:

- **The baseline is a reference point, not a floor.** An earlier draft called it a
  floor; that was wrong, and the review on `docs/294-lemoncrow-mcp-spike/` caught it.
  It is biased in **both** directions: it gets oracle file selection, which no agent
  has, but it is charged whole-file reads, which an agent can avoid with a targeted
  range. So it bounds nothing, and "the true saving is larger" does not follow from
  it — the end-to-end runs below are what settle the question.
- **Token counts use tiktoken `o200k_base`** as a proxy. Claude's tokenizer is not
  public, so the absolute figures carry that error; the ratio is less sensitive to it.
- **Recall is 91.7%, not 100%.** The one partial is the auto-push task, where ripwire
  surfaced the `beginPostTurnWork` declaration in `session-runner.ts` but not the
  implementation in `post-turn-hold.ts`. A cheap answer that misses is not a saving,
  so cost and recall must be read together.

The tool's self-reported `est_tokens` over-states its own cost by about 24%
consistently (4109 reported against 3318 measured, and the same pattern on two more
tasks). It errs against its own headline claim, which is the honest direction.

One fixture correction is worth recording, because it nearly produced a wrong result.
The first run scored this repository's message-group task at 0% recall. The fixture
was wrong, not the tool: `CLAUDE.md` names `agent-listeners.ts` as the key file, and
that is where the flag is *set* (`agent-listeners.ts:1444`), but the boundary logic
ripwire returned lives in `ws-handlers/agent-message-builder.ts`. The tool was right
and cheap; the gold set was incomplete.

### Three features are not reliable here (req 8)

**Blast radius saturates.** `--test-gate` on the single leaf file
`orchestrator/compose-stack-reaper.ts` reports `impacted=3371` and `tests=316` of our
339 test files. A 10-file change reports *fewer* — 3332 and 313. The signal does not
discriminate at all. The same output reports `graph_ambiguous=2540`, so TypeScript
edge resolution is the likely cause.

**Confidence is not calibrated for this repository.** All three correct answers above
self-reported `confidence="low"` and `margin_pct="0"`.

**Doc-drift is about half noise.** It produced 1024 findings across 872 docs.
`WsFullReset` and `AgentTool` were reported undefined but both exist in `src/`.
Against that, `startDeviceAuth`, `pollDeviceAuth` and `get_system_prompt` are
genuinely absent and are still named in `docs/030` and `docs/014`.

`--quality-delta` found one real regression: `reclaimToEvicted` at
`orchestrator/tier-escalation.ts:487`, complexity 44 to 52.

### Integration cost (req 4, req 5)

The release tarball is 6.4 MB and the binary is 40 MB. It links only glibc and
libstdc++, and runs in the session-worker container as-is. The image already bakes
external tools this way — `uv` is copied from a pinned digest and Gradle is fetched
at a pinned version — so a pinned ripwire follows existing convention.

ripwire adds a command. It does not rename, hide, or replace any host tool, and it
writes nothing into the repository clone. It satisfies req 4 and req 5 by
construction.

One caution: the vendor's `scripts/install.sh` copies 19 skills into
`~/.claude/skills` whenever it finds `~/.claude`. That is right for a person and
wrong for an image build. Use the release tarball directly and verify the published
`.sha256`.

### Version choice (req 6)

v0.4.0 was published 2026-09-07 and is 0 days old. The dependency policy asks for 7
days. `check-deps` reads `POLICY_MANIFESTS` — the two `package.json` files — so a
Dockerfile pin is not gated mechanically, but the intent of the policy applies.
v0.3.8, published 2026-08-13, is 25 days old and satisfies req 6 today. This is the
open question in [requirements.md](requirements.md).

## Project risk

This is the main argument against adoption, and it is about the project rather than
the code.

- The repository was created 2026-07-29 — about six weeks old.
- One person wrote it: 1811 commits from a single account, 6 from an agent. The bus
  factor is 1, despite the Red Hat organisation name.
- 13 releases in five weeks, eight of them inside one 24-hour period.

The narrow shape limits what that risk can cost us. A pinned binary that only adds a
command can be removed by deleting a Dockerfile stanza and one skill. Nothing in the
transcript, the guards, or the user's repository depends on it.

## Comparison with LemonCrow

[LemonCrow](https://github.com/lemoncrow-lab/lemoncrow) was evaluated earlier under
planning#332. That evaluation cites `docs/255-lemoncrow-runtime-evaluation/`, which
**does not exist on any ref** — the doc was never committed, so the issue body is the
only surviving record. Two other `docs/255-*` folders exist, which is the numbering
collision `CLAUDE.md` warns about.

The two tools are not the same category, and the difference is what decides this.

| | ripwire | LemonCrow |
|---|---|---|
| Shape | A command the agent may call | A runtime the agent runs inside |
| Tool surface | Adds nothing, hides nothing | Replaces `Read`/`Edit`/`Write`/`Grep`/`Glob`/`Bash`/`WebFetch` with `mcp__lc__*` |
| Writes into the clone | Nothing | `.mcp.json`, `.claude/settings.json`, `.claude/agents` |
| Scope | Retrieval only | Retrieval, memory, loop detection, output compaction, observability |
| Language | C++23, single binary | Python |
| Age / contributors | 6 weeks, 1 author | 4 months, small team |
| Licence | Apache-2.0 | Apache-2.0 (see below) |

LemonCrow publishes stronger and more careful evidence than ripwire does. Its
benchmark table is pinned to committed raw runs, states its normalisation, and
**includes its own regression** (SWE-bench Lite, -2.0 pp). Headline figures are
+12.0 pp correctness at 29.5% lower cost on SWE-bench Verified, and 37.7% fewer
turns. That is a stronger claim than anything ripwire measures, and it is not the
reason to prefer ripwire.

### What changed since planning#332, and what did not

The prior evaluation's blockers were re-checked against today's code on both sides.

**Still true — hiding `Bash` disarms the branch guard.**
`docker/agent-hooks/block-branch-ops.mjs:70` reads
`if (payload?.tool_name !== "Bash") process.exit(0);`. LemonCrow's Claude plugin sets
`disallowedTools: ["Read","Edit","Write","Grep","Glob","Bash","WebFetch"]` and
instructs the agent to *never fall back to host tools*. A `git reset --hard` issued
through `mcp__lc__bash` is not seen by the guard. The design is now more aggressive
than when the issue was written.

**Still true — the transcript stops rendering.**
`src/client/components/message-tools.tsx:81` and `:99` key inline diffs on the
literal names `Edit` and `Write`, and `:233` keys command cards on `Bash`.
`StreamingIndicator.tsx` switches on the same literals. MCP-named replacements fall
through to generic cards. Losing inline diffs is a direct hit on product principles
§1 and §2, which is a heavier cost for ShipIt than for a terminal-shaped host.

**Still true, and now broader — it writes into the repository.** Workspace mode
writes `.mcp.json`, `.claude/settings.json` and `.claude/agents` into the workspace,
and nothing adds them to `.gitignore`. ShipIt's post-turn `git add -A` would commit
them into the user's PR. One part did improve: `.lemoncrow/` now lives under `$HOME`
rather than in the clone.

**No longer true — the licence is not ambiguous.** The prior evaluation recorded an
ambiguous licence and a "planned closed `lemoncrow.pro` engine". The current
`LICENSE` states that the entire repository, explicitly including the
`lemoncrow.pro` engine, is Apache-2.0, with the full text in `LICENSE-APACHE`.
GitHub's `NOASSERTION` is a detection artifact of the wrapper file, not a real
ambiguity. This claim in planning#332 is stale and should not be repeated.

### Why this does not settle into "ripwire wins"

The honest reading is that they solve different problems, and only one of them fits
ShipIt's shape as it stands.

- ripwire is adoptable **because it is small**, not because it is better. It adds a
  command, so requirements 4 and 5 hold with no work, and removal is trivial.
- LemonCrow's evidence is better and its scope is larger. Its blockers are all
  consequences of the tool-replacement shape, and that shape is what the prior
  evaluation already rejected.
- planning#332's recommendation — spike the MCP-only, opt-in shape behind a
  measurement gate — **has since been built and measured**, and that work is in this
  PR too as `docs/294-lemoncrow-mcp-spike/`. Two of its
  findings bear directly on this doc.

  First, it corrected the premise stated here in an earlier draft. Project
  enforcement really is gated on `--project` (`install_claude.sh:598`), but global
  mode *also* installs the plugin, whose agents hide `Bash`. So the "adds rather than
  substitutes" shape holds only if you register the MCP server yourself and never run
  the installer — narrower than this doc originally claimed.

  Second, on retrieval it beat ripwire decisively: **the same 91.7% positioned recall
  for 3,788 response tokens against ripwire's 18,673**. That is measured on the same
  tasks, after a review found and fixed three scoring flaws that had all flattered
  LemonCrow. What blocks LemonCrow is its integration surface, not its retrieval.

  Read together with the A/B above, the conclusion is not "ripwire instead" — it is
  that ripwire's retrieval is the weaker of the two *and* does not pay for itself
  against plain grep-and-read on this codebase.

### The three-arm end-to-end result

LemonCrow was then put through the *same* end-to-end A/B as ripwire — the test that
overturned ripwire's retrieval-size advantage. Same six tasks, same read-only prompt,
same `Sonnet` role, same no-op control. The baseline runs are reused unchanged, so all
three arms are directly comparable. LemonCrow is reached through `lcsearch.py`, a thin
wrapper over the spike's own MCP client, so that both tools are invoked through `Bash`
in exactly the same way.

| Task | baseline | ripwire | LemonCrow | ripwire % | LemonCrow % |
|---|---:|---:|---:|---:|---:|
| post-turn auto-push scheduler lease | 23,590 | 26,261 | 16,488 | **111.3%** | 69.9% |
| preview subdomain proxy routing | 25,027 | 7,553 | 8,879 | 30.2% | 35.5% |
| persist chat transcript card to history | 12,601 | 16,591 | 10,020 | **131.7%** | 79.5% |
| shared git tree ownership uid drop | 16,373 | 10,415 | 7,478 | 63.6% | 45.7% |
| message group boundaries at tool result | 2,286 | 6,610 | 5,037 | **289.2%** | **220.3%** |
| turn executor commit and pr terminal paths | 12,940 | 10,116 | 19,670 | 78.2% | **152.0%** |
| **Total context tokens** | **92,817** | **77,546** | **67,572** | **83.5%** | **72.8%** |
| **Total cost (USD)** | **1.42** | **1.27** | **1.52** | **89.4%** | **107.0%** |
| **Total wall-clock** | 144.6 s | 116.9 s | 199.9 s | 80.8% | 138.2% |
| **Cache-read tokens** | 1,363,984 | 963,823 | 2,308,946 | 70.7% | 169.3% |

Median ratio: ripwire **94.7%**, LemonCrow **74.7%**. LemonCrow beats ripwire on 4 of
6 tasks and is worse than the baseline on 2, against ripwire's 3.

**The two metrics disagree, and that is the result.** On context tokens LemonCrow
clearly wins — it saves 27% where ripwire saves 17%. On money it is the **worst of
the three arms**: it costs 7% *more* than doing nothing, while ripwire is the only
arm that saves anything (10.6%).

The mechanism is visible in the last two rows. LemonCrow ends each task with a
*smaller* context but takes **38% longer** and reads **69% more cache tokens** than
the baseline. Cache reads are billed per turn, so an arm that reaches a tighter answer
over more turns re-reads its accumulated context more times. A smaller final context
does not imply a cheaper run.

Which number matters depends on the constraint. For context-window pressure — fitting
more work into one session before compaction — LemonCrow is the better tool. For
spend, it is the worst option measured, and plain grep-and-read beats it.

**Limits.** The wrapper measures retrieval value, not the ergonomics of a model
calling a native MCP tool, and it avoids the ~215 tokens of `SERVER_INSTRUCTIONS` a
real Claude-backend install pays into the system prompt. This ran LemonCrow **0.7.1**;
the spike's retrieval numbers used **0.7.2**. Six TypeScript tasks on one repository,
one role, one run each — the per-task spread is wide enough that single-task figures
should not be quoted on their own.

**One operational cost worth naming:** LemonCrow's index is **888 MB**, written to
`/workspace/.lemoncrow/workspace` inside the repo clone. It self-ignores — the
directory ships a `.gitignore` containing `*`, and `git add -An` confirms nothing
would be committed, which **corrects** planning#332's "no `.gitignore` handling"
blocker for this shape. But it is large untracked output, so ShipIt would not restore
it when reclaiming an idle checkout, and the first query on a cold session pays a
multi-minute index build during which the database is locked. A warm query is 4.7 s.

## A ShipIt gap this evaluation surfaced, independent of both tools

The most consequential finding here is not about either tool. It was found while
re-checking planning#332's blockers and verified independently at each site.

**Any enabled user MCP server that exposes a shell-shaped tool bypasses the branch
guard.** Three facts compose:

1. `src/server/session/agents/claude/process.ts:448` maps every enabled MCP server to
   a whole-namespace glob, `mcp__${name}__*`, and appends it to the tool grant. There
   are **two** such call sites — the second at `:887` — so this is not one code path.
2. `docker/agent-hooks/managed-settings.json:50` registers the PreToolUse hook with
   `"matcher": "Bash"`, so the hook is never invoked for an MCP tool name.
3. `docker/agent-hooks/block-branch-ops.mjs:70` independently exits on
   `payload?.tool_name !== "Bash"`.

So a `git reset --hard` issued through, say, `mcp__lc__bash` is unguarded — and the
two mechanisms fail independently, so fixing one does not close it.

Enabling a server grants its *whole* namespace, not the tools it happens to advertise.
Reducing a server's advertised surface therefore does not constrain what it can be
asked to run: a hidden tool still executes when called by name.

The code shows this risk was considered on the adjacent path and not on this one —
`process.ts:446` omits user MCP globs from `plan` mode precisely because
"third-party MCP tools can't be assumed read-only". The branch guard got no equivalent
treatment.

**This is live today with no LemonCrow involved.** It is not a reason to reject either
tool; it is a pre-existing gap that adopting *any* MCP retrieval server would walk
into. It is open question 2 in [requirements.md](requirements.md), which is where all
three adoption-gating questions are held. The fix is a product and security judgement —
whether ShipIt gains a real per-server tool authorization boundary — rather than
anything tool-specific, which is why it outlives the verdict on either tool.

## Reproducing this

Every number here is re-derivable. The harnesses are committed beside this doc.

| File | What it measures |
|---|---|
| `measure.py` | Measurement 1 — response size vs a scripted grep-and-read pass |
| `pair.sh` | One task's baseline and ripwire arms, end-to-end |
| `lcsearch.py` | `Bash`-callable wrapper over LemonCrow's `code_search` MCP tool |
| `lcarm.sh` | One task's LemonCrow arm, reusing the existing baseline run |
| `analyse.py` | Prints the table, subtracting the no-op control |

Environment notes, all of which cost time to discover:

- **Tokenizer.** The container has no tokenizer and `pip install` is refused under
  PEP 668. Use `uv venv` plus `uv pip install tiktoken`. `o200k_base` is a proxy for
  Claude's non-public tokenizer.
- **ripwire.** Take the prebuilt release and verify the published `.sha256`. Do **not**
  run the vendor's `scripts/install.sh`: it copies 19 skills into `~/.claude/skills`
  whenever it finds `~/.claude`, which is right for a person and wrong for a scripted
  run.
- **LemonCrow.** Needs Python 3.12–3.13; the container's is 3.11, so `uv venv
  --python 3.12`. Installing from source omits **`httpx`**, and without it
  `lc mcp` dies in the MCP handshake rather than reporting a missing dependency —
  the symptom is an `initialize` timeout, which looks like a slow index build.
- **The index.** First query builds it and locks the database meanwhile; concurrent
  calls fail with `database is locked`. Warm it once before measuring. It lands at
  888 MB in `/workspace/.lemoncrow/workspace`, gitignored.
- **Sub-agent spawns are capped at 3 per turn.** A 13-run experiment cannot execute in
  one turn. A run that fails with "spawn cap reached" consumed nothing and must be
  retried, never recorded as a result — the first attempt at this lost 12 of 13 runs
  that way.
- **Control run.** Take a no-op agent run and subtract its `contextTokens` (47,858
  here) so fixed per-run overhead is not counted as task work.

## Key files

- `docker/Dockerfile.session-worker.prod` — where a pinned binary would be installed,
  next to the existing `uv` and Gradle stanzas.
- `docker/agent-hooks/block-branch-ops.mjs:70` — the branch guard, which exits unless
  the tool name is literally `Bash`.
- `docker/agent-hooks/managed-settings.json:50` — registers that hook with
  `"matcher": "Bash"`, the second and independent reason an MCP tool name is never
  seen by it.
- `src/server/session/agents/claude/process.ts:448` and `:887` — the two sites that
  grant an enabled MCP server its whole `mcp__<name>__*` namespace.
- `src/client/components/message-tools.tsx:81`, `:99`, `:233` — inline diff and
  command cards, keyed on literal `Edit`, `Write` and `Bash`.
- `src/server/shared/agent-tool-names.ts` — the tool-name catalogue the UI maps.
- `src/server/shipit-docs/` — agent-facing docs, which must be updated if a tool
  reaches session containers.

## Related work

- `docs/294-lemoncrow-mcp-spike/` (in this PR) — the MCP-only spike planning#332 asked
  for: what the installer really does in global mode, LemonCrow's retrieval measured
  against ripwire's, and what its installer really does in global mode. The two
  adoption-gating questions it raised now live in [requirements.md](requirements.md)
  rather than in that doc, so there is one copy of each.
- planning#332 — the original LemonCrow evaluation. Its `docs/255-lemoncrow-runtime-evaluation/`
  pointer resolves on no ref; the issue body is the only surviving record.
- planning#520 (this doc), planning#521 (the spike).
