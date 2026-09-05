---
issue: planning#505
title: Merge it when the checks pass — design
description: A durable, commit-bound merge request that ShipIt performs itself from its own executor, excluded against turns by a runner-held merge hold.
---

# Merge it when the checks pass — design

Implements [requirements.md](./requirements.md). Builds directly on
[`docs/287-agent-merge-per-repo`](../287-agent-merge-per-repo/plan.md), now
shipped, and changes nothing it decided: the repository grant, the ownership
tuple, the flush, the live read and its observation, merging at an exact SHA, the
durable claim and settlement are all that feature's and are used as they are.

## Verified against the shipped foundation

This design was written before docs/287 existed and was parked until it did.
Every claim it made about that foundation has now been read at the source; the
six that were wrong or unsettled are recorded here rather than silently fixed,
because each changed a decision.

| Claim as parked | What the code says | Effect |
|---|---|---|
| the row is keyed by `repo_key` | `agent_merge_claims.repo_id`, matched on `repoId()` (`agent-merge-claims.ts:19`) | column names below corrected; revocation matches on `repoId`, not `canonicalRepoKey` |
| the row already carries the merge method | it does not — the columns are `session_id, repo_id, pr_number, expected_sha, state, created_at` | a `method` column is added; a request is performed long after the flag was passed |
| four turn-start entry points need a check | three admission sites, and `releaseQueuedTurn` **routes through `runner.dispatch`** (`queue-drain.ts:105`), so the drain is covered by the `dispatchOnRunner` check | the gate is two checks plus the existing drain guard, not four |
| revocation must mark in-flight rows `revoked` | only matters if reconciliation returns a row to `pending`; it does not (see *One request, one attempt*) | the `revoked` column is dropped |
| the executor must become an input to the polling supervisor and the global gate | `pr-polling-supervisor.ts` and `polling-global-gate.ts` would both need a new first-class concept | replaced by a small dedicated executor — strictly less mechanism (see *Where the executor runs*) |
| the immediate-green case is unsettled | — | settled: `--auto` never merges inline (see *What this adds*) |

## What this adds

`gh pr merge --auto`, in a repo-bound session, stops being a refusal and becomes a
**request**: the observation that would have refused for pending checks instead
records what to merge, and ShipIt performs that merge later (req 1).

`--auto` **never merges inline**, even when the checks are already green. One flag,
one meaning: an agent that wants the merge now calls `gh pr merge` without it,
and gets the answer in the command's own reply. Requirement 1's "once the checks
pass" is satisfied either way, so this is chosen for being the single rule rather
than for being forced.

`--auto` does **not** use GitHub's own merge-when-green. `expectedHeadOid` is a
precondition checked when the arming is *enabled*, not a binding on the merge
GitHub later performs, and GitHub keeps an arming alive across a push by anyone
with write access — so a native arming can land a commit the agent never
authorised, and withdrawing the grant cannot cancel it (requirements, resolved
2026-09-03).

**Repo-bound sessions only** (req 7). A sandbox has no `session.remoteUrl`, may
target several repositories, and is governed by `dangerousGitHubOps` rather than
the repository grant. Its `--auto` keeps arming GitHub's native auto-merge exactly
as before; nothing below applies there.

### The row

It **extends `agent_merge_claims`** rather than adding a second table — the row
already carries repository, pull request, expected SHA and state, and a request is
the same thing with a life before the merge call:

```sql
ALTER TABLE agent_merge_claims ADD COLUMN origin TEXT NOT NULL DEFAULT 'direct';
ALTER TABLE agent_merge_claims ADD COLUMN method TEXT NOT NULL DEFAULT 'merge';
-- `state` gains a third value, `pending`, which only an `origin = 'auto'` row uses
```

`method` is new and load-bearing: the direct merge passes squash/merge/rebase
straight into the REST call in the same function, while a request is performed
minutes later by different code, which has nowhere else to read it from.

There is deliberately no `armed_at` and no repository index: nothing times a
request out, at most one row exists per session, and a column or index no code
reads is one that will drift.

### The state machine

`pending → merging → settling → deleted`, and `merging` is written **before** the
REST call, never after it. An executor that only recorded success would have an
unrepresentable window: the row it is merging could be replaced or cleared while
the call is in flight, leaving its own success nowhere to land.

