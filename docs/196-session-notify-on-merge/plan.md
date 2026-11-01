---
issue: planning#120
title: Async notify-on-merge watch for spawned child sessions
description: A parent session arms a watch and gets a notice in its inbox when a spawned child's PR merges (or closes), without blocking a turn on human-review latency.
---

# Notify-on-merge (`shipit session notify-on-merge`)

**Requirements:** [`requirements.md`](./requirements.md). It starts with the rework of
2026-10-10 (arming again), and numbers like (req 3) refer to entries there. The rest of
this document describes behaviour that shipped before requirements were recorded.

## Problem

A parent session that spawns a child for foundation work it depends on has no
way to resume automatically once the child's PR **merges**. `shipit session wait`
only blocks until the child's *agent turn* goes idle (code written / PR opened),
capped at 1 hour — it does **not** wait on a merge, and blocking an agent turn on
a human merge (which can take days) is the wrong model.

## Model — event-driven, not a blocking wait

`shipit session notify-on-merge <child-id>`:

1. The parent agent calls it; the orchestrator **registers a persisted watch** on
   the child session row, the command returns `0` ("armed"), and the parent's
   turn can end. **Non-blocking.**
2. The PR poller (`pr-status-poller.ts`) already detects PR terminal states. When
   the watched child's PR transitions to **merged** (or **closed-without-merge**),
   the watch fires.
3. Firing = **store a notice in the PARENT's inbox**
   (docs/328-session-message-inbox req 6), end the watch in the same database
   transaction, and **surface a persisted merge card** in the parent's
   transcript. The inbox then tells the parent's agent that a message waits:
   during its running turn, in front of its next prompt, or with one short turn
   when the parent is idle.

Until docs/328, step 3 was a turn of its own in the parent's queue (a "wake
turn"). A busy parent then ran one turn for each child that merged, one after
the other. The agent now reads the notice with every other unread message, in
one call.

This is the async primitive only. A blocking `wait --until merged` is explicitly
out of scope.

The notice is intentionally compact: one event line, decision-critical metadata,
and one action line. The persisted card retains the full PR details, so
repeating URLs, SHAs, and lifecycle explanation for the agent only wastes
context.

## Watch state machine

The watch is persisted on the **child** session row (`SessionMergeWatch`, keyed
by the child id; the registering parent is recorded in `parentSessionId`). Stored
on the child because PR-terminal detection is keyed by the child's session id, so
the poller has the child in scope at fire time.

