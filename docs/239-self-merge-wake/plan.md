---
issue: https://linear.app/shipit-ai/issue/SHI-253
title: Self-merge wake — continue a session automatically when its own PR merges
description: A session arms an intent-carrying watch on its own PR and is woken by one system turn — on a freshly reset branch — once that PR merges.
---

# Self-merge wake (`shipit session notify-on-merge --self`)

## Problem

docs/196 wakes a **parent** session when a **child's** PR merges. Nothing wakes a
session when its **own** PR merges.

For the "several PRs in a row from one session" workflow that is the missing half.
The user says "ship this, then do the API half", the PR opens, and then the chain
stops dead: the merge happens hours or days later, and the only way work resumes is
the user noticing and sending another message. Worse, today's merge path
deliberately **quiets** the session — `markMergedAndPruneExcess` marks it merged and
deletes the remote head branch, `useSessionGrouping` sinks the row into "Recently
resolved", and `computeAttentionReason` is fed `resolved: true` so `useAttentionInfo`
suppresses the attention bar. Every one of those is correct under the assumption the
whole merge path is built on — **1 session = 1 PR = done** — and that assumption is
what breaks for a session that is merely *between* PRs.

## Scope — an armed intent, not a merge notification

This feature covers **only** the case where a follow-up was explicitly stated.
Notifying the user on *every* own-merge was considered and **rejected**:

- We cannot distinguish "this session is finished" from "this session is between
  PRs", so any persistent signal nags every genuinely-shipped session forever.
- The browser-notification pipeline is **state-derived**, not event-derived:
  `useAttentionNotifications` fires `notify()` off a `null → reason` transition of
  `computeAttentionReason`, the same function that drives the sidebar bar (they are
  deliberately coupled so they "can never disagree"). Adding a merged reason there
  buys a notification *and* an amber needs-attention bar on every merged session,
  sitting in the group literally named "Recently resolved".

An edge-triggered notification (one-shot SSE → `notify()`, bypassing
`computeAttentionReason`) remains a possible separate feature. It is not this one,
and this design does not depend on it.

## Model

```
shipit session notify-on-merge --self --then "<instruction>"
  → persist an armed self-watch + surface a cancellable arm card
  → (turn ends; hours or days pass; the user merges the PR)
  → poller detects the merge → merge bookkeeping completes
  → CAS-claim the watch, revalidating the PR identity
  → reserve a system-turn slot, THEN reset the branch inside it
  → run ONE system turn carrying <instruction>
  → the turn ends at a new PR and stops
```

The `--then` payload is the whole difference from docs/196. A child wake-turn can
say "proceed with the planned integration" because the *dependency* is the intent; a
self-wake has no such structural intent, so without a captured instruction it has
nothing to act on.

The agent arms this **only** when the user has stated a follow-up. It is never
armed by default, and never inferred from the mere existence of a PR.

## Prerequisites — all three fixed

Cross-agent review (see *Review notes*) found that three mechanisms this design
intended to reuse were **already broken for docs/196**, in ways that would have
reproduced the exact duplicate-wake bug that doc believed it had closed. All three
are now fixed and merged, and the third one's fix supplies machinery this design had
planned to build itself — see *What P3's fix changes here*.

**P1 — a system turn could be live-steered into a running user turn.
✅ Fixed (SHI-254).** `dispatch` consulted `trySteerDispatch` before enqueueing even
for `systemTurn` dispatches, and `shouldSteerMessage` only asked whether the
**currently running** turn was a system turn — never the incoming one. A wake-turn
arriving during a streaming user turn was injected into that turn, and since the
steer branch returns before any enqueue, `onTurnComplete` was dropped. Now
`isSteerableDispatch` refuses to steer any dispatch carrying `systemTurn` **or** a
completion callback, so it always enqueues and always runs as its own turn.

**P2 — the interactive queue drain lost `systemTurn` and `onTurnComplete`.
✅ Fixed (SHI-255).** One queue, multiple drains, and only the dispatched one
restored the full option set. Every queued entry now carries a required
`QueuedMessage.execution` tag (defaulting to `"dispatched"`, the superset path) and
both drains route through `startQueuedMessage` (`queue-drain.ts`), so a
server-dispatched entry always re-enters via `runner.runDispatchedTurn`. The fix
also caught a **third** narrowing drain (`drainQueueForSession` in
`bootstrap-managers.ts`) and a related gap where `executeAgentTurn` set
`systemTurnInProgress` only for a turn started from idle — so a *drained* system
turn used to run steerable.

