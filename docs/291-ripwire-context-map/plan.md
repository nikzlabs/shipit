---
issue: planning#520
title: ripwire evaluation and the LemonCrow comparison
description: Measured evaluation of ripwire on ShipIt's own source, why the narrow shape is the only one recommended, and how it compares to the LemonCrow runtime
---

# ripwire evaluation and the LemonCrow comparison

Implements [requirements.md](requirements.md).

[ripwire](https://github.com/redhat-et/ripwire) is a single C++23 binary, Apache-2.0,
from the `redhat-et` organisation. It parses a repository with vendored tree-sitter
grammars for 21 languages, ranks symbols with Personalized PageRank, and prints a
minified XML map. It needs no API key, no embeddings, no index server and no daemon.
It also exposes an MCP server.

**Recommendation: do not adopt it now.** This reverses an earlier draft of this doc,
which recommended baking in a pinned binary and one skill. That recommendation rested
on a token saving that measurement did not support.

The retrieval is accurate — it returns the right symbols with exact line numbers in
about 2.6 s. But accuracy was never the question; the question was whether it saves
an agent work. Measured against real agents on six tasks, it costs **83.5%** of the
baseline, saves about **5% on the median task**, and costs **more on half of them**.
That is too small and too unreliable to justify adding a dependency on a six-week-old
project with one author (req 6, and the project risk below).

What would change this verdict: evidence that the tool can be invoked
*conditionally*, on diffuse multi-file questions only, where it did win clearly. The
blanket "run it first" shape the vendor's skills teach is measurably wrong here.

If it is adopted anyway, the narrow shape still holds — a pinned binary and one
skill, never the vendor's 19 skills, `--test-gate`, or `--doc-drift`.

## Measurements

All numbers below come from release v0.4.0 (linux-x64, checksum verified) run
against `/workspace` at commit `4e120fe5a` on 2026-09-07.

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

#### The observed baseline contradicts the floor

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

**This corrects the floor number above, and nearly inverts it.** The floor said
ripwire costs 16.8% of a grep-and-read pass. Measured against real agents it costs
**83.5%**. The floor was not wrong about what it measured; it was wrong as a proxy
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

The floor measurement is retained above as the conservative bound. Where the two
disagree, **the observed number governs**.

Three things bound how far the number can be pushed:

- **The baseline is a floor.** It allows one grep with a well-chosen keyword, then
  reads only the gold files. A real agent greps several times and reads files that
  turn out to be irrelevant, so the true baseline is higher and the true saving
  larger. That was not measured.
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
  measurement gate — **has since been built and measured** (PR #2685). Two of its
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

## Key files

- `docker/Dockerfile.session-worker.prod` — where a pinned binary would be installed,
  next to the existing `uv` and Gradle stanzas.
- `docker/agent-hooks/block-branch-ops.mjs` — the branch guard that keys on the
  literal `Bash` tool name.
- `src/client/components/message-tools.tsx` — inline diff and command cards, keyed on
  literal `Edit`, `Write` and `Bash`.
- `src/server/shared/agent-tool-names.ts` — the tool-name catalogue the UI maps.
- `src/server/shipit-docs/` — agent-facing docs, which must be updated if the tool
  reaches session containers.
