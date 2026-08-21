---
issue: planning#457
title: Headless compaction triggers for OpenCode and Grok Build
description: Both harnesses DO support on-demand compaction headlessly — Grok in-band like Claude, OpenCode over its server's summarize route. The evidence, and what it took to find it.
---

# 276 — Headless compaction triggers

Implements [requirements.md](./requirements.md). Extends
[docs/178 — Context Compaction](../178-context-compaction/plan.md), which built
the `/compact` composer path and the compaction card, to OpenCode
([docs/268](../268-opencode-harness/plan.md)) and Grok Build
([docs/274](../274-grok-build-harness/plan.md)).

## Result

**Both harnesses support it. Both were declared `false`.** The old comments —
"`opencode run` has no on-demand compaction trigger" and "no on-demand trigger
found" — overstated a search that had not been run against the CLIs (req 4).
Both now declare `supportsCompaction: true`.

| | Grok Build 1.0.1 | OpenCode 1.18.18 |
|---|---|---|
| Trigger | **in-band** — `/compact` in the prompt | **HTTP** — `POST /session/{id}/summarize` |
| Shape it matches | Claude (slash command in the prompt) | neither; a third shape |
| Reached from `run`? | yes — the prompt IS the trigger | **no** — needs a server |
| Adapter work needed | event mapping only | a transient `opencode serve` |
| Context before → after | 19,585 → 10,335 tokens | 16,867 → 6,262 tokens |

Both figures are probe turns through the **real adapters** against the real
CLIs, on freshly built sessions.

## Requirement 2 is the whole point

Each CLI has a plausible-looking trigger that exits 0 and does nothing. Either
would have been reported as support by a probe that checked only the exit code.

- **OpenCode `--command compact`** dispatches — the debug log even prints
  `message=command command=compact` — and then throws. It fails **identically**
  to `--command __definitely_bogus__`, same `UnknownError` at the same
  `SessionPrompt.command` frame. `--command` resolves *registered* commands
  only; `compact` is not one. The control that proves the flag itself works is
  `--command init`, which is registered and succeeds.
- **OpenCode `/compact` as the prompt** exits 0 and produces no assistant text,
  which reads like interception. It is not: the session store shows it recorded
  as an ordinary user message, the full history still went to the model, and no
  compaction marker exists. It reaches the model verbatim and burns a turn.
- **The v2 route `POST /api/session/{id}/compact`** is in OpenCode's OpenAPI
  document — the obvious modern choice — and returns
  `503 "Session compact is not available yet"`. Declared, not implemented.
  This unimplemented route is the likeliest source of the `/compact` string in
  the binary that prompted this investigation.

The measurements that do count: a probe turn's reported context across the
call, and — for OpenCode — a recording proxy standing in for the model, which
showed the three pre-compaction turns **absent** from the next request and
replaced by a summary produced by OpenCode's own "context summarization agent".

## Grok: in-band, like Claude

`/compact` in the prompt is intercepted by the CLI in headless mode. Verified
through `--prompt-file` (how this adapter passes every prompt, not just `-p`)
and with `prefixPromptWithNotice`'s trailing notice appended, which does not
break the parse.

Two negative controls prove interception rather than a lucky reply:
`/__definitely_bogus__` and `/compact-mode` both run as **ordinary prompts**
(full `usage` block, model answers "ok"), while `/compact` alone returns empty
text with **no usage block at all** — no model call was billed as a turn.

Corroboration in the session store, which is independent of the wire:
`compaction_requests/<id>.json` records `"trigger": "manual"` with the
summarization prompt appended to the captured history, and
`compaction_checkpoints/<id>.json` holds a `compacted_history` whose transcript
has been replaced by a "This session is being continued from a previous
conversation…" summary.

The CLI also **advertises** the command: `system/init` carries
`slash_commands: ["compact", …]`, and `--output-format streaming-json` emits an
`available_commands` event listing it. A future probe should check that list
before re-deriving any of this.

### The wire event is Claude's, and its `trigger` field lies

Grok emits `system` / `subtype: "compact_boundary"` with `compact_metadata` —
byte-for-byte Claude's shape. It fills fewer fields (`pre_tokens` only; no
`post_tokens`, no `duration_ms`), so the card degrades to what it has.

**`compact_metadata.trigger` is always `"auto"`**, including on a compaction
ShipIt explicitly requested — the same runs that wrote `"trigger": "manual"`
into their own `compaction_requests/` record reported `"auto"` on the wire. The
adapter therefore labels by correlation with `params.compact`, exactly as the
Codex adapter does for a backend that reports no trigger at all, and
deliberately never reads the field. `adapter.test.ts` pins this against a real
captured boundary line.

