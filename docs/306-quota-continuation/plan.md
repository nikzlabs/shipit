---
issue: planning#568
title: Autonomous work survives a quota wall — design
description: ShipIt continues a quota-stopped session on another credential, and resumes it by itself when every credential was spent.
---

# 306 — Autonomous work survives a quota wall: design

Implements [`requirements.md`](./requirements.md); requirements are cited as
`(req N)`.

## The stall

`quotaRefusalCanFailOver` (`src/server/orchestrator/credential-failure-policy.ts`)
returns `false` as soon as the turn is one the CLI started on its own — a
self-wake, or a turn adopted after a result. `retireOnSpentAccount`
(`src/server/orchestrator/turn-executor.ts`) then benched the account and posted
a notice telling the user to send a message. Production 2026-09-14, session
`e4be6129`: a second Claude account was healthy for the whole window and served
other sessions normally; that one session simply never asked the router a
question, so it waited for a human.

`docs/140-live-steering/plan.md` (phase 6.12) gives the reason for standing down,
and the reason is sound as far as it goes: the failover mechanism in that file is
`retryOnNextAccount`, which replays `input.prompt`, and a self-started turn has
no prompt. What it does not consider is ShipIt starting a **fresh** turn instead
of replaying an old one. `wakeSessionWithTurn` (`wake-session.ts`) already does
exactly that for merged PRs, finished consults and child reports, and it runs
`prepareSessionAgentEnvironment` when the runner is idle — so a woken turn goes
through ordinary per-turn account selection. Verified at
`wake-session.ts:75-86`, and pinned by *"detached system turns run the session's
agent through per-turn selection"* in
`integration_tests/provider-route-pinning.test.ts`.

So the stand-down keeps its rule (no replay) and loses its consequence (a human
must restart the work).

## Phase 1 — continue on the next credential (reqs 1, 2, 3, 5, 6)

