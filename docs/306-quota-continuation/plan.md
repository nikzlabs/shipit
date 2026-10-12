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
account move needs no new code here: the continuation dispatches as a system
turn, and `dispatchOnRunner` defers a system turn while the resident process has
background work, releasing it when the work clears. Verified at
`turn-admission.ts:systemTurnBlockedByResidentWork`, `session-runner.ts:248`, and
the `background_work` handler in `runner-registry-factory.ts`.

## Phase 2 — resume when the bench ends (req 4)

`QuotaContinuationManager` (`services/quota-continuation.ts`) holds both halves,
and a stand-down records the session **either way** — the immediate continuation
and the delayed one are then the same act, differing only in what triggers it.
One registry entry (agent, the `lastUsedAt` stamp at stand-down, wake attempts),
one freshness rule, one wake function. A sweep runs while any session is
recorded and stops when the map empties.

The sweep asks the router the same question the stand-down asked, and that is the
whole clock story: selection skips a credential while
`now < min(exhaustedUntil, exhaustedAt + ~30min)` (docs/260 section 2), so the
session resumes exactly when the router stops refusing, and this design adds no
clock of its own. The 60s tick is polling resolution, not policy.

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
  successor that has already *finished* as well as one still running;
- **the sweep** additionally skips a session whose runner is `agentBusy`. That
  covers more than `running`: the stand-down records the session before its own
  commit and push have run, and `agentBusy` folds in the post-turn hold, so a
  sweep tick landing in that window cannot start a successor against an
  uncommitted tree (req 6). The immediate path deliberately does *not* read it —
  it runs inside the very hold it would be testing, and its position at the end
  of the terminal sequence is its ordering guarantee.
- the entry is deleted *before* the wake, so a session is woken at most once per
  stall. A continuation that is refused again records a fresh stall.

The wake is `wakeSessionWithTurn`, which calls `restoreWorkspace` first, so a
session whose container was reclaimed while it waited still resumes. A delivery
failure (a container that would not resume) re-records the session for a later
sweep, up to three attempts — enough for something transient, bounded so a
session that can never be resumed is not woken for ever.

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
stated none (`turnQuotaRefused`). Nothing else reads it yet. A ledger that mixes
a quota refusal with a failed sign-in counts too: the quota account frees at its
reset whatever the other one does, so waiting for it beats giving up. A refusal
on a metered key, an auth-only ledger and a turn with no credential at all keep
the plain `errored`, so none of them is ever waited on.

For an automatic turn the all-refused error row no longer says "Send this
message again" — there is no message of the user's to send (req 3).
`allRefusedMessage` takes `automatic` and ends with "Connect another account in
Settings, or wait for an account to reset."

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
(`promptInTranscript`) — for a quota refusal and for any other failure, because
the transcript, not the outcome, is what says whether the row exists. A chat
rewind deletes the row and a code rollback marks it `rolledBack`; either way the
next attempt shows the prompt again. A `promptShown` turn adds no user row and
no echo (`dispatched-turn.ts`); the agent still gets the whole prompt.

`QuotaContinuationManager` was the other candidate, and is not used here for
two reasons. Its registry is in-process (a restart loses it — the incident had
one between attempts), while the watch is persisted. And it asks the router,
which re-probes a benched credential 30 minutes after the refusal whatever reset
the provider stated, so a weekly limit would wake the session every half hour.
It never sees this turn either — the executor calls `recordStandDown` only for a
CLI-started turn — so one stall cannot produce two wakes.

**Superseded, not doubled.** `quotaWait.lastUsedAt` is the session's
`lastUsedAt` at the refusal, and every turn start stamps it; the wake's own next
attempt clears the wait before it dispatches, so it never counts. When a turn has
started since:

- while it runs, the wake waits for it to end (`runner.running`) — a restart or
  a poller repeat must not queue a wake behind it;
- a turn that ran — the user's message, or anything else — took the session on,
  so the watch ends `delivered` and wakes nothing;