What this buys the self-wake: a delivery dispatch now reliably enqueues behind a
busy session, runs as a genuine system turn, and fires `onTurnComplete` in-process —
which is what the `completed` / `failed` transitions below depend on.

**P3 — delivery failure had no retry before restart. ✅ Fixed (SHI-258).** The
design originally said a failed delivery is retried "on the next poll". False: the
terminal callbacks fire only when `alreadyTerminal` is false, and `reconcilePending`
had exactly one call site, bootstrap. A wake / boot / reset exception stranded the
watch until the orchestrator restarted. `MergeWatchManager` now carries a retry
supervisor: a self-stopping 30s timer re-attempts stalled deliveries, gated on an
in-memory `inFlight` set plus a persisted `deliveryAttempts` / `lastAttemptAt`
exponential backoff, capped, terminating in a `delivery-failed` state with a
persisted failure card.

### What P3's fix changes here

It mattered more for a self-wake than for a child watch, because the failure modes
*this* design adds — workspace restoration, the reset coordinator, container boot for
an idle-reaped session — are exactly the ones that throw. That risk is now retired,
and three pieces this design planned to build itself already exist:

- **The delivery lease is built.** The state machine below called for a per-watch
  in-flight lease so `checkAndFireNow` and the poller couldn't both enqueue. That is
  what the `inFlight` set is, with a subtlety worth inheriting rather than
  re-deriving: it is deliberately **not persisted**, because the queued turn and its
  callback are in-memory too, so a restart correctly empties it and hands recovery
  back to `reconcilePending`. It also drops the marker when the parent's runner has
  been disposed, since the queued turn went with it.
- **The fire-once guard is centralized.** `isTerminalWatchState` is the single
  terminal check; a self-watch's extra terminal states (`expired`, `cancelled`,
  `delivery-failed`) must join it rather than adding a parallel predicate.
- **Terminal watches release the polling gate.** A terminal watch drops out of the
  pending list, so it stops holding `PollingGlobalGate` open for a wake that will
  never happen. The self-watch's `expired` / `cancelled` / `blocked` states need the
  same treatment or they leak a permanently-open poll gate.

The open question this raises is **whether the retry supervisor should be generalized
over both watch kinds or duplicated**. It is currently written against
`SessionMergeWatch` and the child-delivery path. Duplicating it for self-watches
would be a second copy of the trickiest logic in the subsystem — the in-flight/backoff
split that keeps a merely-queued turn from being re-fired. Generalizing it is the
better end state, and it partially cuts against the "distinct `SelfMergeWatch` type"
decision below: the two watch kinds want different *identity* fields but the same
*delivery* fields. Likely shape: a shared `WatchDelivery` sub-record (attempts,
lastAttemptAt, lastError, failedAt) embedded in both types, with the supervisor
generic over "things that have a delivery record and a deliver() function".

## Why the firing point is `onMergeDetectedCb`, not `onPrTerminalState`

The obvious hook is the one docs/196 already uses. For a self-watch it is **wrong**.

In `verifyMissingPr` the terminal-merge block runs, in order: persist the terminal PR
snapshot → launch `onPrTerminalState` (fire-and-forget) → **synchronously** write
`setMergedHeadSha` → launch `onMergeDetectedCb` (fire-and-forget). A self-wake hung
off `onPrTerminalState` therefore starts before `mergedHeadSha` is stored and before
`markMergedAndPruneExcess` has stamped `mergedAt` or attempted the remote-branch
deletion — so every clause of docs/218's reset gate fails and the woken turn lands on
an un-moved branch at the merged tip.

The correct site is **inside `onMergeDetectedCb`, after `markMergedAndPruneExcess`
resolves** — next to the existing `emitResetEligibleSignal` call. `app-lifecycle.ts`
genuinely awaits it, and it stamps `mergedAt` synchronously, so the reset gate's
persisted inputs are all committed by then. Two precision notes: the remote-branch
deletion is **best-effort**, so only the *attempt* has completed (the force-push heal
below must not assume the branch is gone); and docs/196's `onPrTerminalState` path
stays untouched for child watches.

### The site is ordering-safe but not generation-safe

