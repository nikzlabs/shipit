---
issue: planning#721
title: An armed merge either merges or the agent is told why not — design
description: Cancelled agent-merge requests reach the agent through the session inbox, and ShipIt's own rebase retargets a pending request to the commit it pushed.
---

# An armed merge either merges or the agent is told why not — design

Implements [requirements.md](./requirements.md), on top of
[`docs/288-agent-merge-arming`](../288-agent-merge-arming/plan.md).

## The gap

`runOneRequest` (`services/agent-merge-executor.ts`) ends a request through
`end()`, which writes a `notice: true` chat row. Notices never reach the agent:
the prompt prefix in `dispatched-turn.ts` carries the pending notice, bug and
card outcomes, the inbox notice, the reset prefix and the status card, and none
of those reads merge outcomes. The executor also starts no turn. So every
cancellation was user-only, and ShipIt's own rebase (`rebase-driver.ts`)
produced one: it force-pushes a new head, and the executor read that as "the
branch has moved past" the armed commit.

## Delivery: the session inbox (req 1, 2, 5)

The cancellation is stored as a message in the session's inbox
(`docs/328-session-message-inbox`), with no sender and a `[ShipIt]` body. That
store already has every property the requirements ask for, verified at
`services/session-inbox.ts:tellOwed` and `services/session-inbox-notice.ts:prepareInboxNotice`:

- the notice rides every prompt until the agent reads the inbox, then stops
  (told once, req 5);
- a running turn is steered with it, and an idle session is started with a turn
  (`wakeSessionWithTurn`, the same path notify-on-merge's self wake uses) (req 2);
- a failed start is retried by the inbox sweep, and a restart loses nothing
  because the owed notice is in the database;
- it is a list, so the single last-write-wins `pendingAgentNotice` slot a
  branch sync writes cannot replace it (req 5).

The operator's packet suggested the bug-outcome pattern (docs/164). The inbox is
that pattern with the wake built in, so no second store was added.

The inbox reaches every ending path through the claim store:
`AgentMergeClaimStore.setAgentInbox` is called once in `bootstrap-managers.ts`,
and `services/agent-merge-agent-notice.ts` reads it. Every path that ends a
request already holds the store, while the revocation path sits behind the
settings-proposal dependency chain; holding it there avoids threading a new
dependency through that chain.

Every ending writes the inbox row in the transaction that deletes the request
(`releasePending`, `releaseUnmerged`, `releaseAfterRecording`,
`cancelPendingForRepo` take a synchronous `record`). A write that throws
rolls the deletion back: a pending request ends on the next pass, and an
attempt row is settled and reported by reconciliation. So a request can never
be gone with no message. Telling the inbox runs after commit.

| Ending | Where |
|---|---|
| repointed PR, unreadable repository, permission withdrawn, branch moved, closed, draft, failed checks, review required, unknown rollup, too many unreadable reads | `end()` in `agent-merge-executor.ts` |
| permission withdrawn just before the merge call; GitHub refused the merge | `performMerge` → `releaseUnmerged` |
| an attempt that settlement finds did not merge (or merged at another commit) | `releaseNotMerged` in `agent-merge-settlement.ts` |
| the user turned agent merging off | `cancelAgentMergeRequests` in `settings-apply.ts` (the only revocation path; the `PATCH /api/repos/:url` route and the settings proposal both go through `applyRepoSettings`) |

Not told: a session that is gone (no agent to tell); an indeterminate merge
attempt, which is not an ending — settlement resolves it and tells the agent if
it did not merge; and a request the agent replaces itself by running
`gh pr merge` again (`AgentMergeClaimStore.write` replaces a pending row), where
the command's own answer is what the agent reads. A second `--auto` answers with
the commit it now merges. A direct merge that replaced a pending request and
then did not merge says in its answer that the earlier request is no longer
armed (`api-routes-github.ts`, `displaced`).

## ShipIt's own rebase moves the request (req 3, 6)

Every rebase ShipIt makes — automatic conflict resolution
(`runAutoResolveAttempt`, wired in `app-lifecycle.ts`) and the user's Sync
(`api-routes-git.ts`) — runs `runRebaseFlow`. After the flow's force-push
succeeds, `followArmedMerge` calls `AgentMergeClaimStore.retarget(session,
headBefore, headAfter)`:

- only a `pending`, `auto` request whose commit is `headBefore` — the commit the
  rebase started from — moves. A request armed at any other commit, including
  one that a pre-sync commit of uncommitted work made stale, is left for the
  executor to cancel and report;
- the force-push is then leased on that armed commit
  (`--force-with-lease=<branch>:<armed sha>`), so it replaces exactly the
  armed commit. If anyone else pushed in between, the push is rejected,
  nothing moves, and the executor cancels on their head and tells the agent.
  Without an armed request the lease is the one `forcePush` always took;
- `headAfter` is the commit ShipIt just pushed. A push anyone else makes after
  that does not match, so it still cancels (req 3);
- the executor is not changed in what it merges: it applies the same gate to
  the new commit as to an armed one — its own rollup, or the docs/288
  zero-check grace for a repository with no CI — and merges exactly
  `expected_sha` (req 3);
- a request that is not pushed (no GitHub auth, a refused shared-branch push)
  does not move, and the old commit stays the request.

The move runs under the flow's session hold, which the executor reads as not
idle, so the executor cannot compare the pushed head against the old commit in
between. One window remained: an executor read that started before the hold and
returned after the push. `runOneRequest` therefore re-checks idleness when the
head has moved, and waits instead of cancelling while the session is held.

If the retarget write itself fails after the push (a database error), the
executor later cancels on the new head and tells the agent: req 1 still holds,
and no retry was added for that case.

A user notice says the request moved (req 4 keeps the cancellation notice;
this one is new and says what happened instead). When a request is pending at
the rebase's starting commit, `buildRebaseConflictPrompt` adds that the merge is
armed and that ShipIt moves it (req 6).

Other ShipIt force-pushes are out of scope: the merged-branch reset
(`pre-turn-reset.ts`) and the PR re-arm (`github.ts`) run after the pull request
merged, and `release-prepare.ts` pushes a release branch no session merge
request names.

## Key files

- `src/server/orchestrator/agent-merge-claims.ts` — `retarget`, `setAgentInbox`
- `src/server/orchestrator/services/agent-merge-agent-notice.ts` — the inbox message and its delivery
- `src/server/orchestrator/services/agent-merge-executor.ts`, `agent-merge-settlement.ts`, `settings-apply.ts` — the ending paths
- `src/server/orchestrator/services/rebase-driver.ts` — `followArmedMerge`, `armedMergeAt`, the prompt line

## Tests

- `services/agent-merge-agent-notice.test.ts` — every ending reaches the inbox and tells it; a merge does not; told once; a sync notice does not replace it; a failed store leaves the request pending; a retargeted request merges the new commit after its checks pass; a head that moved under a session hold waits.
- `services/rebase-driver.test.ts` (docs/343 block) — clean and conflict rebases move the request and the prompt names it; another commit and an unpushed rebase do not.
- `integration_tests/agent-driven-pr.test.ts` — a refused direct merge that replaced an armed request says so in its answer.
- `integration_tests/repos.test.ts` — withdrawing the permission through the route puts the message in the inbox, through the app's real wiring.
