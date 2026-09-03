---
issue: planning#505
title: Merge it when the checks pass — design
description: A durable, commit-bound merge request that ShipIt performs itself, executed from the PR poller's tick and excluded against turns by admission.
---

# Merge it when the checks pass — design

> **Parked, 2026-09-03, until `docs/287-agent-merge-per-repo` is implemented and
> merged.** This feature's foundation — the durable claim, the pull-request
> provenance, the live observation and settlement — is 287's, and reviewing this
> design against *that design* rather than against shipped code produced repeated
> rework: three consecutive reviews returned blockers here while 287's half stayed
> stable. Nothing below is abandoned; it waits for something real to sit on.
>
> **Re-verify these against the implementation when this is picked up**, because
> each is written against a foundation that does not exist yet:
>
> - **The claim table's extension.** This adds `pending`, `origin` and `revoked`
>   to 287's `agent_merge_claims`. Check the shipped columns and states first.
> - **The admission gate.** A background merge must exclude turns, and turn starts
>   are not confined to the two obvious entry points — the queue drain and
>   `runDispatchedTurn` also start work. Confirm the shipped set.
> - **Queue release.** Every background-claim exit must call the shared
>   `releaseQueuedTurn()`; a background merge has no owning turn whose completion
>   would drain the queue.
> - **Revocation semantics.** "Cancel every request at any time" cannot be met
>   literally for a request already in flight. The in-flight contract here —
>   re-check the grant at `pending → merging`, mark rather than delete, never
>   return a revoked row to `pending` — needs stating in requirement terms rather
>   than as a mechanism.
> - **Turn ownership.** A turn-owned claim assumes the caller is inside a live
>   turn, and the route checks no turn identity today. Bind it to a turn identity,
>   not to a mutable boolean.
> - **The immediate-green case.** A review argued `--auto` should merge at once
>   when the observed commit is already green, rather than always deferring —
>   requirement 1 says "once the checks pass", which an immediate merge satisfies.
>   Settle that against the shipped observation.

Implements [requirements.md](./requirements.md). Builds directly on
[`docs/287-agent-merge-per-repo`](../287-agent-merge-per-repo/plan.md) and changes
nothing it decided: the repository grant, the ownership tuple, the flush, the live
read and its observation, merging at an exact SHA, the durable claim and
settlement are all that feature's, and are used here as they are.

## What this adds

`gh pr merge --auto`, in a repo-bound session, stops being a refusal and becomes a
**request**: the observation that would have refused for pending checks instead
records what to merge, and ShipIt performs that merge later. `--auto` never merges
inline, even when the checks are already green — one flag, one meaning. An agent
that wants the merge now calls `gh pr merge` without it.


`--auto` does **not** use GitHub's own merge-when-green. `expectedHeadOid` is a
precondition checked when the arming is *enabled*, not a binding on the merge
GitHub later performs, and GitHub keeps an arming alive across a push by anyone
with write access — so a native arming can land a commit the agent never
authorised, and withdrawing the grant cannot cancel it. The existing
ShipIt-managed loop is no better on its own: `AutoMergeState` holds neither a
pull-request number nor a SHA, and it selects through the branch-keyed map.

**Repo-bound sessions only.** A sandbox has no `session.remoteUrl`, may target
several repositories, is not tracked by the repository poller, and is governed by
`dangerousGitHubOps` rather than the repository grant. `docs/287-agent-merge-per-repo` req 12 settles it:
sandbox behaviour does not change, and none of this section applies there.

It **extends `agent_merge_claims`** (docs/287) rather than adding a second table
— the row already carries repository, pull request, expected SHA, method and
state, and a request is the same thing with a life before the merge call:

```sql
ALTER TABLE agent_merge_claims ADD COLUMN origin  TEXT NOT NULL DEFAULT 'direct';
ALTER TABLE agent_merge_claims ADD COLUMN revoked INTEGER NOT NULL DEFAULT 0;
CREATE INDEX idx_agent_merge_claims_repo ON agent_merge_claims(repo_key);
-- `state` gains a third value, `pending`, which only an `origin = 'auto'` row uses
```

There is deliberately no `armed_at`: nothing times a request out, and a column no
code reads is a column that will drift.

### The state machine

`pending → merging → settling → deleted`, and the claim is written **before** the
REST call, never after it. An executor that only recorded success would have an
unrepresentable window: the row it is merging could be replaced or cleared while
the call is in flight, leaving its own success nowhere to land.

| State | Written | Who may touch it |
|---|---|---|
| `pending` | when `--auto` records the request | every lifecycle clear, revocation, a second `--auto` |
| `merging` | durably, immediately **before** the REST call | only the performer |
| `settling` | on a witnessed REST success | only settlement |