`markMergedAndPruneExcess` stamps `mergedAt` **before** awaiting the remote deletion.
During that await a concurrent turn can complete, docs/202's re-arm can detect
progress, and `clearMerged` can wipe `mergedAt` **and** `mergedHeadSha` and re-arm the
poller against a *new* PR. The original callback then resumes and would claim the
watch with no terminal-PR identity in hand — the reset correctly fails, but the stale
follow-up would still run against freshly re-armed work.

So delivery must be **generation-checked**, not merely ordered: carry `prNumber` and
the merged head SHA into the delivery, and CAS-revalidate that the session still
represents *that* merge before claiming the watch. A terminal event for an old PR
must never consume a watch that is now waiting on a newer one.

### Closed-without-merge needs its own fan-out

`onMergeDetectedCb` fires only for `isMerged`. Closed-without-merge is exposed
**only** through `onPrTerminalState`. So the `expired` transition below cannot hang
off the merge callback — it must fan out from `onPrTerminalState`, which is safe
precisely because it does no reset and starts no turn (it needs none of the
bookkeeping the merged path waits for).

## The reset must run inside the reserved turn slot

docs/218's reset is not merely *gated off* for system turns — it is on a different
code path. `autoResetMergedBranchOnContinue` is called only from
`runAgentWithMessage` (`ws-handlers/agent-execution.ts`); a dispatched system turn
runs through `dispatch` → `runDispatchedTurn` and never passes it. So the delivery
path must invoke the reset itself.

**But not before `dispatch`.** A `fetch → reset --hard → forcePush` sequence run
ahead of dispatch sits entirely outside turn serialization: `dispatch` only sets
`running` / `systemTurnInProgress` synchronously at its own entry, so a normal user
turn can be running — or can start — during the reset's awaits. A tree that is clean
when the gate samples it can be dirty a moment later, and the reset then moves the
branch underneath a live agent. The reset also takes no workspace mutex (unlike
post-turn commit), does not coordinate with a pending debounced auto-push, and a
pending watch counts as neither `agentBusy` nor a viewer, so disk-tier descent can
evict the workspace mid-operation.

So: **reserve the system-turn slot first** (runner marked busy before the first
await), then run the reset preflight inside it, under the workspace mutex, with any
pending push timer cancelled or serialized.

### A reset coordinator, not the raw helper

"Reuse `autoResetMergedBranchOnContinue` unchanged" was wrong on two counts.

1. **It respects the global `autoResetMergedBranch` setting.** A user who turned
   interactive auto-reset *off* would get an un-moved branch on a self-wake despite
   having given explicit per-arm consent — which also contradicts this design's "no
   global setting" decision. Consent must be an explicit **policy** on the call
   (`interactive-setting` vs `self-watch`), not an ambient global.
2. **The interactive caller does more than call the helper.** Around it,
   `agent-execution.ts` performs the immediate docs/216 PR-card re-arm, pushes the
   `reset_eligible` update, and emits the persisted branch-reset card. A raw helper
   call skips all three.

Extract a **reset coordinator** owning: gate → fetch → re-gate → reset → force-push
heal → re-arm → `reset_eligible` → persisted card → a durable **`reset-complete`**
substate recorded *before* the turn is enqueued. Without that substate, a crash
between the force-push and dispatch is unrecoverable-by-inspection: on restart the
gate reports "not moved" because HEAD already sits at the base, so neither the
transcript nor the wake prompt can truthfully say what happened.

### Consent, and why the gate now fails **closed**

Narrowing docs/218's "interactive path only" boundary is still justified — that
boundary was about *absent consent*, and here the arming is the consent, more
explicit than the composer checkbox it substitutes for. But the **fail-open**
behavior does not carry over. docs/218 runs the turn anyway on a failed gate because
a human has *just typed*; an arm from days ago is not consent to consume whatever
happened since. A dirty tree, moved HEAD, wrong branch, or in-progress sequencer are
all evidence that work occurred after arming, and running the follow-up regardless
risks stacking it on rejected commits and letting post-turn auto-commit sweep up
unrelated WIP.

So a safety-gate failure **fails closed**: persist a `blocked` state, retain the
instruction, surface it on the card, run **no** turn. Only transient infrastructure
failures (fetch, container boot) retry. This also gives "the user redirected while
armed" a structural boundary that needs no content heuristic.

## State machine

Stored in a **separate `self_merge_watch` column** with a **distinct
`SelfMergeWatch` type** and its own `listPendingSelfMergeWatches`.

