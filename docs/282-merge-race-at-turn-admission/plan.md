---
issue: planning#472
title: Merge race at turn admission — design
description: Refresh the merge state at turn admission so the docs/218 reset gate never decides against a stale poll.
---

# Merge race at turn admission

Implements [requirements.md](./requirements.md). Sits on top of
`docs/218-auto-reset-merged-branch-on-continue` (the reset itself) and
`docs/266-merge-time-reset-notice` (what a refusal says, and when).

## The race (req 1)

Merge detection is poll-driven: `PR_STATUS_POLL_INTERVAL_MS = 15_000`, so the
orchestrator can learn about a merge up to a poll interval after GitHub records
it. The docs/218 reset is, by construction, a *pre-turn* gate. A turn admitted
inside that window evaluates the gate against a session that does not read as
merged yet, gets the `not-merged` clause — the ordinary state of nearly every
session, and correctly silent — and runs on the branch untouched.

From the incident's orchestrator log (UTC, 2026-08-22):

```
19:31:02.08  [git] Pushed to origin/shipit/browser-game-performance-benchmark-oyvceu
19:32:02     GitHub merges PR #101
19:32:03.54  [turn] env-prep took 68ms                      <- turn ADMITTED
19:32:05.27  [pre-turn-reset] reset_eligible=true (merge-detected)  <- 1.7s TOO LATE
19:37:43.04  [git] Committed: ac6ebf2 …
19:37:43.12  [merged-push-guard] auto-push refused … stacked on the merged tip
```

The trigger is the ordinary way to use the product: click merge, then type the
next message. 1.5 seconds apart here; anything inside 15 seconds does it.

Nothing downstream was wrong. The guard refused correctly (req 2), the commit
happened (req 3), the `head-moved` post-turn line and the guard's notice both
fired. The session was simply left on a branch it could not ship from, needing a
manual `gh pr create`. **The defect is the freshness of the input to the gate,
not the gate.**

## The fix

`services/pre-turn-merge-recheck.ts` — `recheckMergeBeforeTurn`, called from
`pre-turn-reset-hook.ts` immediately before `autoResetMergedBranchOnContinue`,
so both transports (the interactive WS turn and every dispatched turn) inherit
it for the planning#333 reason.

It runs one definitive, single-session probe of the pull request's true state and
then gets out of the way. It decides nothing about the branch: if the probe finds
a merge, the ordinary docs/218 gate runs in its ordinary place and produces the
ordinary reset, card, agent prefix and re-arm. If it finds nothing, the turn is
byte-for-byte what it is today.

### Two gates stand in front of the network (req 5)

Both are free or nearly so, and each rules out a case where a fresher answer
could not change the outcome:

- **The poller's last observation must say the PR is OPEN.** In-memory. No open
  PR ⇒ nothing could have merged out from under us.
- **A reset must be applicable.** The local `origin/<session-branch>` ref must
  not *disagree* with HEAD — a branch carrying unpushed commits fails the gate's
  `head-moved` clause however fresh the merge state is — plus
  `checkResetPreconditions`, the same clean-tree / on-branch / no-sequencer
  clauses the reset requires. That function is now exported and shared rather
  than copied, so "would a reset be applicable here?" keeps one definition.

  A ref that does not *resolve* is deliberately not treated as one that differs.
  `origin/<session-branch>` can legitimately be absent — a clone restored from
  the bare cache after GitHub deleted the merged head branch, or any prune —
  while HEAD is still exactly the commit GitHub merged, which is what the gate's
  anchor clause accepts. Only a resolvable, disagreeing ref proves the branch
  moved; an unavailable one proves nothing, so it must not exclude the probe.

So the cost lands on turns of sessions with an open PR and a clean, fully-pushed
branch: one REST probe plus the canonical-owner GraphQL probe
`forceVerifySessionPrState` needs for transferred repos, bounded by
`MERGE_RECHECK_TIMEOUT_MS` (8 s).

**Not gated on the `autoResetMergedBranch` setting.** With the setting off the
reset is skipped, but the `setting-off` skip still writes its transcript notice
and its agent prefix — "your pull request merged, this branch is dead, do not
commit here" — which is exactly the fact whose absence produced the incident.
Gating would make the fix silently inapplicable to a subset of users.

### Two halves of merge detection, and why the wait exists

`verifyMissingPr` records the merged snapshot and `mergedHeadSha` synchronously,
then fires `onMergeDetectedCb` **fire-and-forget** — and that callback
(`markMergedAndPruneExcess`) is what stamps `merged_at`. Every clause of the
docs/218 gate reads `mergedAt`, so "the probe resolved" is not the same fact as
"this session now reads as merged": without waiting, the recheck reads the
session one beat too early and answers *not merged* for a merge it just
discovered itself — the same one-beat error as the poll window.

