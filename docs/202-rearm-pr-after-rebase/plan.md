---
issue: https://linear.app/shipit-ai/issue/SHI-134
title: Re-arm a merged session for a new PR after rebase
description: When a merged branch is rebased onto its base and gains new work, drop the stale merged PR state and treat the session as ready for a fresh PR.
---

# Re-arm a merged session for a new PR after rebase

## Problem

A session branch whose PR has merged is a dead end today. Once a merge is
detected, the session is parked in a terminal state and never re-evaluated:

- The PR poller adds the session to its `mergedSessions` set and **stops polling
  it** (`pr-status-poller.ts` — the set gates the per-session/repo/supervisor
  loops).
- The PR lifecycle card is locked into the terminal `"merged"` phase
  (`PrLifecycleCard.tsx`), with no controls.
- `markMerged()` stamps `merged_at`, which sinks the session out of the sidebar
  (top-N merged cap + Done group in `filterVisibleInSidebar`) and puts it on the
  faster merged disk-eviction ladder.
- The post-turn PR flow early-returns on `session.mergedAt`
  (`services/pr-lifecycle.ts`), so even new work after the merge never produces a
  new card or a new PR.

But a real and **frequent** workflow keeps the same session alive past the
merge: merge the PR, **rebase the branch onto the now-advanced base**, keep
working, open a *new* PR for the next slice of work. GitHub allows a second PR on
the same branch name after the first merges. ShipIt does not — it keeps showing
the old merged PR and offers no path to the next one.

There is **no divergence detection** anywhere: nothing compares the branch HEAD
against what was merged. That absence is the bug.

## Goal

When a merged session's branch has been **rebased onto its base and carries
genuinely new work**, ShipIt should:

1. Drop the stale merged PR state (no more terminal "merged" card).
2. Treat the session as a normal active session ready for a **new** PR
   (auto-create if enabled, otherwise the "ready" card).
3. Keep the session **visible in Active** and off the fast merged-eviction
   ladder — these sessions are long-lived by user intention.

…while adding **no extra GitHub query load** for the common case (merged
sessions that are *not* progressing).

## Detection — squash-safe, history-free

The naive signal "HEAD is ahead of base" is **wrong**, and squash merges are
why. After a squash merge the branch's original commits never enter the base's
history — the base gets one new squashed commit instead. So:

- `git rev-list base..HEAD` (commit ancestry) is non-empty for a freshly
  squash-merged branch with **zero** new work → false positive on every squash.
- `git cherry` / patch-id matching also breaks: squash collapses N commits into
  one, so no individual patch-id matches the combined squash commit.

The signal must be **content/tree-based, gated on the rebase**:

> **A merged session has "progressed" iff**
> `merge-base(origin/<base>, HEAD) == rev-parse(origin/<base>)`
> **AND** a **two-dot** `git diff origin/<base>..HEAD` is **non-empty**.

Why this is squash-safe with no squash-specific code:

- The merge-base equality is really "has the branch been rebased onto the
  *current* base yet?" Once rebased, the merge base *is* the base tip.
- Rebasing is what drops the already-merged content. For a **squash** merge git
  replays the commits, sees the content already present in the base (as the
  squash commit), and drops them as empty; for a **regular** merge the commits
  are already there. Either way, post-rebase an unchanged branch has an **empty**
  two-dot diff → still "merged/done". The moment there's new work the diff goes
  non-empty → progressed.
