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
credential"* or *"will continue this work by itself as soon as one of your
credentials is free"*. Neither asks the user for anything (req 3). The two
existing gates are untouched — the turn must be CLI-started, and the credential
must be one that can fail over at all, which is what keeps a metered key out
(req 5, docs/140's second gate).

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
refusal. It also stands down if the drain started a queued turn while the
teardown ran: that turn IS the continuation, and a second one would only queue an
unasked-for "carry on" behind the user's own message. The continuation can never land on the account the turn just spent: the
refusal is already stamped when it is asked (`markSessionAccountExhausted` runs
in the listener, synchronously, before the executor's handler), and
`recordStandDown` also passes the route to `selectAccountForTurn`'s `exclude`
explicitly. A continuation that is itself refused is a new refusal on a
different account, which benches that one too — so the walk is bounded by the
number of credentials, the same bound docs/260's attempt loop has.

docs/260's rule that a process with background work is never retired for an
account move needs no new code here: the continuation dispatches as a system
turn, and `dispatchOnRunner` defers a system turn while the resident process has
background work, releasing it when the work clears. Verified at
`turn-admission.ts:systemTurnBlockedByResidentWork`, `session-runner.ts:248`, and
the `background_work` handler in `runner-registry-factory.ts`.

## Phase 2 — resume when the bench ends (req 4)

`QuotaContinuationManager` (`services/quota-continuation.ts`) holds both halves.
When no credential is free, the stand-down records the session — service id, and
the `lastUsedAt` stamp it had at that moment — and a sweep runs while any session
is recorded.

The sweep asks the router the same question it asked at stand-down. That is the
whole clock story: `selectAccountForTurn` skips a credential while
`now < min(exhaustedUntil, exhaustedAt + ~30min)` (docs/260 section 2), so the
session resumes exactly when the router stops refusing, and this design adds no
clock of its own. The 60s tick is polling resolution, not policy.

Per sweep entry:

- a session that no longer exists, or is archived, is dropped and never woken;
- a session whose `lastUsedAt` has moved is dropped — some other turn has run
  since, so the stall is stale and a wake would be an unasked-for interruption.
  `sessionManager.track()` stamps it at every turn start, so this is a state
  comparison rather than an observed transition;
- a session whose runner is mid-turn is left for the next sweep;
- otherwise the entry is deleted *before* the wake, so a session is woken at most
  once per stall. A continuation that is refused again records a fresh stall.

The wake is `wakeSessionWithTurn`, which calls `restoreWorkspace` first, so a
session whose container was reclaimed while it waited still resumes.

Both phases wake with the same prompt
(`prompts/quota-continuation-wake.md`): it has to stand on its own, because phase
2 may deliver it hours later, so it says a quota limit stopped the previous turn,
that ShipIt found a credential with quota left, and that the agent should read
the conversation and the working tree and finish what was outstanding.

## Deliberate limits

- **The stall registry is in-process.** An orchestrator restart forgets which
  sessions were waiting on quota; those sessions then need a message, as they do
  today. Persisting it would mean a schema change for a window measured in
  minutes.
- **A wake that fails to deliver is not retried.** It is logged; the session is
  not re-recorded, so a permanently unresumable session cannot be woken in a
  loop.
- **Several sessions stalled on the same service all wake in the same sweep,**
  sequentially. That is the same load the user would create by resending in each
  of them, and the first refusal re-benches the credential for the rest.
- **A content-free quota refusal still leaves its error row** in the transcript
  (`agent-listeners.ts` decides suppression at result time, before availability
  is known). In the incident's shape the refusal arrives as assistant text, so
  the turn has visible content and no row is added.

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

- `services/quota-continuation.test.ts` — continues on another credential and
  excludes the spent one; dispatches a system turn carrying the continuation
  prompt; never touches an archived session; resumes a recorded session once the
  router stops refusing, exactly once; forgets a session that has run a turn
  since; defers a session that is mid-turn.
- `turn-self-wake-commit.test.ts` — *"continues a CLI-started turn on another
  credential when one is free"* (the stand-down is recorded with the benched
  route, the continuation is invoked with a clean tree after the PR flow, the
  notice promises the move, the interrupted work is committed under `Agent
  turn`); *"does not re-dispatch a CLI-started turn whose quota limit leaves no
  credential free"* (docs/140's case, with the notice's new wording and no
  continuation); *"leaves the continuation to a queued turn that drained during
  the stand-down"*.
