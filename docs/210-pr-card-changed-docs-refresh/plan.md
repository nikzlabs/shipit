---
issue: https://linear.app/shipit-ai/issue/SHI-163
description: Keep the PR card's changed-docs strip current after every turn, and base it on the merge-base diff so it matches the diff stat and Docs panel.
---

# PR card changed-docs strip — keep it current, matched to the Docs panel

A bug-fix follow-up to [docs/205](../205-pr-changed-docs/plan.md). The PR card's
collapsible **changed-docs strip** under-reported: it listed only the docs that
existed *at PR creation*, while the Docs panel's "Modified in this session" list
showed every doc the session touched. A user with several modified docs saw all
of them in the Docs panel but only one (the doc that existed when the PR opened)
on the card.

The goal: **both surfaces show exactly the documents modified in the current
PR**, and the PR card additionally shows the "important" files (the config
allowlist). They must not be able to drift.

## Root cause

Two independent gaps, both server-side in how `notableFiles` is computed:

1. **Frozen at PR creation (primary).** `notableFiles` is computed only in the
   `"ready"` / auto-create `"open"` lifecycle emits (`services/pr-lifecycle.ts`).
   Once a PR exists, `emitPrLifecycleAfterCommit` short-circuits at
   `if (prStatus) return` — the poller drives the card from then on, and the
   poller's `pr_status` path *preserves* the last-known `notableFiles` rather than
   recomputing it (by design, docs/205). So a doc changed on turn 8, when the PR
   opened on turn 3, never reached the strip. The Docs panel doesn't have this
   problem: it re-derives from git on every `GET /docs`.

2. **Two-dot vs merge-base.** `notableFilesForBranch` used a two-dot
   `git diff base HEAD` name-status, while the card's diff stat
   (`diffStatVsBranch`, three-dot) and the Docs panel
   (`getSessionChangedPaths`, merge-base) both use the merge-base diff. Two-dot
   additionally surfaces files that moved on `base` after the branch point —
   noise the branch never authored.

## Fix

### 1. One shared change set (no drift)

The two surfaces previously ran *different* git computations. They now both
derive from a single helper, **`committedChangesVsBase(git, baseBranch)`**
(`services/git.ts`) — the committed name-status diff for
`merge-base(base, HEAD)..HEAD`:

