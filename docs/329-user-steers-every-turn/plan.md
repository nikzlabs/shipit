---
issue: planning#689
title: The user steers every turn
description: Turns that ShipIt starts run on the same process as a typed turn and accept a message from the user; the hold for ShipIt's own operations becomes a flag of its own.
---

# The user steers every turn — design

Implements [requirements.md](./requirements.md).

## What was there before this feature

A dispatch could carry `systemTurn: true`, and the runner carried
`systemTurnInProgress`. Together they meant four things. Each was read at the
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

## Three parts

The work ships in three pull requests. Each review asked for a split (see the
review record below).

- **Part 1** (merged) makes the turns that do ordinary work ordinary turns.
  That is the report that started this feature: no steering after a restart.
- **Part 2** (merged) makes one rule for when a message enters a turn, and
  gives a message that had to wait to the turn that starts. It leaves the old
  flag in place.
- **Part 3** makes the hold a flag of its own, moves the two turns that run
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
  `unattended`) when streaming is off for it, for a harness that starts turns
  of its own. The setting decides, and not a resident that happens to be alive:
  a spawn guard can still retire that one, and the note costs nothing on a
  process that stays up. Its text no longer says who started the turn.
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
  that ends before the process read its prompt settles `dropped`, and its
  sender delivers again; one that ends after the read settles `interrupted`,
  which a sender takes as delivered. That holds for each way such a turn can
  end early: the restart and compaction steps settle the ending turn
  (`runRequestedRestart`, `runRequestedCompaction`), a newer turn retires the
  process (`superseded`), the runner is disposed, or the process exits. The
  `turn_result` event that the dispose path reads is emitted for the prompt's
  own result only, for the same reason.
- **When the next turn takes the process.** A reuse removes the listeners of
  the turn before it. The process emits `reused` first, and a turn that has not
  settled settles then, by the rule above. Its post-turn work goes on; only
  `superseded` gives that up.
- **A turn that a drain starts** is told of a disposed runner and of an
  abandoned turn, as a turn that `dispatch` starts already was
  (`turn-settlement.ts` → `settleWhenRunnerLetsGo`). The restart follow-up is
  such a turn when a message of the user's ran first.
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
records it for that turn, as `/agent/start` does. When the prompt goes in
behind a turn the CLI started, the worker keeps the id aside and gives it to
the next turn, so that an orchestrator restart cannot settle the delivery on
the result of the CLI's own turn. A steer passes none and leaves the running
turn's id alone. A container whose worker is older than this change ignores the
field; the merge watch then behaves as it does today for a turn with no id.

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

## Part 2 — a message waits only for an agent that can read it (req 2)

Each statement about today's code was read at the source on 2026-10-12, after
Part 1 merged. This part leaves the old flag in place, and every decision below
still obeys it.

### When a message enters a turn

Today two places decide a steer (`dispatch-steering.ts` → `trySteerDispatch`
for a dispatch, `ws-handlers/send-message.ts` for a typed message), and both
ask only whether the process can take input. Three cases go wrong:

- **A turn in setup.** A process that is alive between turns takes a message
  at once, so a message sent while the next turn sets up starts a turn of the
  CLI's own before that turn's prompt arrives. The turn's setup can reset the
  branch (`preTurnReset`) while that message runs.
- **No process yet.** The message goes to the queue and runs after the turn,
  however long the turn is.
- **A turn that is a compaction.** ShipIt has nothing to steer into: Codex
  steers a running turn, and a compaction is not one; Claude gets the text on
  its input and reads it after the compaction, as a turn of its own that
  ShipIt did not order (`docs/140-live-steering/plan.md`, phases 6.9 and
  6.11). A compaction that the agent or the harness runs in the middle of a
  turn is not such a turn, and nothing changes for it.

The rule: **a message enters the running turn when the agent has accepted that
turn's prompt, and the turn is not a compaction turn.** Before that it waits in
the queue, in the order it was sent.

- The state is the turn phase that Stop already keeps for each claim of
  `running` (`turn-stop-request.ts`). It gains `ready` and `compaction`.
  `turnTakesMessages(runner)` is the one reading: the runner is running, and
  its phase is ready and not a compaction. A runner with no phase record reads
  as ready, as it reads as submitted today.
- **`ready` is set** when the submission of the turn's own prompt is accepted
  (`AgentProcess.submissionSettled` resolved; at once for a process with no
  such promise), when the CLI reads the prompt back, and when ShipIt adopts a
  turn that survived an orchestrator restart or that the CLI started by
  itself. That last case marks only the turn that the adoption began: a wake of
  the CLI during another turn's setup says nothing about that turn's prompt.
  Each attempt of a turn has a token, and an answer marks only the attempt it
  belongs to, so a late answer cannot mark a retry or the next turn. A retry
  (`reopenTurnSetup`) clears `ready`.
- **`compaction`** is set by the executor from `TurnInput.compact`, for each
  attempt, whoever started the turn.
- **Codex.** Its adapter drops a steer that arrives before the turn has an id
  (`session/agents/codex/adapter.ts` → `writeStdin`): the start request is
  accepted before `turn/start` returns. The adapter now keeps such a steer and
  sends it when the turn has its id, so "accepted" means the same for both
  harnesses.
- **`/compact` typed while a turn runs** compacts the agent in the middle of
  that turn, through a branch that the hold or a turn in setup also reaches
  (`decideAndRunSend`). That branch now asks `turnTakesMessages`; in the other
  cases the command is queued as a message.
