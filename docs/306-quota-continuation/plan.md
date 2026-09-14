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

`retireOnSpentAccount` now asks `recordQuotaStandDown` before it writes the
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
is allowed, and on a "no" hands a CLI-started turn to the same stand-down. It
stamps the bench itself, because the listener that stamps one on the result path
has no result to work from here — without it the notice's "ShipIt has set that
account aside" would be false and the continuation could land straight back on
the spent credential. The stand-down is synchronous by contract there (the
listener calls the predicate inline), so it is wrapped in its own try/catch, and
`onError`'s terminal sequence gained the same `quota-continuation` step.

The continuation itself runs as the LAST step of the turn's terminal sequence,
after drain, commit, PR flow and idle:

```
await postTurnStep("commit", runCommitAndPr);
await postTurnStep("idle", signalIdleIfIdle);
await postTurnStep("quota-continuation", runQuotaContinuation);
```

Three things make that position load-bearing, all of them CLAUDE.md invariants
rather than preferences. It is inside `postTurnStep`, so a throw cannot abandon
the rest (planning#279). It is after the commit, so the interrupted turn's work
is in git before a new turn can touch the tree (req 6, planning#264). And it is
inside the post-turn hold, so the runner never reads idle between the two turns.
A test asserts the state observed *at the moment the continuation is invoked*:
clean tree, PR flow already run twice, `runner.running === false`.

Bounding: `quotaContinuationPending` is a single latch, set at the stand-down
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

## Known gaps

Named rather than hidden; the first is the one most worth closing next.

- **A continuation refused by every credential is not recorded.** The
  continuation runs as an ordinary turn, so a quota refusal on it takes the
  docs/260 attempt loop and ends at `allRefusedMessage` — which asks for another
  message and registers no stall, so nothing resumes it when quota returns. Only
  the CLI-started stand-down records. Closing it means recording from the
  all-refused terminal path too, which would also change behaviour for
  *user*-started turns that exhaust every credential — a bigger decision than
  this fix, and out of its scope.
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
- `src/server/orchestrator/prompts/quota-continuation-wake.md` — the
  continuation prompt.
- `src/server/orchestrator/turn-executor.ts` — `retireOnSpentAccount`, the
  `quota-continuation` terminal step.
- `src/server/orchestrator/session-runner.ts` — `recordQuotaStandDown` /
  `continueAfterQuotaStandDown` on `SystemTurnDeps`.
- `src/server/orchestrator/runner-registry-factory.ts`,
  `bootstrap-managers.ts`, `startup-monitors.ts` — wiring and shutdown.

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

An independent cross-model review (`shipit agent run --role reviewer`, run
`a6b9ca93`) found the string-credential routing defect, the sweep's
`running`-vs-`agentBusy` window, the missing adapter-error path, the lost
undeliverable wake and the turn-type language in the notice. All five are fixed
above; its remaining findings are the first three entries under *Known gaps*.
