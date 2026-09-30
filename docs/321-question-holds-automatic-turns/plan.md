---
issue: planning#630
title: A question holds automatic turns
description: A saved per-session mark, set when a turn ends waiting for the user and cleared when the user starts a turn, gates every automatic turn; held turns are saved in the database.
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
  turn start, skipped for a turn adopted after a restart.
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
| `services/rebase-driver.ts` — conflict resolution turn | true unless the user started the flow (`userStarted`) |
| `services/child-sessions.ts` — a parent's message | true, unless the user delivered it from a proposal card |
| `services/agent.ts` — `POST /agent/dispatch` | the body's `automatic`; the client's preview auto-fix sets it |
| typed messages, answers, Fix CI, Create PR, headless and child creation | absent |

The preview auto-fix is the one automatic trigger that runs in the browser
(`hooks/useAutoFix.ts`). It now sends `automatic: true` and adds no optimistic
bubble, so a held fix does not show as the user's own message under the
question.

## The gates

1. **Dispatch admission** (`dispatchOnRunner`): an automatic dispatch that meets
   the mark is saved (below), or refused for a `whenBusy: "refuse"` caller
   (req 1, 4). While a turn runs, automatic work is not steered into it
   once the turn has asked (`runner.awaitingUserAnswer`), so it queues instead.
   An interrupted interactive turn discards its queue — the Stop button's
   meaning. A question also interrupts the CLI, and used to discard the queue
   the same way, dropping even a reply the user typed as the card appeared. The
   interactive drain now discards only after a stop; after a question it goes on
   to the take below, which runs the user's own entry and holds the automatic
   ones (req 3, 6).
2. **Queue take** (`takeRunnableQueuedTurn`): while the mark is set, every
   automatic entry in the queue — one that queued behind the asking turn — is
   saved and leaves the queue, and the first entry the user queued is taken.
   Every drain, `releaseQueuedTurn` and the dispatch setup-failure recovery take
   through it (req 4, 6).
3. **Remediation** (`AutoRemediationManager`): a held session defers exactly as
   a running one does, before any runner is created, so no container boots
   for it, and again after the awaits just before the attempt is claimed, since
   a turn can end on a question in between. The `idle` event after the user's
   turn re-fires it. This covers the CI auto-fix and the conflict auto-resolve;
   `runAutoResolveAttempt` checks once more before it touches the tree.
4. **Wake-ups** (`wake-session.ts`): a merge notice, child report, consult
   result or quota continuation for a session that is waiting is saved at once,
   without restoring its workspace or booting a container, and merge-watch counts
   a saved delivery as in flight so its retry loop does not spend attempts on it.
5. **The agent's own turns** (`agent-listeners.ts`, req 7): a turn a resident CLI
   starts by itself — a background job of its own finishing — is interrupted as
   soon as it is adopted while the mark is set. It ends as the question did,
   still waiting (`awaitingUserAnswer`), so its queue is kept; what woke the
   agent stays in its conversation for the user's reply.
6. **Rebase flow**: a conflict-resolution turn that ends by asking the user
   stops the flow and aborts the rebase, with the abort notice, instead of
   sending another resolution prompt. This holds for the manual Sync too: its
   own turns are the user's, but the next prompt would still land on the
   question.

Work the user starts by hand passes every gate and clears the mark when its
turn starts (req 6): Fix CI is a plain dispatch, and a rebase flow the user
started — the Sync button, or **Retry** on the auto-resolver — carries
`userStarted`, so its resolution turns are not automatic. Retry reaches the
resolver as `handleTransition(…, { byUser: true })`, which skips the hold.

## Held turns are saved (req 8)

A held automatic turn is a row in `held_turns` (`SessionManager.holdTurn`,
`heldTurns`, `forgetHeldTurn`, `hasHeldDelivery`), never an entry in a runner's
memory queue, so a stopped or restarted container — whose runner goes with it —
and a ShipIt restart cannot lose it. Its completion callback lives only as long
as the process, as its caller does.

- **Saved** by the dispatch gate, the queue take and the wake path. A second
  hold of the same turn or the same delivery keeps its one row.
- **Restored** when a turn the user started begins (`restoreHeldTurns`, next to
  the clear): the rows go back into the queue behind what the user queued
  (req 6), each carrying its `heldId`, and run when that turn ends. If it ends on
  a new question, the take saves them out again.
- **Forgotten** when the take hands the entry over to run.
- A runner that goes away while they are back in its queue does not settle them
  (`withoutHeldEntries`); their rows bring them back at the next user turn. A
  Stop discards them with the rest of the queue (`forgetHeldEntries`).

The accepted cost: after a restart that lands between the reply's start and its
end, the rows come back at the user's next turn rather than at once.

## Key files

- `src/server/orchestrator/sessions.ts`, `src/server/shared/database.ts` — the mark and the `held_turns` table.
- `src/server/orchestrator/held-turns.ts` — save, restore and forget, all failing open.
- `src/server/orchestrator/wake-session.ts`, `merge-watch.ts` — wake-ups saved without booting.
- `src/server/orchestrator/ws-handlers/agent-listeners.ts` — the CLI's own turn stopped.
- `src/server/orchestrator/turn-executor.ts` — set at settlement, clear at a user turn's start.
- `src/server/orchestrator/session-runner.ts` — `automatic` option, `answerHold`, the dispatch gate.
- `src/server/orchestrator/queue-drain.ts` — the take.
- `src/server/orchestrator/auto-remediation-manager.ts` — the remediation gate.
- `src/server/orchestrator/services/rebase-driver.ts` — stop after a question.
- `src/client/hooks/useAutoFix.ts`, `src/client/utils/dispatch-agent-message.ts` — the browser's automatic dispatch.
