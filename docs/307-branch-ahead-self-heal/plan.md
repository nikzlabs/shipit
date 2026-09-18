---
issue: planning#579
title: A branch ahead of its remote heals itself — design
description: Two independent repair paths (post-turn and PR poll) for a push that was never armed, plus the visible hold on the PR card.
---

# 307 — A branch left ahead of its remote

Implements [`requirements.md`](./requirements.md). Requirements are cited as
`(req N)`.

## The trap

`postTurnCommit` (`src/server/orchestrator/ws-handlers/post-turn.ts`) armed the
auto-push in exactly two cases: `git.autoCommit()` made a commit, or no commit
was made but `turnStartHeadHash` is set AND HEAD moved during the turn (the
agent committed on its own).

So arming was a **side effect of this turn moving HEAD**. Nothing reconsidered a
branch that was *already* ahead. Once a push was missed for any reason, no
ordinary turn recovered it: a recovery turn runs on a clean tree with HEAD
unchanged, hits neither branch, and arms nothing. The user sends message after
message and the branch stays ahead forever.

Downstream the state was fully diagnosed and then discarded:

| Where | What it knew | What it did |
|---|---|---|
| `pr-status-poller.ts` | `branchSync` from `readBranchSync()`, every tick | stored it on the summary |
| `auto-merge-manager.ts` | `summary.branchSync.state === "ahead"` | one `console.log`, deduped forever by `syncLogged` |
| `PrStatusControls.tsx` | the same state | disabled the merge button |

Nobody scheduled a push.

## The shape

Two repair paths, because neither covers the other's gap, and one visible hold.

### 1. Post-turn: a turn that moves nothing still checks the branch (req 1, 2)

In `commitInLock`'s `if (!commitHash)` block, after the moved-HEAD branch: read
the branch's sync against its remote from **local refs** (`readBranchSync`, no
network fetch) and, if it is `ahead`, call the same `pushUnlessMerged` the other
two paths call.

Routing it through `pushUnlessMerged` is what gives reqs 5 and 6 for free: it
consults `evaluateMergedBranchPush` and it honours `deferPushArm`, so the arm
still lands *after* the PR-lifecycle flow's own synchronous push — the ordering
CLAUDE.md's post-turn section pins.

This covers the session that keeps taking turns, including when PR polling is
gated off because no viewer is attached.

### 2. PR poll: a branch nobody will touch again (req 2)

`PrStatusPoller.healBranchAhead` runs on every tick that already computed
`branchSync`, and delegates the decision to `BranchAheadHealer`
(`services/branch-ahead-heal.ts`). It schedules through the **same**
`AutoPushScheduler` the turn path uses — there is still exactly one push route,
one debounce, and one place that reports `Auto-push completed …` /
`Auto-push failed (<class>)`.

The healer holds, in order:

| Check | Reason | Requirement |
|---|---|---|
| `sync.state !== "ahead"` | `not-ahead` | reqs 3, 4 |
| `!autoCommitAllowed(session)` | `kind` | req 10 |
| `session.secretBlock` | `secret-blocked` | req 10 |
| `runner.agentBusy \|\| runner.systemTurnInProgress` | `busy` | req 6 |
| `autoPushScheduler.pending(sessionId)` | `push-armed` | req 6 |
| back-off window not elapsed for this HEAD | `cooling-down` | req 7 |
| `evaluateMergedBranchPush` returns a block | `merged` | req 5 |

`agentBusy` is the load-bearing one for req 6: an armed or in-flight auto-push
takes a post-turn lease, so the PR-lifecycle flow's synchronous push cannot race
a poller-scheduled one. It is deliberately the same pair of flags the managed
auto-merge holds on — not a second definition of "idle". The busy/armed pair is
read **twice** — once before the two git awaits and once immediately before
`schedule()` — because a turn can start inside that window, and the claim has to
be made on what is true at the moment of claiming.

Req 10 is the review's finding: `sessionAutoCommitAllowed` gates the turn path at
the top of `postTurnCommit`, so a repair path that skipped it would be the one
automatic git write a `sandbox` or `ops` session still received. The secret-block
refusal is narrower than it looks — the block gates the **commit**, and a push
publishes the whole branch either way — but it keeps the background repair off a
session ShipIt has already refused to write to. On the post-turn path the block
has to be sampled *before* `clearSecretBlock` runs earlier in the same call,
which is why `commitInLock` reads it first.

