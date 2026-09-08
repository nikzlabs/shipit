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

**Two ordinary turns, in order** — what a user already gets by pressing compact
and then sending their message:

```
message arrives  →  message QUEUED  →  `/compact` turn  →  drain  →  the user's turn
                                                                     (reset + merge prefix)
```

No new lifecycle state: at every instant the session is running exactly one
ordinary turn, and the message is in the queue.

Both transports make the same decision (req 13). The composer checkbox is the
per-send intent for the typed path only; a programmatic continuation has no
checkbox and follows the global setting, exactly as it already does for the
reset.

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

## What the step actually does — settled in code, three times

The open question this plan named — *can a compaction run in a turn's pre-spawn
phase without the executor treating its completion as the user's turn
finishing?* — was the wrong question, and it took three answers to see that.

**First: a process spawned BESIDE the turn's agent cannot work.** In container
mode the SSE relay resolves every worker event against the proxy currently
installed in the runner's single `_agent` slot and drops the rest
(`container-session-runner.ts`, `isStaleSpawnEvent` and the `(no _agent)` drop).
Such a process would receive no `agent_compacted`, no `done` and no `error`, and
would hang until a timeout — in production, every time, while passing any
in-process test.

**Second: it was run as a nested TURN**, through `executeAgentTurn` with
`postTurn: "none"` + `systemTurn: true`, and then as a nested slot-owning
OPERATION when that proved to carry the whole turn lifecycle into a place none of
it belonged. Five review rounds went into the consequences and they were all one
consequence: **a session mid-phase is in a state nothing else in the orchestrator
has a name for.** `running` is true but no turn is accumulating, so every
side-channel card written during it was recorded against the *previous* turn and
deleted by the next one — a bug fixed narrowly for the compaction's own card and
still open for the other twenty call sites. The session read busy to some
consumers and idle to others, so a predecessor's late `done` could clear
`running` and `shipit session wait` could report ready mid-compaction. Nothing
owned cancellation, so a timeout could not stop a spawn that was still starting.
Each was patchable; each patch taught one more consumer about a phase only this
feature knew existed.

**Third, and what ships: there is no phase.** ShipIt does what a user already
does by hand — press compact, then send the message:

```
user's message arrives on an eligible merged session
   → the message goes on the QUEUE
   → a `/compact` turn runs                        (an ordinary turn)
   → its post-turn drain starts the user's message (an ordinary turn)
      → which runs the docs/218 reset and carries the merge prefix
```

Both are ordinary turns, so `executeAgentTurn` owns their `running`, their
delivery, their readiness, their cancellation, their transcript accumulators and
their persistence — as it owns every other turn's. At every instant the session
is running exactly one turn and the user's message is in the queue, which is a
place the whole system already understands. `preTurnHold` and the admission
checks that read it, the slot-owning operation, its settle latch, its ownership
re-checks, its credential teardown and its persistence bypass are **deleted, not
fixed**: the executor was already doing every one of those jobs correctly.

What is left is a decision (`compact-before-turn.ts`) and two takeovers of four
lines each. Three things are worth naming because they are not free:

- **`silent`** — the one genuinely new field. ShipIt started the compaction turn,
  so it gets no user bubble and no echo. It is a value, not a mechanism: the
  executor already takes `emitUserEcho` and `persistUserMessage` as inputs.
- **`compactContext: false` on the re-queued message** — what stops a loop. The
  session is still merged and still eligible when the message drains, so nothing
  about the *session* would stop a second decision; the flag says the true thing
  instead, that the compaction for this message has already happened.
- **`systemTurn` is inherited by the compaction turn** — mechanically necessary,
  not cosmetic. The outer dispatch has already set `systemTurnInProgress`, and
  `drainNext` refuses to drain while that flag is up unless its own turn is a
  system turn. A compaction that did not inherit the marker ran, ended, and then
  declined to start the very message it was making room for.

`compactAgentOnWorker` (`container-session-runner.ts`) is still **not** the
mechanism: it asks a *resident* agent to compact, which is the mid-turn
`/compact` case, and a session continuing after a merge has nothing resident to
ask.