| State | Written | Who may replace or clear it |
|---|---|---|
| `pending` | when `--auto` records the request | a second `--auto`, a direct `gh pr merge`, revocation, the executor |
| `merging` | durably, immediately **before** the REST call | only the performer |
| `settling` | on a witnessed REST success | only settlement |

`merging` and `settling` stay **monotonic**: nothing may write over an attempt
whose outcome is unknown, which is docs/287's single-flight rule unchanged. What
this feature adds is that a `pending` row is *not* an attempt and may be replaced
— an agent that pushes again and re-arms at the new commit is the ordinary case,
and a direct `gh pr merge` supersedes a request it makes redundant. Only
settlement, or destroying the session through the cascade, removes a `merging` or
`settling` row.

### Reconciliation must stand down for a merge in flight

The worst interleaving this feature can produce, and the one that needs a
mechanism a row cannot carry. The executor writes `merging` and then awaits
GitHub **with no turn running**, so docs/287's reconciliation — whose busy check
is about turns — saw an idle session, read the pull request as still open, and
deleted the row as unmerged. GitHub then accepts the outstanding request and the
merge is recorded nowhere at all.

`AgentMergeClaimStore.isMergeInFlight()` is what closes it, and it is deliberately
**in memory rather than a column**: the question is "is this process merging this
row right now?", and a `merging` row left by a crash must be reconciled while one
being merged this instant must not. A restart empties the set, which is the crash
case answering correctly.

### One request, one attempt

**A request that leaves `pending` never returns to it.** Once the executor has
written `merging`, the row is resolved exactly as docs/287 resolves a direct
claim: merged ⇒ settle, definitively refused ⇒ delete and say so,
indeterminate ⇒ leave it for reconciliation, which reads the tuple and either
settles or deletes.

This is the decision that removes the `revoked` column. A row that can never merge
again after one attempt is already, by construction, cancelled by revocation:
deleting the `pending` rows is the whole of requirement 4. Retrying an attempt
whose outcome was never learned is also the one retry that could merge twice, and
an arming that quietly retries every tick is the surprising behaviour the refusal
rule below rejects for the same reason.

The cost is that a transient failure ends the request instead of retrying it. The
agent is told, in the transcript, and can ask again. Nothing in the requirements
promises a retry.

### What the executor waits for, and what ends the request

Each tick reads the pull request through docs/287's `readMergeObservation` — the
same single query, so the two paths cannot diverge — and applies one rule:

> **Wait only while the checks are running. Merge when they are green. End the
> request, with a notice, in every other case.**

| What the read finds | The row |
|---|---|
| unreadable | stays `pending`; try the next tick — but see *A bounded run of unreadable answers* |
| the rollup describes a different commit | stays `pending` — the armed commit's checks have not reported |
| head is no longer `expected_sha` | cancelled, with the req 3 notice |
| `MERGED` at `expected_sha` | settled, with docs/287's narrower recovery wording |
| `MERGED` or `CLOSED` at another head | cancelled as moved-head (req 3) |
| `CLOSED` unmerged | ended, with a notice |
| draft, review not `APPROVED`, checks `FAILURE`/`ERROR` | ended, with a notice naming the reason |
| checks `PENDING`/`EXPECTED` | stays `pending` — the one waiting state |
| no checks at all | docs/287's zero-check grace decides: wait, or merge |
| checks `SUCCESS` | merge |

Ending on a red or unapproved pull request rather than waiting is deliberate.
Waiting is defensible — a re-run can turn a flake green, a reviewer can approve —
but it makes a request that never terminates, and an unbounded background job the
user cannot see. The notice is the value: the agent learns the merge is not coming
and can act. In practice the common repair (push a fix) moves the head, which
cancels the request under req 3 regardless.

**The rollup must describe the commit being merged.** Arming deliberately
ignores a lagging rollup — that lag is *why* the request exists — so the executor
is the place that must not. Reading a lagging `SUCCESS` here would merge a head
CI has never seen, which is exactly the fail-open docs/287's
`head-moved-since-checks` rule exists to stop.

