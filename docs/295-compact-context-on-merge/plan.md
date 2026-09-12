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
`WsSendMessage.compactContext?: boolean`, non-sticky, never persisted, read
independently of its sibling. Both flags ride the queue (`QueuedMessage`,
`AgentDispatchOptions`), so an untick made while a turn was running still
applies when the entry drains — including on the `/review` frame, which composes
its own prompt.

**The untick belongs to the message, and only that message leaving clears it.**
It shipped as two `useState(true)` flags re-armed by an effect keyed on the
control becoming visible, and carried on the wire only while the control was
visible. Both halves discarded a deliberate untick, silently and in the
compacting direction, because an **omitted** `compactContext` means "follow the
global setting" and the setting is on:

- Eligibility is recomputed between turns by several server paths — the
  activation, post-turn and merge-detected emitters, the debounced file-change
  recompute in `reset-eligible-watch.ts` (which requires `mergedAt` and skips
  while a turn runs), the dispatched post-turn path in
  `runner-registry-factory.ts`, and the direct emitters in
  `pre-turn-reset-hook.ts` and `api-routes-git.ts`. `computeResetEligibility`
  **fails closed**: a git read that throws answers `false` for a session that is
  perfectly eligible. One such `false`, for a reason that never reaches the
  user, re-ticks the box on the way back to `true`; and a send made while the
  control is still away carries no intent at all, which falls back to the global
  setting.
