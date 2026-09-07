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

## What the step actually does — settled in code, twice

The open question this plan named — *can a compaction spawn run in a turn's
pre-spawn phase without the executor treating its completion as the user's turn
finishing?* — took two answers to get right, and the second one is the design.

**A process spawned BESIDE the turn's agent cannot work.** In container mode the
SSE relay resolves every worker event against the proxy currently installed in
the runner's single `_agent` slot and drops the rest
(`container-session-runner.ts`, `isStaleSpawnEvent` and the `(no _agent)` drop).
Such a process would receive no `agent_compacted`, no `done` and no `error`, and
would hang until a timeout — in production, every time, while passing any
in-process test. So the compaction must OWN the slot.

**But owning the slot does not mean being a turn**, and conflating those two was
the mistake. The first implementation ran the compaction through
`executeAgentTurn` with `postTurn: "none"` + `systemTurn: true`, on the grounds
that this is the mode the docs/146 rebase driver uses for "a step inside a larger
operation the driver owns". Those flags do suppress the commit, the push, the PR
flow and the queue drain. They do **not** stop the turn giving up the rest of the
turn lifecycle, and every remaining piece of it is wrong for a maintenance step
nested inside someone else's send:

- it publishes and then clears `activeDeliveryId`, so a dispatched
  continuation's delivery reads as **not in flight** for the compaction's whole
  duration — which is what a redelivery supervisor consults;