**A bounded run of unreadable answers ends the request.** An unreadable read is
transient by assumption, and the assumption has a limit: a deleted repository, a
revoked credential or a pull request ShipIt can no longer see would otherwise
leave the row pending for ever with the agent never told. Counted rather than
timed, and in memory rather than in a column, because the question is "have this
process's own reads kept failing?" — a restart re-earns the benefit of the doubt,
which is the right answer for an outage that spanned it. Any answer at all clears
the run; the limit is on *consecutive* failures.

**A throw from the merge call is `indeterminate`, never a failure.** The manager's
wrapper reads the pull request before it sends the merge, so a rejection can come
from either — and the second can reject after GitHub accepted it. The shape of an
error never decides whether something merged.

**The request names its own repository, and the session can be repointed while it
waits.** Without an identity check the grant is read from the session's *current*
remote while the merge is sent to the *claim's* repository: arm in A, repoint
`origin` to B where merging is allowed, and B's permission merges A. So the
executor confirms the session's remote still resolves to the claim's `repo_id`
and that its provenance still names this pull request, before either check.

### Where the executor runs

**Its own small loop in the orchestrator process** (`services/agent-merge-executor.ts`),
built and started in `bootstrapManagers` immediately after
`reattachInFlightTurns()`. The interval runs unconditionally; a tick with no
`pending` row is one indexed `SELECT` and no GitHub call at all.

The parked design put it in the PR poller's tick. That is a second timer avoided
at the price of making armings a first-class input to **both** the polling
supervisor and the global gate — because the supervisor iterates
`tracker.sessionRepos` and the gate opens only for in-memory automation, so a
persisted request after a restart with no viewer would never receive a tick. Two
subsystems gain a concept; this one gains a timer. The timer is less. It also
needs no gate of its own: it makes a GitHub call only when a row exists, so an
idle ShipIt is exactly as quiet as before. It is stopped from the app's
`onClose` — the interval is `unref`'d and does not hold the process open, but a
tick firing after `app.close()` would query a closed database.

Starting **after** `reattachInFlightTurns()` is not incidental: until the adoption
sweep completes the runner registry is empty, so "is this session busy?" answers
no for everything and the executor could merge a surviving turn's pre-turn head
while that turn still holds uncommitted work. Same ordering, and the same reason,
as docs/287's startup reconciliation directly above it.

### A merge and a turn are mutually exclusive (req 6)

Two directions, and they need different mechanisms.

**The merge does not start while the agent is working.** The executor takes a row
only when the session is idle: no runner, or a runner that is not `running`, not
`agentBusy`, not holding `systemTurnInProgress`, with an empty queue.

**A turn does not start while the merge is in progress.** A busy check cannot give
that — `PostTurnHold.begin()` only increments a counter, and neither admission
site consults `agentBusy` — so the executor sets `runner.mergeHold` for the
duration of the attempt, and the two admission sites consult it beside the flag
they already consult:

| Site | Existing check | Turn start |
|---|---|---|
| `session-runner.ts` `dispatchOnRunner` | `runner.systemTurnInProgress` | dispatched turns **and** `releaseQueuedTurn`, which routes through `runner.dispatch` |
| `ws-handlers/send-message.ts` `handleSendMessage` | `runner.running \|\| runner.systemTurnInProgress` | the interactive send |
| `ws-handlers/send-message.ts` `handleAnswerQuestion` | `assertCanDispatch` only | an `AskUserQuestion` answer — it does **not** go through `dispatch`, it sets `running = true` and calls `runAgentWithMessage` itself, which is why it is the path most easily missed |
| `queue-drain.ts` `releaseQueuedTurn` | same | refuses to dequeue at all |

**A runner is not always there to hold.** A session with no container has no
runner at all, and the user opening it *during* the merge creates one — with
`mergeHold` false, free to start a turn. So the executor also marks the session
on the claim store (`markMergeInFlight`, in memory, not a column), and
`onRunnerCreated` seeds a fresh runner's hold from it. The `finally`
**re-resolves** the runner from the registry rather than using the one it
captured, so the runner created mid-call is the one released.

`mergeHold` is a new field rather than a reuse of `systemTurnInProgress` for one
reason: that flag is cleared by `turn-executor.ts` when a system turn ends, so two
holders sharing it is a lost update that silently removes the exclusion. The
rebase driver's flow (`rebase-driver.ts:421`) is the precedent for the shape, not
for sharing the field.

**Adoption after a restart is deliberately not gated.** It resumes a turn that
already exists rather than starting a new one, and gating it could block the very
turn that owns a persisted direct claim.