- **Component state does not outlive the composer, and the untick was the only
  thing on it that did not.** `AppLayout` renders the chat panel into a Fragment
  on mobile and a `div` on desktop, so any `isMobile` flip destroys and rebuilds
  the subtree; App's `{(showHarnessOnboarding || !showHomeScreen ||
  showNewSessionView) && …}` wrapper drops the composer whenever `showHomeScreen`
  turns true; and a page reload remounts it outright. (A WebSocket reconnect does
  **not** — `App.tsx` keeps the composer mounted and only changes its `disabled`
  prop.) Through all of those the draft text and the attachment chips came back
  from their own stores, so the composer looked untouched while a checkbox had
  quietly gone back to blue, with no signal at all.

**The root cause: a `send_message` frame that carried neither flag.** The user's
report was that it only happened when they pressed a button on an **action
card**; a typed message respected the tick. `App.tsx`'s `handleSendFollowUp` —
the `onSubmit` behind `ActionChecklistCard` — builds its own frame and never
read the composer's controls, so it reached `handleSendMessage` with
`compactContext: undefined`, which falls back to the global setting. Four
siblings had the identical omission: both release-card buttons, the
review-comments submit, and "ask the agent to review this file". `runSend` was
the only producer that carried the flags, and docs/293 had already closed
exactly this omission for the `/review` branch *inside* it — closing the class
one site at a time is what let the rest drift.

It fits every fact: **zero** `false` intents on the wire (matching the LFS
evidence that the reset ran and the compaction ran, since neither intent was
ever expressed); the send reaching `handleSendMessage` (matching the
`(activation)` echo 8 ms before the turn); and the user's untick still visibly
unticked, because the composer was never submitted and so never cleared.

**Reading the intent and spending it are one act, in one place.** A shared
*builder* was the first fix and it was not enough: the action-card path then
carried the untick and never consumed it, so one untick governed every later
message — req 5 says it applies to that one message. So `sendUserTurn`
(`client/utils/send-user-turn.ts`) owns the frame, the intent and its
consumption together, and is the **only** place a `send_message` frame is built;
a guard test fails the build if that literal appears in any other client file.
A producer that starts no turn calls `sendControlFrame` — a named export a
reviewer can enumerate, not a comment anyone can copy. The consumption happens
only on a send that reached the wire, so a refused one leaves the user's choice
where they can still see it. Only an opt-out is carried: absent and `true` both
mean "do it".

**The transport does not decide it; the interaction does.** The same omission
existed on the HTTP dispatch (`POST /agent/dispatch`), which four ShipIt buttons
use — preview errors, Create PR, and the two compose-error actions. They now
pass `userInitiated`, which carries the intent and spends it; a CI auto-fix and
an agent-interface continuation do not, and keep req 13. The server route and
`services/agent.ts` forward the two fields onto the dispatch shape, which
already carried them.

**One snapshot for display and wire.** The composer memoises what it read while
a send reads afresh, so another tab could display an unticked box and send
nothing. `syncMergeContinueOptOutAcrossTabs` pulls a `storage` write into the
store, which both sides read.

**A click is not a programmatic continuation** (req 13 vs req 5). Req 13 sends a
continuation "the user did not type" to the setting alone, and its stated reason
is that such a continuation "has no checkbox, so the setting alone decides". A
card button is pressed by the user, in the view the checkbox is in, often in the
same breath as unticking it — the checkbox is right there, and req 5 says an
untick applies to the user's next message. These frames therefore honour it. A
continuation with genuinely no checkbox — a wake turn, a `shipit session
message`, a click inside an agent-built page — never reaches that builder and is
unaffected. This is a requirements judgement, recorded here rather than as a new
numbered requirement.

**The other four defects.** Each is real, each is fixed here, and the host log
rules each out for the observed incident. The remount is what the log positively
supported before the action-card path was known. A remount
is the one candidate that predicts **zero** `false` intents on the wire — both
tick states re-initialise to `true` — and zero is what the server received on a
turn where the user had unticked a box. The pre-turn LFS restore fired on both
post-merge turns, which only `autoResetMergedBranchOnContinue`'s `moved: true`
path can produce, and no `opted-out` skip line exists anywhere in the retained
log; so the branch reset ran and `resetMergedBranch` was not `false` either.

The eligibility-flicker mechanism above is a real defect of the same class and is
fixed here, but it did not fire in that incident: the log holds only
`reset_eligible=true` across both merge windows, and `emitResetEligible` logs on
every path where `merged` is true, so a `false` could not have been silent. The
same goes for the control's hit target — the two buttons abutted and the compact
row had no top padding, so the apparent breathing room above its checkbox was a
live hit target for the reset control; a near-miss would have shown as exactly
one `false` on the wire, and none was sent. Both are fixed; neither is the cause.

So the tick state is `mergeContinueOptOutBySession` in the PR store, mirrored to
`shipit-merge-continue-optout:{sessionId}` in localStorage — the third durable
half of a draft, beside its text and its upload chips — and it holds only what
the user turned **off**. Nothing keys on a visibility transition. The payload
carries the intent whenever the control is shown **or** an opt-out is
outstanding; an opt-out can only say `false`, and `false` can only skip an
action, so carrying it is safe whatever the server thinks eligibility is by the
time the frame lands. The sibling `resetMergedBranch` control had the identical
shape and the identical defect, and takes the same fix.

**A send does not echo eligibility back at the composer.** `handleSendMessage`
activates the session on every send, and activation pushed a freshly computed
`reset_eligible`. That answer is a pre-turn one the same message is about to
invalidate, and it landed ~10 ms after the send — cancelling the composer's
optimistic hide and putting both controls back on screen, re-ticked, while the
turn they belonged to ran. The send now passes
`skipResetEligibleSignal`; a viewer arriving still gets the signal, and the
post-turn recompute is the authoritative answer for the turn.

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
publishes `running`, `systemTurnInProgress` and `activeDeliveryId` at entry —
`dispatchOnRunner` already did for a turn started from idle; the drains did not
— and restores them on a setup throw. One residual, of the class the executor
already accepts for the WS drain: a one-shot predecessor's `done` landing while
the reserved successor is still before its spawn finds an empty agent slot and
reads `running` as its own stale flag. It cannot be told from the docs/287
phantom adoption by state alone, and it self-heals at the successor's executor
entry. And `systemTurnInProgress` describes the
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
does not double in weight. Both tick states re-tick on send, and are keyed by
session, so an untick never rides a later message or another session.

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
| `client/stores/pr-store.ts`, `client/utils/local-storage.ts` | `mergeContinueOptOutBySession` and its durable mirror: the untick outlives the composer. |
| `client/utils/send-user-turn.ts` | `sendUserTurn` / `sendControlFrame` — the ONLY place a `send_message` frame is built. |
| `client/utils/merge-continue-intent.ts` | Read, consume, and the cross-tab sync. |
| `client/utils/dispatch-agent-message.ts`, `orchestrator/services/agent.ts`, `api-routes-agent.ts` | The HTTP dispatch carries it for a user-clicked send. |
| `client/utils/send-handler.ts`, `client/App.tsx` | Every producer, through that one boundary. |
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