- it clears `running`, announces `turn_result`, broadcasts
  `session_agent_finished` and fires the runner's idle event, so `shipit session
  wait` reports the session **ready** and a supervisor reports the work
  **delivered**, before the user's message has run at all;
- it bumps the turn epoch and resets the transcript accumulators, so the
  compaction's own card lands as in-progress rows that the user's turn then
  replaces (the docs/236 failure).

Each of those was found by review and patched individually, and each patch was
another borrow-and-restore of state the executor owns and this step has no
business touching. That is the signal the shape was wrong.

**So the step owns the SLOT and nothing else.** Everything it genuinely needs is
already factored: `prepareAgentEnv` for credentials, `buildRunParams` (with
`compact: true`) for the spawn shape, the adapter's own compaction mapping, and
`emitChatCard` for the docs/178 card. What it does not need — commit, push,
drain, settlement, readiness, delivery identity, transcript accumulation — it now
cannot do **by construction** rather than by a flag someone has to remember.

Two consequences are load-bearing:

- **`running` stays false throughout.** No completion signal is emitted for a
  turn that has not run; and `emitChatCard` therefore takes its already-final
  append path, so the compaction card is durable the moment it is written
  instead of being an in-progress row awaiting a finalization this step would
  have to remember to do.
- **Admission is held by `preTurnHold`** — a new runner flag mirroring docs/288's
  `mergeHold`, checked at the same three admission points. It is taken *before*
  the first await, because the window that needed closing was never the
  compaction itself: the merge probe is a network round-trip and the eligibility
  check reads git, and during those the session was idle by every measure a
  caller consults.

`compactAgentOnWorker` (`container-session-runner.ts:1669`) is still **not** the
mechanism: it asks a *resident* agent to compact, which is the mid-turn
`/compact` case, and a session continuing after a merge has nothing resident to
ask.

**It reports an outcome, never completion.** `agent_compacted` is observed
directly, so a backend that accepts the trigger and does nothing is reported as
`no-compaction` rather than success — docs/276 req 2's standard, applied in both
directions: a compaction that happened counts even if the process then died or
timed out, because the history really was replaced.

**The spawn is raced against the settle latch, not awaited ahead of it.**
`prepareAgentEnv` and `buildRunParams` are awaits the timer cannot interrupt, so
sequencing them first would park the user's message forever on a hung credential
round-trip while the timeout fired into a promise nobody was waiting on.

## Custom compaction instructions — Claude and Grok

A default summary ends with the shipped work's next steps, which is the wrong
emphasis for a session whose work just merged. So the compaction carries a short
post-merge instruction: keep the durable context — user preferences, repo
conventions, unresolved questions — and drop the completed implementation
detail.

**Two harnesses honour it.** Claude passes instructions through to
`/compact <instructions>` (`session/agents/claude/adapter.ts:595`). Grok honours
them too — probed 2026-09-07 at grok 1.0.12 and written up in
[docs/276](../276-headless-compaction-triggers/plan.md#it-does-honour-custom-compaction-instructions-probed-2026-09-07-grok-1012);
it lifts them into a `user_context` field on its compaction request, and an
instructed summary differs from a bare one under a negative control.

Grok needs no adapter change **for this feature**, because this feature always
takes the spawn path. Its trigger is the prompt, so `/compact <instructions>`
delivers the instruction with the text — which is exactly what the probe drove.
`GrokAdapter.compact()` does ignore its argument
(`agents/grok/adapter.ts:1060`), but that method is the *resident, mid-turn*
path, and Grok has no resident process to compact; the method exists only to
warn. A session continuing after a merge is idle, so the step spawns.

**Two do not.** Codex's `thread/compact/start` has no slot for them
(`agents/codex/adapter.ts:525`) and OpenCode's `summarize` route has none either
(`agents/opencode/adapter.ts:853`).

So on **two of four** harnesses the docs/218 prefix is the only thing stopping
the agent continuing the shipped work. That is why req 7 is a requirement rather
than a nicety, and why the prefix must never be reordered ahead of the
compaction as an optimisation — the instruction cannot be relied on to carry
that meaning everywhere.

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
compacts twice — once as the pre-step, once as the command — and resets the
branch for a maintenance command that should trigger neither.

**Both paths that can run a `/compact` classify it**, and that is not
belt-and-braces. `send-message.ts` classifies an IMMEDIATE send. A `/compact`
that had to QUEUE — behind a merge hold, or behind a dispatched turn — drains
somewhere else: an interactive entry through `runQueuedInteractiveMessage`, and
anything dequeued by a dispatched turn's own drain through `runDispatchedTurn`.
Neither knew about the command, so a queued `/compact` ran both pre-turn hooks
and was then handed to the CLI as the literal text behind a `[System] …PR was
merged…` prefix and without the adapter's compaction flag — spending the command
as prose *and* doing the two things it must not.

Both drains now re-derive it with the same `parseCompactCommand` + capability
check the send handler uses. **Re-derived rather than carried as a queue field**,
deliberately: it is derived state — the same parse against the agent that will
actually run the turn — and carrying it would let the queue's copy disagree with
the live answer after a model or agent change.

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
| `orchestrator/pre-turn-compact-hook.ts` | **New.** The shared step: gate on `isResetEligible`, run ONE `postTurn: "none"` + `systemTurn` compaction turn, report its outcome, and carry a failure notice. Sibling of `pre-turn-reset-hook.ts`. |
| `orchestrator/ws-handlers/agent-execution.ts` | Call the step before `applyPreTurnReset`; pass the per-send intent. The pre-turn steps and the agent resolution move BELOW the executor deps — the compaction is a turn, so it needs them, and it takes the agent slot the turn's own proxy used to occupy by then. |
| `orchestrator/dispatched-turn.ts` | Call the step before `deps.preTurnReset`, once per message, with the same `postTurn: "none"` exclusion (req 13). |
| `orchestrator/runner-registry-factory.ts` | Wire the step into `SystemTurnDeps` beside `preTurnReset`. |
| `orchestrator/session-runner.ts` | `SessionRunnerInterface.preTurnHold` (the admission hold, mirroring `mergeHold`), `SystemTurnDeps.preTurnCompact`, a `{ compact }` options argument on `buildRunParams` (the pre-turn compaction runs on dispatch-shaped deps and has no closure of its own to set the flag on), and `resetMergedBranch` / `compactContext` on `AgentDispatchOptions` + `QueuedMessage` so the composer's per-send intent survives the queue. |
| `orchestrator/turn-executor.ts` | `TurnInput.compact`, forwarded to `buildRunParams`. |
| `orchestrator/pre-turn-reset-hook.ts` | Accepts the merge recheck's answer instead of always probing for itself, so both gates read one snapshot. |
| `orchestrator/prepared-dispatch.ts` | The two new per-send fields, carried through the exhaustively-guarded dispatch shape. |
| `shared/types/ws-client-messages.ts` | `compactContext?: boolean` on `WsSendMessage`. |
| `client/components/MessageInput/MessageInput.tsx` | `showCompactControl`, non-sticky checked state, the subordinate control line, the payload flag. |
| `client/App.tsx` | Carry `compactContext` from the composer payload onto the WS message. |
| `client/components/Settings/tabs/AdvancedTab.tsx` | Description of the existing toggle names both actions. |

## Risks

- ~~**The executor assumes one spawn per turn.**~~ Settled before implementation:
  it does, which is why the compaction is a `postTurn: "none"` + `systemTurn`
  TURN rather than a bare pre-spawn spawn. See "What the step actually does".
- **Stop does not reach the compaction.** `handleInterruptAgent` interrupts
  `runner.getAgent()`, and during the compaction that is the compaction's own
  process — so stop does reach it, but the user's message then runs anyway
  rather than being cancelled with it. The compaction is bounded at 300 s and
  killed on timeout, so the turn can never be lost (req 9); cancelling the
  whole send from inside the compaction is not something any requirement asks
  for, and is deliberately not built.
- **The wait is visible.** Compaction measured 27.7 s on a 22k-token context
  (docs/178) and grows with the context; the user pays it before their turn
  starts. It is spent under the compaction card rather than in silence, and the
  checkbox is there to untick. Requirement 3 rules out shortening it with a size
  gate. On a programmatic continuation nobody is waiting, so the cost is lower
  there — but so is the supervision, which is why req 13 includes it.
- ~~**Grok's instruction handling is unverified.**~~ Settled 2026-09-07: Grok
  honours them, and the spawn path this feature uses delivers them (docs/276).
  This risk is closed, and the post-merge instruction now reaches two harnesses
  rather than one.