Grok emits no *progress* event (nothing answering Claude's
`status: "compacting"`), so the adapter emits `agent_compaction_started` itself
when it starts a compaction spawn — it knows it asked.

## OpenCode: a transient server

The trigger is the server's documented `POST /session/{id}/summarize`
(opencode.ai/docs/server → "Summarize the session"), which needs a running
server; ShipIt's adapter spawns one `opencode run` per turn and nothing lives
between turns. So `run({ compact: true })` spawns a short-lived
`opencode serve`, makes one call, and kills it —
`session/agents/opencode/compaction.ts`.

Three details that are easy to get wrong:

- **The port must be parsed from the server's own readiness line.** `--port 0`
  documents itself as random and actually resolves to OpenCode's fixed default
  4096; it falls back to a real ephemeral port *only* when 4096 is taken
  (verified: a second concurrent server came up on 34439). A hard-coded 4096
  would work on a clean box and fail exactly when a user already has OpenCode
  running.
- **The server needs the turn's config and env**, not a bare spawn:
  `OPENCODE_CONFIG` carries the `shipit` provider block and the credential is
  delivered in the env. The route rejects a body without
  `providerID`/`modelID` (`400 Missing key ["providerID"]`), and summarizing is
  a real model call that has to be billed somewhere.
- **Success is the body `true`, not HTTP 200.** A 200 with any other body is the
  server accepting the request and declining the work — which must never be
  rendered as a "Context compacted" card, the exact failure req 2 exists to
  rule out.

Compaction here reports no token figures and no duration, so the card degrades
to a bare "Context compacted" row, the same as Codex's.

## Routing: neither harness needs a resident process

`send-message.ts` routes `/compact` two ways: to `agent.compact()` when a turn
is in flight, and to a fresh `run({ compact: true })` otherwise. Both harnesses
are one spawn per turn with `supportsSteering: false`, so the spawn path is the
one that matters and it is the path that works. Each adapter's `compact()`
therefore warns and no-ops rather than throwing — mirroring the Claude
adapter's non-streaming branch, because a best-effort mid-turn compaction must
not tear down the turn it was asked about.

**The OpenCode compaction spawn settles the turn itself.** It starts no
long-lived `this.proc` whose `exit` would synthesize `agent_result`, and the
orchestrator's whole post-turn sequence — the local commit above all (CLAUDE.md
post-turn invariant 2) — hangs off that event. Every exit path in
`runCompaction`, including the two refusals that never reach the server (no
session, no model), emits exactly one `agent_result`; a quiet return would
strand the session `running` forever. `adapter.test.ts` pins each path.

**And `this.proc` being unset is exactly why the compaction server needs its own
handle.** `kill()` and `interrupt()` both key off `this.proc`, so a compaction
was deaf to both for the entire 300s summarize window — the user pressing stop
did nothing at all. `compactionProc` is a second handle with that one job:
killing the server aborts the in-flight request, which rejects and settles the
turn through the ordinary failure path. The settle is idempotent because a kill
can race the response, and a duplicate terminal event damages the post-turn
sequence as surely as a missing one.

## Key files

- `shared/catalogue/harnesses.ts` — both `supportsCompaction` rows, with the
  evidence and the failed approaches recorded inline.
- `session/agents/grok/adapter.ts` — `compactionRequested`, the
  `compact_boundary` mapping, `compact()`.
- `session/agents/grok/stream.ts` — `compact_metadata` on `GrokEvent`.
- `session/agents/grok/__fixtures__/compact-boundary-grok-4.20.ndjson` — a real
  captured manual-`/compact` stream.
- `session/agents/opencode/compaction.ts` — the transient server + summarize.
- `session/agents/opencode/adapter.ts` — `runCompaction`, `compact()`.

## This is upstream-drift territory

Every claim here is about a CLI ShipIt pins and does not control, which is what
the docs/272 verification recipe exists for. The version-sensitive ones, in the
order they are likely to change:

- OpenCode's v2 `/api/session/{id}/compact` is **expected to land**. When it
  does it is the better route — no provider/model in the body — and
  `compaction.ts` should move to it. Re-probe for the 503 before assuming.
- OpenCode's `--command` could start resolving built-in commands, which would
  make `--command compact` work and remove the need for a server entirely.
- Grok's `compact_metadata.trigger` could start reporting `"manual"` honestly.
  The correlation stays correct either way; the test forbids trusting the field,
  not the field being right.

Re-probing is cheap and the negative controls above are the method: compare the
candidate trigger against a deliberately bogus one, and measure the context, not
the exit code.
