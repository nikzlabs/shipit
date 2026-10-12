---
issue: planning#689
title: The user steers every turn
description: Turns that ShipIt starts run on the same process as a typed turn and accept a message from the user; the hold for ShipIt's own operations becomes a flag of its own.
---

# The user steers every turn — design

Implements [requirements.md](./requirements.md).

## What is there today

A dispatch can carry `systemTurn: true`, and the runner carries
`systemTurnInProgress`. Together they mean four things. Each was read at the
source on 2026-10-12.

| Meaning | Where |
|---|---|
| The turn runs on a one-shot process. | `dispatched-turn.ts` → `runDispatchedTurnInner`: `useStreaming` is false when `opts.systemTurn` is set, and `runOnce` retires the resident process first. |
| A message from the user cannot steer it. | `dispatch-steering.ts` → `shouldSteerMessage` refuses while `systemTurnInProgress` is set; `isSteerableDispatch` refuses a system dispatch. |
| No other turn starts. | `session-runner.ts` → `dispatchOnRunner` queues every dispatch while the flag is set; `queue-drain.ts` → `releaseQueuedTurn` declines. Flows set the same flag with no turn running: `services/rebase-driver.ts` → `takeSystemHold`, `services/recovery.ts` → `takeQueueHold` (a restart), and the decision to compact (`decideWithSystemHold`, `decideCompactBeforeTurn`). |
| Its sender learns how it ended. | `turn-executor.ts` → `finishTurn` calls `onTurnComplete`. The result path of a resident process does not reach it: "a resident streaming turn settles no turn at all". A one-shot process exits after each turn, and `done` is what settles a system turn. The worker also records a turn's delivery id only at `/agent/start` (`session/agent-controller.ts`), so a turn that enters a resident process has none. |

Nobody chose the fourth row. It is why a turn cannot simply be moved to the
resident process: the merge watch, the CI fix and the rebase driver wait for
that settlement, and the merge watch finds its turn again after an orchestrator
restart by that delivery id.

The flag was made on 2026-05-29 for one turn, the conflict resolution of an
automatic rebase (docs/146). `wakeSessionWithTurn` sets it by default, so the
restart follow-up, the `notify-on-merge --self` wake, the consult result, the
quota continuation and the stopped-jobs notice took it without a decision of
their own.

## Two parts

The work ships in two pull requests. Both reviews of 2026-10-12 asked for the
split (see the review record below).

- **Part 1** makes the turns that do ordinary work ordinary turns. That is the
  report that started this feature: no steering after a restart.
- **Part 2** makes the hold a flag of its own, moves the two turns that run
  inside a ShipIt operation (conflict resolution, compaction), and deletes
  `systemTurn` and `systemTurnInProgress`. The constraint resolved on
  2026-10-12 ("a separate flag", "delete the old one") is met at its end.

## Part 1 — work turns are ordinary turns (req 1, req 2)

### The turns

| Caller | Turn |
|---|---|
| `wake-session.ts` → `wakeDispatch` | the follow-up after a requested restart, the `notify-on-merge --self` wake, a finished consult, a quota or sign-in continuation, the stopped-jobs notice |
| `services/github-ci-fix.ts` → `autoFixDispatch` | the automatic CI fix |
| `services/secret-block.ts` | the removal of a credential from a commit |
| `services/rebase-followup.ts` | the note after a rebase |
| `services/agent-compaction-request.ts` → `continuationEntry` | the note after a compaction that the agent asked for |

Each stops setting `systemTurn`. It then takes the path a child session's first
prompt takes today: `runDispatchedTurnInner` gives it a streaming process when
Live steering is on and the harness can steer, reuses the resident process, and
runs the spawn-identity guards. It takes no hold, so `shouldSteerMessage` lets a
typed message in. `automatic`, `unattended`, `messageOrigin`, `deliveryId` and
`onTurnComplete` stay; none of them changes how the turn runs.

Three things followed from the flag and now need a statement of their own.

- **A turn of its own.** These dispatches must not become a steer into a turn
  that is already running. `whenBusy: "queue"` now means "wait, never steer",
  and each of them passes it. Its one caller today is the rebase follow-up,
  which never steered, and a queue entry that is dispatched again carries the
  completion callback that already makes it unsteerable (verified at
  `prepared-dispatch.ts` → `withSettlement`, `dispatch-steering.ts` →
  `isSteerableDispatch`).
- **The one-shot note** (docs/235-agent-self-wake-liveness §9) is keyed on the
  process too: it rides a turn that ShipIt started (`automatic` or
  `unattended`) and that will run on a one-shot process, for a harness that
  starts turns of its own. Its text no longer says who started the turn.
- **A compaction ahead of the turn.** The dispatched compaction is still a
  one-shot system turn until Part 2, and it retires the resident process. A
  system turn used to wait while the resident had background work
  (`systemTurnBlockedByResidentWork`); a work turn no longer waits. So the
  decision to compact is skipped while the resident has background work, and
  the next eligible turn compacts instead.

`wakeSessionWithTurn` prepares the agent environment before it dispatches. It
now passes `reusingResidentAgent` when a resident process is alive, as the
executor does (`session-agent-env.ts` → `repairLeakedSubtrees`).

### A turn on a streaming process settles at its own result

In the result path of a streaming turn, after the `idle` step and before the
continuation, the executor calls `finishTurn()` when the result answers this
turn's own prompt (`takeResultAttribution`, the reading `notePromptDelivered`
uses).

- **What "completed" means on a reused process.** `finishTurn` reads
  `receivedResult`, which any result on the process sets. For a turn that
  entered a resident process it now also needs the prompt's own result. A turn
  that is torn down before that settles `dropped`, and its sender delivers
  again: the restart and compaction steps settle the ending turn early
  (`runRequestedRestart`, `runRequestedCompaction`), and a restart then
  destroys the process with the prompt unread.
