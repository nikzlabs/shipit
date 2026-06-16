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