The original plan — reuse `SessionMergeWatch` and extend `listPendingMergeWatches` —
does not leave docs/196 untouched, which was the whole point of a separate column:
that type structurally requires `parentSessionId` and child-specific states, the
existing list returns `{ childSessionId, watch }`, and startup reconciliation feeds
every result to the **child** handler. Without a discriminator, self entries get
misrouted as child watches. A distinct type carrying a stable `watchId` and
generation is the fix (the generation is also what finding "generation-safe" above
needs).

```
armed ──CAS claim──▶ merge-observed ──reset ok──▶ reset-complete ──turn RAN──▶ completed
  │                        │                                          └──▶ failed
  │                        └──gate failed──▶ blocked  (terminal until user acts)
  ├──PR closed unmerged──▶ expired    (terminal, NO turn)
  └──CAS cancel──▶ cancelled          (terminal)
```

`armed → merge-observed → …` reuses docs/196's machine including its load-bearing
rule that a delivered state means **the turn ran**, not that it was enqueued —
stamped from `onTurnComplete`. Getting that wrong produced docs/196's two historical
bugs, and P1/P2 above show the mechanism it depends on is not yet trustworthy.

**Every transition is a DB-level CAS**, not a read-then-write. The existing manager
reads a watch and later writes unconditionally, which here would let a Cancel that
has already read `armed` be overwritten by delivery — producing a "cancelled" card
followed by a reset and a turn. `armed → merge-observed` claims delivery;
`armed → cancelled` claims cancellation; the loser gets a conflict result (Cancel
reports "too late"). `merge-observed` is a *retryable* state, not an exclusive lease,
so delivery additionally needs a per-watch in-flight lease keyed on `watchId` —
otherwise `checkAndFireNow` and the poller callback can both enter it and enqueue
twice.

**Terminal states must be truthful.** `completed` is not "a PR exists":
`onTurnComplete` fires on agent **error** too, and `wakeSessionWithTurn` currently
discards the `errored` outcome — so a naive `delivered` would claim success for a
turn that crashed. Auto-create-PR is also user-controlled and **off** by default, so
a successful turn need not produce a PR. Hence `completed` / `failed` /
`completed-without-pr`, with the outcome preserved through the wake path.

`reconcilePending` on boot re-fires non-terminal watches, and
`hasPendingSelfMergeWatch()` must join `anyAutonomousActionInFlight()` in
`PollingGlobalGate` — it matters more here than for children, since a session waiting
on its own merge has no viewer. Per P3 that gate keeps *polling* alive but does not
by itself retry a failed delivery.

### `expired` — closed-without-merge does **not** wake (decided)

docs/196 wakes the parent on a closed-unmerged child, deliberately, so it cannot
proceed as if the work shipped. A self-watch does the opposite: it drops the intent
and records that it expired, with **no turn**. The reason is mechanical — the reset
gate requires `mergedAt` + `mergedHeadSha`, and a closed PR sets `closedAt` instead,
so the branch stays exactly where it is and a woken follow-up would stack new work on
the very commits that were just rejected.

The expiry is **not** silent: the arm card patches to `expired` and states the
dropped follow-up, so scrolling back shows what did not happen.

## The arm card

The arm is **do-then-surface** (mirroring `shipit issue create`): the agent arms it
and a card appears in the transcript stating the captured follow-up, with a
**Cancel** that works any time before the merge.

The original plan reached for the `upsertReleaseCard` pattern because the *later*
transitions fire outside any turn. That is the wrong primitive for the **arm**: the
arm is issued by an agent tool call **while the arming turn is still in progress**,
which is exactly the HTTP side-channel shape CLAUDE.md's transcript-persistence
invariant covers, and `upsertReleaseCard` deliberately appends at the end because
release proposals land *after* a finalized turn. A card appended that way lands at
the wrong transcript position and can be clobbered when the in-flight turn finalizes
its `recordedCards`.

So: **arm via `emitChatCard`** (atomic emit + in-band record anchored by
`afterGroupIndex` + persist-in-progress), and drive every later transition through
**`persistCardTransition`**, which patches the recorded in-progress card when the
proposing turn is still live and falls back to a finalized-row patch otherwise —
the race it exists for.

**A distinct card type is still right here, despite the SHI-258 precedent.** That fix
added its delivery-failure state as an optional `deliveryFailure` block on the
existing `ChildMergedCard` rather than a new type + migration, on the grounds that the
failure concerns the same child and PR and so reuses the same identity fields and
persistence wiring. The test it implies is "same identity?", not "fewer card types" —
and an armed self-watch is a different subject (a pending intent on *this* session's
own PR, with a Cancel affordance and a follow-up instruction to render), so it earns
its own type. Its *terminal* states, however, should follow the precedent and ride
the same card as additional blocks rather than spawning sibling types.