**Requirement 9 is now structural.** "The turn is never lost because the
compaction did not complete" needs no timeout, no fail-safe outcome and no
notice machinery: the user's message is in the queue, and every terminal path of
the compaction turn drains it — including the ones where the agent process dies
(CLAUDE.md post-turn invariant 2). A compaction that fails is a turn that failed,
and shows its error in the transcript like any other.

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

Both are inherited rather than built, which is the clearest measure of the
sequencing being right.

**Visibility (req 8).** The compaction turn emits `agent_compaction_started` and
the persisted compaction card (docs/178) through the ordinary turn listeners, so
the user sees it start and sees the before/after result — the same thing they see
for a `/compact` they typed. Their own message shows as queued while it runs,
which is the existing "queued behind a running turn" experience.

**Failure (req 9).** "The user's message still runs; the turn is never lost" is
now structural: the message is in the queue before the compaction starts, and
every terminal path of a turn drains the queue — including the ones where the
agent process dies (CLAUDE.md post-turn invariant 2). There is no timeout to
tune, no fail-safe outcome type, and no notice machinery, because there is no
way for a failed compaction to strand the message.

"The transcript says that the compaction did not succeed" is likewise inherited:
a compaction turn that errors persists its error like any other turn. The one
case that is weaker than the nested design's bespoke notice is a backend that
accepts the trigger, exits 0 and compacts nothing (docs/276 req 2's shape): that
now shows as a turn with no compaction card rather than a sentence saying so.
Recorded as a deliberate trade — the requirement is that a failure is never
silent, and an absent card next to a completed turn is not a *claim* of success.

## The step must not fake a user message

The compaction is started by ShipIt, not typed, so it must not persist a user
row or echo a `/compact` bubble to other viewers — the transcript would then
show a command the user never sent. The compaction card is the record; the
bubble is not.

## Key files

| File | Role |
|---|---|
| `orchestrator/compact-before-turn.ts` | **New.** The whole of docs/295's own logic: should this message be preceded by a compaction turn? Gates on the setting, the per-send untick, the harness capability, an armed conversation replay, background work, the docs/282 `unsettled` answer and `isResetEligible`. Fail-safe false. |
| `orchestrator/ws-handlers/send-message.ts` | The interactive takeover: enqueue the user's message with `compactContext: false`, run the `/compact` turn, return. |
| `orchestrator/dispatched-turn.ts` | The same takeover for a continuation the user did not type (req 13), inheriting `systemTurn`. |
| `orchestrator/ws-handlers/agent-execution.ts` | `silent` — no user row, no echo, for a turn ShipIt started. The docs/218 reset stays where it was and now runs on the user's turn, which is what carries the merge prefix (req 7). |
| `orchestrator/session-runner.ts` | `SystemTurnDeps.shouldCompactBeforeTurn` (decision only) and `silent` on the dispatch/queue shape. |
| `orchestrator/prepared-dispatch.ts` | `silent` through the exhaustively-guarded dispatch shape. |
| `shared/types/ws-client-messages.ts` | `compactContext?: boolean` on `WsSendMessage`. |
| `client/components/MessageInput/MessageInput.tsx` | `showCompactControl`, non-sticky checked state, the subordinate control line, the payload flag. |
| `client/utils/send-handler.ts` | Carry `compactContext` (and `resetMergedBranch`) onto the WS message — on the `/review` frame as well as the ordinary one. |
| `client/components/Settings/tabs/AdvancedTab.tsx` | Description of the existing toggle names both actions. |

**Deleted with the nested design**, and worth listing because the deletion is the
point: `pre-turn-compact-hook.ts`, `pre-turn-hold.ts`, `missing-conversation.ts`,
`SessionRunnerInterface.preTurnHold` and its six admission checks, the
`mergeRecheck` hand-off through `SystemTurnDeps.preTurnReset`, and the ownership
publication `runDispatchedTurn` needed to make a pre-turn phase legible.

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