So `PrStatusPoller` now keeps the in-flight callback promise per session and
exposes `awaitMergeHandling(sessionId)`. It covers the merge this probe
discovered *and* one a background poll discovered a beat earlier (whose
`alreadyTerminal` guard means our probe fires no callback of its own). The entry
removes itself when the callback settles; `reArm` and `untrackSession` clear it
too, because a handler that never settles would otherwise make every later
qualifying turn wait out the whole budget on a merge the session has since been
re-armed out of.

The recheck bounds both halves with one timeout, because that callback awaits a
`git push --delete` of the merged head branch (plus the docs/266 merge-time
notice and any self-merge wake), none of which may be able to strand a turn
(req 6).

### A timeout is not "nothing happened" — the third outcome

`markMergedAndPruneExcess` stamps `merged_at` **first** and only then awaits the
head-branch deletion (`services/session.ts`). So an expired budget can land with
the session reading as merged while that deletion is still in flight — and if the
gate acted on it, the reset would force-push the branch back for the pending
delete to remove it. That trades a stranded commit for a deleted branch, and if a
new pull request had been opened from it in the meantime, GitHub closes that PR
with it.

Hence `MergeRecheckOutcome` is three-valued. On `unsettled` the hook skips the
reset for this turn entirely: the turn runs un-reset, which is exactly the
pre-docs/282 behaviour (req 6), and the next turn — against settled state —
resets. The rule is the general one: never take a destructive action on state you
know is mid-flight.

### `armAbsentDebounce: false` is load-bearing

`forceVerifySessionPrState` arms the `verifiedAbsent` single-probe debounce on
every resting outcome. Every pre-existing caller probes a PR it expects to be
*terminal*, where arming is right. This one probes a PR it expects to still be
**open**, on every qualifying turn — and `verifiedAbsent` clears only when the PR
reappears in the OPEN bulk view or a forced refresh happens. Arming it here would
mean a PR merged moments after a recheck falls out of the bulk view with the
debounce already set, is never REST-verified, and merge detection stops until
something forces a refresh. That is a *worse* bug than the one being fixed, which
is why it has its own test.

## Why not reset mid-turn (req 4, resolved question)

The ops packet's option 2 — apply the reset when the merge is detected while a
turn is in flight and the branch has not moved — is cheaper on paper. At
19:32:05 the branch was still at the merged tip and nothing had been committed,
so a reset was still *safe* in the git sense.

It is not safe in the agent sense. A `reset --hard` re-materializes the whole
worktree under a process that is reading and writing it: the agent may already
have read files it will now edit against a different tree, `onWorkspaceRewritten`
would kick a dependency reinstall into the middle of the turn, and the gate's
clean-tree clause protects only edits that have already landed on disk — not the
ones in flight. That trades a stranded commit for a corrupted turn.

Refreshing the *input* at admission gets the same outcome with none of that: the
destructive move stays where it already is, before any agent process exists.

Option 3 (recover the stranded state afterwards) was not taken either: rebasing
the new commits off the merged tip is a history rewrite in the post-turn path
with real conflict potential, and it treats the symptom while the gate keeps
deciding on stale input.

## Key files

- `src/server/orchestrator/services/pre-turn-merge-recheck.ts` — the recheck: the
  two local gates, the bounded probe, the fail-safe.
- `src/server/orchestrator/pre-turn-reset-hook.ts` — calls it ahead of the gate,
  for both transports.
- `src/server/orchestrator/pr-status-poller.ts` — `mergeHandling` +
  `awaitMergeHandling`, and `forceVerifySessionPrState`'s `armAbsentDebounce`.
- `src/server/orchestrator/services/pre-turn-reset.ts` —
  `checkResetPreconditions` is exported so the recheck's local gate is the
  reset's own, not a copy.

## Tests

- `services/pre-turn-merge-recheck.test.ts` — fires in the incident's state and
  with a missing remote-tracking ref; waits for `mergedAt`; spends no round-trip
  in each state where it must not; survives an error and a timeout; reports
  `unsettled` when the merge landed but its bookkeeping did not finish.
- `pre-turn-reset-hook.test.ts` (`refuses to reset while the merge bookkeeping is
  still in flight`) — the destructive case the third outcome exists for.
- `pr-status-poller.test.ts` (`drops a never-settling merge handler when the
  session is re-armed`) — the `mergeHandling` lifecycle clear.
- `pre-turn-reset-hook.test.ts` (`a merge the poller has not observed yet`) — the
  end-to-end reproduction: a session that is not merged at admission, whose probe
  discovers the merge, ends the turn setup with the branch reset and the card
  recorded. It fails without the recheck.
- `pr-status-poller.test.ts` (`turn-admission merge probe`) —
  `awaitMergeHandling` resolves only after the bookkeeping settles; the un-armed
  debounce leaves the next poll free to verify.

## What is deliberately unchanged

`services/merged-push-guard.ts` (req 2), the post-turn commit ordering (req 3),
the docs/266 busy gate (req 4), and every clause of `computeResetBlocker`. This
change adds no clause and relaxes none — it only makes sure the gate is answering
about the present.
