---
issue: planning#165
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

## Follow-up 3: cross-feature title collapse dropped chips (the fifth gap)

Two confirmed reports of the strip rendering **fewer chips than the PR changed**.

- **PR #1877** (branch `shipit/review-done-linear-issues-m_1ljv`) changed **8**
  markdown files and rendered **6**. `docs/150-…/requirements.md`,
  `docs/246-…/requirements.md` and `docs/247-…/requirements.md` all resolve to
  the literal title "Requirements" (`requirements` is not in `GENERIC_FILENAMES`,
  so `titleFromPath` → `kebabToTitle("requirements")`).
- **Branch `shipit/brxzvw`** changed **3** files in *one* feature dir and
  rendered **2**: `plan.md` and `requirements.md` there carry an **identical
  author-written frontmatter `title:`** (same feature, so sharing a title is
  reasonable authoring under docs/241 spec-discipline).

### Root cause

`dedupeNotableDocs` keyed the collapse on **title alone, globally across the
whole diff, ignoring the directory**. It was added for one narrow case (a
feature dir's `plan.md` + `checklist.md` both deriving the *directory* title),
but docs/241 made `requirements.md` a standard per-feature file, so the
collision became systemic.

Worse than a miscount: with equal `docFilenameRank`, **first-seen won**, so the
single surviving "Requirements" chip on #1877 pointed at
`docs/150-multiple-provider-subscriptions/requirements.md` — clicking it opened
an unrelated feature's document. It also violated this doc's own invariant that
the strip and the Docs panel cannot drift: the panel keys by **path**, so it
listed docs the strip was hiding.

The two reports also rule out the obvious narrower fixes. `brxzvw`'s collision
is **same-directory** and comes from an **explicit author-chosen** title, so
neither rescoping the dedupe to same-directory nor restricting it to
path-derived titles would have helped. The collapse itself had to go.

### Fix — compact path labels, and no dedupe at all

Chips are now labelled by a **compact path** instead of a document title
(`compactPathLabel` in `services/notable-files.ts`):

- `<parent>/<basename>`, with a `NNN-slug` feature dir shortened to its number
  — `docs/246-native-issue-tracker-evaluation/plan.md` → `246/plan.md`.
- A non-numbered parent stays verbatim (`shipit-docs/environment.md`); a
  repo-root file is its bare basename (`shipit.yaml`). Only the immediate
  parent appears — the full path is still in the chip's `title=` tooltip.
- Applied to **all three tiers**, not just docs: it resolves the identical
  ambiguity for a monorepo's `api/package.json` vs root `package.json` and for
  `a/diagram.png` vs `b/diagram.png`.

This is the right identity for this surface: the strip is a **flat PR file
list**, not a document browser. A feature's `plan.md` and `checklist.md` are
indistinguishable when both render as the feature's title (and #1877 showed the
near-miss variant — "Native Issue Tracker Evaluation" vs "Native issue tracker
evaluation", differing only in case because one came from the directory and one
from frontmatter). The **Docs panel stays the title-and-description surface**;
`resolveDocTitle` / `titleFromPath` / `GENERIC_FILENAMES` are untouched.

Because a path is unique within a diff, labels can no longer collide — which
removes the entire reason `dedupeNotableDocs` existed. It and
`DOC_FILENAME_RANK` / `docFilenameRank` were **deleted**, making the chip set a
pure **1:1 projection** of the classified changed-file set and strip/Docs-panel
drift structurally impossible.

Deliberate behavior change: a feature dir with both `plan.md` and `checklist.md`
changed now shows **two** chips (`246/plan.md`, `246/checklist.md`) rather than
one. That is the point — the user asked to be able to tell the checklist apart
from the design doc.

Two consequences fall out:

- `NotableFileChange.title` was renamed to **`label`** — it no longer holds a
  title. (Transient per-session state, re-pushed on every connect, so an
  orchestrator/client version skew self-heals on reconnect.)
- `computeNotableFiles` no longer reads frontmatter, so it needs no
  `workspaceDir` and does **no disk I/O** — dropping a per-changed-file
  `fs.open` from both the post-turn recompute and the `activateSession`
  re-seed. `notableFilesForBranch(git, baseBranch)` lost its `workspaceDir`
  parameter too.

### Key files (follow-up 3)

- `src/server/orchestrator/services/notable-files.ts` — `compactPathLabel` (new);
  `dedupeNotableDocs` / `docFilenameRank` / `DOC_FILENAME_RANK` and the
  `resolveDocTitle` import deleted; `computeNotableFiles` is now synchronous and
  `workspaceDir`-free.
- `src/server/shared/types/github-types.ts` — `NotableFileChange.title` → `label`.
- `src/client/components/ChangedDocsStrip.tsx` — chip renders `file.label`.
- `src/server/orchestrator/services/pr-lifecycle.ts`,
  `src/server/orchestrator/route-registry.ts` — dropped the `workspaceDir` argument.
- `services/notable-files.test.ts` — regression tests for both reported shapes
  (#1877's 8 files, `brxzvw`'s shared-frontmatter-title trio) plus
  `compactPathLabel` unit coverage (root file, non-numbered parent, deep nesting,
  deleted file).

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