Full at-rest contract: typed `selfMergeWatch` field on `PersistedMessage`,
`self_merge_watch_card` column + `toRow`/`fromRow` + `database.ts` migration,
rehydrate in `loadSessionHistory`, register in `CARD_MESSAGE_FIELDS` +
`EVERY_OPTIONAL_FIELD_MESSAGE`, and add the WS type to `TRANSCRIPT_SCOPED_MESSAGES`.
Cancel follows the bug-report / egress precedent: a WS message → handler → CAS the
watch → patch the card.

## One turn, one PR, then stop (decided)

The woken turn does the follow-up and stops. It must **not** arm another self-watch,
so a merge cannot start an unbounded unattended chain — and that has to be a
**server-side refusal** while a watch is non-terminal, not prompt prose, since
nothing otherwise stops the woken agent from calling `--self` again.

The PR itself is best-effort, not guaranteed (auto-create-PR is off by default), which
is why the terminal states above distinguish `completed-without-pr`. Where a PR *is*
created, docs/202's re-arm handles the card: after the reset `HEAD == origin/<base>`,
the turn commits, and the re-arm opens a **new** PR on the same branch — the
sequential-PR shape this feature exists for.

## Staleness

The follow-up may be stale by the time a human merges days later. This is **not**
specific to self-watches — docs/196 has the same exposure and already mitigates it in
`buildWakeTurnPrompt` ("*unless the user has since redirected you*" + "*review this
session's earlier messages*"). The mitigation stays **shared**: add a `self` branch to
that existing prompt builder rather than writing a parallel one, so the escape clause
cannot drift. The fail-closed gate above is the structural half of the same concern.

The one asymmetry is how likely staleness is to bite, and it argues for keeping this
opt-in. A child watch is armed against a **dependency** — once it merges, integrating
it is usually still right. A self-watch is armed against a **plan**, and plans are
exactly the thing that goes stale.

## Edge cases

- **PR not open yet when armed** → arm and wait (same as docs/196).
- **PR already merged when armed** → the poller won't re-observe it, so the register
  route fires a one-shot `checkAndFireNow` — which must take the same delivery lease
  as the poller path, or both enqueue.
- **Container idle-reaped** → `wakeSessionWithTurn` owns stale-runner teardown,
  container resume, and credential refresh.
- **Workspace disk-evicted** → **not** covered by the above: `wakeSessionWithTurn`
  only checks that `workspaceDir` metadata is non-null and then creates a runner,
  while container creation fails outright when the directory is missing. The delivery
  path must call the workspace restoration service explicitly before the reset.
  A pending watch also does not currently prevent tier descent from evicting the
  checkout in the first place.
- **Reset gate fails** → fail **closed**: `blocked`, instruction retained, card
  updated, no turn (see above).
- **Session archived before the merge** → drop the watch at delivery and refuse at
  arm time, mirroring docs/196's both-ends enforcement.
- **User keeps working while armed** → the watch survives; the escape clause plus the
  fail-closed gate cover redirection (see "No auto-disarm" below).
- **docs/202 re-arm before the merge** → the generation check makes the stale
  terminal event a no-op; the watch stays armed against the new PR.

## Flow

```
shipit session notify-on-merge --self --then "<instruction>"   (agent-shim/shipit-session.ts)
  → POST /agent-ops/session/notify-on-merge/self               (agent-ops-routes.ts)
  → POST /api/sessions/:id/self-merge-watch                    (api-routes-session.ts)
  → registerSelfMergeWatch — persist armed watch, emitChatCard arm card, checkAndFireNow

PR poller: verifyMissingPr, merged
  → setMergedHeadSha → onMergeDetectedCb → await markMergedAndPruneExcess
      → handleSelfMerge(sessionId, { prNumber, headSha })      (merge-watch.ts)
           ├─ CAS claim armed → merge-observed (generation-checked)
           ├─ restore workspace if evicted
           ├─ reserve system-turn slot (runner busy)
           ├─ reset coordinator → reset-complete   (or → blocked, stop)
           └─ run the turn → onTurnComplete → completed / failed / completed-without-pr

PR poller: verifyMissingPr, closed-unmerged
  → onPrTerminalState → expireSelfWatch  (CAS → expired, card patched, no turn)
```

## Key files

| Area | File | Change |
|---|---|---|
| ~~P1~~ ✅ | `src/server/orchestrator/dispatch-steering.ts` | Done (SHI-254) — `isSteerableDispatch` |
| ~~P2~~ ✅ | `src/server/orchestrator/queue-drain.ts` | Done (SHI-255) — `QueuedMessage.execution` + `startQueuedMessage` |
| ~~P3~~ ✅ | `src/server/orchestrator/merge-watch.ts` | Done (SHI-258) — retry supervisor, `inFlight` set, `isTerminalWatchState`, `delivery-failed` |
| Retry reuse | `src/server/orchestrator/merge-watch.ts` | Generalize the SHI-258 supervisor over both watch kinds (shared delivery record) rather than duplicating it |
| Watch state | `src/server/orchestrator/sessions.ts` | `self_merge_watch` column, CAS transitions, `listPendingSelfMergeWatches` |
| Persist | `src/server/shared/database.ts` | `self_merge_watch` + `self_merge_watch_card` columns + migrations |
| Type | `src/server/shared/types/domain-types/session.ts` | Distinct `SelfMergeWatch` (watchId, generation, `followUp`, full state set) |
| Fire point | `src/server/orchestrator/app-lifecycle.ts` | `handleSelfMerge` after `markMergedAndPruneExcess`, with PR identity |
| Expiry | `src/server/orchestrator/pr-status-poller.ts` | Fan closed outcomes out to `expireSelfWatch` |
| Delivery | `src/server/orchestrator/merge-watch.ts` | `handleSelfMerge`; generation check; delivery lease; `self` branch in `buildWakeTurnPrompt` |
| Reset | `src/server/orchestrator/services/pre-turn-reset.ts` (+ new coordinator) | Consent policy arg; extract coordinator (re-arm + `reset_eligible` + card + `reset-complete`) |
| Workspace | `src/server/orchestrator/services/session.ts` | Restore an evicted checkout before reset/wake |
| Wake | `src/server/orchestrator/wake-session.ts` | Preserve the `errored` turn outcome |
| Poll gate | `src/server/orchestrator/polling-global-gate.ts` | Count pending self-watches |
| Arm + cancel | `src/server/orchestrator/api-routes-session.ts`, `ws-handlers/` | Register route (refuse while non-terminal); `cancel_self_merge_watch` |
| Card | `src/server/orchestrator/chat-card-persistence.ts`, `chat-history.ts` | `emitChatCard` arm + `persistCardTransition` for transitions |
| Agent surface | `src/server/session/agent-shim/shipit-session.ts`, `agent-ops-routes.ts` | `--self` + `--then`; container-accessible route golden test |
| Client | `src/client/components/`, `hooks/message-handlers/index.ts`, `components/visual-elements.ts` | Card + handler; `CARD_MESSAGE_FIELDS`; `TRANSCRIPT_SCOPED_MESSAGES` |
| Agent docs | `src/server/shipit-docs/sessions.md` | `--self --then`, one-attempt rule |

## Testing

- P1–P3 already carry their regressions (`system-turn-queue.test.ts`,
  `queue-drain.test.ts`, and the `failed-delivery retry (SHI-258)` block in
  `merge-watch.test.ts`). This design's tests should assert **against** those
  guarantees rather than re-prove them — but if the retry supervisor is generalized
  over both watch kinds, its "a turn queued behind a busy parent is never re-fired"
  regression must be re-run for the self-watch path, since that is the duplicate-wake
  trap and a generalization is exactly where it would be lost.
- `merge-watch.test.ts` — fire-once; terminal-means-ran; `expired` with no dispatch;
  `blocked` on a failed gate with no dispatch; cancel-vs-merge CAS both orderings;
  `checkAndFireNow`-vs-poller double-enqueue; archived drop; reconcile without a
  second card.
- Generation — a terminal event for a docs/202-superseded PR does not consume a watch
  armed against the new one.
- Reset — runs inside the reserved slot; holds the workspace mutex; coordinates with a
  pending auto-push; crash after force-push before dispatch recovers via
  `reset-complete`.
- Workspace — evicted checkout is restored before the reset (distinct from the
  idle-reaped-container case).
- `polling-global-gate.test.ts` — a pending self-watch keeps the gate open with no
  viewer.
- Card — arm and cancel/merge **within the same still-running turn**, then switch and
  reload; round-trip; no duplicate on replay; `CARD_MESSAGE_FIELDS` +
  `EVERY_OPTIONAL_FIELD_MESSAGE`.
- Integration — arm → merge → reset + one turn + new PR; the woken turn's `--self`
  re-arm is refused server-side; WS disconnect / no viewer during delivery.

## Resolved decisions

- **Intent-armed only**; a general own-merge notification is out of scope.
- **Fire from `onMergeDetectedCb` after the merge bookkeeping**, generation-checked;
  **closed outcomes fan out from `onPrTerminalState`** (the merge callback never sees
  them).
- **Distinct `SelfMergeWatch` type + column + list**, so docs/196 is genuinely
  untouched rather than nominally so.
- **Reset runs inside the reserved turn slot**, under the workspace mutex, via a
  reset coordinator with an explicit consent policy — not the raw helper before
  dispatch.
- **The safety gate fails closed** (`blocked`, no turn). This reverses the original
  fail-open decision: docs/218's fail-open is licensed by a human having just typed,
  which a days-old arm does not supply.
- **Every watch transition is a CAS**, with a delivery lease keyed on `watchId`.
- **Closed-without-merge → `expired`, no wake-turn**; recorded on the card.
- **Arm card via `emitChatCard` + `persistCardTransition`** (the arm happens
  mid-turn), not the `upsertReleaseCard` append pattern.
- **One unattended attempt**, enforced by a server-side re-arm refusal; terminal
  states distinguish `completed` / `failed` / `completed-without-pr` rather than
  claiming a PR that may not exist.
- **Staleness mitigation shared with docs/196** via one `buildWakeTurnPrompt`.
- **No auto-disarm on user redirect.** There is no reliable "the user changed their
  mind" signal — any implementation is a heuristic whose wrong guess drops work the
  user asked for *silently*. The escape hatches are explicit: the card's Cancel, the
  prompt's escape clause, and now the fail-closed gate.
  **Revisit if** watches are observed firing against abandoned plans often enough
  that the silent-drop risk becomes the lesser one.
- **No global setting.** `autoFixCi` / `autoResetMergedBranch` need global switches
  because they fire **without** per-use consent; this fires only from an explicit arm
  and is cancellable. The reset coordinator's `self-watch` consent policy is what
  keeps this consistent — the global auto-reset toggle must not silently disable a
  self-wake's reset. **Revisit if** someone asks for a cross-feature "never run
  unattended turns" switch, which would not belong to this feature anyway.

## Open questions

_None — see "Resolved decisions"._

## Review notes

Reviewed by Codex (cross-agent), pre-implementation. Both load-bearing source claims
were independently confirmed: the `verifyMissingPr` callback ordering (with two
corrections now folded in — `setMergedHeadSha` is a synchronous write, and the remote
branch deletion is best-effort so only the *attempt* completes), and that
`autoResetMergedBranchOnContinue` has exactly one production caller.

Accepted and folded in: the P1/P2/P3 prerequisites; the generation race across
`markMergedAndPruneExcess`'s await; turn-serialization of the reset; the reset
coordinator and its consent policy; fail-closed on gate failure (reversing a prior
decision); CAS transitions and the delivery lease; the `emitChatCard` /
`persistCardTransition` card primitive; truthful terminal states; server-side re-arm
refusal; the distinct `SelfMergeWatch` type; the false evicted-workspace claim; and
the missing closed-outcome fan-out.

The review's headline effect is on **cost**, not direction: this was scoped as
composition of docs/196 + docs/218 with "no new card and no new machinery". It is
not. It needs a reset coordinator, CAS watch storage, and a retry supervisor.

**Update — all three prerequisites are fixed and merged** (SHI-254, SHI-255,
SHI-258). The dispatch path now honors "`delivered` means the turn ran" on every
drain, and a failed delivery retries in-process on a backoff instead of stranding
until a restart.

That materially reduces this design's remaining cost. The delivery lease it specified
now exists as SHI-258's `inFlight` set, the fire-once guard is centralized in
`isTerminalWatchState`, and terminal watches already release the polling gate — three
things this doc had planned to build. What remains genuinely new: the reset
coordinator, CAS watch storage, generation-checked delivery, and the arm card. The
main open engineering question is whether to generalize SHI-258's retry supervisor
over both watch kinds or duplicate it (see *What P3's fix changes here*).
