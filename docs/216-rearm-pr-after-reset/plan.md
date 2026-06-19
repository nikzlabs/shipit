---
issue: https://linear.app/shipit-ai/issue/SHI-178
title: Re-arm a merged session after a branch reset to a clean base
description: When a merged session's branch is reset to a clean base (no commits ahead), drop the stale merged PR card so the session reflects its clean current state.
---

# Re-arm a merged session after a branch reset to a clean base

## Problem

A session that merged a PR keeps showing the **"Merged: &lt;title&gt;"** PR
lifecycle card as its *current* state even after the branch is reset back to a
clean base — `git fetch origin --prune --tags && git reset --hard origin/main`.
After that reset the branch points at `origin/main` with **zero commits ahead
and no open PR**, yet the card still presents the previous merged PR as if it
were live.

The merged PR state is **server-derived and sticky**. When a PR merges, the
poller parks the session in `mergedSessions`, persists `pr_status: merged`,
stamps `session.mergedAt`, and **stops polling it** (docs/064, docs/202). The
only mechanism that clears that state is the docs/202 **re-arm**, and it fires
only when **both**:

1. the post-turn flow runs — which is **gated on the turn producing an
   auto-commit** (`turn-executor.ts` `runCommitAndPr`), and
2. `GitManager.advancedBeyondMergedBase(base)` is true — branch rebased onto the
   base tip **AND** a non-empty two-dot diff (genuinely **new work**).

A `git reset --hard origin/main` fails **both** gates: it leaves a **clean tree**
(so the turn auto-commits nothing → the post-turn PR flow is skipped) and an
**empty** two-dot diff (so `advancedBeyondMergedBase` is false even if the flow
did run). So nothing ever clears the merged state, and the card sticks. The
client merely reflects the server state — and `pr-store.updateCard`'s
terminal-regress guard means even a silent server clear wouldn't drop the card
on the *active* viewer without an overriding card.

This is the reset-to-clean counterpart of docs/202 (rebase + new work).

## Fix

Detect "**merged session whose branch is now reset to a clean base**" and re-arm
it to a clean (no-PR) state, on **every** turn — not just commit-producing ones.

### Detection — `GitManager.headIsAtBase(base)`

Local-git-only, no network. Returns true iff `rev-parse HEAD === rev-parse
origin/<base>` — the branch sits **exactly** at the base tip with no commits of
its own. Fail-safe false (stay merged) on a missing `origin/<base>` or any
resolution error.

This is the counterpart of `advancedBeyondMergedBase` and is **mutually
exclusive** with it: "at base" means zero commits ahead (empty diff), while
"progressed" requires a non-empty diff.

**Why it doesn't fire right after a legitimate merge.** None of GitHub's three
merge methods leaves `origin/<base>` equal to the branch tip: *squash* adds a
new squash commit (branch keeps its own commits), *merge* adds a `--no-ff` merge
commit (base advances past the branch), and *rebase-and-merge* replays the
branch's commits onto the base with **new SHAs**. So `headIsAtBase` is false
immediately after any merge and only becomes true once the user explicitly
resets/fast-forwards the branch onto the base — exactly the case we want to
re-arm.

### Trigger — every turn, not commit-gated

A branch-pointer reset produces no auto-commit, so the commit-gated
`postTurnPrFlow` never sees it. A new **every-turn** hook `postTurnReArmReset`
(mirroring `postTurnReleaseFlow`, which already fires "commit or not" for the
same reason) drives the detection. It no-ops cheaply for non-merged sessions
(`if (!session?.mergedAt) return`) and for merged sessions not at the base, so
the only sessions paying the local git check are merged ones, once per turn.

### Transition — `detectAndReArmResetSession`

On a merged session with `headIsAtBase(prior.baseBranch)` true:

1. `sessionManager.clearMerged(id, breadcrumb)` — clears `merged_at`, stashes the
   `previousMergedPr` breadcrumb (number + url + title + baseBranch). Pulls the
   row back into Active/gray.
2. `poller.reArm(id, prior.prNumber)` — **silently** clears `lastKnown` /
   `mergedSessions` / persisted `pr_status` and records the superseded PR number
   so the immediate forced poll's REST verify can't re-promote the old merged PR
   (docs/202 suppression).
3. `sseBroadcast("session_list", …)` — regroup the sidebar live.
4. Emit a **clean "ready" card** (`phase: "ready"`, 0 diff) carrying
   `previousMergedPr`. There is no new work, so it **does not auto-create a PR**.
   The breadcrumb both renders the "Previously merged #N" note and is the
   override signal that lets the card replace the active viewer's stale terminal
   merged card in `pr-store.updateCard`'s regress guard (re-arm broadcasts no
   destructive `pr_status` removal that could race it across transports —
   docs/202 "Transport").

On reload the card is reconstructed from server state: `mergedAt` and `pr_status`
are now null, so the SSE snapshot (`getAllStatuses` → `applyPrStatusUpdates`
snapshot branch) prunes the merged card and nothing stale rehydrates — the
"cleared" half of the deliverable. The next genuine new-work turn commits, the
session is no longer merged, and the normal `emitPrLifecycleAfterCommit` flow (or
the docs/202 progressed path) opens the next PR.

## Scope / limitations

- **Turn-gated, like docs/202.** The detection runs on assistant turns. In a
  chat-shaped IDE the reset *is* an agent turn, so this is immediate. A reset
  typed directly into the terminal panel (no turn) clears on the next turn — the
  same assumption docs/202 makes ("the rebase itself is an agent turn").
- **Both post-turn entry points are wired** — the interactive WS path
  (`ws-handlers/agent-execution.ts`) and the dispatch / system-turn path
  (`runner-registry-factory.ts`), so spawned children, CI auto-fix, and
  programmatic `shipit session message` turns re-arm too.

## Key files

| Area | File | Change |
|---|---|---|
| Detection | `src/server/shared/git.ts` | `headIsAtBase(base)` — `HEAD === origin/<base>` tip, fail-safe false |
| Transition | `src/server/orchestrator/services/pr-rearm.ts` | `detectAndReArmResetSession` — clearMerged → reArm → session_list → clean ready card (no auto-create) |
| Hook type | `src/server/orchestrator/session-runner.ts` | `SystemTurnDeps.postTurnReArmReset` (every-turn) |
| Trigger | `src/server/orchestrator/turn-executor.ts` | call `postTurnReArmReset` regardless of `commitHash` |
| Wiring | `ws-handlers/agent-execution.ts`, `runner-registry-factory.ts` | wire `postTurnReArmReset` on both post-turn sites |

## Testing

- `git-rearm-detect.test.ts` — `headIsAtBase`: reset-to-base → true; just-merged
  (squash, not reset) → false; new work on top → false; missing base → false.
- `pr-rearm.test.ts` — `detectAndReArmResetSession`: non-merged no-op; no prior
  base no-op; not-at-base stays merged (no card); merged + at base → clearMerged
  + reArm + session_list + clean ready card carrying `previousMergedPr`; git
  throw fails safe.