Back-off (req 7) is keyed on the local HEAD: new commits restart the budget, the
same stuck tip doubles the wait from `HEAL_BASE_COOLDOWN_MS` (60s) to
`HEAL_MAX_COOLDOWN_MS` (30 min). A *hold* costs no attempt — the budget is for
pushes actually tried. Reaching `in-sync` forgets the session entirely, so the
next stall starts fresh.

### 3. The hold says itself (req 8)

`BranchSyncIndicator` (`client/components/PrLifecycleCard/indicators/`) renders
the `ahead` / `diverged` hold on the PR card's merge row. It appears only when
the merge button does **not** — the button already carries the same fact in its
tooltip, and the invisible case is precisely managed auto-merge, where
`showMergeButton = canMerge && !autoMerge?.enabled` renders nothing to hover.

### 4. A killed turn's work is flushed (req 9)

`restartAgent` (`services/recovery.ts`) called
`runnerRegistry.dispose(sessionId, { force: true })` first, and
`runPostInterruptCommit` opens with `if (runner.disposed) return` — so the
restart path had no commit-or-push flush at all. It now runs one before the
dispose, bounded by `RESTART_FLUSH_TIMEOUT_MS` so the restart button cannot hang
on a GitHub round trip.

Two guards make that bound safe. The flush **stands aside** when
`runner.postTurnWorkInFlight` — the ordinary terminal sequence is memoized and
arms its own push, and a second flush can only order its own arm against itself,
which is how a debounced plain push ends up racing the PR flow's synchronous one.
And a flush that overruns the timeout keeps running, so `postTurnCommit` now
takes `abortIfStale`, re-read **inside** the workspace lock: a flush that wins
the lock after its runner was replaced abandons the commit rather than sweeping
the replacement's edits up under the dead turn's summary.

And `postInterruptCommitDepsFrom` replaces three hand-assembled dependency
literals, every one of which had omitted `scheduleAutoPush` — so an interrupted
turn committed and then never pushed, which is one of the ways *into* the state
this feature repairs.

## Deliberately not done

The ops packet also suggested passing `turnStartHeadHash` through
`post-interrupt-commit.ts` and `turn-adoption.ts` (and it is `null` in
`dispatched-turn.ts` too). Each needs a turn's *starting* HEAD threaded through
a path that does not have one — the interrupt path cannot know it, and an
adopted turn's is genuinely lost with the previous process. The post-turn check
above subsumes all three from one place: whatever left the branch ahead, the
next turn that ends finds it. The `turnStartHeadHash` branch is still what
drives the **secret scan** of agent-made commits, and that is unchanged.

## Key files

- `src/server/orchestrator/services/branch-ahead-heal.ts` — the decision, and the back-off
- `src/server/orchestrator/pr-status-poller.ts` — `healBranchAhead`, called from the poll loop
- `src/server/orchestrator/ws-handlers/post-turn.ts` — `branchAheadOfRemote` in the no-commit path
- `src/server/orchestrator/services/post-interrupt-commit.ts` — `postInterruptCommitDepsFrom`
- `src/server/orchestrator/services/recovery.ts` — the pre-dispose flush
- `src/client/components/PrLifecycleCard/indicators/BranchSyncIndicator.tsx` — the visible hold

## Tests

- `services/branch-ahead-heal.test.ts` — every hold, the re-check after the git awaits, the back-off ladder and its cap, and that a hold costs no attempt
- `pr-status-poller.test.ts` — the **poll loop itself** schedules the push, and holds for busy / armed / merged / kind. Calling `healBranchAhead` directly would leave a deleted poll-loop call green, so these drive the real tick
- `ws-handlers/post-turn.test.ts` — arms on `ahead`, silent on in-sync / behind / diverged / detached HEAD / merged PR, and reads local refs only
- `integration_tests/auto-push-success.test.ts` — a real branch left ahead with no further turn converges to pushed, and does not push again once caught up
- `services/recovery.test.ts` — the restart commits and arms the push *before* disposing
- `services/post-interrupt-commit.test.ts` — the built deps carry `scheduleAutoPush`, and a flush that wins the lock after its runner is replaced abandons the commit
- `client/components/PrLifecycleCard/PrStatusActions.test.tsx` — the hold renders under auto-merge and defers to the button otherwise
