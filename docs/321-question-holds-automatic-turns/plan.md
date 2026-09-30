---
issue: planning#630
title: A question holds automatic turns
description: One persisted per-session mark, set when a turn ends waiting for the user and cleared when the user starts a turn, gates every automatic turn.
---

# A question holds automatic turns

Implements [requirements.md](./requirements.md).

## The problem

A turn that ends with a question card or a plan to approve leaves the session
idle, and idle is exactly when ShipIt's automation fires: the runner's `idle`
event re-fires deferred CI fixes and conflict resolutions, the PR poller fires
new ones, and wake-ups (a merged PR, a child's report, a finished consult) are
dispatched straight into the idle runner. Any of them starts a turn under the
open question, and a rebase also holds the session so the user's answer is
refused with "The agent is busy with a system operation".

`runner.awaitingUserAnswer` (docs/303 req 13) already knows that a turn ended
this way, but it is per turn — the next turn resets it — and it is in memory, so
nothing could read it before an automatic turn starts.

## The mark

`sessions.awaiting_answer` (migration in `shared/database.ts`), read and written
through `SessionManager.isAwaitingAnswer` / `setAwaitingAnswer`. It is ShipIt's
own bookkeeping, so it is not on `SessionInfo`. On the session row it survives a
reclaimed container and a restart (req 5).

- **Set** at turn settlement (`settleTurnFacts` in `turn-executor.ts`), when the
  turn's `awaitingUserAnswer` fact is true — for any turn, including an
  automatic one and a CLI-started one, since each can ask (req 1).
- **Cleared** when a turn that is not automatic starts (req 3): the executor's
  turn start, skipped for an adopted turn and a retry of one already started.
  A settling turn that did not ask leaves the mark alone, so an automatic turn
  can never clear it.

Both writes go through `SystemTurnDeps.answerHold` (the `SessionManager`), and
the runner reads it back as `runner.answerHold`. A failed read counts as "not
held", so a closed database cannot freeze the queue.

## What is automatic

A dispatch says so with `AgentDispatchOptions.automatic`, carried through
`QueuedMessage`, `SteeredMessage` and `TurnInput`. `AgentDispatchInit` lists
every field, so each dispatch site had to decide (req 2):

| Site | `automatic` |
|---|---|
| `wake-session.ts` — merge notice, child report, consult result, quota continuation | true |
| `app-lifecycle.ts` — CI auto-fix | true |
| `services/secret-block.ts` — credential remediation | true |
| `services/rebase-followup.ts` | true |
| `services/rebase-driver.ts` — conflict resolution turn | true unless the flow is the manual Sync (`recordSyncCard`) |
| `services/child-sessions.ts` — a parent's message | true, unless the user delivered it from a proposal card |
| `services/agent.ts` — `POST /agent/dispatch` | the body's `automatic`; the client's preview auto-fix sets it |
| typed messages, answers, Fix CI, Create PR, headless and child creation | absent |

The preview auto-fix is the one automatic trigger that runs in the browser
(`hooks/useAutoFix.ts`). It now sends `automatic: true` and adds no optimistic
bubble, so a held fix does not show as the user's own message under the
question.

## The gates

1. **Dispatch admission** (`dispatchOnRunner`): an automatic dispatch meets the
   mark like any other hold — queued, or refused for a `whenBusy: "refuse"`
   caller (req 1, 4). While a turn runs, automatic work is not steered into it
   once the turn has asked (`runner.awaitingUserAnswer`), so it queues instead.
   An interrupted interactive turn discards its queue; one that ended on a
   question now keeps the automatic entries (`discardQueueAfterInterrupt`), since
   those are held, not cancelled.
2. **Queue take** (`takeRunnableQueuedTurn`): while the mark is set, a queued
   automatic head is passed over for the first entry the user queued, and left
   in place when there is none. Every drain and `releaseQueuedTurn` takes
   through it, so held work runs in order once the user's turn ends without a
   new question (req 4, 6).
3. **Remediation** (`AutoRemediationManager`): a held session defers exactly as
   a running one does, before any runner is created, so no container boots
   for it. The `idle` event after the user's turn re-fires it. This covers the
   CI auto-fix and the conflict auto-resolve, and so the automatic rebase.
4. **Rebase flow**: a conflict-resolution turn that ends by asking the user
   stops the flow and aborts the rebase, with the abort notice, instead of
   sending another resolution prompt. This holds for the manual Sync too: its
   own turns are the user's, but the next prompt would still land on the
   question.

Work the user starts by hand passes every gate and clears the mark when its
turn starts (req 6): Fix CI is a plain dispatch, and the manual Sync's
resolution turn is not automatic.

## Limits

- A queued entry lives in the runner. If the runner is reclaimed while an
  automatic turn is held, the entry settles as dropped, as any queued entry
  does today; merge notices and quota continuations retry, and CI fixes and
  conflict resolutions are re-derived from PR state, but a consult result or a
  child report is not redelivered.
- A turn the agent CLI starts on its own — a finished background job waking a
  resident process — is not dispatched by ShipIt and is not gated.
- The auto-resolve **Retry** button re-arms the automatic resolver, so it is
  held like the resolver itself.

## Key files

- `src/server/orchestrator/sessions.ts`, `src/server/shared/database.ts` — the mark.
- `src/server/orchestrator/turn-executor.ts` — set at settlement, clear at a user turn's start.
- `src/server/orchestrator/session-runner.ts` — `automatic` option, `answerHold`, the dispatch gate.
- `src/server/orchestrator/queue-drain.ts` — the take.
- `src/server/orchestrator/auto-remediation-manager.ts` — the remediation gate.
- `src/server/orchestrator/services/rebase-driver.ts` — stop after a question.
- `src/client/hooks/useAutoFix.ts`, `src/client/utils/dispatch-agent-message.ts` — the browser's automatic dispatch.