**Releasing the hold must actively restart the queue.** Draining is event-driven:
a finished turn drains once, and a background merge has no owning turn whose
completion could drain afterwards — so a message that arrived while the hold was
held would sit there until some unrelated event. Every exit from the attempt
clears `mergeHold` and calls the shared `releaseQueuedTurn()`
(`queue-drain.ts`), which exists for exactly this case: work with no turn of its
own (req 6, last sentence). Both run in a `finally`, **after** the durable state
change, so a crash in between leaves a row reconciliation resolves rather than a
queue released against a hold that still exists.

### Revocation (req 4)

Turning `allow_agent_merge` off deletes every **pending** row whose `repo_id`
matches, resolved by `repoId()` so every URL spelling of that repository is
covered — the same identity the grant itself is matched on, never
`canonicalRepoKey`.

Requirement 4 says *every* request that has not merged is cancelled, and the
in-flight case is not waived, but it needs no second mechanism:

- **The grant is re-checked twice**: once before the GitHub read, and again in
  the instant before the merge call, since the first is taken a round trip too
  early. This cannot be made atomic with the merge — **the residual window is the
  REST call itself**, which no design can recall, and GitHub's own arming has the
  same one. The late re-check is the whole of what is left.
- **A row past `pending` can no longer merge anything** (*One request, one
  attempt*): it is being settled, or it is being resolved from its tuple. There is
  nothing left to cancel.

So revocation reports the permission withdrawn once no row can merge again, not
once every network call has returned. A merge the user armed from the pull-request
card is GitHub-native and untouched (req 4, second sentence).

## Settlement

Entirely docs/287's, unchanged: the same witnessed recording, the same terminal
promotion, the same natural identity, the same narrower wording when recovery
cannot prove ShipIt performed the merge. Two details are this feature's:

- The executor settles with `witnessed: true` and **no turn token**. That is
  correct rather than a loophole: `settleAgentMerge` compares the token only
  against a turn that is *currently running*, and the executor holds the session
  idle for the whole attempt, so there is none to disagree with.
- **Notices have no runner to reach.** A post-turn or post-restart executor may
  have none, so they go through `persistNoticeUnattached()`.

## Key files

| File | Change |
|---|---|
| `src/server/shared/database.ts` | `agent_merge_claims` gains `origin` and `method`; `state` gains `pending` |
| `src/server/orchestrator/agent-merge-claims.ts` | the request half: `arm`, `listPending`, `beginMerging`, `cancelPendingForRepo` |
| `src/server/orchestrator/services/agent-merge-executor.ts` | new — the tick, the wait/merge/end rule, the hold |
| `src/server/orchestrator/services/github.ts` | repo-bound `--auto` records a request instead of refusing |
| `src/server/orchestrator/api-routes-github.ts` | the `onArm` hook: grant + provenance re-check, then the row |
| `src/server/orchestrator/api-routes-session-repos.ts` | revocation deletes pending rows for the repository |
| `src/server/orchestrator/session-runner.ts`, `container-session-runner.ts` | `mergeHold` on the runner; `dispatchOnRunner` consults it |
| `src/server/orchestrator/ws-handlers/send-message.ts`, `queue-drain.ts` | the interactive send, the `AskUserQuestion` answer, and the drain consult it |
| `src/server/orchestrator/runner-registry-factory.ts` | a runner created mid-merge is seeded held |
| `src/server/orchestrator/services/agent-merge-settlement.ts` | reconciliation stands down for a merge in flight |
| `src/server/orchestrator/bootstrap-managers.ts` | construct and start the executor after adoption; `route-registry.ts` and `startup-monitors.ts` take it from the runtime |
| `src/server/shipit-docs/github.md` | the agent-facing `--auto` section |

## Tests

- The row: `arm` replaces a `pending` row, is refused over `merging`/`settling`;
  a direct claim supersedes `pending` and is still refused over the other two.
- The rule table above, one case per row.
- Restart: a persisted request is carried out with no viewer and no tracked
  session, and only after adoption.
- Admission: a turn queues while the hold is held, and **starts** when it clears —
  interactive, dispatched, and through the drain.
- Revocation: pending rows for that repository deleted, another repository's left
  alone, and the grant re-check refusing at `pending → merging`.