- `getSessionChangedPaths` (Docs panel's `changedInSession` flag) is now a thin
  paths-only projection of it.
- `notableFilesForBranch` (PR card strip) classifies the same set into docs +
  config.

So the strip is literally "the Docs panel's set, filtered to docs + the config
allowlist." Three former divergences are closed:

- **Base branch.** The Docs route no longer hardcodes `main`; it resolves the
  base the way the PR lifecycle does — the tracked PR's base
  (`prStatusPoller.getStatus(id)?.baseBranch`), else a re-armed session's prior
  base, else `main`. A PR onto a non-`main` base now lines up.
- **Committed-only.** `getSessionChangedPaths` dropped its `uncommittedPaths()`
  term. Uncommitted edits aren't in the PR; the per-turn auto-commit makes a
  doc appear in both surfaces at the same moment.
- **Merge-base, not two-dot.** The strip used a two-dot `base..HEAD`, which
  pulled in files moved on `base` after the branch point. The shared helper is
  three-dot (merge-base), matching the card's diff stat (`diffStatVsBranch`).

Intentional, kept differences (the Docs panel is a markdown browser; the strip
is a flat PR file list): the Docs panel folds `checklist.md` into its `plan.md`
row, and only the PR card shows config files and deleted docs.

### 2. Recompute every post-turn commit (no staleness)

In `emitPrLifecycleAfterCommit`, the existing-PR branch no longer bare-returns:
it re-derives the notable list from the current branch and emits a new
lightweight **`pr_notable_files`** WS message
(`{ sessionId, cardId, notableFiles }`). The client patches *only*
`notableFiles` on the live card (`pr-store.setNotableFiles`), leaving the
poller-owned fields (phase/pr/checks) untouched, so the strip tracks the branch
turn-by-turn without fighting the poller. The list is authoritative — an empty
array clears the strip.

A dedicated patch message (rather than reusing `pr_lifecycle_update`) is the key
choice: `updateCard` *replaces* the whole card, so a partial lifecycle update
would clobber the poller's phase/pr/checks. `pr_notable_files` → `setNotableFiles`
merges, so it's a safe in-place patch.

## Follow-up: strip empty after reload / session-switch (the third gap)

docs/210 fixed staleness *during a live session* (recompute every post-turn
commit). But `notableFiles` was still **transient client state** held on the
poller-driven card, pushed only at PR creation and on each post-turn commit. The
poller's `pr_status` snapshot — which rebuilds the card on a page reload, a
session switch, or an orchestrator restart — carries **no** `notableFiles`, and
`applyPrStatusUpdates` could only re-thread `existing?.notableFiles` (undefined
on a fresh load). So after a reload the strip rendered its **issue chips**
(derived client-side from the PR body + first message, so they survive) but
**dropped its doc/config/image chips** until the next turn committed. For a
finished PR (no more turns) the doc chips never came back. That's the
"modified documents are not always recognized" report.

### Fix

1. **Standalone client slice.** `notableFiles` moved off the card into its own
   `pr-store` map, `notableFilesBySession` (mirrors `autoMergeBySession`). It's
   keyed by session, independent of the poller-owned card, so a card rebuild
   can't drop it and a patch that arrives *before* the card exists isn't
   discarded (the re-seed and the poller snapshot travel on independent sockets
   with no ordering guarantee). `setNotableFiles` writes this slice
   authoritatively (empty list → key deleted → strip cleared); `updateCard` /
   `applyPrStatusUpdates` no longer thread it. The card only *gates* the strip's
   visibility — `PrLifecycleCard` shows doc chips only when a card exists, so a
   session with changed docs but no PR card can't render a floating strip.

2. **Re-seed on viewer connect (server).** `route-registry.ts`'s
   `activateSession` — which runs on every per-session WS (re)connect — now
   recomputes `notableFilesForBranch` for a session with a remote and pushes a
   `pr_notable_files` patch. Fire-and-forget + best-effort, so it adds no
   latency and a git error just leaves the strip empty until the next commit.
   This is the load-time analogue of the post-turn recompute: the same way the
   Docs panel re-derives from git on every `GET /docs`, the strip re-derives on
   every connect.

## Follow-up 2: strip frozen until session-switch, while diff numbers update live (the fourth gap)

A later report: after creating docs in an existing PR, the changed-docs strip
didn't update until the user **switched sessions** — yet the diff stat updated
immediately. Both should track the post-turn commit.

### Root cause

The post-turn `notableFiles` recompute lived **inside** the `if (prStatus)`
branch of `emitPrLifecycleAfterCommit`, coupling the strip refresh to the
PR-lifecycle state machine. The diff stat, by contrast, refreshes off the
**unconditional** `git_committed` emit (`post-turn.ts`), which fires on every
commit. So when a turn took a path *other* than the tracked-PR branch — most
often the **PR-recovery early-return** (lines that `trackSession` +
`forceRefreshSession` + `return` while the poller's `getStatus` is still null,
right after the PR was created or after an orchestrator restart) — the commit
landed with new docs but **no** `pr_notable_files` was emitted. The strip stayed
frozen until the next qualifying turn or the `activateSession` re-seed that runs
on session-switch/reload. That asymmetry is exactly "diff numbers update
immediately, docs don't."

### Fix

Hoist the recompute **above** the lifecycle branching in
`emitPrLifecycleAfterCommit`, so it fires for any remote, un-merged,
non-renamed session on every post-turn commit — the same unconditional cadence
as `git_committed`. Base resolution mirrors the session-switch re-seed
(`getStatus()?.baseBranch ?? previousMergedPr?.baseBranch ?? "main"`), and the
emit stays a notableFiles-only patch that merges into the live card. The
`if (prStatus)` branch no longer carries its own emit; the auto-create/ready
emits keep their inline `notableFiles` (atomic with card creation, idempotent
with the hoisted patch). Guard: `services/pr-lifecycle.test.ts` asserts
`pr_notable_files` fires in both the tracked-PR and the no-status path.

### Key files (follow-up 2)

- `src/server/orchestrator/services/pr-lifecycle.ts` — recompute hoisted above
  the branching; emitted unconditionally per commit.
- `src/server/orchestrator/services/pr-lifecycle.test.ts` (new) — pins the
  unconditional emit.

### Key files (follow-up)

- `src/server/orchestrator/route-registry.ts` — `activateSession` re-seed.
- `src/client/stores/pr-store.ts` — `notableFilesBySession` slice; `setNotableFiles`
  rewritten; card threading removed; removal/snapshot pruning of the slice.
- `src/client/hooks/message-handlers/pr-lifecycle-update.ts` — routes the
  PR-create `notableFiles` into the slice instead of onto the card.
- `src/client/components/PrLifecycleCard/PrLifecycleCard.tsx` — reads the slice,
  gates the strip on a card existing.

## Key files

- `src/server/orchestrator/services/git.ts` — `committedChangesVsBase` (new
  shared helper); `getSessionChangedPaths` reprojected onto it, committed-only.
- `src/server/orchestrator/services/notable-files.ts` — `notableFilesForBranch`
  classifies the shared change set.
- `src/server/orchestrator/api-routes-files.ts` — `/docs` route resolves the
  PR's base branch and passes it through.
- `src/server/shared/types/github-types.ts` — `WsPrNotableFiles` type.
- `src/server/shared/types/ws-server-messages.ts` — union entry.
- `src/server/orchestrator/services/pr-lifecycle.ts` — recompute + emit
  `pr_notable_files` on the existing-PR post-turn path.
- `src/client/stores/pr-store.ts` — `setNotableFiles` merge action.
- `src/client/hooks/message-handlers/pr-notable-files.ts` (new) + registration
  in `message-handlers/index.ts`.

## Tests

- `services/git-session-changes.test.ts` — committed merge-base set; uncommitted
  edits now excluded until committed.
- `services/notable-files.test.ts` — merge-base behavior; base-advanced file is
  excluded.
- `stores/pr-store.test.ts` — `setNotableFiles` patches in place, clears on
  empty, no-ops without a card.
