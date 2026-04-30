---
status: planned
---

# 111 — Continue on a New Branch

## Summary

A "continue on new branch" action in a session: keep the chat history and Claude's working context, but switch the underlying git worktree to a fresh branch off `main`. The current branch (and any outstanding PR) stays intact. Inspired by Conductor v0.32.0 — useful when you finish one feature and want to immediately start the next without losing the conversational warmup with the codebase.

## Motivation

Today, when a user finishes a feature in a session, their options are:

1. **Same session, same branch** — keep working, but new commits land on the merged PR's branch (mess).
2. **New session** — fresh chat, no context. Claude has to re-learn the repo from the top.
3. **Fork from a turn** ([RewindDropdown](../099-auto-pr-on-meaningful-turn/plan.md) flow) — only useful for going backward, not forward.

Power users want a fourth: keep the conversation warm (Claude has built useful context about the repo, conventions, recent decisions) but reset the working tree so commits go to a new branch and a new PR. Effectively: graduate the session.

## Design

### What "continue on new branch" does

1. Check the working tree is clean (no uncommitted changes). If dirty, prompt to commit or stash first.
2. Create a new branch off `origin/main` (or the configured base branch) using the existing branch-naming logic in `git-utils.ts:generateBranchPrefix`.
3. Rename the worktree's branch to point at the new branch (or in the underlying RepoGit, replace the worktree with a new one on the new branch).
4. Reset PR lifecycle state on the session: `prNumber = null`, `prStatus = null`, `mergedAt = undefined`, `branchRenamed = false`. The PR card transitions to its blank "ready to push" phase.
5. Insert a system message in the chat: `"Continued on new branch: feat/2026-04-30-add-billing"`. Acts as a visible boundary in the chat history.
6. Trigger the next user prompt to start the new feature.

### What it does NOT do

- Doesn't clear chat history. The summarizer ([104](../104-chat-toc-and-summaries/plan.md)) and Claude's own prompt-cache benefit from continuity.
- Doesn't reset Claude's working files context — the worktree is fresh on the new branch but the agent is still running. This is a feature: Claude knows the codebase from the previous work.
- Doesn't delete the old branch. It stays remotely so the PR keeps working independently.

### Constraints

Only available when:

- The session's current branch has a merged PR (`mergedAt` is set), **or**
- The user explicitly confirms "continue without merging" via a confirmation dialog (graduating mid-flight is allowed but flagged as unusual).

This nudges users toward the "finish a feature, ship it, start the next" flow that the action is designed for.

### Where it lives in the UI

- Action in the PR lifecycle card's overflow menu, surfaced after `phase: merged`.
- Action in the session header dropdown ("Continue on new branch…").
- Keyboard shortcut: `⌘⇧B`.

### Naming the new branch

Use `services/session-namer.ts` to generate a branch name from the user's first message on the new branch (or fall back to `feat/<date>-<random>` if unnamed). Match the pattern of existing session-named branches.

## Server pieces

- New service method: `services/session.ts:continueOnNewBranch(sessionId, opts)`:
  1. Calls `git.isClean(sessionDir)`. Throws `ServiceError(409, …)` if dirty.
  2. Calls `git.fetch(sessionDir, baseBranch)`.
  3. Calls `gitManager.createBranch(sessionDir, newBranchName, fromRef = base)`.
  4. Updates session metadata: clears PR fields, sets new branch.
  5. Inserts a system message into chat history via `ChatHistoryManager.appendSystemMessage`.
  6. Broadcasts `session_metadata_update` and `pr_lifecycle_update phase=ready`.
- New WS server message `session_branch_continued { sessionId, oldBranch, newBranch }` — purely informational, drives a small toast.

### Worktree mechanics

`RepoGit` (`repo-git.ts`) owns worktree lifecycle. We add `RepoGit.changeBranch(worktreePath, newBranchName)`:

- Creates the new branch in the bare repo (`git -C bareRepo branch newBranch base`).
- In the worktree, runs `git checkout newBranch` (the new branch is empty relative to base, so checkout is fast).

This avoids destroying and re-creating the worktree, preserving the agent process and any open file watchers.

### Edge case: outstanding auto-fix loops

If `useAutoFix` is mid-loop on the old branch, abort the loop on branch change. Otherwise the next failed-CI fix would land on the new branch, which is wrong.

## Client pieces

- New menu item in `PrLifecycleCard.tsx`'s merged-phase overflow.
- New menu item in the session header dropdown.
- New action in `session-store.ts`: `continueOnNewBranch(sessionId, opts)`.
- New toast component for the "continued on…" notification.

## Tests

`integration_tests/continue-on-new-branch.test.ts`:

1. Session with a merged PR + clean tree → action succeeds → new branch created off main, PR card resets to ready.
2. Dirty tree → 409, no branch created.
3. Mid-flight (no merged PR) without confirm → 412 precondition, returns "requires confirm".
4. With confirm → succeeds.
5. Chat history retains all prior messages and gets a new "Continued on …" system message at the end.
6. Auto-fix loop is canceled on branch change.

## Key files

| File | Change |
|---|---|
| `src/server/orchestrator/services/session.ts` | New `continueOnNewBranch` |
| `src/server/orchestrator/repo-git.ts` | New `changeBranch` |
| `src/server/orchestrator/sessions.ts` | Reset PR state |
| `src/server/orchestrator/chat-history.ts` | `appendSystemMessage` if missing |
| `src/server/orchestrator/api-routes-session.ts` | `POST /api/sessions/:id/continue` route |
| `src/shared/types/ws-server-messages.ts` | `session_branch_continued` |
| `src/client/components/PrLifecycleCard.tsx` | Overflow menu item |
| `src/client/stores/session-store.ts` | Action |

## Future extensions

- **Auto-trigger on merge** — opt-in setting: "When my PR merges, automatically continue on a new branch off main." Removes a click from the rapid-shipping flow.
- **Carry notes forward** — the [scratchpad](../106-session-scratchpad/plan.md) is preserved by default; option to start fresh.
- **Branch-from-branch** — allow basing the new branch on something other than `main` (e.g. a long-lived integration branch).