> **See also — the SELF variant (docs/239).** `shipit session notify-on-merge
> --self` uses this manager, its polling gate and its startup reconcile, with
> `kind: "self"` and `parentSessionId === ` the watched session's own id. It is
> the watch that still sends a **wake turn**: a session's own merge is not a
> message from another session, so docs/328 does not apply to it. The delivery
> id, the attempt counter, the retry supervisor and `delivery-failed` are
> therefore its alone. It also fires from the poller's `onMergeDetectedCb` (after
> `markMergedAndPruneExcess`, so the wake can't race the remote-branch deletion)
> instead of `onPrTerminalState`; arming always replaces (an idempotent "already
> armed" would make chaining impossible), so settlements carry an expected
> `watchId` (every watch has one since the 2026-10-10 rework); and terminal
> outcomes append plain notes instead of a new card, while the arm card records
> its own end.
>
> **The two watches are stored apart and coexist.** The parent's watch is the
> row's `merge_watch` column (`SessionInfo.mergeWatch`); the session's own is
> `self_merge_watch` (`SessionInfo.selfMergeWatch`). `registerMergeWatch` reads
> and writes only the first, the self-arm only the second, so neither arm can
> displace or block the other, and one merge serves both — this watch from
> `onPrTerminalState`, the self one from `onMergeDetectedCb`. The manager
> addresses a watch by slot (`(sessionId, "parent" | "self")`), and its
> in-memory state is keyed the same way. They once shared one column, and a
> parent's arm silently overwrote a child's live self-watch; docs/239 § Storage
> has the incident. Changes here must keep both working; `merge-watch.test.ts`
> and `self-merge-watch.test.ts` cover the pair.

A parent's watch. Each arrow is one transaction, which also stores the notice:

```
armed ──PR merged──────────▶ delivered         (terminal)
  └────PR closed unmerged──▶ closed-unmerged   (terminal)
```

A session's watch on its own PR, which sends a wake turn:

```
armed ──merge observed──▶ merge-observed ──wake-turn RAN──▶ delivered      (terminal)
                             ▲     │
           restart / retry ──┘     └──attempts exhausted──▶ delivery-failed (terminal)
```

- **`armed`** — registered, waiting. The child's PR need not exist yet.
- **`merge-observed`** — the poller saw the merge, and the wake turn has not run
  to completion. *A self watch* stays here while its wake turn is enqueued or
  still executing, while its container is being (re)booted, and after a delivery
  attempt that *threw*; the startup reconcile and the retry supervisor both
  re-fire from here. *A parent's watch* is never written in this state now. One
  that an older ShipIt left here, with a wake turn in delivery, is handled as
  described below.
- **`delivered`** — *a parent's watch:* the notice about the merge is in the
  parent's inbox. *A self watch:* the wake-turn has **actually run to
  completion** (not merely been enqueued). Terminal, **fire-once**. A parent's
  record keeps the PR it reported (`reportedPr`) for the next arm.
- **`closed-unmerged`** — the PR closed without merging, and a *distinct* notice
  is in the parent's inbox, so the parent doesn't proceed as if the work
  shipped. Terminal. It keeps `reportedPr` too.
- **`delivery-failed`** — a self watch whose wake turn failed
  `MAX_DELIVERY_ATTEMPTS` times; it gives up, leaves a note in its session, and
  stops holding the poll loop open (planning#260). Terminal. A parent's watch no
  longer reaches it: a record that an older ShipIt wrote stays as it is, and the
  next arm reports its merge (*Arming again*, below).

The `delivered` / `closed-unmerged` / `delivery-failed` terminal states are the
fire-once guard: a re-poll or a restart re-observation is a no-op. Re-arming a
`delivery-failed` watch (`registerMergeWatch`) starts a fresh `armed` one — the
recovery path is deliberately the user's / agent's call, not an automatic
resurrection of a watch that already reported it gave up.

### The stored notice is the delivery (docs/328-session-message-inbox req 6)

Storing is durable and synchronous, so a parent's watch needs no evidence that a
turn ran. Telling the agent is the inbox's work, and the inbox has its own
recovery — the idle trigger and the sweep, `services/session-inbox.ts`. A parent
that cannot be started is tried again there, and the watch has ended by then. So
a parent's watch has no delivery id, no attempt counter, no backoff and no
failure card (verified at `merge-watch.ts`: `handleParentWatchTerminal`, which
dispatches nothing).

**The notice and the end of the watch are one transaction**
(`SessionInbox.add(sessionId, message, alongside)`; the store is built on the
session manager's database, verified at `bootstrap-managers.ts`). Both are
written or neither is. A notice beside a watch that is still open would be
reported a second time by the next reconcile; an ended watch with no notice
would tell nobody. A merge and a close use the same step, and the watch has no
state between `armed` and its end. The card follows the transaction, and the
tell comes last, so the user sees the card before a session start that can take
a minute.

**A write that fails changes nothing.** The watch stays `armed`, no card is
surfaced, and the error goes to the caller's log. Nothing in memory tries again:
the next arm, or the startup reconcile, reads the PR from the child's stored
state (`unreportedPrFor`). In production the orchestrator has one connection to
its database (verified at `app-di.ts`; the script that seeds the dogfood instance
is the one other writer), and the parent is read and the notice is written with
no await between them. So such a failure means a disk that is full or broken,
and that stops every other write too. The watch that the wake turn used had the
same property: its first write was not guarded either.

**A watch that an older ShipIt left in delivery.** Before docs/328 a parent's
watch stayed `merge-observed` until its wake turn ended, so such a record can
exist at the upgrade, with its turn running, queued, or held for the user's
answer (docs/322). `isDeliveryInFlight` still asks the runner and the held turns
for that delivery id. While one of them has it, no notice is stored: the turn's
settlement ends the watch (`rebindDelivery` → `markDelivered`), and the agent is
told one time. When the turn is gone, or it ends without a result, the startup
reconcile or the retry pass stores the notice (`storeObservedMerge`), in one
transaction with the end of the watch. No attempt is counted against such a
watch, a busy parent does not hold it back, and it never becomes
`delivery-failed`. A store that throws leaves the watch `merge-observed`, and
the retry pass, which `storeObservedMerge` starts first, tries again.

A record from before `mergedPr` existed (2026-10-10) has no note of the merge it
observed. It gets `mergedPr` in the transaction that stores its notice, so that
the PR it reports is the PR it records as reported. When the child's stored
state shows only a later PR by then, and no turn can still report the merge,
the watch reports that PR as an armed watch does; it does not stay
`merge-observed` and hold every later arm.

### Arming again — a parent that follows a child across several PRs

One arm gives one notice (req 1). A coordinator that does work for each merged PR
of a chaining child arms again after each notice, most often in the turn in
which it reads the notice. Until 2026-10-10 the watch carried no PR number, and
both natural places to arm again were wrong: an arm during the wake was the
idempotent "already armed" no-op, so the watch settled to `delivered` and the
child's next merge woke nobody; an arm after the wake fired again at once for
the PR already reported, because the register-time check found it still in the
child's PR snapshot.

**The watch remembers what its parent was told (req 4).** `reportedPr` holds the PR
number and outcome that the parent last heard about. The transaction that ends the
watch writes it, for a merge and for a close (`markDelivered` does that for a watch
from an older ShipIt), and `registerMergeWatch` copies it from the watch it
replaces into the new one. An armed watch does not fire for
exactly that PR and outcome, wherever the event comes from: the register-time
check (`checkAndFireNow`), the startup reconcile, or the poller. The poller is in
that list because it can repeat a terminal event — merge-claim recovery promotes a
merged PR again with `force` (verified at `pr-status-poller.ts:
promoteMergedPrByNumber`). The outcome is part of the comparison, so a PR that was
reported as closed, then reopened and merged, is news.

"Told" means stored in the inbox. An arm that the parent makes before its agent
has read that notice finds the PR already reported, as it must (req 3, req 4):
the notice is in the inbox, and one read returns it.

A `delivery-failed` record, which only an older ShipIt wrote, reported nothing.
It keeps the `reportedPr` it inherited, not its own PR. `registerMergeWatch`
puts that PR at the front of the list of PRs that the new watch owes
(`unreportedPrs`, below), so the next arm reports it, does not depend on the
child's PR snapshot for it, and is not displaced by a PR that resolved in the
meantime.

**An arm applies to the next PR, whenever it is made (req 3).** The watch has
ended by the time its notice is in the inbox. So an arm at any later moment — in
the turn that reads the notice, or before that turn — is an ordinary arm of a
terminal watch: `registerMergeWatch` writes a new watch with the PR just
reported as its `reportedPr`. Nothing has to be queued.

The queued arm remains for a watch that an older ShipIt left in delivery
(above). `registerMergeWatch` sets `rearmedAt` on it and does not replace it,
because it still owns its wake turn. When that watch ends, `markDelivered` calls
`armFollowingWatch`, which writes a fresh `armed` watch in its place, with the PR
just reported as its `reportedPr`. `afterDelivered` then runs the register-time
check on the next tick. It runs after the write and not inside it: the write can
be part of the store's transaction, and a check that was scheduled inside a
transaction that rolls back would find the old watch and try again at once. A
restart before that tick is covered by the startup reconcile. No watch follows
for a parent that was archived in the meantime.

**Every watch armed now has a `watchId`,** as the self-watch always had. The watch
that follows is written in the same slot while an old wake's settlement can still
arrive, and `isCurrentWatch` compares ids strictly, so that settlement cannot mark
the new watch delivered. A watch armed by older code has no id and neither has its
settlement, so the two still match.

**A later PR is not lost between two arms (req 2).** One arm reports one PR, so a
watch that already reported, or an older one that holds PR #A in
`merge-observed`, does nothing with a terminal event for PR #B — except keep it:
the event is appended to the watch's `unreportedPrs` (`keepForNextArm`), oldest
first, without duplicates. (Before, a *closed* event that arrived during a merge delivery
overwrote the watch and sent a second wake from one arm.) The next arm inherits
the list — through `registerMergeWatch`, or through `armFollowingWatch` — and
reports its first entry. "First" holds against the poller too: a live event that
reaches an armed watch is appended, and the watch reports the head of the list,
which is that event only when nothing older is owed.

An archived parent is told nothing, so nothing is kept for it. At the next event a
live watch of an archived parent is dropped, as before, and a watch that already
reported loses its list (it keeps `reportedPr`).

Keeping the events on the watch is what makes this hold for a chaining child. The
child's PR snapshot is not enough: the child resets its branch at the start of its
own wake, and that docs/202 re-arm clears the snapshot within seconds of the
merge. The list helpers are in `merge-watch-prs.ts`. The list is read through
`unreportedPrs(watch)`, which leaves out the PR that the parent already knows, and
every write that carries it to another record reads it that way first. It holds at
most `MAX_UNREPORTED_PRS` entries, and past that a new PR is not kept (the
snapshot still shows the latest). The PR of a `delivery-failed` record, which
goes to the front, is exempt from that limit, so that it takes the place of no
PR that the watch already accepted.

For a PR that resolved while no watch record could keep it — a record that older
code wrote, or an event lost in a crash between the poller's write and its hook —
`unreportedPrFor` reads the child's stored state after the list, oldest first:

1. `previousMergedPr` — the merge that the docs/202 re-arm recorded when it
   cleared the snapshot. It is database-backed (verified at
   `services/pr-rearm.ts`: both re-arm functions call `clearMerged` with the
   merged PR before `PrStatusPoller.reArm`; the release-branch adoption in
   `services/release-branch-adopt.ts` re-arms without it). It counts only for a
   watch that has a `reportedPr`, and only when it is newer than that report: a
   higher PR number (one branch has one PR at a time, so its PRs are numbered in
   order), or the same number when the report was a close. A first arm does not
   read it and waits, as before: the child's last merge can be work that the
   parent never asked about.
2. The PR snapshot, when it is terminal and not the PR already reported.

**A limit that stays.** A `delivered` record that older code wrote has no
`reportedPr`. The first arm after it behaves as before the 2026-10-10 rework,
and can report that PR once more.

The CLI says which case an arm was: `armed`, `already armed`, or `armed for the
next PR; PR #N was already reported to this session`. For a watch that an older
ShipIt left in delivery it says `armed for the next PR; the notice about PR #N
is still in delivery`. A line below says where the notice arrives. The
`[merge-watch]` log line of each arm says the same.

## The wake turn — what a `--self` watch sends

Everything from here to *Correctness requirements* describes the wake turn.
Until docs/328 it carried a parent's notice too, and this text was written for
that case, so it says "parent" for the session that is woken. Only a session's
watch on its own PR sends a wake turn now (docs/239); a parent's watch from an
older ShipIt can still own one (*A watch that an older ShipIt left in delivery*,
above).

**Why `delivered` means "ran", not "enqueued" (the docs/196 restart fix).** The
dispatched turn lives only in the parent runner's **in-memory** queue until it
executes. If the watch were stamped `delivered` the instant the turn was
*enqueued* — as the original code did — an orchestrator restart (or a parent
idle-reap) between enqueue and execution would lose the queued turn while the
persisted watch already read `delivered`. `reconcilePending` only re-fires
`armed` / `merge-observed` watches, so a prematurely-`delivered` watch is skipped
forever: the card persists and rehydrates on reload, but the parent agent never
runs ("notification visually there, agent didn't start"). The fix advances to
`delivered` **only from the wake-turn's `onTurnComplete`** (the same
turn-completion signal the CI auto-fix loop awaits in `app-lifecycle.ts`).

> **Updated by docs/240 (planning#263).** That signal is now a *settlement* carrying a
> `TurnOutcome`, and `delivered` is stamped **only** when the outcome is a clean
> `completed` — or `interrupted`, a turn that reached the agent and was then cut
> short (planning#318). A wake-turn that errored, exited without ever producing a result
> (planning#262), or was dropped when the parent's queue was cleared records a failed
> attempt instead — and its delivery stops reading as in-flight the moment the
> turn settles — so the retry supervisor re-attempts it rather than the watch
> looking healthy while stranded.
> The two bullets below still describe *when* the signal fires.

- **idle parent** → `dispatch` starts the turn now → it completes → `delivered`.
- **mid-turn parent** → `dispatch` enqueues (never preempting). `onTurnComplete`
  rides the **in-memory queue** (carried by `toQueuedMessage` /
  `queuedMessageToDispatchOptions`), so when the queued turn later drains and
  runs it advances the watch to `delivered` **in-process** — no restart needed.
  The watch sits at `merge-observed` only for the window between enqueue and the
  turn actually running; a restart inside that window drops the queued turn and
  leaves the watch recoverable for `reconcilePending`. This holds on **both**
  drains — the dispatched turn's own and the interactive (WS) turn's — see
  *How a queued wake-turn survives the drain* below.

A restart at any point before the turn completes therefore leaves the watch
recoverable, and re-delivery never surfaces a second card.

**Duplicate-notification fix (busy-parent path).** The original code left the
mid-turn path's `onTurnComplete` *unwired* and relied solely on `onTurnComplete`
being "dispatch-only, not carried through the queue." A busy-parent watch
therefore never reached `delivered` even after its wake-turn ran — it stayed
`merge-observed` **forever**, so `reconcilePending` re-fired a fresh wake-turn on
**every** orchestrator restart. In a long fan-out where the parent is almost
always mid-turn, nearly every watch hit this path, producing the observed bursts
of duplicate "Child PR merged" wake-turns on each restart/reconnect. Carrying
`onTurnComplete` through the in-memory queue lets the busy path reach
`delivered` once the turn drains, so reconcile re-fires **only** the genuine
"restart lost the still-queued turn" case.

### How a queued wake-turn survives the drain (planning#256 / planning#257)

Carrying `onTurnComplete` on the queue is necessary but wasn't sufficient: two
defects in the shared dispatch path meant a wake-turn arriving at a *genuinely*
busy parent still lost it. Both are fixed; the mechanism now honors
"`delivered` means the turn ran" instead of quietly breaking it.

- **The wake-turn is never live-steered (planning#256).** `dispatch` consults
  `trySteerDispatch` before enqueueing, and `shouldSteerMessage` only asks
  whether the **currently running** turn is a system turn — nothing about the
  incoming one. With live steering on, a wake-turn arriving during an ordinary
  streaming *user* turn was therefore injected into that turn via
  `sendUserMessage`: the system instruction landed mid-context in someone else's
  turn (contradicting "never preempts a running turn"), and because the steer
  branch returns **before** any enqueue, `onTurnComplete` was dropped outright —
  the watch could never leave `merge-observed`. `isSteerableDispatch`
  (`dispatch-steering.ts`) now refuses to steer any dispatch carrying
  `systemTurn` **or** a completion callback, so such a turn always enqueues and
  always runs as its own turn.
- **Both queue drains preserve the full option set (planning#257).** A session has one
  queue but two drains: the dispatched turn's (`dispatched-turn.ts`) and the
  interactive WS turn's (`ws-handlers/agent-execution.ts`). Only the first
  restored `systemTurn` / `onTurnComplete`; the interactive one re-entered
  `runAgentWithMessage` with just text, attachments, and the agent session id. So
  a wake-turn queued behind a **user** turn — the common case, since a busy
  parent is busy precisely because a user turn is running — ran as an ordinary
  interactive turn and never signalled completion. Every queued entry is now
  **tagged** with the executor that must run it (`QueuedMessage.execution`:
  `"interactive"` for a user-typed WS message, `"dispatched"` for everything
  server-originated, which is also the default), and both drains route through
  `startQueuedMessage` (`queue-drain.ts`): a `"dispatched"` entry goes back
  through `runner.runDispatchedTurn` with the full option set, and only an
  `"interactive"` entry reaches a transport's narrower re-entry. A third drain
  added later cannot re-narrow an entry without deliberately bypassing that
  module.

  > **Falsified, then fixed properly (planning#261 → docs/240).** That last sentence
  > was wrong: turn adoption added a *fourth* hand-rolled drain days later, by an
  > author reasonably following the surrounding code. The rule is no longer a
  > convention — `dispatch` / `runDispatchedTurn` / `toQueuedMessage` accept only
  > a branded `PreparedDispatch` that only `prepared-dispatch.ts` can mint, so a
  > drain that builds an object literal does not compile.
- **A drained system turn runs as a system turn.** `dispatch` sets
  `systemTurnInProgress` synchronously only for a turn it starts from idle, so an
  *enqueued* system turn used to run steerable. `executeAgentTurn` now sets the
  flag from `input.systemTurn` as well (and clears it on teardown), so a
  wake-turn suppresses live steering for its whole duration however it started.

### Retrying a delivery that failed (planning#260)

The three fixes above make a *dispatched* wake-turn reliably reach `delivered`.
They say nothing about a delivery that never dispatched at all.
`attemptSelfWake`'s dispatch throws whenever the session can't be woken — its container won't
resume, the credential refresh fails, the worker is unreachable — and both this
doc and `merge-watch.ts` used to claim the watch was then retried "on the next
poll / reconcile". Only the reconcile half was real, and it has exactly one call
site: bootstrap. The poller's terminal callbacks fire behind `verifyMissingPr`'s
`alreadyTerminal` guard, so once the terminal PR snapshot is persisted **no later
poll re-enters delivery**. A failed delivery therefore sat at `merge-observed`
until someone restarted the orchestrator — the merge card in the parent's
transcript, the agent never starting: the same "notification visually there,
agent didn't start" symptom this doc was written to fix, reached by a different
route. Worse, `PollingGlobalGate` kept the poll loop alive *because* the watch was
pending, so the system burned polls forever without retrying the thing that
failed.

**Why a naive retry is wrong.** "Reconcile on every poll" reintroduces the
duplicate-wake bug fought twice above: `merge-observed` is ALSO the legitimate
state of a wake-turn that is **enqueued behind a busy parent**, and a parent turn
can run far longer than any poll interval. Re-firing every cycle would spam
duplicate wake-turns at exactly the busiest parents. The retry must therefore
distinguish **in-flight** from **failed**, and *time alone cannot do it*.

**What was built.** A self-managing retry supervisor inside `MergeWatchManager`
(`retryStalledDeliveries`, driven by a 30 s interval that exists only while some
watch sits at `merge-observed`, and stops itself the moment none does). Delivery
now runs through `attemptSelfWake`, which records the attempt on the persisted
watch *before* running it, and eligibility is decided on two independent axes:

1. **A durable delivery id, asked of the runner that owns it** — the precise
   signal. Every attempt is stamped `watchId:attempt` and persisted on the watch
   row alongside `deliveryAttempts`, so `isDeliveryInFlight` can ask
   `runner.hasDelivery(id)`: true while the wake-turn runs, and for the whole
   time it waits in the parent's queue. Such a watch is **never** re-fired. A
   parent runner that has since been **disposed** answers nothing, so the watch
   becomes retryable — a stranding case the pre-planning#260 code could only recover
   by restarting.

   > **planning#266 superseded the original form of this axis.** It used to be an
   > in-memory `inFlight` set — *tracked* state beside the thing it described,
   > which desynchronized from a disposed runner, a second runner for the same
   > session, and above all a turn ADOPTED after an orchestrator restart (the
   > adopted turn could settle nothing, so `reconcilePending` queued a duplicate
   > behind it). The id is sent to the worker and reported back on
   > `/agent/status`, so liveness is now *derived* from ground truth and survives
   > a restart. What remains in memory is a `dispatching` re-entrancy lock over
   > the one `await` where the delivery exists nowhere yet. See docs/240 § Fix C.
2. **Persisted `deliveryAttempts` + `lastAttemptAt` backoff — the safety net.**
   Even an eligible watch is re-attempted only once an exponential backoff (1 m,
   2 m, 4 m, 8 m, capped at 10 m) has elapsed, so a container that keeps failing
   to boot is probed on a sane cadence rather than every tick.

The attempt budget is capped at `MAX_DELIVERY_ATTEMPTS` (5). A wake that every
credential refused for quota spends none of it: it waits for the stated reset
instead (docs/306-quota-continuation, *A self wake that every credential
refuses*). On exhaustion the
watch moves to the terminal `delivery-failed` state and appends a **persisted**
note to the session's transcript (`emitNoticePostTurn`), which gives the attempt
count and the last error, and says the agent did **not** start so the user knows
to send a message. Being terminal also drops the watch out of
`listPendingMergeWatches`, which is what stops a permanently-failed watch from
holding the polling gate open forever. (Until docs/328 a parent's watch that gave
up appended a second card to the parent's transcript instead — the
`ChildMergedCard` `deliveryFailure` variant.)

**Why the supervisor lives in `MergeWatchManager`, not the poll loop.** The poll
loop does stay alive for a pending watch, which makes it a tempting host. But
`PrPollingSupervisor.tick` iterates *tracked, non-merged* sessions, and by the
time a watch is stalled its child has been promoted into `mergedSessions` and
archived — nothing in the poller's own bookkeeping is keyed to the stalled watch,
and the supervisor's arming is driven by `trackSession` / viewer events. Hanging
retry liveness off that would make it depend on unrelated state. The retry also
needs the delivery bookkeeping (mint, persist, rebind), which lives here — as
does `rebindDelivery`, the hook turn adoption calls to re-settle a delivery that
outlived a restart. A dedicated, self-stopping
timer is both simpler to reason about and directly testable
(`retryStalledDeliveries` is public), and it costs nothing in the steady state:
no watch at `merge-observed` ⇒ no timer.

**The closed-unmerged path has no wake turn.** A self watch whose PR closes is
cleared with a note. A parent's watch stores its notice (*The stored notice is
the delivery*, above).

## Correctness requirements (and how they're met)

- **No turn of its own in the parent (docs/328-session-message-inbox req 1).**
  The watch stores a notice and calls `SessionInbox.tell`. A busy parent gets a
  steered `[ShipIt]` line when its turn can take one, and otherwise nothing
  until it is idle; an idle parent gets one short turn for all its unread
  messages. Nothing is put in the parent's queue, and the poller event never
  calls `agent.kill()` / `dispose()` — same invariant as the rest of the
  poller-driven automations.
- **Survives an orchestrator restart.** The watch is persisted; on startup
  `MergeWatchManager.reconcilePending()` re-derives "child PR terminal + watch
  not ended → report", independent of whether the poller re-observes the
  (now-archived) merged child. A watch that already **observed** its merge
  carries the merge facts itself (`SessionMergeWatch.mergedPr`, written at
  `armed → merge-observed`, which is a self watch or an older parent's watch),
  and reconcile and the retry pass read them from there. The child's PR snapshot (`loadPersisted` seeds it) is the source for a
  watch still `armed`, and the fallback for a watch that observed its merge
  before `mergedPr` existed. The snapshot alone was not durable enough: a
  docs/202 re-arm nulls it, and a child that also watches its own PR resets its
  branch — a re-arm — in the wake turn of the very merge the parent is still
  waiting to hear about. The stored notice needs nothing from a restart: it is a
  row in the inbox, and the inbox's sweep tells a parent that was not told.
- **A parent that cannot be started loses nothing.** The notice is stored before
  anything is started, and the inbox tries the start again
  (`services/session-inbox.ts`). The self watch's wake turn keeps its own retry —
  see *Retrying a delivery that failed* above.
- **Fires headlessly — keeps the poll alive with no viewer.** The live (non-restart)
  fire path depends on a poll *observing* the child PR's terminal state, but the
  poll loop only runs while `PollingGlobalGate.isOpen()` is true. A child waiting
  on a human merge has no viewer and no armed remediation of its own, so without a
  signal the gate closes, the supervisor stops, and the merge is never observed
  until someone reopens a tab. The gate therefore treats *any* pending watch as a
  reason to keep polling: `hasPendingMergeWatch()` (backed by
  `SessionManager.listPendingMergeWatches()`) is wired into
  `anyAutonomousActionInFlight()` (`polling-global-gate.ts`). `reconcilePending`
  is the restart backstop; this is the steady-state one. Covered by
  `polling-global-gate.test.ts` ("a pending notify-on-merge watch keeps the gate
  open with no viewer").
- **Self-describing payload.** The notice carries the child's title and id, the
  PR number and title, and the intent — it depends on no in-memory state, so it
  stands alone however much later the agent reads it. The branch, PR URL and
  merge SHA are on the persisted card, not in the notice.
- **Persisted merge card, decoupled from the turn.** Surfaced via
  `chatHistoryManager.append` + a live `child_merged_card` WS emit (the card fires
  outside any turn, so it's an append, not `emitChatCard` — same pattern as
  `issue-lifecycle.ts`). Full at-rest-card contract: typed `childMerged` field on
  `PersistedMessage`, `child_merged` column + `toRow`/`fromRow` + migration,
  `CARD_MESSAGE_FIELDS` registration, client `ChildMergedCard`, and the two guard
  tests.

## Edge cases

- **Child PR not opened yet** → arm and wait; fires once it appears and resolves.
- **Child PR closed without merging** → distinct `closed-unmerged` notice +
  card; the parent is told the work did **not** ship.
- **Parent archived before the merge** → the watch is dropped silently when the
  PR resolves (`handleParentWatchTerminal` bails on `parent.archived ||
  userArchived`). Also refused at **arm time**: `registerMergeWatch` rejects
  (400) when the parent is archived, so a watch that could only ever be dropped
  is never even persisted. Both ends enforce the same invariant — an archived
  parent receives nothing. Only the parent's watch is dropped; the child's own
  self-watch still fires.
- **The child also watches its own PR** (`--self`, docs/239) → both watches
  fire on the one merge: a notice for the parent, a wake turn for the child. The
  register-time `checkAndFireNow` handles the parent's watch only; the startup
  reconcile takes each of the two down its own path.
- **PR already resolved when the watch is armed** (the poller won't re-observe an
  already-promoted session) → the register route fires a one-shot
  `checkAndFireNow` off the response path. It does not fire for the PR that an
  earlier arm of the same parent already reported (req 4); see *Arming again*.
- **Armed again before the notice was read** → an ordinary arm: the watch has
  ended, and the new watch skips the PR already reported (req 3, req 4).
- **The parent's agent waits for the user's answer** (docs/322) → the short turn
  for the inbox is an automatic turn, so it is not started and nothing is saved
  for later; the user's reply is a turn, and the notice rides it.
- **Only the parent that spawned the child may watch it** — reuses the
  `assertChildOfParent` cross-tenancy guard (404, never "wrong parent").

### Related hardening — archived sessions receive nothing

Notify-on-merge is the headline "updates from a child" channel, but the same
invariant — **an archived session is frozen and receives no updates from
children or anything else** — is enforced on the sibling out-of-turn delivery
paths:

- **Issue-lifecycle merge cards** (`issue-lifecycle.ts` `surfaceWriteCard`) skip
  the chat-history append + live emit for an archived session. The *outward*
  tracker write (closing the linked issue on PR merge) still happens — that's
  correct regardless of local session lifecycle — but no provenance card is
  pushed into an archived transcript.
- **WS activation** (`route-registry.ts` `activateSession`) refuses to
  `getOrCreate` a runner or re-track the PR poller for an archived session, so a
  stray connection to an archived session id can't boot a container or re-arm
  polling. The restore path (`unarchiveSession`) flips `archived → false` before
  the client activates, so the legitimate flow is untouched; history still loads
  read-only over HTTP.

Most other emit paths are runner-gated (an archived session has no runner) and
the PR poller only scans Active (`list()`) sessions, so the invariant holds by
construction elsewhere.

## Flow

```
shipit session notify-on-merge <child>   (shim, agent-shim/shipit.ts)
  → POST /agent-ops/session/notify-on-merge/:childId   (worker, agent-ops-routes.ts)
  → POST /api/sessions/:parentId/children/:childId/notify-on-merge   (api-routes-session-spawn.ts)
  → registerMergeWatch(...)   (services/child-sessions.ts) — persists armed watch

PR poller detects terminal PR state (verifyMissingPr)
  → onPrTerminalState(info)   (pr-status-poller.ts hook)
  → MergeWatchManager.handleChildPrTerminal(info)   (merge-watch.ts)
       ├─ SessionInbox.add(parent, notice, end the watch)   — one transaction
       ├─ surface persisted ChildMergedCard into the parent (append + live emit)
       └─ SessionInbox.tell(parent)   — steer, start one short turn, or later

Parent's agent, at a point that it chooses
  → shipit session inbox   — every unread message, this notice among them
```

## Key files

- `src/server/orchestrator/merge-watch.ts` — `MergeWatchManager`: fire / card /
  startup reconcile / register-time check. For a parent's watch: the notice and
  the end of the watch (`handleParentWatchTerminal`, `storeObservedMerge` for a
  watch from an older ShipIt, `tellParent`). For a self watch: wake-turn
  delivery and the planning#260 retry supervisor (`attemptSelfWake`,
  `retryStalledDeliveries`, `isDeliveryInFlight`, `failSelfWatch`,
  `MAX_DELIVERY_ATTEMPTS`).
- `src/server/orchestrator/services/session-inbox.ts`,
  `src/server/orchestrator/session-inbox-store.ts` — `add` stores the notice with
  the watch's own write in one transaction; `tell` is how the parent's agent
  learns of it (docs/328-session-message-inbox).
- `src/server/orchestrator/startup-monitors.ts` — stops the retry supervisor in
  the interval-cleanup `onClose` hook.
- `src/server/orchestrator/pr-status-poller.ts` — `onPrTerminalState` hook +
  `PrTerminalStateInfo`, fired at the terminal site in `verifyMissingPr` (merged
  AND closed).
- `src/server/orchestrator/services/child-sessions.ts` — `registerMergeWatch`
  (arms the watch, reuses `assertChildOfParent`; hands `reportedPr` and
  `unreportedPrs` to the new watch, or records `rearmedAt` on a watch that an
  older ShipIt left in delivery).
- `src/server/orchestrator/merge-watch-prs.ts` — the list of PRs that a watch
  still owes its parent: read, append, put first, write
  (`merge-watch-prs.test.ts`).
- `src/server/orchestrator/sessions.ts` — `merge_watch` column,
  `setMergeWatch` / `getMergeWatch` / `listPendingMergeWatches` (non-terminal
  only, so a `delivery-failed` watch stops holding the polling gate open). The
  list also returns each session's own docs/239 watch from `self_merge_watch`
  (`setSelfMergeWatch` / `getSelfMergeWatch`).
- `src/server/shared/types/domain-types/session.ts` — `SessionMergeWatch`,
  including `mergedPr`, the watch's own record of the merge it fires for, and
  `reportedPr` / `rearmedAt` / `unreportedPrs` for arming again.
- `src/server/orchestrator/session-runner.ts` +
  `src/server/orchestrator/dispatched-turn.ts` — the wake turn: `onTurnComplete`
  is carried through the in-memory queue (`QueuedMessage` / `toQueuedMessage` /
  `queuedMessageToDispatchOptions`) so an enqueued wake-turn signals completion
  when it drains, plus the `QueuedMessage.execution` tag and
  `runner.runDispatchedTurn` drain re-entry.
- `src/server/orchestrator/queue-drain.ts` — `startQueuedMessage`: the single
  router both drains use, so a queued entry always runs on the executor it was
  tagged for (planning#257).
- `src/server/orchestrator/dispatch-steering.ts` — `isSteerableDispatch`: a
  `systemTurn` / completion-callback dispatch is never steered (planning#256).
- `src/server/orchestrator/ws-handlers/agent-execution.ts` — the interactive
  drain routes through `startQueuedMessage`; `runQueuedInteractiveMessage` is
  reached only by `"interactive"` entries.
- `src/server/orchestrator/turn-executor.ts` — sets `systemTurnInProgress` from
  `input.systemTurn`, so a *drained* system turn also suppresses live steering.
- `src/server/orchestrator/api-routes-session-spawn.ts` — register route; logs
  each refusal with the `[merge-watch]` prefix (`registerMergeWatch` logs each
  arm).
- `src/server/session/agent-ops-routes.ts` — worker relay.
- `src/server/session/agent-shim/shipit-session.ts` — `notify-on-merge`
  subcommand.
- `src/server/orchestrator/chat-history.ts`, `src/server/shared/database.ts`,
  `src/server/shared/types/domain-types.ts`, `ws-server-messages.ts` — the
  `childMerged` persisted card + `child_merged` column + `WsChildMergedCard`.
- `src/client/components/ChildMergedCard.tsx`,
  `src/client/hooks/message-handlers/child-merged.ts`,
  `src/client/components/visual-elements.ts`,
  `src/client/components/MessageList.tsx` — client render + live handler. The
  card's optional `deliveryFailure` block is the planning#260 failure variant.
  No code writes it since docs/328; the client still renders the cards that are
  stored.
- `src/server/shipit-docs/sessions.md` — agent-facing reference.

## Tests

- `merge-watch.test.ts`, "a parent's watch on a child" — a merge and a close
  each give a card, a notice in the parent's inbox and an ended watch, and the
  parent is told; no turn is dispatched to a parent that is idle or busy; a
  repeated event, repeated restarts and the retry pass report nothing again; an
  archived parent drops the watch and gets nothing; reconcile and
  `checkAndFireNow`. "The notice and the end of the watch are one write", for a
  merge and for a close: when the watch cannot be ended no notice and no card
  are kept, and the next check reports the PR; when the notice cannot be stored
  the watch stays armed; and a transaction that fails at its end keeps neither.
- `merge-watch.test.ts`, "a wake turn that cannot be delivered is retried"
  (planning#260), on a self watch: a delivery that throws records the attempt and
  resolves rather than rejecting; it is retried in-process to `delivered` with
  no restart, both by an explicit pass and by the supervisor's own timer (fake
  timers); the backoff suppresses an immediate re-attempt; **a wake-turn queued
  behind a busy session is never re-fired however many retry passes run, and
  never burns attempts** (the duplicate-wake regression); a queued turn lost to
  a disposed runner IS re-delivered; attempts are capped to `delivery-failed`
  with a persisted note and an empty pending list; a `delivery-failed` watch is
  never resurrected by a retry / reconcile / re-observation; an archived session
  drops the watch mid-retry; the durable delivery id, and `rebindDelivery`.
- `merge-watch.test.ts`, "a session watched by its parent AND by itself"
  (docs/239): one merge tells the parent and wakes the child, also when the two
  paths run at the same time; the child's wake turn in delivery does not hold
  the parent's notice, and a wake that fails leaves the parent told; the pending
  list works per watch; a closed PR tells the parent and clears the self-watch
  with its note; an archived parent drops only its own watch; and a parent's
  notice that could not be stored is stored by a **fresh** manager at the next
  startup, from the child's stored PR state.
- `merge-watch.test.ts`, "a parent that follows a child across several PRs" —
  the requirements one by one: an arm made before the parent read the notice
  applies to the next PR, and one read then returns both notices; two later PRs
  are reported in order, one for each arm, from the watch's own copy; a live
  event does not overtake a kept PR; an arm after the notice does not repeat the
  PR, nor does a terminal event that the poller repeats; a PR that merged in
  between is found on the watch, in `previousMergedPr` and in the snapshot,
  oldest first; an archived parent gets nothing kept, loses its watch at a
  repeated event and its kept list at the next one; a kept PR that the parent
  already knows does not come back; a PR reported as closed and then merged is
  reported; a first arm does not read `previousMergedPr`; and a watch with no id
  hands over what it reported.
- `merge-watch.test.ts`, "a parent's watch that an older ShipIt left with a wake
  turn in delivery" — no notice is stored while that turn can still end (on a
  runner, or held for the user's answer with no runner), and its end closes the
  watch; a turn that did not survive the restart, or that ends with no result,
  has its notice stored, with no second card, no new wake turn, no attempt
  counted and for a busy parent too; a record with no merge facts records the PR
  it reports, and the next arm does not repeat it, and with no turn it reports a
  later PR that closed; a store that fails at its end is not tried again at
  once, and the watch's own timer tries it; an arm made during that turn is
  queued, a second one changes nothing, the old settlement cannot end the watch
  that follows, and the queued arm survives a restart with the turn or without
  it; PRs that resolve during that turn are reported to the arms that follow,
  and a close does not replace it; no watch follows for an archived parent; and
  a `delivery-failed` record stays as it is until the next arm, which reports
  its merge before a PR kept in the meantime.
- `session-inbox-store.test.ts`, `services/session-inbox.test.ts` — the message
  and the sender's own write are stored together or not at all; `add` stores
  and starts nothing until `tell`.
- `ChildMergedCard.test.tsx` — the three card variants (merged, closed-unmerged,
  delivery-failure), including that the failure copy replaces the success copy.
- `services/child-sessions-wait.test.ts` — `registerMergeWatch` arm-time guards:
  arms when active, rejects (400) an archived parent (no watch persisted) and an
  archived child. Against a child that holds its own live self-watch: arms
  beside it and leaves it as it was, on a first arm, an `alreadyArmed` re-arm
  and a re-arm over a terminal watch; and each arm writes a `[merge-watch]` log
  line.
- `issue-lifecycle.test.ts` — an archived session still gets the outward tracker
  write on merge but **no** provenance card appended or emitted.
- `pr-status-poller.test.ts` — `onPrTerminalState` fires on merged AND closed.
- `integration_tests/session-notify-on-merge.test.ts` — through a fully-wired
  `buildApp`: register (happy / cross-tenancy 404) → merge → persisted parent
  card, a watch that ends at once, and one short turn for an idle parent whose
  prompt holds the inbox line and no PR text → the read route returns the notice
  one time → fire-once → closed-unmerged. A parent that is busy with a **real
  interactive turn** gets nothing in its queue, and is told when that turn ends.
  A restart after the notice was stored reports nothing again. A parent whose
  runner cannot be created still has an ended watch, one card with no failure
  block, and the notice in its inbox. The chain: merges seen by the real poller,
  the parent arming in the turn in which it reads each notice, one notice for
  each PR and none twice. And the docs/239 pair: the parent's arm and the
  child's self-arm leave each other in place in both orders, and one merge seen
  by the real poller (`forceVerifySessionPrState`) tells the parent and starts
  a wake turn in the child.
- `integration_tests/restart-delivery-identity.test.ts` — a watch-originated
  turn that outlived a restart is adopted, settles its watch, and puts nothing
  in the inbox; a self watch whose turn died is dispatched one more time; a
  parent's watch from an older ShipIt whose turn died has its notice stored, and
  no turn starts.
- `integration_tests/system-turn-queue.test.ts` — the two dispatch-path
  regressions against a real turn (the fake busy runner in `merge-watch.test.ts`
  cannot reproduce either): with live steering on a `systemTurn` dispatch queues
  instead of being steered and its `onTurnComplete` still fires (planning#256); a
  wake-turn queued behind a real interactive turn runs as a system turn and fires
  its callback (planning#257); and an ordinary user message queued behind a running
  turn still drains on the interactive path (no duplicate echo bubble).
- `queue-drain.test.ts` — the drain router: a `"dispatched"` entry never reaches
  the interactive re-entry, an `"interactive"` one always does, the deps-less
  fallback, and a round-trip guard that fails if a new `AgentDispatchOptions`
  field is not carried through the queue.
- `session-runner.test.ts` — a `systemTurn` (or completion-callback) dispatch
  enqueues rather than steering, even with live steering on and a streaming turn
  in flight, and the queued entry keeps its callback.
- `chat-history.test.ts` + `visual-elements.test.ts` — the at-rest-card guard
  contract (round-trip + empty-text carrier).