- a turn that no credential could run either (`lastTurnOutcome` is
  `quota-refused`) leaves the session stopped by quota, and req 4 says such a
  session resumes by itself: the wake still runs at the reset. This covers a
  refused inbox turn, which would otherwise cancel the wake for good, and a
  refused user message, whose text is in the transcript the woken agent reads.
  An independent review argued that a user message should cancel the wake even
  when it was refused; the reading above is the one req 4 supports, and nothing
  persisted tells a user's turn from ShipIt's without a schema change.

**Bounded.** `MAX_QUOTA_REFUSALS` (5) refusals end the watch with the ordinary
give-up note, so quota that never returns cannot wake the session for ever.

**The other wake callers** have the same "nobody is there to send it again" end,
by a different mechanism, and are not changed:

- `services/session-inbox.ts` has no attempt budget: a turn that ends without a
  receipt doubles its wait, from a minute to an hour, and the stored message is
  never lost. A quota wall costs a refused turn per wait.
- `services/consult-result-delivery.ts`, `services/agent-restart-request.ts` and
  `services/stopped-background-jobs.ts` make one attempt. A refused wake stamps
  the consult card failed or parks its note for the next turn, which a human
  then has to start.
- `services/quota-continuation.ts` — the continuation itself, the first entry
  under *Known gaps*.

## Known gaps

Named rather than hidden; the first is the one most worth closing next.

- **A continuation refused by every credential is not recorded.** The
  continuation runs as an ordinary turn, so a quota refusal on it takes the
  docs/260 attempt loop and ends at `allRefusedMessage` — which asks for another
  message and registers no stall, so nothing resumes it when quota returns. Only
  the CLI-started stand-down records. Closing it means recording from the
  all-refused terminal path too, which would also change behaviour for
  *user*-started turns that exhaust every credential — a bigger decision than
  this fix, and out of its scope. The settled outcome now carries `quotaRefused`
  with the stated resets, which is what a fix for this and for the one-attempt
  wake callers (*A self wake that every credential refuses*) would read.
- **"Pushed before anything else starts" (req 6) is commit-strict, push-armed.**
  The continuation waits for `runCommitAndPr`, which *arms* the debounced push
  rather than awaiting the remote. A slow push can therefore still be in flight
  when the continuation starts. No work is at risk — it is committed, and the
  next push carries both commits — but the literal requirement is met only for
  the commit half.
- **Restart loses every pending resumption.** The registry is in-process, so an
  orchestrator restart during a quota wait leaves the promise in the transcript
  with nothing to fulfil it; those sessions need a message, as they do today.
  Persisting it means a schema change.
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
  stand-down decision, the stall registry, the sweep, the wake.
- `src/server/orchestrator/prompts/quota-continuation-wake.md`,
  `auth-continuation-wake.md` — the continuation prompt for each cause.
- `src/server/orchestrator/turn-executor.ts` — `retireOnSpentAccount`,
  `standDownAfterAuthHeal`, the `continuation` terminal step.
- `src/server/orchestrator/session-runner.ts` — `recordStandDown` /
  `continueAfterStandDown` on `SystemTurnDeps`.
- `src/server/orchestrator/runner-registry-factory.ts`,
  `ws-handlers/agent-execution.ts` — the two executors that take the hooks.
- `src/server/orchestrator/merge-watch.ts` — `recordQuotaRefusal`,
  `holdForQuota`, `quotaWaitUntil`: the self wake's quota wait.
- `src/server/orchestrator/turn-settlement.ts` — `quotaRefused` on
  `TurnOutcome`; `promptShown` on `AgentDispatchOptions`
  (`session-runner.ts`), read by `dispatched-turn.ts`.
- `bootstrap-managers.ts`, `route-registry.ts`, `startup-monitors.ts` — wiring
  and shutdown.

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
  cannot silently turn it into a different test.
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
  since supersedes the wake, one refused for quota does not, one still running
  is waited for; the wake's own next attempt does not supersede it; a retry after
  another kind of failure does not show the prompt again, and one after a rewind
  does; `reconcilePending` after a restart honours the wait and the attempt
  budget; a rebound delivery keeps the attempts that refusals did not spend.
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
