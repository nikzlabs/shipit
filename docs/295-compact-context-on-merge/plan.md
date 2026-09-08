---
issue: planning#522
title: Compact the context when a merged session continues
description: A merged session compacts its context before the next turn — offered as a second composer checkbox, on typed and programmatic continuations alike — so it starts the next slice with a clean context as well as a clean tree.
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
message arrives on an eligible merged session
   → the message goes on the QUEUE
   → a `/compact` turn runs                          (an ordinary turn)
   → its post-turn drain starts the user's message   (an ordinary turn)
      → which runs the docs/218 reset and carries the merge prefix
```

No new lifecycle state: at every instant the session is running exactly one
ordinary turn and the message is in the queue. `executeAgentTurn` owns both
turns' `running`, delivery, readiness, cancellation, transcript accumulators and
persistence, as it owns every other turn's.

Both transports make the same decision (req 13), for the planning#333 reason:
docs/218 scoped its reset to the interactive path, and an Agent Interface SDK
click, a `shipit session message` and a notify-on-merge wake then all continued
on a branch still sitting on merged commits. The composer checkbox is the
per-send intent for the typed path only; a programmatic continuation has no
checkbox and follows the global setting, exactly as the reset does.

## The pieces

- **The decision** — `compact-before-turn.ts`, `shouldCompactBeforeTurn`. Gates,
  in order: the per-send untick (req 5), the shared setting (req 11), the
  harness capability (req 10), an armed conversation replay (the next spawn
  consumes it read-and-clear, so a compaction turn would take the seed), a
  resident holding background work (docs/260 req 13), the docs/282 merge
  recheck's `unsettled` answer (the reset stands down on it, and a compaction
  without the reset's prefix loses req 7), and finally `isResetEligible` — the
  same predicate that offers the reset checkbox (reqs 1, 3, 13). Fail-safe
  false throughout (req 9).
- **Two takeovers** — `ws-handlers/send-message.ts` for a typed send (and,
  through the same `runCompactionAhead` helper, the WS queue drain for a
  message that queued behind another turn), `dispatched-turn.ts` for a
  continuation the user did not type. Each puts the message at the **front** of
  the queue — it was next and stays next, so an entry queued earlier cannot
  overtake it — with `compactContext: false`, which says the true thing that
  stops a loop: the compaction for this message has already happened, while the
  *session* stays eligible. Then it runs the `/compact` turn as a **system
  turn**: a send arriving meanwhile queues behind it instead of being steered
  into the compaction process (which would run it before the message it
  overtook, without that message's reset). `systemTurnInProgress` is held from
  the moment the decision starts — an idle resident streaming process would
  otherwise take a send arriving mid-decision — and released if the answer is
  no. The compaction's own drain is the one interactive drain allowed to run
  under the flag, and it is also what **clears** it: a streaming compaction
  reuses the resident process, and the turn that follows strips its listeners
  before the `done` that would have cleared it in `finishTurn`. The dispatched
  takeover runs before attachment resolution (the drain redoes it) and excludes
  `postTurn: "none"` for the reset's reason: a rebase-resolution turn is a step
  inside a git operation, and compacting there would summarise away the
  conflict context.
- **`silent`** — the one new field on the dispatch shape (and, because the
  queue narrows nothing, on the queue shape). ShipIt started the compaction
  turn, so it gets no user bubble and no user row; the compaction card is the
  record. A value, not a mechanism: the executor already
  takes `emitUserEcho` and `persistUserMessage` as inputs.

## Ordering, and why the merge notice survives (req 4, req 7)

The docs/218 reset runs on the **user's** turn, after the compaction. Its
`[System] …PR was merged…` prefix is built after the summary exists and is
handed only to the turn that carries the user's message, so it cannot be
absorbed into the summary. Reversed, the agent would start holding a paraphrase
of the warning instead of the warning. The compaction turn is a `/compact`, so
it skips the reset and every prefix, as a typed `/compact` already did.

The user's turn resumes the right agent session: `buildRunParams` reads
`agentSessionId` fresh from the database at spawn time, not from the id captured
when the handler started.

## Custom compaction instructions

The `/compact` carries a short post-merge brief: keep the durable context (user
preferences, repo conventions, unresolved questions), reduce the shipped work to
a statement of what it changed. Claude passes instructions through to `/compact
<instructions>`; Grok lifts them into `user_context` (probed 2026-09-07 at grok
1.0.12, [docs/276](../276-headless-compaction-triggers/plan.md)). Codex's
`thread/compact/start` and OpenCode's `summarize` have no slot and ignore them.
On those two the docs/218 prefix is the only thing stopping the agent continuing
the shipped work — which is why req 7 is a requirement, not a nicety.

## The per-send intent (req 5, req 6)

The wire path mirrors `resetMergedBranch` field for field:
`WsSendMessage.compactContext?: boolean`, set only when the control was shown,
non-sticky, never persisted, read independently of its sibling. Both flags ride
the queue (`QueuedMessage`, `AgentDispatchOptions`), so an untick made while a
turn was running still applies when the entry drains — including on the
`/review` frame, which composes its own prompt.

## A typed `/compact` is still one compaction (req 12)

`send-message.ts` classifies an immediate `/compact`. One that had to queue
drains elsewhere — `runQueuedInteractiveMessage` or `runDispatchedTurn` — and
both re-derive the command from the text with the same parse and capability
check, so it skips the reset and the prefixes and reaches the adapter with the
compaction flag. Re-derived rather than carried on the entry, because it is
derived: the same parse against the agent that will run it.

## Visibility and failure (req 8, req 9)

Mostly inherited. The compaction turn emits `agent_compaction_started` and the
persisted compaction card (docs/178) through the ordinary turn listeners; the
user's message shows as queued while it runs. A failed compaction is a failed
turn: its error persists like any other, and every terminal path of a turn
drains the queue — including the ones where the agent process dies (CLAUDE.md
post-turn invariant 2) — so the message is never lost. Two cases needed a line
each:

- **Stop during the compaction** stops the compaction; the message it ran ahead
  of still runs. The WS drain normally clears the queue after an interrupt (the
  user stopped *their* turn); after the compaction turn it does not. This rides
  the turn's terminal event; a streaming CLI that answers a stop with neither a
  result nor an exit leaves the session as it leaves any stopped streaming turn
  today — nothing drains until the process ends.
- **A compaction turn that ends with no compaction card** — stopped before any
  output, or a backend that accepted the trigger, exited 0 and compacted
  nothing — gets a persisted `warn` notice from the turn's drain,
  `noteMissedCompaction`, so the failure is never silent on reload either.

**A dispatch's settlement is its own.** A continuation dispatched onto an
eligible session has the compaction run inside its dispatch's lifetime, so the
dispatch's `turn_result` latch (which tells *interrupted* — do not redeliver —
from *dropped* — redeliver) ignores a compaction's result unless the dispatch
asked for one, and for a delivery counts a result only while `activeDeliveryId`
is its own. Without that, a runner disposed after the compaction but before the
continuation ran reported it delivered.

**The runner stays reserved through the handoff.** `tryDrain` clears `running`
before the compaction's drain dequeues the continuation, whose own setup (the
decision, attachments, the branch reset) then runs for a while. `runDispatchedTurn`
publishes `running`, `systemTurnInProgress`, `activeDeliveryId` **and the turn
identity (`turnEpoch`)** at entry — `dispatchOnRunner` already did the flags for
a turn started from idle; the drains did not — and restores the flags on a setup
throw. The identity is what makes the reservation hold against the predecessor:
its late `done` reads `turnIsCurrent()` before clearing `running` or the
system-turn flag, and the reservation has no agent in the slot yet. And `systemTurnInProgress` describes the
*current* turn: the executor assigns it for every turn at start, and a turn's
`finishTurn` clears it only while that turn is still current. Before that, a
one-shot compaction's `done` — landing while its drain awaited the commit, so
the successor's spawn superseded nothing — cleared the flag a queued wake had
just published.

**Known trades.** A worker probe (`verifyRunningState`, run when a second send
arrives) that finds no agent on the worker while a turn is still in its pre-spawn
setup reads that turn as stuck and abandons it; the setup window has always
included the branch reset, and the decision adds to it — a general property of
the probe, not of this feature. An orchestrator restart mid-compaction adopts
the surviving compaction process without its system-turn marker, as adoption
does for every turn. The takeover queues the send's raw inputs (the drain resolves
uploads, so queuing the resolved copies too handed the file to the agent twice —
main's merge-hold re-check did the same and is fixed alongside). The queued
message lives in the in-memory queue for the length of the compaction, as any
queued message does; an orchestrator restart in that
window loses it — the same window a user who presses compact and then sends has
today. And the queue has never carried `userReview` (review-card metadata), so
a review submitted on an eligible session runs as its prompt but persists
without the card — the same loss a review queued behind a merge hold has today.

## The composer control (req 1, req 2, req 3, req 10)

```
showCompactControl = showResetControl && supportsCompaction
```

Offered whenever the reset control is, so req 11's single setting governs both
with no second gate. Nothing gates on context size (req 3). Placed as a
subordinate second line inside the existing control block — one line, no
description — so the block that appears at the moment the user wants to type
does not double in weight. Both tick states re-tick on send and on a session
switch, so an untick never rides a later message or another session.

## The shared setting (req 11)

No new setting. `autoResetMergedBranch` governs both actions; the Settings →
Advanced description names both.

## Key files

| File | Role |
|---|---|
| `orchestrator/compact-before-turn.ts` | The decision, the post-merge `/compact` prompt, `noteMissedCompaction`. |
| `orchestrator/ws-handlers/send-message.ts` | The interactive takeover. |
| `orchestrator/dispatched-turn.ts` | The dispatched takeover (req 13); `/compact` re-derived on the drain (req 12). |
| `orchestrator/ws-handlers/agent-execution.ts` | `decideCompactBeforeTurn` + `runCompactionAhead` (shared by the send handler and the WS drain); `silent`, `systemTurn`; the compaction turn's drain exemptions and `noteMissedCompaction`; `/compact` re-derived on the WS drain (req 12). |
| `orchestrator/session-runner.ts`, `prepared-dispatch.ts` | `shouldCompactBeforeTurn` dep; `compactContext` / `resetMergedBranch` on the queue shape, `silent` on the dispatch shape; the delivery-aware `turn_result` latch. |
| `orchestrator/turn-executor.ts` | `TurnInput.compact`, passed to `buildRunParams` for the dispatched path. |
| `shared/types/ws-client-messages.ts` | `compactContext?: boolean`. |
| `client/components/MessageInput/MessageInput.tsx` | The control, its tick state, the payload flag. |
| `client/utils/send-handler.ts` | Carries the flag, on the `/review` frame too. |
| `client/components/Settings/tabs/AdvancedTab.tsx` | Description names both actions. |

## Risks

- **The wait is visible.** Compaction measured 27.7 s on a 22k-token context
  (docs/178) and grows with the context; the user pays it before their turn
  starts, under the compaction card, with the checkbox there to untick. Req 3
  rules out shortening it with a size gate.
- **Stop reaches the compaction, not the send.** Interrupting during the
  compaction stops that turn; the queued message then runs. Cancelling the
  whole send from inside the compaction is not something a requirement asks for.
- **A refused reset compacts again next time.** Eligibility is the composer's
  own signal, so while a reset keeps being refused (no network, say) the box
  keeps appearing ticked and each message compacts first. Consistent with what
  the user sees; untick to skip.
