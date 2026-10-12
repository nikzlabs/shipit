---
issue: planning#689
title: The user steers every turn
description: One kind of turn, a hold of its own for ShipIt's branch and container operations, and a queue that puts the user's message first.
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
| Its sender learns how it ended. | `turn-executor.ts` → `finishTurn` calls `onTurnComplete`, and it is reached from `done`, `superseded` and the error path only. The result path of a resident process does not call it: "a resident streaming turn settles no turn at all". A one-shot process exits after each turn, so `done` is what settles a system turn. |

The fourth row is not a meaning that anybody chose. It is why a turn cannot
simply be moved to the resident process: the merge watch, the CI fix and the
rebase driver wait for that settlement.

The flag was made on 2026-05-29 for one turn, the conflict resolution of an
automatic rebase (docs/146). `wakeSessionWithTurn` sets it by default, so the
restart follow-up, the `notify-on-merge --self` wake, the consult result, the
quota continuation and the stopped-jobs notice took it without a decision of
their own.

## The design

### 1. One kind of turn (req 1)

`systemTurn` is deleted from `AgentDispatchOptions`, `QueuedMessage`, the
`prepareDispatch` field table, the executor input and `runAgentWithMessage`.
Every turn takes the path that a child session's first prompt takes today:

- `runDispatchedTurnInner` computes `useStreaming` from the Live steering
  setting and the harness for every turn, and reuses the resident process on
  the first attempt. The block that retires the resident for a system turn goes.
  The spawn-identity guards (`releaseResidentOnSpawnChange` and its two
  siblings) run for every turn, as they do for a typed one.
- `systemTurnBlockedByResidentWork` goes from the dispatch gate and the drain:
  no turn replaces the resident process any more. `residentBackgroundWork`
  stays for two flows that read it as a policy of their own — the automatic
  rebase does not rewrite the tree under a running job, and the agent's
  requested compaction waits for the job.
- The bug-outcome notice rides every turn except a compaction and a driver's
  step (`postTurn: "none"`), the same rule the other notices already follow.
- The one-shot note (docs/235-agent-self-wake-liveness §9) is keyed on the
  process and not on who started the turn: it rides a dispatched turn that will
  run on a one-shot process.
- `wakeSessionWithTurn` prepares the agent environment before it dispatches.
  It now passes `reusingResidentAgent` when a resident process is alive, as the
  executor does (`session-agent-env.ts` → `repairLeakedSubtrees`).

What ShipIt still knows about a turn it started: `automatic` (docs/322),
`unattended` (docs/295), `messageOrigin`, `deliveryId` and `onTurnComplete`.
None of them changes how the turn runs.

### 2. A turn on a resident process settles at its own result (req 1)

Without this, a ShipIt-started turn on the resident process would never tell
its sender that it ended.

In the result path of a streaming turn, after the `idle` step and before the
continuation, the executor calls `finishTurn()` when the result answers this
turn's own prompt (`takeResultAttribution`, the same reading that
`notePromptDelivered` uses). The outcome rule is the one `done` uses today:
`completed` unless the adapter errored.

- A result that does not answer the prompt (the prompt went in behind a turn
  that the CLI started) does not settle the turn. The prompt's own result does,
  when the CLI reads the prompt back. Until then the paths of today still
  settle it: `done`, `superseded` and a disposed runner.
- A Stop kills the resident process (`services/agent-interrupt.ts`), so a
  stopped turn still ends as `interrupted` through `done`.
- This also settles the dispatched turns that are not system turns today and so
  never settled at their result: a child's first prompt, a headless session's
  first prompt, an agent-interface message, a manual Fix CI. One caller reads
  such a handle, the scheduled run's first turn, and it reads a setup failure
  only (`schedule-runner.ts` → `onFirstTurnSettled`).

### 3. The session hold (resolved 2026-10-12: "a separate flag", "delete the old one")

`runner.sessionHold` replaces `runner.systemTurnInProgress`, with
`sessionHoldSeq` as its identity. It means one thing: **ShipIt is changing the
branch or the container itself, so no turn starts.**

- Holders, through one helper `takeSessionHold(runner)` that returns a ticket
  with `release()`: the rebase flow for its whole length, and a restart
  (`takeQueueHold`, which adds the lease). Nothing else.
- **No turn takes or releases it.** The writes in `dispatchOnRunner`,
  `runDispatchedTurn` and `executeAgentTurn` go, and so does `ownsSystemHold`.
  The rebase driver keeps its hold while its own resolution turn runs, so the
  hand-over (the turn takes the hold, `finishTurn` releases it, the driver takes
  it again in `onTurnComplete`) and its gap go.
- The holder's own step enters under the hold as it does today, by
  `postTurn: "none"`; the rebase driver is the only caller that sets it.
- Readers keep their meaning under the new name: the dispatch gate, the drains,
  `releaseQueuedTurn`, the auto-merge and merge executors, the branch heal, the
  auto-push deferral, the rebase start, the requested restart and compaction
  ("another flow holds the session"), and the abort route.
- **The hold is not an input to the steer rule** (section 4).

Compaction does not use the hold. Its decision already runs with `running`
claimed on both paths, so the hold did one thing there, block a steer. That is
now `runner.compacting` (section 4).