- **Before** the rebase, `merge-base ≠ base tip`, so we stay conservative and
  keep showing "merged" — correct, because pre-rebase against a moved base there
  is no reliable content diff anyway (three-dot breaks on squash, two-dot picks
  up other people's commits). The existing `diffStatVsBranch` uses **three-dot**,
  which is exactly the squash-breaking comparison — we must not reuse it here.

The check is **local git only — no network.** It keys directly off the user's
own action (the rebase).

## Turn-gated evaluation — no extra GitHub load

Detection and re-arm run **only from the post-turn flow**, once per assistant
turn for that session. There is deliberately **no poller-tick sweep** over merged
sessions:

- The local check (merge-base + two-dot diff) is cheap and offline, so running
  it per turn is free.
- GitHub polling only **resumes** for a merged session if that local check says
  the branch genuinely progressed — i.e. only when there's a real new PR to
  track. Merged sessions that aren't moving cost zero GitHub queries.
- The terminal-only-rebase-with-no-turn case waits until the next turn. In
  practice that's immediate: in a chat IDE the rebase itself is an agent turn.

## Re-arm transition

When the post-turn flow sees `session.mergedAt` set, it runs the detection. If
progressed:

1. `sessionManager.clearMerged(id)` — **new** method, sets `merged_at = NULL`
   (mirrors how `setPrStatus` already clears `closed_at` on reopen). This is what
   pulls the session back into **Active**, removes it from the Done group, and
   reverts it to the normal (slower) disk-eviction ladder. No separate pin
   needed.
2. `setPrStatus(id, null)` — clears the persisted merged summary so the client's
   snapshot reconciliation prunes the stale "merged" card.
3. Poller `reArm(sessionId)` — drop from `mergedSessions` and `trackSession`
   again so GitHub polling resumes for the new PR.
4. Fall through to the existing create/ready flow. Because the old PR is merged,
   `findPullRequest` (open-only) returns null, so `quickCreatePr` cleanly opens a
   **new** PR. The merge had deleted the remote branch, so the create path
   re-pushes it first — already its behavior, no change needed.

If **not** progressed: return as today (stay merged, no GitHub call).

## Auto-archive / visual-archive

Merge **never auto-archives** a session today — `onMergeDetectedCb` only calls
`markMergedAndPruneExcess` (sets `merged_at`, deletes the remote branch). The
workspace stays hot and the runner stays alive. So there is no archive call to
suppress.

Two reclaim/visibility surfaces still matter, and both are handled by the re-arm:

- **Visual archive** — the sidebar's top-N merged cap + Done group in
  `filterVisibleInSidebar`. A progressed session must stay in **Active**.
  Clearing `merged_at` makes `resolvedAt()` null → Active → visible.
  (`reopenedAfterResolve()` already floats a worked-in merged session back to
  Active even before re-arm, so there is no visible flicker.)
- **Disk eviction** — merged sessions evict faster (~2 days) than open ones
  (~14). Clearing `merged_at` reverts a progressed session to the normal active
  ladder, so it is not reclaimed out from under the user.

Requirement: **a merged-but-progressed session is never visually archived and
never fast-evicted.** It is treated as a plain live session.

## State transitions

```
                merge detected (verifyMissingPr)
   open  ───────────────────────────────────────▶  merged
                                                      │
                          post-turn: local detect     │  (per assistant turn)
                          progressed? ────────────────┤
                                                      │
                  no  ──────────────────────────▶  stay merged (no GitHub call)
                                                      │
                  yes ─▶ clearMerged + setPrStatus(null) + poller.reArm
                                                      │
                                                      ▼
                              Active, ready/creating ─▶ new open PR
```

## Edge cases

- **Base branch name.** Use the session's stored base (`baseBranch` from the PR
  summary / PR base), resolved as `origin/<base>`. `diffStatVsBranch` already
  relies on `origin/<base>` being present in the clone.
- **`origin/<base>` staleness.** Detection assumes the clone's `origin/<base>` is
  current; the user must have fetched to rebase, so it is. If `origin/<base>` is
  missing, detection returns false (stay merged) — fail safe.
- **Evicted workspace.** If a merged session sat long enough to be disk-evicted
  before the user returns, the local check can't run; treat as not-progressed
  until the workspace is rehydrated. Active use prevents this.
- **False merge positive (rate limits).** The poller documents that a persisted
  "merged" can be a false positive. Re-arm only fires on real new local work +
  rebased base, so a false-merged session that later shows new work simply gets a
  PR — desirable, not harmful.
- **Card wording.** Default: re-armed card reads as a clean **"no PR / ready"**.
  (Open question below.)

## Key files

| Area | File | Change |
|---|---|---|
| Detection | `src/server/shared/git.ts` | Add two-dot diff + `advancedBeyondMergedBase(base)` (uses existing `mergeBase()`); do **not** reuse three-dot `diffStatVsBranch` |
| Un-merge | `src/server/orchestrator/sessions.ts` | Add `clearMerged(id)` (sets `merged_at = NULL`) |
| Re-arm | `src/server/orchestrator/pr-status-poller.ts` | `reArm(sessionId)` — drop from `mergedSessions`, `trackSession` |
| Post-turn | `src/server/orchestrator/services/pr-lifecycle.ts` | Replace `if (session.mergedAt) return` with detect → re-arm → fall through |
| Client | `src/client/stores/pr-store.ts` | Verify snapshot reconciliation prunes the merged card; SSE session-update carries cleared `merged_at` so the session regroups to Active |

## Testing

- `git.test.ts` — detection matrix: {squash, regular} × {rebased, not-rebased} ×
  {new work, clean}. Squash+rebased+clean → false; squash+rebased+new-work →
  true; any not-rebased → false.
- `sessions.test.ts` — `clearMerged` clears `merged_at`; session returns to
  Active grouping.
- Poller integration — merged → progressed → re-armed (resumes tracking); merged
  → not progressed → no GitHub call.
- Post-turn integration — merged+progressed creates a new PR; merged+clean stays
  merged and visible/active per the requirement above.

## Open questions

- **Re-armed card wording:** clean "no PR / ready" (default) vs. a small
  "previously merged" breadcrumb. Functionally identical; this is a UX call.