A second `--auto` while a row is `merging` or `settling` is **refused**, so one
row per session stays true and the primary key cannot collide. `merging` and
`settling` are **monotonic**: an origin change, archive, a re-arm, a reset, an
unarchive, a repository removal and revocation all act on `pending` rows only.
Only settlement, or destroying the session (through the cascade), removes a
`merging` or `settling` row.

**A merge attempt has three outcomes, not two.** The REST call is a plain
`fetch`, which can reject *after* GitHub accepted the request — so "it threw" does
not mean "it did not merge", and treating it as a failure would discard the
record of a merge that already happened:

| Outcome | What it means | What happens to the row |
|---|---|---|
| **witnessed success** | a parsed response saying the merge landed | → `settling` |
| **definitive refusal** | GitHub answered no — conflict, protection, moved head | deleted, reason surfaced once |
| **indeterminate** | a transport error, a timeout, an unparseable body | stays `merging`, reconciled from the tuple |

A definitive refusal **ends the claim**, whatever its origin: the row is deleted
and GitHub's reason is surfaced once. The requirements ask ShipIt to wait for
*checks*, not to keep an arming alive after GitHub has said no — a conflict or a
branch-protection refusal at a fixed commit does not resolve itself, and a
lingering arming that retries every tick is both surprising and noisy. A direct
refusal reaches the agent as the command's answer; an arming's refusal reaches
the transcript as a notice.

An indeterminate outcome — and equally a crash — leaves the row `merging`, and it
is resolved from its own tuple: read that pull request in that repository and ask
whether `expected_sha` merged. Merged ⇒ `settling`. Still open ⇒ back to
`pending` for an arming, deleted for a direct claim — unless the row is `revoked`,
which terminates it instead. Nothing is decided from the shape of the error.

**A `pending` row also needs terminal handling.** The observation table refuses
every non-open pull request, so without this a row whose pull request was merged
or closed by somebody else — the user, the pull-request card's own auto-merge —
would refuse for ever, and keep the polling gate open with it:

| What the read finds | The row |
|---|---|
| `MERGED` at `expected_sha` | settle, with the narrower "the agent asked for this commit and it is now merged" attribution (req 9) |
| `MERGED` or closed at a different head | cancel as moved-head, with the req 3 notice |
| closed without merging | delete, with a terminal notice |

### Where the executor runs, and what it excludes

In the PR status poller's existing tick, beside the managed auto-merge loop —
not a second timer. Durability alone would not reach it: the polling supervisor
iterates `tracker.sessionRepos` and the global gate opens only for in-memory
automation, so after a restart with no viewer a persisted arming would never
receive a tick. Armings are therefore a **first-class input to the supervisor and
the gate** — loaded at startup, `ensure()`d when one is written, and their
repository ticked even when no ordinarily tracked session would keep polling
alive. They are **activated only after `reattachInFlightTurns()` completes**,
because `trackSession()` polls immediately when the gate is open and the poller
exists before reattachment; activating at construction could merge a session's
pre-turn head while a surviving turn still holds uncommitted work.

**A merge and a turn are mutually exclusive, through admission (docs/266 req 2).**
A busy check alone cannot give that: `PostTurnHold.begin()` only increments a
counter, interactive admission (`ws-handlers/send-message.ts`) tests `running`
and `systemTurnInProgress`, dispatched admission (`session-runner.ts`) does the
same, and none of them consults `agentBusy` — so a turn can start *during* the
REST call, after which its push is refused and its work is stranded. That is a
documented failure of the existing managed loop, not a hypothetical.

The exclusion is a **session-scoped merge claim**, and it has two kinds, because
the two performers stand in opposite relations to the turn:

| Claim | Taken by | Precondition |
|---|---|---|
| **turn-owned** | the direct `gh pr merge` route | none — it belongs to the turn that is already running, and that route documents that its own runner is always running |
| **background** | the arming executor | the session is idle **and** its queue is empty |

An idle-only rule would make the direct path impossible, since that HTTP call is
issued from inside the active turn. A turn-owned claim instead says "this turn is
merging", which is exactly what a later turn must wait for.

**The claim is only worth what admission is.** Turn starts are not confined to
the two entry points named above: a queued turn re-enters through
`ws-handlers/agent-execution.ts`'s drain, and `runDispatchedTurn`
(`session-runner.ts`) deliberately bypasses the ordinary send-or-queue decision
via `dispatched-turn.ts`. A check added to two of those four is not an exclusion.
So every turn start — interactive send, dispatched turn, and queue drain —
passes through **one authoritative admission gate** that consults the claim; a
background claim makes a turn wait, and it is released when the merge has
settled.