- **An adopted turn** (after an orchestrator restart) composed no prompt, so
  its attribution starts as "running": the turn that was in flight is the one
  the next result ends.
- A Stop kills the resident process (`services/agent-interrupt.ts`), so a
  stopped turn still ends as `interrupted` through `done`.
- This also settles the dispatched turns that never settled at their result: a
  child's first prompt, a headless session's first prompt, an agent-interface
  message, a manual Fix CI. One caller reads such a handle, the scheduled run's
  first turn, and it reads a setup failure only (`schedule-runner.ts` →
  `onFirstTurnSettled`).

### The delivery id travels with the prompt

`sendUserMessage` takes the turn's delivery id when the message is a turn's own
prompt. `ProxyAgentProcess` passes it to `/agent/message`, and the worker
records it for that turn, as `/agent/start` does. A steer passes none and
leaves the running turn's id alone. A container whose worker is older than this
change ignores the field; the merge watch then behaves as it does today for a
turn with no id.

### The user's message goes first (req 2)

- **Queue order.** `takeRunnableQueuedTurn` takes the first entry that is not
  `automatic` when one exists, and the head otherwise. It does that today in
  two cases of docs/322; it becomes the rule. It still picks among the entries
  that can start: the question hold, the saved held turns and the commit gate
  are read as before.
- **A message typed during a restart.** The follow-up used to start as soon as
  the restart's hold came off, ahead of the queue the restart had carried. It
  now goes to the head of that queue before the hold comes off, and the queue's
  own order decides: a message of the user's first, then the follow-up.

## Part 2 — the session hold, and the last two turns

Not built in Part 1. The design below is the direction; the review found
defects in the first version of it, listed here so that Part 2 starts from
them.

- `runner.sessionHold` replaces `runner.systemTurnInProgress`: ShipIt is
  changing the branch or the container itself, so no turn starts. No ordinary
  turn takes or releases it. `systemTurn` leaves the dispatch shape, the queue
  entry and the executor.
- The conflict-resolution turn must accept a message from the user (req 2). A
  resident process that outlives that turn is unsafe: the executor's
  `postTurn: "none"` would apply to turns the CLI starts later, and the driver
  would rewrite the tree while a live process can still write to it. The
  direction is a streaming process that ends with the turn, so that it can be
  steered and nothing survives into the driver's git steps.
- The hold during a compaction ahead of a turn is also an admission hold:
  `verifyRunningState` can clear `running` while the decision waits. It cannot
  become a steer block alone.
- A message typed while ShipIt compacts ahead of the user's own message waits
  behind that message's whole turn today. Req 2 asks for more: it must reach
  the agent when that turn starts.
- The timeout and the abort of a rebase clear the hold without its owner, and
  an answer to a question card is refused under the hold ("busy with a system
  operation"). Both need the hold's owner to be explicit.

## Known limits of Part 1

- A prompt that goes in behind a turn the CLI started, and that the CLI never
  reads back, does not settle at a result. It settles at `done`, a
  displacement or disposal, as every streaming turn did before. The merge watch
  then sends its wake again.
- A harness that can steer but ends its process with each turn (Codex) is
  steerable during a work turn and still starts a process per turn. A queued
  turn drained at the exact moment that process ends can lose its first
  attempt; the existing no-result retry starts it again. This is today's
  behaviour for every dispatched turn on that harness.
- A work turn can retire the resident process, and its background jobs with
  it, when the session's model, credential route, tool list or MCP servers
  changed. A typed message does the same.
- The rebase-resolution turn and ShipIt's compaction turns still refuse a
  steer and still run one-shot, until Part 2.

## Review record

2026-10-12, before any code, on the user's instruction. Two independent runs
of ShipIt's configured reviewer read `requirements.md`, the first version of
this plan and the code.

- **"Would anyone notice if it were removed?"** Applied: no change to a
  `/compact` that the user types (the first version blocked steering there for
  symmetry alone); the restart note stays a queue entry and is not turned into
  a pending notice; two pull requests. Not applied: letting a message steer
  into a compaction that ShipIt starts. `docs/295-compact-context-on-merge`
  blocks that so the message cannot run before the message that waits behind
  the compaction, on a branch that message is about to reset.
- **Defects.** Applied in Part 1: the delivery id on a resident process; the
  settlement of an adopted turn; `completed` on a reused process needs the
  prompt's own result; the wording "no turn replaces the resident". Moved to
  Part 2 with the design they belong to: the resident conflict resolver, the
  admission half of the compaction hold, the rebase timeout and abort, answers
  under a hold, the compaction flag's lifecycle. Not applied: a separate
  acceptance path for a rejected `/agent/message`. The worker that has no agent
  already ends such a turn as `dropped` (`verifyRunningState` →
  `turn_abandoned`), and the new `dropped` settlement covers a prompt that was
  never read.

## Key files (Part 1)

- `src/server/orchestrator/wake-session.ts` — the wakes
- `src/server/orchestrator/session-runner.ts` → `dispatchOnRunner` — `whenBusy: "queue"`
- `src/server/orchestrator/dispatched-turn.ts` — the one-shot note, the compaction guard
- `src/server/orchestrator/turn-executor.ts` — settlement at the result
- `src/server/orchestrator/queue-drain.ts` — the queue order
- `src/server/orchestrator/proxy-agent-process.ts`, `container-session-runner.ts`, `worker-http.ts`, `src/server/session/agent-controller.ts` — the delivery id
- `src/server/orchestrator/services/agent-restart-request.ts`, `github-ci-fix.ts`, `secret-block.ts`, `rebase-followup.ts`, `agent-compaction-request.ts` — the callers