- What the user sees for a message sent during a compaction turn: it shows in
  the queue at once and runs when the compaction ends. Before, it showed as
  delivered and was put back in the queue at the result, or ran as a turn of
  the CLI's own.

### A waiting message enters the turn that starts

`deliverWaitingMessages` (`dispatch-steering.ts`) gives the user's waiting
messages to the running turn. It starts when a turn becomes `ready`, when
ShipIt adopts a turn of the CLI's own, and when a message of the user's joins
the queue behind one that still waits.

- **Which entries.** The messages that the user wrote in this chat: queue
  entries with `execution: "interactive"`. The typed path and the answer path
  are the callers that queue them, and a typed steer that the agent did not
  read goes back as one. A child's first prompt, a scheduled run's prompt, a
  click on Fix CI and a message from a page keep their own turn: none is the
  user's message to the agent that works now. A command of the harness
  (`/compact`, `/goal`) keeps its turn too: steered text is not read as a
  command.
- **Attachments.** A typed steer resolves files and uploads, saves images and
  assembles the prompt before it writes to the agent. That code moved to
  `prepareSteer`, which the typed path and the delivery both call.
- **One entry at a time, one delivery for a turn attempt.** For each entry the
  delivery prepares the message while the entry stays in the queue, then
  decides the steer again, takes the entry out in the same step as the write,
  and waits until the worker has accepted the write before the next entry. The decision reads
  the turn attempt it started for, a Stop or a question (`wasInterrupted`), a
  refusal (below), and every condition of a live steer. A call while a
  delivery runs adds nothing: the loop reads the queue again before each
  entry. An entry that cannot be prepared is not tried again; it reports its
  error when it runs as a turn.
