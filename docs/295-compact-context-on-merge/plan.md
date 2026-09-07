---
issue: planning#522
title: Compact the context when a merged session continues
description: A shared pre-turn compaction step, offered as a second composer checkbox, so a merged session starts the next slice with a clean context as well as a clean tree — on typed and programmatic continuations alike.
---

# 295 — Compact the context when a merged session continues

Implements [requirements.md](./requirements.md). Extends
[docs/218 — Auto-update a merged session's branch to latest base](../218-auto-reset-merged-branch-on-continue/plan.md)
and reuses the compaction primitive from
[docs/178 — Context Compaction](../178-context-compaction/plan.md), which
[docs/276](../276-headless-compaction-triggers/plan.md) extended to all four
harnesses.

## Shape

A **shared pre-turn compaction step**, sitting immediately in front of the
docs/218 reset and called from the same two places the reset is called from:

```
compaction  →  branch reset  →  prompt assembly (with the merge prefix)  →  spawn
```

Both transports call both hooks (req 13). The composer checkbox is the per-send
intent for the typed path only; a programmatic continuation has no checkbox and
follows the global setting, exactly as it already does for the reset.

**This shape is chosen because of planning#333.** docs/218 scoped its reset to the
interactive path and wrote the wiring inline in `agent-execution.ts`, with "if
we later want programmatic continues to reset too, factor a shared helper then."
Later came: an Agent Interface SDK click, a `shipit session message`, and a
notify-on-merge wake all reached `runDispatchedTurn`, which had none of it, and
the agent worked on a branch still sitting on already-merged commits. Requirement
13 puts this feature in that same position on day one, so it starts shared rather
than being factored out after the same bug.

## Ordering, and why the merge notice survives (req 4, req 7)

The compaction runs **before** the reset, and both run before the prompt is
assembled. That is what protects req 7.

`buildAgentPrefix` (`services/pre-turn-reset.ts:1027`) tells the agent its pull
request merged and that it must not re-apply the shipped work. The prefix is
produced by the reset hook and prepended to the turn's prompt, so it enters the
context **after** the compaction has already produced its summary. The notice
cannot be absorbed into that summary, because it did not exist when the summary
was written.

Reverse the two and the feature breaks quietly: the compaction would summarise a
conversation that ends with a merge notice, and the agent would start the turn
holding a paraphrase of the warning instead of the warning.

The interactive path already refuses to mix the two for exactly this reason.
`runAgentWithMessage` skips the reset when `opts.compact` is set
(`ws-handlers/agent-execution.ts:442`), with the reason at the call site: the
`[System] …PR was merged…` prefix would derail a compaction, because the agent
reacts to the merge notice instead of compacting. This design keeps that
separation — the compaction spawn carries no prefix, and the prefix rides only
the real turn.

**The turn resumes the right agent session.** A compaction can leave the backend
on a new agent session id, and a stale id would resume the pre-compaction
conversation and throw the whole compaction away. This is safe here, verified at
`ws-handlers/agent-execution.ts:594`: `buildRunParams` reads `agentSessionId`
**fresh from the database** at spawn time rather than reusing the id captured
when the handler started.

## What the step actually does

An idle session has no resident agent, so the compaction needs a spawn of its
own. `compactAgentOnWorker` (`container-session-runner.ts:1669`) is **not** the
mechanism here — it asks a *resident* agent to compact, which is the mid-turn
`/compact` case. Between turns there is nothing resident to ask.

So the step performs one compaction spawn — the `run({ compact: true })`
semantics of `session-agent-run-params.ts:237`, which each adapter maps to its
own trigger (Claude and Grok in-band, Codex `thread/compact/start`, OpenCode's
transient `summarize` server) — and awaits it before returning.

**The one thing implementation must verify in code:** that the compaction spawn's
completion is not mistaken by the turn executor for the user's turn finishing.
The step runs inside the turn's pre-spawn phase, and the executor's terminal
handling (`agent_result`, the `done` path, the post-turn commit sequence) is
built around one spawn per turn. This is named as a risk rather than asserted as
safe, because nothing in the shipped code proves it today.

## Custom compaction instructions — Claude only

A default summary ends with the shipped work's next steps, which is the wrong
emphasis for a session whose work just merged. Claude accepts custom
instructions (`session/agents/claude/adapter.ts:595` passes them through to
`/compact <instructions>`), so the compaction carries a short post-merge
instruction: keep the durable context — user preferences, repo conventions,
unresolved questions — and drop the completed implementation detail.

The other three do not honour it. Codex's `thread/compact/start` has no slot for
it (`agents/codex/adapter.ts:525`), and OpenCode's `summarize` route has none
either (`agents/opencode/adapter.ts:853`). Grok's trigger is in-band so the text
reaches the CLI, but whether it honours arguments is **unverified** and must not
be assumed.

So on three of four harnesses the docs/218 prefix is the **only** thing stopping
the agent continuing the shipped work. That is why req 7 is a requirement rather
than a nicety, and why the prefix must never be reordered ahead of the
compaction as an optimisation.

## The per-send intent (req 5, req 6)

The wire path mirrors `resetMergedBranch` field for field:

- `WsSendMessage.compactContext?: boolean`
  (`shared/types/ws-client-messages.ts`) — set only when the control was shown;
  non-sticky, never persisted.
- Carried into `runAgentWithMessage`'s options beside the existing
  `resetMergedBranch`.

The two flags are read independently (req 6): unticking either does not change
what the other does.

Unlike the reset, the compaction is **not** re-validated server-side. The reset
earns its server-side gate because it destroys committed work; a compaction
destroys no repository state, and the client sends the flag only when it showed
the control. A second gate would only give two answers that could disagree.

## Programmatic continuations (req 13)

The dispatched path takes the same two hooks, in the same order, at the place
the reset already runs: `runDispatchedTurn` calls `deps.preTurnReset` before
prompt assembly, once per dispatched message, **outside `runOnce`** so a
no-result retry neither re-resets nor re-emits (`dispatched-turn.ts:241`). The
compaction step inherits both properties — once per message, not once per
attempt. A retried turn must not compact twice.

It also inherits the **one exclusion**: `postTurn: "none"`. That marks a turn
that is a step inside a git operation the driver owns — docs/146
rebase-conflict resolution — not a continuation of the session's work.
Compacting there would summarise away the conflict context the agent is holding
precisely to finish the rebase.

No intent is passed on this path, so the global setting alone decides — which is
what the checkbox reflects when it is ticked.

## The composer control (req 1, req 2, req 3, req 10)

`client/components/MessageInput/MessageInput.tsx` already computes
`showResetControl = resetEligible && autoResetMergedBranch` and holds
`resetChecked` in non-sticky state that re-checks whenever the control
reappears. The compaction control is the same pattern:

```
showCompactControl = showResetControl && supportsCompaction
```

`supportsCompaction` for the active agent is already on the client
(`MessageInput.tsx:854`, where it gates the `/compact` autocomplete entry), so
req 10 needs no new plumbing.

**Nothing gates on context size.** Requirement 3 forbids a token or percentage
threshold, so `showCompactControl` reads no usage state at all.

**Placement: a second line inside the existing control block**, subordinate to
"Start from the latest base" rather than an equal-weight second row. The block
already sits inside the composer border as its top row (docs/218 placement B),
so the input's corners still never change. Two equal rows would double the
weight of a block that appears at the exact moment the user wants to type.

## The shared setting (req 11)

No new setting. `autoResetMergedBranch` governs both actions, so when it is off
neither control is offered — which falls out of `showCompactControl` deriving
from `showResetControl`. The Settings → Advanced row
(`client/components/Settings/tabs/AdvancedTab.tsx:166`) keeps its toggle and its
title; its description grows to name both actions.

## A typed `/compact` is still one compaction (req 12)

The intent flag and the `/compact` command can arrive on the same send: the
control is on screen and the user types `/compact`. Without a guard, that send
compacts twice — once as the pre-step, once as the command.

So the pre-step is suppressed when the send is already a compaction request.
`send-message.ts` computes `isCompactRequest` before anything else runs, and the
step reads it. The reset is already suppressed for that same send by the shipped
`opts.compact` skip, so both halves of req 12 come from one condition.

## Visibility and failure (req 8, req 9)

Visibility is inherited. The compaction spawn emits `agent_compaction_started`
and the persisted compaction card (docs/178), so the user sees it start and sees
the before/after result in the transcript — no new card type, no new persistence
work.

Failure must be **visible**, not merely survivable, or a user who ticked the box
cannot tell a compaction that worked from one that did nothing. The step reports
its outcome rather than its completion, and two shapes have to be
distinguished:

- the compaction **errored** — say so;
- the compaction produced **no compaction event at all** — a backend that
  accepted the trigger and did nothing. docs/276 req 2 is the precedent: a
  command that exits successfully while doing nothing does not count as a
  compaction and must not be reported as one.

Either way the user's turn still runs (req 9). The notice reuses the docs/218
skip-notice path (`emitNoticeInTurn` / `emitNoticePostTurn` in
`chat-card-persistence.ts`), which already anchors a one-line explanation at its
true transcript position.

## The step must not fake a user message

The compaction is started by ShipIt, not typed, so it must not persist a user
row or echo a `/compact` bubble to other viewers — the transcript would then
show a command the user never sent. The compaction card is the record; the
bubble is not.

## Key files

| File | Change |
|---|---|
| `orchestrator/pre-turn-compact-hook.ts` | **New.** The shared step: decide, spawn one compaction, await it, report the outcome. Sibling of `pre-turn-reset-hook.ts`. |
| `orchestrator/ws-handlers/agent-execution.ts` | Call the step before `applyPreTurnReset`; pass the per-send intent. |
| `orchestrator/dispatched-turn.ts` | Call the step before `deps.preTurnReset`, once per message, with the same `postTurn: "none"` exclusion (req 13). |
| `orchestrator/runner-registry-factory.ts` | Wire the step into `SystemTurnDeps` beside `preTurnReset`. |
| `shared/types/ws-client-messages.ts` | `compactContext?: boolean` on `WsSendMessage`. |
| `client/components/MessageInput/MessageInput.tsx` | `showCompactControl`, non-sticky checked state, the subordinate control line, the payload flag. |
| `client/components/Settings/tabs/AdvancedTab.tsx` | Description of the existing toggle names both actions. |

## Risks

- **The executor assumes one spawn per turn.** Named above; the pre-spawn
  compaction is the part of this design that is not proven by shipped code, and
  it is the first thing implementation should establish.
- **The wait is visible.** Compaction measured 27.7 s on a 22k-token context
  (docs/178) and grows with the context; the user pays it before their turn
  starts. It is spent under the compaction card rather than in silence, and the
  checkbox is there to untick. Requirement 3 rules out shortening it with a size
  gate. On a programmatic continuation nobody is waiting, so the cost is lower
  there — but so is the supervision, which is why req 13 includes it.
- **Grok's instruction handling is unverified.** Treat it as not honoured until
  someone probes it, exactly as docs/276 req 4 requires.