`retireOnSpentAccount` now asks `recordStandDown` before it writes the
notice, and the answer picks the wording: *"is continuing this work on another
credential"* or *"will continue this work as soon as one of your credentials is
free"*. Neither asks the user for anything (req 3), and neither says which kind
of turn was interrupted (req 2) — the notice is about the credential. The two
existing gates are untouched — the turn must be CLI-started, and the credential
must be one that can fail over at all, which is what keeps a metered key out
(req 5, docs/140's second gate).

**Both terminal paths, not just the result.** The same refusal reaches the
executor two ways: as an `agent_result` whose text or error carries the provider
notice, and as an adapter `error`. docs/140 only ever handled the first, so an
adopted turn that died the second way got no bench, no notice and no failover.
`willRetryOnQuotaError` now detects the refusal *before* it asks whether a retry
is allowed, and on a "no" hands a CLI-started turn to the same stand-down,
passing the bench deadline with it — the listener that stamps one on the result
path has no result to work from here, and without a bench the notice's "ShipIt
has set that account aside" would be false and the continuation could land
straight back on the spent credential.

**The stamp sits behind the stand-down's two gates, not in front of them.** A
"no" from `quotaRetryAllowed()` has two causes — a CLI-started turn, and a
metered key — and only the first is this feature's. Stamping before the gates
benches a metered key, which req 5 and docs/140 both forbid; it is why
`retireOnSpentAccount` takes `benchUntil` rather than the caller stamping and
then delegating. Caught by `credential-failure-retry.test.ts`'s *"does not fail
over from an adapter error on a metered key"*, which this change had to keep
green. The stand-down is synchronous by contract there (the listener calls the
predicate inline), so it is wrapped in its own try/catch, and `onError`'s
terminal sequence gained the same `continuation` step.

The continuation itself runs as the LAST step of the turn's terminal sequence,
after drain, commit, PR flow and idle:

```
await postTurnStep("commit", runCommitAndPr);
await postTurnStep("idle", signalIdleIfIdle);
await postTurnStep("continuation", runContinuation);
```

Three things make that position load-bearing, all of them CLAUDE.md invariants
rather than preferences. It is inside `postTurnStep`, so a throw cannot abandon
the rest (planning#279). It is after the commit, so the interrupted turn's work
is in git before a new turn can touch the tree (req 6, planning#264). And it is
inside the post-turn hold, so the runner never reads idle between the two turns.
A test asserts the state observed *at the moment the continuation is invoked*:
clean tree, PR flow already run twice, `runner.running === false`.

Bounding: `continuationPending` is a single latch, set at the stand-down
and cleared when the continuation runs — at most one automatic continuation per
refusal. Whether that continuation is still *wanted* is the manager's decision,
not the executor's (below), so a queued turn that drained during teardown simply
supersedes it.

The probe cannot answer "yes" on the strength of the credential that just
refused: the refusal is already stamped when it is asked
(`markSessionAccountExhausted` runs in the listener, synchronously, before the
executor's handler, and on the error path the stand-down stamps it itself), and
`recordStandDown` passes the route in the router's `exclude` as well. The
*continuation turn* then runs ordinary selection, which is optimistic — so if it
is refused too, it can attempt the earlier credential again inside its own
attempt loop, bounded by that loop's ledger exactly as docs/260 intends. What
cannot happen is the continuation *starting* on the credential that just refused.

docs/260's rule that a process with background work is never retired for an
account move holds for the sweep, not for the immediate path. The continuation is
an automatic wake, not a system turn (`wakeDispatch` leaves `systemTurn` unset),
so `turn-admission.ts:systemTurnBlockedByResidentWork` does not defer it. The
sweep waits on `agentBusy`, which counts the resident process's background tasks
(`session-runner.ts`); `continueNow` does not read it (below).

## Phase 2 — resume when the bench ends (req 4)

`QuotaContinuationManager` (`services/quota-continuation.ts`) holds both halves,
and a stand-down records the session **either way** — the immediate continuation
and the delayed one are then the same act, differing only in what triggers it.
One registry entry (agent, the `lastUsedAt` stamp at stand-down, wake attempts),
one freshness rule, one wake function. The registry is the `sessions.quota_resume`
column (`SessionQuotaResume`), so an orchestrator restart during a wait keeps the
promise the notice made: `start()` at boot resumes the sweep for what is
recorded. A sweep runs while any session is recorded and stops when none is.

The sweep asks the router the same question the stand-down asked, and that is the
whole clock story: selection skips a credential while
`now < min(exhaustedUntil, exhaustedAt + ~30min)` (docs/260 section 2), so the
session resumes exactly when the router stops refusing. The one clock this design
adds is the stated reset of a refused wake (`notBefore`, in the section on the
other automatic wakes below), which the router's 30-minute re-probe would
otherwise undercut. The 60s tick is polling resolution, not policy.

**The question is asked through `selectRouteForSelection`, not
`ProviderAccountManager.selectAccountForTurn`** — the same entry point a turn
uses. The account manager only knows credentials stored as *accounts*, so a
session on a subscription the harness carries as a *string* (the Z.ai coding plan
is today's example) would have been asked about the wrong service entirely:
answered "nothing is free" while a healthy credential sat there, and answered it
again on every sweep, so the session would never have resumed. Deliberately
*without* `optimistic`: that mode hands back a refusal-blocked candidate for a
caller that is about to attempt it, and the only useful answer here is whether
anything is actually free.

Before waking — in the sweep, and again on the immediate path — an entry is
checked against the session as it stands:

- a session that no longer exists, or is archived, is dropped and never woken;
- a session whose `lastUsedAt` has moved is dropped: some other turn has run
  since, so this one is superseded and a wake would be an unasked-for
  interruption. `sessionManager.track()` stamps it at every turn start, so this is
  a state comparison rather than an observed transition, and it holds for a
  successor that has already *finished* as well as one still running. That
  includes a later turn that no credential could run either: a user message
  supersedes the wake (the requested behaviour), and what the wake was for is
  parked, so it rides the turn that runs instead;
- the immediate path leaves the entry to the sweep while the runner is
  `running` (a queued turn drained during teardown, and the sweep decides once it
  has ended) and while the entry waits for a stated reset;
- **the sweep** additionally skips a session whose runner is `agentBusy`. That
  covers more than `running`: the stand-down records the session before its own
  commit and push have run, and `agentBusy` folds in the post-turn hold, so a
  sweep tick landing in that window cannot start a successor against an
  uncommitted tree (req 6). The immediate path deliberately does *not* read it —
  it runs inside the very hold it would be testing, and its position at the end
  of the terminal sequence is its ordering guarantee.
- the entry is cleared once a turn has the wake, not before it: the wake's
  preparation (workspace restore, environment, worker readiness) can take tens of
  seconds, and a restart inside it now finds the entry still recorded. An
  in-process `waking` set stops the sweep and the immediate path from preparing
  the same entry twice. The wake is start-or-refuse (`startOrRefuse`): a turn that
  took the session meanwhile refuses it instead of queueing it behind, and the
  entry stays for the sweep to judge again. Just before dispatch the wake asks
  again whether its entry still stands (`stillWanted`), so a turn that started
  and ended during the preparation, or a newer refusal that replaced the entry,
  also stops it. A continuation that is refused again records a fresh stall.

The wake is `wakeSessionWithTurn`, which calls `restoreWorkspace` first, so a
session whose container was reclaimed while it waited still resumes. A delivery
failure (a container that would not resume) keeps the entry for a later sweep,
up to three attempts — enough for something transient, bounded so a session
that can never be resumed is not woken for ever.

Both phases wake with the same prompt
(`prompts/quota-continuation-wake.md`): it has to stand on its own, because phase
2 may deliver it hours later, so it says a quota limit stopped the previous turn,
that ShipIt found a credential with quota left, and that the agent should read
the conversation and the working tree and finish what was outstanding.

## A second cause — a renewed sign-in

Since docs/140-live-steering Phase 6.13 the same manager continues a CLI-started
turn that a 401 cut short, once ShipIt has renewed the sign-in. `recordStandDown`
takes a `cause` (`"quota"` by default, `"auth"` for this), and the cause chooses
what the continuation turn is told (`prompts/auth-continuation-wake.md`) and
nothing else: the registry, the freshness rule, the sweep and the delivery
retries are shared. Nothing is benched on this path, so the router is asked with
no route excluded and the renewed credential itself counts as a way to continue.
The requirements here are about quota and are unchanged.

**Both executors take the hooks, and until that phase only one did.** A turn has
two composition sites: the runner's dispatch (`runner-registry-factory.ts`) and
the composer's `runAgentWithMessage` (`ws-handlers/agent-execution.ts`). Only the
first passed `recordStandDown` / `continueAfterStandDown`. A resident CLI that a
chat message started adopts its own turns through the *second* executor, so a
stand-down there asked nobody, registered nothing, and still posted a notice
that promised a continuation — for quota as well as for a sign-in. The unit
tests inject the hooks and could not see it. The composer site now passes the
manager through `AppCtx.quotaContinuation` (`route-registry.ts`), pinned by
`integration_tests/chat-turn-stand-down-wiring.test.ts`, which sends a real
composer message and follows the hooks to the continuation turn.

## A self wake that every credential refuses (reqs 3, 4)

Production 2026-10-11, build a28f165b: a session's `notify-on-merge --self` wake
ran while both of its Claude accounts were out of quota, with stated resets at
17:00 and 17:20. A wake is a ShipIt-started turn *with* a prompt, so it is not
the CLI-started stand-down above: it takes the docs/260 attempt loop, every
account refuses it, and env preparation ends it with `allRefusedMessage`. The
merge watch counted that as a failed delivery and retried on its 1/2/4/8-minute
backoff, so all five attempts fell inside 16 minutes. The chat got five copies of
the merge prompt and five quota errors, the watch gave up, and the user typed
"continue" eight minutes after the first reset.

**The executor says why the turn failed.** When env preparation finds no
credential left after a quota refusal (`ProviderRouteUnavailableError` with a
quota entry in the attempt ledger), the turn settles `errored` with
`quotaRefused`: one stated reset per quota refusal, `null` where the provider
stated none (`turnQuotaRefused`). The merge watch reads it here, and the other
automatic wakes in the next section. A ledger that mixes
a quota refusal with a failed sign-in counts too: the quota account frees at its
reset whatever the other one does, so waiting for it beats giving up. A refusal
on a metered key, an auth-only ledger and a turn with no credential at all keep
the plain `errored`, so none of them is ever waited on.

For an automatic turn the all-refused error row no longer says "Send this
message again" — there is no message of the user's to send (req 3).
`allRefusedMessage` takes `automatic` and ends with "Connect another account in
Settings." It promises no retry: the wake's owner schedules one — the merge
watch, or `QuotaContinuationManager` for the other wakes — and its own notice
says when.

**The merge watch is the one owner of the wait.** On that outcome the self watch
records a refusal, not a failure (`merge-watch.ts`, `recordQuotaRefusal`):

- the attempt spends no delivery attempt — the budget is `deliveryAttempts`
  minus `quotaRefusals`, and the delivery id stays unique;
- `quotaWait.until` is the earliest stated reset plus one minute; a refusal that
  stated none waits the router's re-probe window (`REFUSAL_REPROBE_MS`,
  docs/260), and no wait is shorter than the ordinary backoff;
- a notice says when ShipIt tries again and asks for nothing (req 3).

`attemptSelfWake` reads the wait, so the retry pass, the poller's repeat and
`reconcilePending` after a restart all honour it; the retry pass reads it before
it probes the worker, because a weekly limit can mean days of ticks. It also
reads the attempt budget now: a restart that cut the fifth attempt off from its
settlement used to send a sixth wake from `reconcilePending`, and now leaves the
watch to the retry pass, which asks the worker and then gives up.

**The merge prompt is in the transcript once.** A retry dispatches with
`promptShown` when a user row with the same prompt is already in the transcript
(`promptInTranscript`, one indexed query: `ChatHistoryManager.hasUserMessage`) —
for a quota refusal and for any other failure, because
the transcript, not the outcome, is what says whether the row exists. A chat
rewind deletes the row and a code rollback marks it `rolledBack`; either way the
next attempt shows the prompt again. A `promptShown` turn adds no user row and
no echo (`dispatched-turn.ts`); the agent still gets the whole prompt.

`QuotaContinuationManager` was the other candidate. When this was built its
registry was in-process (a restart loses it — the incident had one between
attempts) and its timing was the router's, which re-probes a benched credential
30 minutes after the refusal whatever reset the provider stated. The next
section gave it a persisted registry and the stated resets; the merge watch
keeps its own wait because it already persists the merge it delivers and counts
that merge's attempts. The manager never sees this turn — the executor calls
`recordStandDown` only for a CLI-started turn, and the merge watch does not call
`recordRefusedWake` — so one stall cannot produce two wakes.

**Superseded, not doubled.** `quotaWait.lastUsedAt` is the session's
`lastUsedAt` at the refusal, and every turn start stamps it; the wake's own next
attempt clears the wait before it dispatches, so it never counts. When a turn has
started since:

- while a turn runs, the wake waits for it to end (`runner.running`, read before
  the timestamp, because a turn claims `running` in setup before it stamps the
  session) — a restart or a poller repeat must not queue a wake behind it;
- a turn that ran — the user's message, or anything else — took the session on,
  so the watch ends `delivered` and wakes nothing;
- a turn that no credential could run either supersedes the wake too, as the
  user asked of a user message: the user's new intent replaces the wake's
  "continue the earlier request". Nothing is parked. The agent still learns that
  the PR merged, from the pre-turn reset (`pre-turn-reset-hook.ts`, verified at
  `applyPreTurnReset` and `turn-executor.ts` `reparkUnsubmittedPrompt`): a reset
  that moved the branch parks its `[System]` merge note again when the turn never
  reached the agent (planning#609), and a skipped reset writes its note on every
  turn. A reset with nothing to move writes no note; that case is under *Known
  gaps*. Parking the merge prompt was tried and dropped: `quota-refused` is also
  the outcome of a CLI turn that worked and then ran out, so the prompt's "reset
  to base, and stop if that fails" would reach an agent whose branch had moved
  on. A refused user message asks the user to send it again; a refused inbox
  turn or continuation has an owner that starts it again.

**Bounded.** `MAX_QUOTA_REFUSALS` (5) refusals end the watch with the ordinary
give-up note, so quota that never returns cannot wake the session for ever.

The other automatic wakes are the next section's.

## Every other automatic wake that every credential refuses (reqs 3, 4)

Four more callers of `wakeSessionWithTurn` made one attempt and then had nobody
to start the turn again: the consult result (`services/consult-result-delivery.ts`,
which stamped the card failed), the restart follow-up
(`services/agent-restart-request.ts` — `shouldRepark` reads a quota refusal as a
turn that ran, so its note was not even parked), the stopped-jobs note
(`services/stopped-background-jobs.ts`, parked for a next turn that a human had
to start), and the continuation itself (`services/quota-continuation.ts`, which
read no outcome at all).

**`QuotaContinuationManager` is the one owner of all four stalls.** Each caller,
on a `quotaRefused` outcome:

- parks what its wake was for as a pending agent notice (`[System] <its prompt>`),
  so the content rides whichever turn runs next — the continuation, or a message
  of the user's that supersedes it. A turn that never reaches the agent puts the
  notice back (planning#609), so a refused continuation does not lose it;
- calls `recordRefusedWake({ sessionId, resetsAt })`. The continuation's own
  wake does the same from its settlement, carrying its entry's count.

The manager records the session with `notBefore` = `quotaWaitUntil`
(`quota-wait.ts`, shared with the merge watch): the earliest stated reset plus a
minute, the router's re-probe window where none was stated, never sooner than a
backoff that grows with the refusals. The sweep wakes nothing before
`notBefore`, then asks the router as before — so the 30-minute re-probe alone can
no longer wake a session that a weekly limit stopped. A notice says when ShipIt
continues and asks for nothing (req 3).

The continuation is told what it is for: a refused wake records cause `wake`,
whose prompt (`prompts/refused-wake-continuation.md`) says the earlier turn never
reached the agent and points at the `[System]` note above it — the `quota` prompt
would claim a turn stopped partway and left commits. A refused continuation keeps
its entry's cause and count. An owner's refused wake starts a new entry: its own
turn has moved `lastUsedAt`, which supersedes whatever waited before it, and
that entry's parked note is still pending, so nothing it carried is lost.

**One stall, one wake.** The merge watch keeps its own wake (above); every other
automatic wake is the manager's, and each records into the session's single
entry, so two refused wakes of one session produce one continuation. The
manager's wake is start-or-refuse, so it is not queued behind a turn that took the
session meanwhile — the merge watch's, the user's, or any other — with the one
exception of pre-turn compaction, under *Known gaps*. When the merge
watch and the manager both wait on one session, whichever runs first stamps the
session and the other stands down, also when that turn was refused. The
exception is under *Known gaps*.

**Bounded.** `MAX_QUOTA_REFUSALS` (5) refusals in a row — the owner's and the
continuations' — clear the entry with a notice that the work continues with the
user's next message.

The session inbox (`services/session-inbox.ts`) is not changed: it has no
attempt budget, a turn that ends without a receipt doubles its wait from a
minute to an hour, and the stored message is never lost. A quota wall costs it a
refused turn per wait.

## Known gaps

Named rather than hidden.

- **A stale `running` holds the merge watch's quota wait.** A turn whose end the
  orchestrator never sees leaves `runner.running` true, and the wait (like the
  retry pass before it) keeps waiting. The recovery for a stale flag is the
  runner's, and it stops when the last viewer detaches. Inherited from the retry
  pass, not changed here.
- **"Pushed before anything else starts" (req 6) is commit-strict, push-armed.**
  The continuation waits for `runCommitAndPr`, which *arms* the debounced push
  rather than awaiting the remote. A slow push can therefore still be in flight
  when the continuation starts. No work is at risk — it is committed, and the
  next push carries both commits — but the literal requirement is met only for
  the commit half.
- **A stand-down's first continuation is still timed by the router.** The
  CLI-started stand-down knows only the bench it stamped, so its entry has no
  `notBefore`, and the router's re-probe can start the continuation 30 minutes in.
  If every credential refuses it, the refusal records the stated resets and the
  wait from there is the providers'. A weekly limit therefore costs one refused
  continuation, not one every half hour.
- **A refused wake's hand-over lives in its settlement callback, in process.**
  The owners park their note and record the refusal from that callback, so a
  restart between the wake's dispatch and its settlement loses both: the session
  then waits for a message, as before this change. The manager's own entry is
  cleared at dispatch, so the same holds for a continuation that a restart cuts
  off. The merge watch is the exception: it rebinds its delivery by id. A turn
  refused during env preparation settles within seconds, so for the incident's
  shape the window is short.
- **The merge watch can still queue behind the manager's continuation.** Both
  check the session before an asynchronous preparation, so when both are due in
  the same moment the merge watch's wake (which queues) can run after the
  continuation (which refuses to queue): two turns, one per stall.
- **Pre-turn compaction can still queue an admitted continuation.** Admission
  reports `started` and the entry is cleared; compaction ahead of the turn then
  puts the continuation back in the queue, so a message the user sends during
  that compaction runs first and the continuation runs after it. This holds for
  every automatic turn, not only this one.
- **A refused automatic turn with no owner of its own supersedes the wait** of
  both owners. A CI-fix or conflict turn that every credential refuses moves
  `lastUsedAt` and retries nothing, so the parked note waits for the next
  message; the merge watch's wake is simply gone.
- **A superseded merge wake can leave the agent unaware of the merge** when the
  pre-turn reset had nothing to move: the branch was already at the base (a
  fast-forward merge), so no merge note exists to put back. The user's next
  message then starts on the fresh base without being told why. The usual path
  — a squash merge, reset by the refused wake's own composition — keeps the note.
- **The notice that announces the wait is appended as its own row** after the
  refused turn (`emitNoticePostTurn`), as the merge watch's is; it is not part of
  that turn's message group.
- **Several sessions stopped on the same service all wake in the same sweep,**
  sequentially. That is the same load the user would create by resending in each
  of them, and the first refusal re-benches the credential for the rest.
- **A content-free quota refusal still leaves its error row** in the transcript
  (`agent-listeners.ts` decides suppression at result time, before availability
  is known). In the incident's shape the refusal arrives as assistant text, so
  the turn has visible content and no row is added.
- **An entry whose session loses its credentials entirely stays registered** —
  there is no expiry, deliberately: a weekly limit can be days away, and any
  timeout short enough to be tidy is short enough to break req 4. It is dropped
  as soon as the session runs, is archived, or is deleted.

## Key files

- `src/server/orchestrator/services/quota-continuation.ts` — the manager: the
  stand-down decision, `recordRefusedWake`, the stall registry, the sweep, the
  wake.
- `src/server/orchestrator/sessions.ts` — `setQuotaResume` / `getQuotaResume` /
  `listQuotaResumes` over the `quota_resume` column (`SessionQuotaResume`).
- `src/server/orchestrator/quota-wait.ts` — `quotaWaitUntil`,
  `MAX_QUOTA_REFUSALS`: when a refused wake runs again, for both owners.
- `src/server/orchestrator/prompts/quota-continuation-wake.md`,
  `auth-continuation-wake.md`, `refused-wake-continuation.md` — the continuation
  prompt for each cause.
- `services/consult-result-delivery.ts`, `services/agent-restart-request.ts`,
  `services/stopped-background-jobs.ts` — park the wake's prompt and hand a
  quota refusal to the manager (`quotaContinuation` in their deps).
- `src/server/orchestrator/turn-executor.ts` — `retireOnSpentAccount`,
  `standDownAfterAuthHeal`, the `continuation` terminal step.
- `src/server/orchestrator/session-runner.ts` — `recordStandDown` /
  `continueAfterStandDown` on `SystemTurnDeps`.
- `src/server/orchestrator/runner-registry-factory.ts`,
  `ws-handlers/agent-execution.ts` — the two executors that take the hooks.
- `src/server/orchestrator/merge-watch.ts` — `recordQuotaRefusal`,
  `holdForQuota`: the self wake's quota wait.
- `src/server/orchestrator/turn-settlement.ts` — `quotaRefused` on
  `TurnOutcome`; `promptShown` on `AgentDispatchOptions`
  (`session-runner.ts`), read by `dispatched-turn.ts`.
- `bootstrap-managers.ts`, `route-registry.ts`, `api-routes-agent.ts`,
  `startup-monitors.ts` — wiring, start at boot, and shutdown.

## Coverage

Every assertion below was verified red on its own, by mutating the
implementation and re-running.

- `services/quota-continuation.test.ts` — drives the real selector over a fake
  credential store, so "is anything free?" is answered by the code a turn uses.
  Continues when another credential is free; does not count the credential the
  turn just spent; **sees a subscription the harness carries as a string, and
  does not borrow the harness's account credentials when the session's service
  has none** (the two that fail against a bare `selectAccountForTurn` probe);
  dispatches a system turn carrying the continuation prompt; never touches an
  archived session; leaves the continuation to a turn that has already taken the
  session on; resumes a recorded session once the router stops refusing, exactly
  once; waits while the stopped turn's own post-turn work is in flight; retries an
  undeliverable wake up to three attempts. The string-credential case derives its
  service from the catalogue rather than naming a vendor, so a catalogue change
  cannot silently turn it into a different test. *An automatic wake that every
  credential refused for quota*, on a fake clock: no wake before the earliest
  stated reset — not at the router's re-probe either — then one, with the
  refused-wake prompt and a notice that asks for nothing; a stated reset that has
  already passed still waits the minimum; a new manager over the
  same store resumes it after a restart through `start()`; a continuation that
  every credential refuses too is recorded again, and `MAX_QUOTA_REFUSALS` ends
  the chain with a warning; a stand-down's refused continuation keeps its cause;
  any turn since supersedes the entry, also one refused for quota; the entry
  survives a restart during the wake's preparation and is cleared once a turn
  has the wake; one wake at a time is prepared for a session; a turn that starts
  and ends during the preparation stops it, and a failed preparation does not
  overwrite a refusal recorded meanwhile; a wake the session
  refuses keeps the entry for the sweep; the
  immediate path leaves a drained turn in setup, and an entry that waits for a
  stated reset, to the sweep.
- `services/consult-result-delivery.test.ts`,
  `services/agent-restart-request.test.ts`,
  `services/stopped-background-jobs.test.ts` — a wake refused for quota parks its
  prompt and is handed over with the stated resets; one that failed for another
  reason is not handed over (and, for the consult, parks nothing).
- `integration_tests/chat-turn-stand-down-wiring.test.ts` — now records the
  stand-down once the first turn has ended, because the continuation no longer
  queues behind a running turn. It proves the composer executor's wiring, not the
  executor's ordering, which `turn-self-wake-commit.test.ts` pins.
- `integration_tests/quota-resume-wiring.test.ts` — the built app starts the
  manager and passes that instance to all three callers: the deps are optional,
  so the unit tests above stay green without the wiring.
- `sessions.test.ts` — the `quota_resume` column round-trips through a second
  manager over the same database.
- `turn-self-wake-commit.test.ts` — *"continues a CLI-started turn on another
  credential when one is free"* (the stand-down is recorded with the benched
  route, the continuation is invoked with a clean tree after the PR flow, the
  notice promises the move, the interrupted work is committed under `Agent
  turn`); *"continues a CLI-started turn whose quota refusal arrives as an adapter
  error"* (the second terminal path: bench stamped here, notice, continuation,
  work committed); *"does not re-dispatch a CLI-started turn whose quota limit
  leaves no credential free"* (docs/140's case, with the notice's new wording and
  no continuation).
- `self-merge-watch.test.ts`, *a wake that every credential refuses for quota* —
  the incident's timeline on a fake clock, with a fake runner that writes the
  prompt row as the dispatched turn does: no retry before the earliest stated
  reset, one wake after it, one prompt row in all; a refusal after four failed
  attempts does not give up; `MAX_QUOTA_REFUSALS` ends the watch; a turn that ran
  since supersedes the wake, one refused for quota does too and parks nothing,
  one still running —
  or still in setup — is waited for; the wake's own next attempt does not
  supersede it; a retry after another kind of failure does not show the prompt
  again, and one after a chat rewind or a code rollback does; the retry pass does
  not probe the worker during the wait; `reconcilePending` after a restart
  honours the wait and the attempt budget, and its retry loop then ends the
  watch; a rebound delivery keeps the attempts that refusals did not spend.
- `integration_tests/quota-exhaustion-retry.test.ts` — the all-refused turn
  settles with the stated resets; a turn with no credential at all does not; an
  automatic turn's error row does not ask to send the message again; a
  `promptShown` dispatch adds no user row and no echo, and the agent still gets
  the prompt.
- `credential-failure-retry.test.ts` — unchanged, and load-bearing for the error
  path: *"does not fail over from an adapter error on a metered key"* is what
  keeps the new bench stamp behind the stand-down's gates. Every test importing
  `turn-executor.ts` was run, not only the affected set the dev-loop selector
  offered.

An independent cross-model review (`shipit agent run --role reviewer`, run
`a6b9ca93`) found the string-credential routing defect, the sweep's
`running`-vs-`agentBusy` window, the missing adapter-error path, the lost
undeliverable wake and the turn-type language in the notice. All five are fixed
above; its remaining findings are the first three entries under *Known gaps*.