- **The user's own order.** A newer message of the user's does not pass one
  that still waits: both steer paths put it in the queue, and the delivery
  gives them in order. A message from another source is not held back by this.
  A refused message goes back in front of every entry sent after it
  (`queue-identity.ts` → `requeueInSendOrder`, planning#691).
- **A refusal stops the sending.** The agent's refusal puts the message back
  in the queue by the path that exists (`agent_steer_rejected`). Two things
  can refuse: the worker's answer to the write, and the harness later, after
  the worker accepted it. Both set a mark on the turn attempt
  (`setSteerRefused`), and the delivery sends nothing while the mark is set.
  Only a message of the user's that goes back to the queue sets it; a refused
  notice from another source does not.
  A new message from the user clears it and tries one time more, in order.
  With no new message, the queue's drain runs the messages after the turn, as
  before this part.
- **After the write** the entry's handle settles as `steered`, also when the
  transcript cannot be saved. A write that throws leaves the entry at its
  place in the queue.
- **What the viewers get.** A queue update without `dequeued`, and then the
  `message_steered` event, which carries the queue entry's id and the
  attachments. Every viewer draws the same bubble from it, and finds it by that
  id, never by its text (planning#691).

### A turn in setup is not a stuck turn

`verifyRunningState` (`container-session-runner.ts`) clears `running`, emits
`turn_abandoned` and releases the queue when the worker reports no agent. From
a turn's claim until the worker records `/agent/start`, that is the normal
state. A typed message calls it on every send while a turn runs; outside a
hold the message then started a second turn beside the one in setup.

- The function leaves a claim alone while its phase is not ready and the
  claim is younger than `TURN_SETUP_MAX_MS` (10 minutes: longer than a setup
  that works, shorter than a session left stuck). This is a grace period for
  the check, not a deadline: after it, a later check clears the claim as
  before, when the worker reports no agent.
- **A refused prompt ends the grace.** A resident process that is gone refuses
  the turn's prompt, and that refusal is only logged
  (`ProxyAgentProcess.sendUserMessage`). The executor now marks the attempt
  as refused and asks the runner to check at once.
- **A turn that was settled during its setup does not submit its prompt.** A
  newer turn took the process or its slot (`reused`, `superseded`), or the
  agent ended. The executor does not read `running` or the phase for this: a
  turn of the CLI's own clears the one and starts the other during a setup,
  and the prompt must still go in. A displaced turn settles `dropped`.
- The check used to repair one more case by accident: a typed turn that
  throws before it has an agent leaves `running` set, and the next message
  cleared it. That turn now ends its own claim (`send-message.ts` →
  `endClaimIfSetupFails`).

### An answer is a message (req 2)

`handleAnswerQuestion` had three rules of its own: it queued under a merge hold
or an open commit, refused under the old flag ("busy with a system
operation"), and dropped the answer when a turn ran. The refusal and the drop
are gone.

- **A hold, or a turn that did not ask.** The answer is dispatched, and takes
  the admission of every dispatch: steered into a turn that takes messages,
  queued otherwise. This comes before the cleanup of a stale process, which
  must not end that turn or a flow's agent.
- **The turn that asked.** Its question interrupted it. Where its process does
  not stay for the answer, the cleanup ends that process and the answer starts
  the next turn, as before. Where the process stays and the turn has not ended
  yet, the answer is queued as the next turn (`whenBusy: "queue"`): it is not
  a part of the turn that asked.
- The client already shows both results: the bubble stays for a steer and
  moves to the queue strip for a queued message
  (`client/hooks/message-handlers`).

### Smaller corrections that the rule needed

- The typed path told the executor that a `/compact` is a compaction only
  through the run parameters. It now sets `TurnInput.compact` too, which is
  what the phase reads.
- A turn that a newer one displaced before it submitted its prompt settled
  `interrupted` or `no-result`. The first tells a sender that the agent had
  the prompt. It now settles `dropped` for both events, `superseded` and
  `reused`.

### What changes for the user and the agent

- A message sent while a turn sets up arrives in that turn. Several messages
  can so become part of one turn, where each was a turn of its own.
- A message sent during a compaction turn shows as queued, not as delivered.
- An answer on a question card is accepted while a turn runs or a flow holds
  the session.
- A typed `/compact` during a flow or a setup waits its turn.

### A queued message's identity (planning#691)

The queue's events had no session and named a message by its text. Three
defects followed: a viewer that switched sessions got another session's queue
and bubble, a second viewer got a delivered message without its attachments,
and a refused steer went to the end of the queue.

- **One id for a message.** It is the sender's request id (typed, answered or
  sent over HTTP), or an id that ShipIt makes the first time a viewer is told
  of the entry (`queueEntryId`). The queue rows, `message_queued`,
  `dequeued`, `message_steered`, the turn's echo and the saved row carry it.
  The client finds a bubble by this id, never by its text, so two messages with
  the same text stay two bubbles.
- **The session.** `queue_updated`, `message_queued` and `agent_interrupted`
  (which clears the queue strip) carry the session id, and the client drops one
  of another session before it changes a store. While the history of a
  reconnecting viewer loads, these events and `message_steered` wait for it, as
  the echo does: a bubble drawn before the load is wiped by it.
- **The same bubble on every viewer.** A steer's event is the bubble, with its
  attachments. A drained message gets its bubble from `dequeued` at once: the
  sender's composed bubble, or the text on another viewer. The turn's echo then
  adds the attachments to a bubble of that id that has none.
- **The user's order.** An entry takes a send order when it is first queued,
  and a steer when it is written; a delivered entry keeps its own. A refused
  steer goes back in front of every entry sent after it. A held turn is saved
  without its send order (the counter is per process), so it comes back without
  one and a refused steer does not pass it.
- A cancel of a queued message updates the strip of every viewer, not only
  the one that cancelled.

### Known limits of Part 2

- Live steering can be off, and a harness may not take a message during a
  turn. Both are in `requirements.md`.
- A waiting entry that the user did not write in this chat (a page message, a
  click on Fix CI) keeps its own turn.
- A second click on a question card, or a second viewer, can send an answer
  twice. "The turn that asked" is the runner's flag, not the card's id, so an
  answer on an old card while a new question waits is taken as the answer to
  the new one.
- A claim that the check gives up after its bound still has a setup that can
  go on and enter the executor, as before this part. Only the grace period is
  new.
- An automatic message can steer past a message of the user's during the
  moment that message is prepared.

## Part 3 — the session hold, and the last two turns (req 1, req 2)

The first version of this part made the conflict-resolution turn a new kind of
turn inside the executor, and tried to make a cancelled rebase safe at each git
step. The reviews of 2026-10-12 found six open points in it, and a second pair
of reviews found more in the version after it (review record). The built
version is smaller than both. The conflict-resolution turn is an ordinary turn.
The rebase flow, which is what needs a quiet workspace, replaces the agent
process before its step, as the old system turn did, and ends the process of
the step itself.

### What was left of the old flag

- `systemTurn: true` on four dispatches: the conflict-resolution turn
  (`services/rebase-driver.ts` → `dispatchRebaseResolutionTurn`), the
  compaction ahead of a dispatched turn (`dispatched-turn.ts`), the compaction
  ahead of a typed turn (`ws-handlers/agent-execution.ts` →
  `runCompactionAhead`; this one already runs on the resident process), and
  the compaction that the agent asked for
  (`services/agent-compaction-request.ts`).
- `runner.systemTurnInProgress`, written by those turns (in `dispatchOnRunner`,
  `runDispatchedTurn` and the executor) and by three flows with no turn of
  their own: the rebase (`takeSystemHold`), a restart (`recovery.ts` →
  `takeQueueHold`) and the decision to compact (`decideWithSystemHold`,
  `decideCompactBeforeTurn`).

### The session hold

`runner.sessionHold` is the lock: ShipIt changes the branch or the container
itself, so no turn starts. Two flows take it: the rebase and a restart.

```ts
interface SessionHold { release(): void }
function takeSessionHold(runner): SessionHold        // session-hold.ts
```

- The field is plain data, `SessionHold | null`. The hold is a token: its
  owner keeps it, and `release()` clears the field only while the field is
  that token, which is what the sequence number did. A flow reads the field
  before it takes the hold, as the rebase and the restart request read the
  flag.
- **No turn takes or releases it.** `TurnInput.systemTurn`, `ownsSystemHold`,
  the release in `finishTurn`, the write at the executor's start, and the
  claims in `dispatchOnRunner` and `runDispatchedTurn` go. Tests state the
  behaviour: a turn that starts and ends under a hold leaves it set.
- **What it stops.** Each reader of the old flag reads the hold: the dispatch
  gate, `releaseQueuedTurn`, the drains, the drain of an adopted turn, the
  merge executor, auto-merge, the branch-ahead heal, the auto-push scheduler
  (which reads it after a failed push, to hold back a warning), the restart
  and compaction requests, the typed-message path, the answer path, the replay
  of a rebase banner, and the abort route.
- **The holder's own step.** The flow that holds the session must be able to
  start a turn under its hold. It passes the hold with the admission:
  `runner.dispatch(step, { whenBusy: "refuse", underHold: hold })`. The gate
  admits a dispatch with `underHold` only when that token is the hold that is
  set, so it also refuses the step of a flow whose hold was released. A
  dispatch without `underHold` waits while any hold is set. `underHold` is an
  argument of the admission call, not a field of the dispatch: the queue does
  not store it (a step is never queued), and the executor does not get it. It
  also replaces `systemTurn` in the exemption of `turnBlockedByPendingCommit`.
- **It does not stop a steer.** The rule of Part 2 decides that. So the user
  steers the conflict-resolution turn, and a message that waited under the
  rebase is delivered to that turn when the agent has its prompt.

### The conflict-resolution turn (req 1, req 2)

It is an ordinary dispatched turn with `postTurn: "none"`. That option exists
beside the old flag and stays as it is: the driver, not the turn, does what
follows the turn (the commit, the push, the pull-request flow, the queue).
Nothing in the executor knows that the turn is a step of a rebase. It runs on
a streaming process when Live steering is on and the harness can steer, takes
a message by the rule of Part 2, and settles at the result of its own prompt
(Part 1).

The flow does four things around it, all in `rebase-driver.ts`:

- **The step runs on a process of its own**, as the system turn did. The
  gate retires an idle resident when it admits a step with `underHold`
  (`retireResident`, `resident-spawn-guard.ts`), in the same synchronous step
  as the claim, so a step that is refused ends no process. Before it
  dispatches, the flow refuses the step while the resident has background
  work (`refuseStepOverResidentWork`, with the old reason: the replacement
  would end that work); a running turn is left to the gate, which refuses. The step so never
  enters a process behind a turn of the CLI's own, whose result it could not
  tell from its own (Part 1, known limits).
- **It admits the step under its hold**, as above, with `whenBusy: "refuse"`.
- **It counts the step as resolved only when the turn ended by itself.** A
  streaming turn that the user stops ends with a result, and so settles
  `completed`. The executor records at the turn's own result whether the user
  had stopped it and whether the result is an error, and the `completed`
  outcome carries both (`stoppedByUser`, `resultErrored`): a turn of the CLI's
  own that starts on the same process before the settlement resets the
  runner's flags. Either makes the step a failed one, and so does a turn that
  asked a question (the answer hold, docs/322). The flow then aborts the
  rebase.
- **It ends the process of the step before it runs git** (`endStepProcess`).
  When a step that started settles, with any outcome, the flow notes the
  process in the slot. If that process is still in the slot afterwards, the
  flow removes its listeners, stops it, and waits for its `done` event. Then it
  continues the rebase or aborts it. A step that was refused started no
  process, and the flow stops nothing. A step that failed keeps its own error;
  a failure to see the exit then only goes to the log, because the flow aborts
  either way.
  - With the listeners gone, no event of the stopping process starts a turn
    or takes a message. A steer that the agent did not read went back to the
    queue at the result, before the stop.
  - A turn of the CLI's own can still begin on the process between the step's
    result and the stop. Under the hold nothing else can run, so a claim on
    `running` at the exit is that turn's: the flow puts back what it took and
    did not read (`requeueUndeliveredSteers`), saves its rows, and clears the
    claim, because its executor's `done` handler no longer runs.
  - The attempt's deadline can release the hold during the wait, and a turn
    can then start. So after the wait the flow touches nothing unless it still
    holds the session, and after the step it stops with an error when it does
    not: it does not stage or continue a rebase for a session it lost.
  - The wait is bounded (15 s; the process tree gets SIGKILL 5 s after
    SIGTERM, `shared/kill-child.ts`). When the bound passes, the step counts
    as failed and the flow aborts the rebase.
  - When the process is no longer in the slot, the flow does not wait: a
    one-shot process has ended (its `done` settled the turn and cleared the
    slot), or an adapter error or the abort route took it out. In the last two
    cases the flow has no proof of the exit, as before.
- The prompt of the turn says that the agent process ends with the turn.

An answer on a question card that arrives under a hold while the turn that
asked still ends is queued, not steered into that turn (`handleAnswerQuestion`).
The old flag did this by refusing every steer.

### The timeout of an automatic attempt

The timeout of `runAutoResolveAttempt` stops the agent, clears `running`, and
aborts the rebase, as before. In place of the write to the flag it releases the
hold of the flow that it stops; the flow gives its hold to the attempt through
a callback (`onSessionHoldTaken`), as it gives the follow-up window. The abort
route changes one read: it settles the driver's wait when a hold is set. It
never cleared the flag, and the flow releases its own hold.

Two things are new. A flow whose hold was released cannot start a step: the
gate refuses it. And the flow releases its hold and the queue in a `finally`
of their own; before, a throw in the cleanup in front of them left the flag
set with no owner. Everything else that a flow can do after its timeout or
after an abort is as before (known limits).

### ShipIt's compaction turns (req 1)

They lose `systemTurn` and take the path of every dispatched turn: the process
that a typed turn would use, the resident when one is alive. `silent` stays for
what it did: no user row, the notice when a compaction left no card, and a Stop
that skips the compaction and runs the message that waited for it. The notice
is now checked at the first drain of every silent turn, before the hold is
read, and once: a turn of the CLI's own adopted after the compaction drains
again, after its reset cleared the cards, and before this change it could add
the notice a second time. The typed path (`agent-execution.ts`) checks it once
in the same way. When that turn began before the compaction's own drain ran,
the cards are gone from the runner, so the check also reads the record: a
compaction card newer than the one before the turn means that the compaction
ran (`compactionCardBefore`).

- **No hold, and no flag in its place.** The old flag did three things here.
  - A message does not enter the compaction: the rule of Part 2, for every
    compaction.
  - Nothing starts between the decision and the compaction. All three decision
    sites run after the claim on `running` (`runDispatchedTurnInner`,
    `runQueuedInteractiveMessage`, and the typed path in `send-message.ts`),
    and a claim in setup takes no steer and is not cleared as stuck (Part 2).
    One case is lost, see the known limits.
  - Nothing starts between the compaction and the turn that waits for it. The
    compaction ends as every turn with a queued successor ends: the open
    commit queues a dispatch (`turnBlockedByPendingCommit`), a typed message
    waits for it (`turnCommitSettled`), and the drain claims `running` for the
    next entry with no macrotask between the commit and the claim.
- **Two of the three guards on background work stay**: ShipIt does not decide
  to compact ahead of a turn, and does not start a compaction that the agent
  asked for, while the resident has background work. They decide when ShipIt
  starts a compaction, which requirement 1 does not cover. The third guard, on
  a compaction entry that already waits in the queue, goes: a `/compact` of
  the user's has no such guard.
- The notice of a bug-report outcome stays off the conflict-resolution turn.
  It read `systemTurn`; it reads `postTurn: "none"`, as the notices beside it
  do. A compaction turn carries no notice at all, as before.

### A restart

`takeQueueHold` takes the session hold in place of the old flag. A restart
request waits while a hold is set (`heldByOther` loses its exception for a
turn that owned the flag). The queue that a restart carries goes to the
replacement past the queue's cap: the entries were accepted already, and a
throw there left the hold set with nobody to release it.

### A fresh process settles at its first result

A streaming turn settles at the result of its own prompt (Part 1), and a
result counts as the prompt's only once the worker has answered the submission.
A process spawned for one prompt can produce its result before that answer;
the turn then never settled, and the rebase flow waited for ever with no
lease. The first result of a process that the turn spawned now settles the
turn. It does not acknowledge the notices of the prompt, which still need the
answer (docs/299 req 8).

### What a turn's end still does

`finishTurn` no longer releases a hold, and the queue release in its `finally`
goes with it: it served an entry that a queued system turn left behind the
resident's background work (planning#562), and no queue gate reads that work
now. The release after a one-shot process exits stays, for a message that
queued after the result. The release when the resident's background work ends
(`runner-registry-factory.ts`) stays too; it declines while any gate holds.

### What goes

`systemTurn` on `AgentDispatchOptions`, `AgentDispatchInit`, `QueuedMessage`,
`TurnInput` and `RunAgentWithMessageOpts`; `systemTurnInProgress` and
`systemHoldSeq` on both runners; `SystemHoldTicket`, `takeSystemHold`,
`decideWithSystemHold`, the hold in `decideCompactBeforeTurn`,
`ownsSystemHold`; `systemTurnBlockedByResidentWork`; the branches of `runOnce`
that retire the resident for a system turn. `SystemTurnDeps` keeps its name:
it is the dependency bundle of every dispatched turn, and a rename would touch
files this feature does not change.

### What this part does not change

- **What a Stop does with the queue.** A Stop discards the queue behind a turn
  that the typed drain started (docs/021: "interrupt clears the queue"), and
  keeps it behind a turn that `runner.dispatch` started, where the next entry
  starts at once. The line is not who started the turn: a message of the
  user's that a gate released runs on the dispatched path too. The two reviews
  of this part disagree on the direction of a fix, and the direction is the
  user's to choose (planning#692). Changed 2026-10-12: the user chose, and
  `docs/330-stop-returns-queued-messages` is the one rule — a Stop empties the
  queue behind every turn, and a message of the user's goes back into the
  input box.
- **How a rebase is cancelled.** The timeout and the abort route race the
  flow; they do not cancel it (planning#693).

### Known limits of Part 3

- A background job that the agent starts in a conflict-resolution turn stops
  when the turn ends, and no notice reports it; the prompt of the turn says
  that the process ends. `requirements.md` gives the reason.
- The flow continues at the exit of the root process of the step. A
  descendant that ignores SIGTERM can write for up to 5 s more. The 15 s bound
  is new: when it passes, the flow aborts the rebase beside a process that it
  could not prove gone. The timeout of an automatic attempt did the same
  before.
- A Stop or a question in a conflict-resolution turn aborts the rebase. What
  the agent wrote in that turn, also on a steer of the user's, goes with the
  abort: a rebase cannot keep a part of a resolution.
- A flow that its timeout or the abort route stopped is not cancelled. A git
  step that was in flight ends later, and the flow then runs its cleanup with
  no hold. It can no longer start a turn (planning#693).
- A turn of the CLI's own that ends while ShipIt decides to compact clears the
  claim of the turn that decides, as it does in every setup (Part 2, known
  limits). The old flag held the session across the decision and the
  compaction. Now a message or a queued entry can start a turn in that window,
  and the two turns then meet on the process.
- A compaction that is drained at the moment the process of a harness that
  ends its process with each turn (Codex) exits goes to that process as a
  message. The process ends with no result, and the existing retry starts the
  compaction on a new process (Part 1, known limits).
- These differences between a typed turn and a dispatched one stay: with Live
  steering turned off while a resident is alive, a dispatched turn still runs
  on the resident and a typed turn replaces it; a dispatched turn starts one
  more time when its process ends with no result and no output, and a typed
  turn shows the error; and a Stop and the queue, above.
- A compaction turn that an orchestrator restart adopts has lost its phase,
  so a message can be written to it. If the agent did not read it before the
  result, it goes back to the queue.
- A hold has no deadline. The leases beside it have one, as before.

## Known limits of Part 1

- A prompt that goes in behind a turn the CLI started, and that the CLI never
  reads back, does not settle at a result. It settles `dropped` when the next
  turn takes the process, at a displacement or at disposal, and its sender
  delivers again: a notice can then arrive twice, and is not lost.
- An orchestrator restart while a prompt waits behind a turn the CLI started
  adopts that turn with no delivery id. The merge watch sends its wake again
  when the session is idle.
- A harness that can steer but ends its process with each turn (Codex) is
  steerable during a work turn and still starts a process per turn. A queued
  turn drained at the exact moment that process ends can lose its first
  attempt; the existing no-result retry starts it again. This is today's
  behaviour for every dispatched turn on that harness.
- A work turn can retire the resident process, and its background jobs with
  it, when the session's model, credential route, tool list or MCP servers
  changed. A typed message does the same.
- The rebase-resolution turn and ShipIt's compaction turns refused a steer
  until Part 3, which removed that.

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
- **Defects in the design.** Applied in Part 1: the delivery id on a resident
  process; the
  settlement of an adopted turn; `completed` on a reused process needs the
  prompt's own result; the wording "no turn replaces the resident". Moved to
  Part 2 with the design they belong to: the resident conflict resolver, the
  admission half of the compaction hold, the rebase timeout and abort, answers
  under a hold, the compaction flag's lifecycle. Not applied: a separate
  acceptance path for a rejected `/agent/message`. The worker that has no agent
  already ends such a turn as `dropped` (`verifyRunningState` →
  `turn_abandoned`), and the new `dropped` settlement covers a prompt that was
  never read.

2026-10-12, on the diff of Part 1. One more run of the reviewer, against each
numbered requirement.

- Applied: an unread prompt is never reported as `interrupted` (a displaced
  turn, a disposed runner); the worker keeps the id of a prompt that waits
  behind a turn of the CLI's apart from that turn; a turn settles when the next
  one takes its process; a turn that a drain starts is told of a disposed
  runner; the one-shot note no longer reads a resident that can still be
  retired; false statements in the agent-facing docs and in four comments.
- Moved to Part 2: a message of the user's that waits in the queue while a turn
  sets up is not given to that turn when it starts. The reviewer counts this
  against req 2, and it is the same gap as the message typed during a
  compaction.
- The reviewer's verdict on the first version of the diff: req 1 and req 2 not
  fully met, for the two reasons above. The fixes for the first were not
  reviewed again.

2026-10-12, on the first design of what is now Part 2 and Part 3, before any
code. Two more runs of the reviewer: one for defects, one on the brief "would
anyone notice if it were removed?".

- **Cut.** A reason on the hold, and a `compaction` hold that a `silent` turn
  took: both reviews read it as the old flag's "this turn cannot be steered"
  under a new name. In its place, one rule for every turn and every
  compaction (Part 2), and the fix to `verifyRunningState`, which was the
  reason a second hold stood around the decision. Also cut: a test that read
  the executor's source for a word; `onSessionHoldTaken`.
- **Split.** Part 2 can ship while the old flag stays; Part 3 replaces the
  flag in one step.
- **Defects, applied.** The conflict-resolution turn takes the whole one-shot
  terminal sequence, not a change to one handler: the first design left
  `finishTurn` reachable before the process ended, let a turn of the CLI's own
  be adopted, and left the runner without a lease between the result and the
  exit. A cancellation keeps the session while it cleans up, and the cancelled
  flow stops at every step, not only after its turn. The delivery waits for
  the prompt's submission to resolve. The setup guard reads acceptance, not
  sending, and has a bound. The `steerable` mark is a dispatch field. An
  answer takes one admission.
- **Not applied.** Steering into a compaction that the agent asked for (the
  removal review): the same rule holds for every compaction, because no
  harness applies a message there. Removing the guards on background work
  (first design): the defect review showed what they still protect. Recovery
  of a compaction's state after an orchestrator restart: nothing is owned any
  more, and the result puts a message back in the queue.
- **Requirements.** Both reviews said that the reading kept two exceptions the
  user did not give: no steer into a compaction that ShipIt starts, and a
  process of its own for the conflict resolution. The first is gone (the rule
  does not read who started the compaction). The second is now stated as the
  constraint it comes from: nothing else writes while ShipIt runs git in a
  rebase.

2026-10-12, on the corrected design (Part 2 and Part 3 as two parts). One
more run of the reviewer.

- **Part 2, applied.** `ready` has more than one source (acceptance, the
  prompt read back, adoption) and belongs to one phase, so a late answer
  cannot mark the next turn. Codex accepted a start before it could take a
  steer; its adapter now keeps the steer. The delivery prepares, checks and
  writes one entry at a time against the phase it started for. "The user's
  message" is a message written in this chat, not "not automatic", which a
  child's first prompt also is. The setup guard has a stated bound, and the
  setup it gave up on does not submit. An answer is admitted before the
  cleanup of a stale process. A typed `/compact` no longer skips the rule.
- **Part 2, not applied.** A deadline that cancels a setup in progress: the
  check at the submission is the smallest thing that stops a second prompt.
  The claims "no harness applies a message during a compaction" and "the user
  sees it run at the same moment" are withdrawn; the rule is now stated for a
  compaction turn only, with what the user sees.
- **Part 3.** The review's points are listed in that part as open. It is not
  built from this text.
- **Requirements.** The review said again that the reading states choices as
  necessities. `requirements.md` now separates the user's words, the
  requirements of other features, and the choices of this design.

2026-10-12, on the code of Part 2. One run of the reviewer on the diff of
PR #3186, against each numbered requirement. Its verdict on that version: do
not merge; requirement 2 not met within the part's scope.

- **Applied, each with a test and a mutation check.** A wake of the CLI during
  another turn's setup no longer marks that turn ready (the blocker). An
  adopted turn gets the waiting messages too. A refused prompt ends the setup
  grace, and the runner checks at once. A Stop ends a delivery. A queued
  `/compact` or `/goal` is not delivered as text. A refusal ends the delivery
  for that turn; before, the loop sent the same message again without end. A
  failed write keeps the entry, and a written entry's handle always settles.
  A newer message of the user's does not pass one that waits. The Codex
  adapter gives kept steers back when the turn cannot start. The steer event
  is the bubble, and the queue update carries no `dequeued`. `reused` during
  setup settles `dropped`.
- **Found while applying.** The first version of the displacement check read
  the phase, and a turn of the CLI's own that ended and started again during a
  setup made the turn in setup drop its prompt. A typed message would have
  been lost. The check now reads `reused` and `superseded` only, and a test
  holds the case.
- **Not applied.** A claim token carried from admission to the executor (the
  review's point 11). A token taken from the turn phase would drop real
  prompts, as above, because a turn of the CLI's own replaces the phase during
  a setup. A separate admission identity that survives those changes is
  possible; it is not built. What is left is in "Known limits of Part 2".
- **Requirements.** The review said again that the reading holds design
  choices. `requirements.md` no longer says "neither has an exception" as a
  fact.

2026-10-12, on those fixes. One more run of the reviewer. It confirmed nine of
the twelve fixes, found no break of the post-turn invariants, and asked for
four more changes, all in the delivery.

- **Applied, each with a test and a mutation check.** One delivery for a turn
  attempt: without it, a second call wrote the next message before the agent
  answered the first, and sent a refused one again. A refusal by the harness
  after the worker accepted the write stops the sending too. A new message of
  the user's tries again after a refusal; before, it waited for the whole
  turn. The queue update carries `dequeued` again: without it, a delivered
  message with the same text as an earlier one lost its bubble.
- **Still open.** Point 11 above. A second viewer does not see the attachment
  of a delivered message until a reload, as for a drained entry today.

2026-10-12, on those four changes. A last, short run of the reviewer. It
confirmed all four and found no leak of the delivery lock.

- **Applied.** The refusal mark was set for every refused steer, also a notice
  from another session that is discarded; such a refusal then stopped the
  delivery of the user's messages. Only a message of the user's that goes back
  to the queue sets it now.
- **Not applied, filed as planning#691.** The queue update with `dequeued` has
  no session id, a second viewer gets no attachments from it, and a refused
  message goes to the end of the queue. All three are true of the code before
  this feature. Fixed later under planning#691: see "A queued message's
  identity" below.
- The reviewer's verdict on requirement 2 was "not fully met", for the mark
  above. That fix had no further review: the three runs of the turn were used.
- Final state: 822 test files pass (16,550 tests). Mutation checks: 33 on the
  first version, 24 on the first fixes, 10 on the later ones; each one was
  caught, except two that change nothing a test can see.

2026-10-12, on the fix for planning#691. Two runs of the reviewer.

- The first found the three defects fixed and no change to when a message
  enters a turn. **Applied:** the steer and the queue events wait while a
  reconnecting viewer's history loads; before, the load wiped a steer's bubble.
- The second confirmed that, and the session scope of `agent_interrupted`.
  **Not applied:** holding an `error` back while the history loads. A load
  that fails never releases what is held, so the error that explains it would
  not show. The case it covers (a refused message for which the browser
  predicted a compaction, during a reconnect) is older than this fix.

2026-10-12, on the second version of Part 3 (before any of its code). Two runs
of the reviewer, with different briefs. That version let the conflict turn
enter the resident process and stopped the process after every step; it added
a rule that a Stop discards the queue behind a dispatched turn.

- **The brief "would anyone notice if it were removed?"** It kept the hold,
  the admission argument, the wait for the exit and the prompt sentence. It
  cut the `held` property, the take-over rule and a test that read the sources
  for a second writer; it moved the check for background work from the gate
  into the flow. All applied.
- **The defect brief, applied.** A step that was refused must not stop a
  process: the refusal exists to protect that process. A Stop of a streaming
  turn settles `completed`, so the flow would have continued the rebase on a
  half resolution; it now reads the runner after the step. On a reused process
  a result of the CLI's own turn ends the executor's lease while the flow
  still waits; the flow now replaces the process before the step, as today.
  An event of the stopping process could start a turn and take a waiting
  message; the listeners now go before the stop. An answer under the hold
  could be steered into the turn that asked. The missed-compaction notice and
  the bug-outcome notice read the old flag and are named now. The 15 s bound
  is new and no longer called "as today".
- **The Stop rule.** The first brief said that requirement 1 asks for one
  rule and not for this direction, and that the direction decides whether a
  message of the user's is lost. The second found the rule sound. The rule is
  out of this part and filed for the user to decide (planning#692).
- **Not followed.** The defect brief asked for a rebase that can be cancelled:
  hold checks in each git step, proof that the process tree is gone, and an
  abort route that waits for the flow. That is true of today's code, the
  requirements do not ask for it, and an earlier version of this part grew
  from the same request (planning#693). It asked for a setup claim that an
  older turn cannot clear; that is the admission identity of Part 2's known
  limits, and the case it adds is listed under Part 3's. It called each known
  limit a failure of requirement 1; they are listed for the user to see, and
  the two that are choices of this design are in `requirements.md`.
- **`postTurn: "none"`.** The first brief found that it does more than stop
  the commit: no drain, no pull-request flow, no restart or compaction request
  at the turn's end. The plan now says so. Its queue part repeats what the
  hold does, and stays: removing it changes the executor's drain for no
  requirement.

2026-10-12, on the Part 3 code. One run of the reviewer against both
requirements and the constraint. It confirmed that the old flag is gone, that
the hold is owned by flows only, that steering under the hold works, and that
the container routes the exit of a stopped step to the flow. It found these,
each reproduced, and each now has a test and a mutation check:

- A stopped step whose process reported a job it ended (a turn of the CLI's
  own) read the runner's flags after they were reset, and the rebase went on:
  the outcome now carries the facts of the step's own result.
- A fresh process's result before the worker's answer never settled the step:
  the first result of a spawned process now settles its turn.
- A turn of the CLI's own on the step's process was left marked running when
  the flow ended the process: the flow now ends that turn.
- A step that the gate then refused could end another process: the gate now
  retires the resident only when it admits the step.
- A restart that carried more than the queue's cap left the hold with no
  owner and lost entries (older than this feature): the carry is lossless.
- A silent compaction on the typed path could add the missed-compaction notice
  twice (older than this feature): checked once.
- The steer of the typed path under a hold was not redundant for a message
  with an attachment, as the record above had assumed; the test now sends one.
- Stale comments.

A second run checked the fixes. It found them correct, and two more cases,
both now fixed with a test and a mutation check: the deadline of an automatic
attempt could release the hold while the flow waited for the step's exit, and
the flow then cleared the state of the turn that started next; and a turn of
the CLI's own that began before the compaction's first drain still produced
the missed-compaction notice.

Final state: 823 test files pass (16,631 tests); 45 mutation checks, each
caught.

## Key files (Part 3)

- `src/server/orchestrator/session-hold.ts` — `SessionHold`, `takeSessionHold`.
- `session-runner.ts` → `dispatchOnRunner` (the gate and `underHold`),
  `DispatchAdmission`; both runners carry `sessionHold`.
- `services/rebase-driver.ts` → `runRebaseFlow`, `runRebaseResolutionTurn`,
  `refuseStepOverResidentWork`, `endStepProcess`, `dispatchRebaseResolutionTurn`,
  `runAutoResolveAttempt` (`onSessionHoldTaken`).
- `resident-spawn-guard.ts` → `retireResident`, called by the gate.
- `turn-executor.ts` → `handleResult` (`settlesThisTurn`), `completedOutcome`;
  `turn-settlement.ts` → `TurnOutcome.stoppedByUser`, `resultErrored`.
- `dispatched-turn.ts` → `runDispatchedTurnInner` (no system branches),
  `drainNext` (the missed-compaction notice, once).
- `turn-executor.ts` → `finishTurn` (no hold), `tryDrain`.
- `ws-handlers/agent-execution.ts` → `drainNextQueuedMessage`,
  `decideCompactBeforeTurn`, `runCompactionAhead`; `ws-handlers/send-message.ts`
  (the typed path and `handleAnswerQuestion` read the hold).
- `queue-drain.ts`, `turn-admission.ts`, `services/recovery.ts` →
  `takeQueueHold`, `services/agent-restart-request.ts`,
  `services/agent-compaction-request.ts`.
- Tests: `session-hold.test.ts`, `turn-exit-session-hold.test.ts`,
  `services/rebase-driver.test.ts` ("the conflict-resolution turn is an
  ordinary turn"), `integration_tests/wake-queue.test.ts`, cases in
  `integration_tests/message-waits-for-agent.test.ts`,
  `integration_tests/steer-after-turn-end.test.ts`,
  `dispatched-turn-compaction.test.ts`.


## Key files (Part 2)

- `src/server/orchestrator/turn-stop-request.ts` — the turn phase: `ready`, `compaction`, `turnTakesMessages`, `turnAwaitsAgent`
- `src/server/orchestrator/dispatch-steering.ts` — `shouldSteerMessage`, `prepareSteer`, `deliverWaitingMessages`
- `src/server/orchestrator/queue-identity.ts` — a queued message's id and send order, `requeueInSendOrder` (planning#691)
- `src/server/orchestrator/turn-executor.ts` — where a turn becomes ready, and the check for a claim lost during setup
- `src/server/orchestrator/ws-handlers/send-message.ts` — the typed steer, `/compact`, and `handleAnswerQuestion`
- `src/server/orchestrator/container-session-runner.ts` → `verifyRunningState`
- `src/server/session/agents/codex/adapter.ts` — a steer kept until the turn has an id

## Key files (Part 1)

- `src/server/orchestrator/wake-session.ts` — the wakes
- `src/server/orchestrator/session-runner.ts` → `dispatchOnRunner` — `whenBusy: "queue"`
- `src/server/orchestrator/dispatched-turn.ts` — the one-shot note, the compaction guard
- `src/server/orchestrator/turn-executor.ts` — settlement at the result, and what a turn on a reused process reports
- `src/server/orchestrator/turn-settlement.ts` → `settleWhenRunnerLetsGo` — a started turn whose runner lets go of it
- `src/server/orchestrator/queue-drain.ts` — the queue order
- `src/server/orchestrator/proxy-agent-process.ts`, `container-session-runner.ts`, `worker-http.ts`, `src/server/session/agent-controller.ts` — the delivery id
- `src/server/orchestrator/services/agent-restart-request.ts`, `github-ci-fix.ts`, `secret-block.ts`, `rebase-followup.ts`, `agent-compaction-request.ts` — the callers