**Adoption after a restart is deliberately not gated.** It resumes a turn that
already exists rather than starting a new one, startup already completes adoption
before later automation, and gating it could block the very turn that owns a
persisted direct claim. The gate is for new work only.

**Releasing the claim must actively restart the queue.** Draining is
event-driven: a finished turn drains once, and a background merge has no owning
turn whose completion could drain afterwards — so a message that arrived while
the claim was held would sit there until some unrelated event. Every exit from a
background claim — settlement, cancellation, a refusal, or recovery — calls the
shared `releaseQueuedTurn()` (`queue-drain.ts`), which exists for exactly this
case: work with no turn of its own. It is called **after** the durable state
change, so a crash in between leaves a row that reconciliation resolves rather
than a queue released against a claim that still exists.

### Revocation (req 4)

Turning `allow_agent_merge` off deletes every **pending** arming whose `repo_key`
matches — one statement in the same transaction as the flag, resolved by
`canonicalRepoKey`, so every URL spelling of that repository is covered. Nothing
network-dependent can fail and leave a merge armed while ShipIt reports the
permission off, which is exactly what the native path could not avoid.

Requirement 20 says *every* request that has not merged is cancelled, so the
in-flight case is not waived. Three parts, because "wait for it to resolve"
cannot be the whole answer — an indeterminate outcome deliberately leaves a row
`merging`, so waiting could hang:

- **The grant is re-checked atomically at `pending → merging`.** A claim is never
  issued under a permission that has already been withdrawn.
- **Revocation marks in-flight rows `revoked`, durably**, rather than deleting
  them: a `merging` row must survive to be reconciled, but it must also carry the
  fact that its permission is gone, or a restart would lose that intent.
- **A revoked row never returns to `pending`.** Reconciliation reads its tuple: if
  `expected_sha` merged, it settles (the merge already happened, and requirement 9
  still wants the record); otherwise it terminates with a notice. Either way
  nothing further is merged.

Revocation reports the permission withdrawn once every row is `pending`-free —
deleted, or marked and therefore incapable of merging again — not once every
network call has returned.

## Settlement, and what this feature adds to it

Settlement is `docs/287-agent-merge-per-repo`'s, unchanged: the same witnessed
recording, the same canonical terminal promotion re-entered from a durable
`settling` row, the same natural identity built from `(repo_key, pr_number,
expected_sha)`, the same narrower wording when recovery cannot prove ShipIt
performed the merge.

Two things are this feature's own:

- **A `pending` row needs terminal handling**, because the observation refuses
  every non-open pull request — so without it a row whose pull request somebody
  else merged or closed would refuse for ever and hold the polling gate open with
  it:

  | What the read finds | The row |
  |---|---|
  | `MERGED` at `expected_sha` | settle, with the narrower "the agent asked for this commit and it is now merged" attribution |
  | `MERGED` or closed at a different head | cancel as moved-head, with the req 3 notice |
  | closed without merging | delete, with a terminal notice |

- **Notices have no runner to reach.** A post-turn or post-restart executor may
  have none, so they go through `persistNoticeUnattached()`.

## Key files

| File | Change |
|---|---|
| `src/server/shared/database.ts` | `agent_merge_claims` gains `origin`, `revoked`, the `pending` state and a repo index |
| `src/server/orchestrator/agent-merge-claims.ts` | the request half: arm, terminal handling, revocation marking |
| `src/server/orchestrator/pr-status-poller.ts` | the executor, in the existing tick |
| `src/server/orchestrator/pr-polling-supervisor.ts`, `polling-global-gate.ts` | requests as a polling input, so a restart still carries them out |
| `src/server/orchestrator/ws-handlers/send-message.ts`, `session-runner.ts`, `ws-handlers/agent-execution.ts` | one admission gate consulting the claim |
| `src/server/orchestrator/queue-drain.ts` | `releaseQueuedTurn()` called on every background-claim exit |
| `src/server/orchestrator/api-routes-session-repos.ts` | revocation marks in-flight rows and deletes pending ones |
| `src/server/orchestrator/services/github.ts` | `--auto` records a request instead of refusing |
| `src/server/shipit-docs/github.md` | the agent-facing `--auto` section |

## Tests

- The state machine: `pending → merging → settling`, a second `--auto` refused
  while in flight, and the three merge outcomes.
- Terminal handling of a `pending` row for each of the three read results.
- Restart: a persisted request is carried out with no viewer and no tracked
  session, and only after `reattachInFlightTurns()` completes.
- A full admission lifecycle: a turn queues, waits, is released and **starts** —
  interactive, dispatched, and through the drain.
- Revocation: pending rows deleted, an in-flight row marked and never returned to
  `pending`, and a timeout-plus-restart case.