### 4. When a message can steer (req 2)

`shouldSteerMessage` becomes: the harness can steer, Live steering is on, the
process is streaming, **a turn is running, and the agent is not compacting**.

- "A turn is running" replaces the hold. Under a session hold, `running` is
  true only for the holder's own turn: the rebase refuses to start while a turn
  runs, a restart waits for the turn's end, and nothing else starts under the
  hold. So a message typed during conflict resolution steers the agent that
  resolves the conflicts, and a message typed between two steps of the rebase
  waits in the queue, because no agent reads then.
- `runner.compacting` is set from the start of the decision to compact until
  the compaction turn's drain, and the executor sets it at the start of every
  turn from `input.compact`, which is what clears a stale value. It covers a
  compaction that ShipIt starts, one that the agent asked for, and a `/compact`
  that the user typed while idle. The last one is a change: a message typed
  during the user's own `/compact` is now queued in front and not steered. That
  makes the three compactions behave the same (req 1), and it keeps the message
  behind the compaction it was typed after.
- A dispatch from ShipIt that needs a turn of its own must not become a steer
  into someone else's turn. `systemTurn` gave that by accident. Now
  `whenBusy: "queue"` says it: the dispatch waits and is never steered. The
  wakes, the automatic CI fix, the credential removal, the requested compaction
  and the rebase follow-up pass it. The default stays "steer, else queue".

### 5. The user's message goes first (req 2)

- **Queue order.** `takeRunnableQueuedTurn` takes the first entry that is not
  `automatic` when there is one, and the head otherwise. Today it does that in
  two special cases of docs/322; it becomes the rule.
- **An answer is not refused.** `handleAnswerQuestion` answers "busy with a
  system operation" under the old flag. Under a session hold it queues the
  answer, as it does under a merge hold.
- **A message typed during a restart.** The replacement runner carries the
  queue. When that queue holds a message of the user's, the restart parks the
  agent's note as a pending notice and releases the queue, so the user's
  message is the first turn on the new container and carries the note in its
  prompt. With no such message, the note is its own turn, as today.

### What stays one-shot

A harness that cannot steer, and any harness while Live steering is off. Those
turns keep the one-shot note and the stopped-jobs wake. No message steers them,
whoever started them.

## Callers that lose the flag

| Caller | Change |
|---|---|
| `wake-session.ts` (restart follow-up, `--self` merge wake, consult result, quota continuation, stopped-jobs notice) | No flag; `whenBusy: "queue"`. `startOrRefuse` keeps its own admission. |
| `services/github-ci-fix.ts` → `autoFixDispatch`, `services/secret-block.ts`, `services/rebase-followup.ts` | No flag; `whenBusy: "queue"`. |
| `services/agent-compaction-request.ts` | No flag. The compaction and its continuation are ordinary entries. |
| `dispatched-turn.ts`, `ws-handlers/agent-execution.ts` (compaction ahead of a turn) | No flag and no hold; `runner.compacting`. |
| `services/rebase-driver.ts` | No flag. The flow's hold is a `takeSessionHold` ticket that it keeps across the resolution turn. |

## Known limits

- A prompt that goes in behind a turn the CLI started, and that the CLI never
  reads back, settles late (at `done`, a displacement or disposal), as every
  streaming turn does today.
- A message typed while a turn is still in setup can reach an idle resident
  process before that turn's own prompt. This is today's behaviour for a typed
  turn. For the conflict-resolution turn, section 2 is what makes it safe: the
  driver continues only after the result of its own prompt.
- A message that waits in the queue behind the user's own earlier message is
  not steered into that message's turn when it starts. It runs after it.
- `SystemTurnDeps` keeps its name. It names the dependencies of a dispatched
  turn and carries no behaviour.

## Order of work

One pull request, built in this order, with the tests of each step green
before the next:

1. Settlement at the result, `whenBusy: "queue"`, the queue order.
2. `sessionHold` and `takeSessionHold`; no turn writes the hold.
3. The steer rule and `runner.compacting`.
4. The flag leaves the callers and the types; the rebase driver keeps its hold.
5. The answer under a hold, and the restart note.
6. Agent-facing docs, the wiki, and the older design docs that state the old
   rule (docs/163, docs/235, docs/240, docs/287, docs/295, docs/304, docs/321).

## Key files

- `src/server/orchestrator/session-runner.ts` — the dispatch shape and gate, the runner interface
- `src/server/orchestrator/container-session-runner.ts` — the same runner state for a container
- `src/server/orchestrator/session-hold.ts` — `takeSessionHold` (new)
- `src/server/orchestrator/dispatch-steering.ts` — the steer rule
- `src/server/orchestrator/dispatched-turn.ts` — one path for every dispatched turn
- `src/server/orchestrator/turn-executor.ts` — settlement at the result
- `src/server/orchestrator/queue-drain.ts`, `turn-admission.ts` — the queue order and the gates
- `src/server/orchestrator/wake-session.ts` — the wakes
- `src/server/orchestrator/ws-handlers/send-message.ts`, `agent-execution.ts` — the typed path, the answer, compaction
- `src/server/orchestrator/services/rebase-driver.ts`, `recovery.ts`, `agent-restart-request.ts`, `agent-compaction-request.ts` — the flows
