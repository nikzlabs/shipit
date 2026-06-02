---
description: Switch the working branch to a fresh branch off main while preserving chat history and agent context, so users can start a closely-related next feature without losing the agent's re-orientation cost.
---

# 111 — Continue on a New Branch

## Summary

A "continue on new branch" action in a session: keep the chat history and Claude's working context, but switch the underlying git worktree to a fresh branch off `main`. The current branch (and any outstanding PR) stays intact. Inspired by Conductor v0.32.0 — useful when you finish one feature and want to immediately start a *closely-related* next one without paying to re-orient the agent on the codebase.

> **What Conductor actually ships (v0.32.0, 2026-01-22):** *"Click 'Continue on new branch' to start work on a new feature in the same workspace. Use this to keep your chats and ignored files, or if it takes a long time to create new workspaces."* Two motivations: (a) keep chats + ignored files, (b) avoid slow workspace creation. See [§ Is this worth building in ShipIt?](#is-this-worth-building-in-shipit) — motivation (b) does not survive the move to ShipIt.

## Motivation

Today, when a user finishes a feature in a session, their options are:

1. **Same session, same branch** — keep working, but new commits land on the merged PR's branch (mess).
2. **New session** — fresh chat, no context. Claude has to re-learn the repo from the top.
3. **Fork from a turn** ([RewindDropdown](../099-auto-pr-on-meaningful-turn/plan.md) flow) — only useful for going backward, not forward.

Power users want a fourth: keep the conversation warm (Claude has built useful context about the repo, conventions, recent decisions) but reset the working tree so commits go to a new branch and a new PR. Effectively: graduate the session.

There's also a hard constraint that makes this an orchestrator action rather than a chat instruction: **[doc 130](../130-block-branch-ops/plan.md) (done) structurally blocks the agent from `git checkout -b` / `git switch -c` / `git branch <name>`** via a PreToolUse hook. So a user *cannot* just tell the agent "start the next feature on a fresh branch off main" — the hook rejects it. Without this feature, the only in-product "next feature" path is opening a new (cold) session. 111 is the sanctioned escape hatch for the exact operation 130 forbids the agent from doing.

## Is this worth building in ShipIt?

Conductor's pitch leans on two motivations; only one survives the port to ShipIt, and even that one is narrower than it looks. This section is the honest reckoning — read it before picking the feature up.

**Motivation that does NOT survive: "slow to create new workspaces."** ShipIt creates sessions fast — warm session pool, bare-cache clones, and `dep-cache/<hash>`. Conductor users wait on clone + `npm install`; ShipIt users mostly don't. The "skip the workspace-creation cost" argument is the headline reason in Conductor and it essentially evaporates here.

**Motivation that partially survives: "keep your chats and ignored files."**
- *Ignored / untracked files* (`.env`, build artifacts, caches): in ShipIt this is mostly covered by the secret store + dep-cache, so the win is thin.
- *Keep your chats*: real, but double-edged. Docs [047](../047-chat-history-editing/plan.md) and [104](../104-chat-toc-and-summaries/plan.md) exist precisely because long contexts degrade answer quality and inflate cost. Carrying a full feature's worth of debugging chatter into an *unrelated* next feature is a liability, not an asset.

**What genuinely justifies it anyway — agent re-orientation cost.** Creating a container is cheap; getting the *agent* back to the same level of understanding is not. A fresh session's agent re-reads `CLAUDE.md`, re-explores the subsystem, and rebuilds its mental model — potentially several turns with a cold prompt cache. When the next feature is *closely related* to the one just shipped (same subsystem, conventions just established), continuing on a new branch is materially faster and cheaper. "Session creation is fast" answers infra cost; it does not answer cognition cost.

**Conclusion.** Narrow but real — a power-user action for closely-related follow-up work, **not** a headline feature (hence `priority: low`). The strongest form is not "carry the entire chat forward" but **"graduate to a fresh branch off main with a compacted summary"** (compose with [104](../104-chat-toc-and-summaries/plan.md)): keep repo/convention knowledge, drop the debugging noise. That variant is strictly better than a cold new session for related work and neutralizes the context-pollution objection. If we build 111, build that version.

## Design

### What "continue on new branch" does

1. Check the working tree is clean (no uncommitted changes). If dirty, prompt to commit or stash first.
2. Create a new branch off `origin/main` (or the configured base branch) using the existing branch-naming logic in `git-utils.ts:generateBranchPrefix`.
3. Rename the worktree's branch to point at the new branch (or in the underlying RepoGit, replace the worktree with a new one on the new branch).
4. Reset PR lifecycle state on the session: `prNumber = null`, `prStatus = null`, `mergedAt = undefined`, `branchRenamed = false`. The PR card transitions to its blank "ready to push" phase.
5. Insert a system message in the chat: `"Continued on new branch: feat/2026-04-30-add-billing"`. Acts as a visible boundary in the chat history.
6. Trigger the next user prompt to start the new feature.

### What it does NOT do

- Doesn't clear chat history. The summarizer ([104](../104-chat-toc-and-summaries/plan.md)) and Claude's own prompt-cache benefit from continuity. (But see the [usefulness reckoning](#is-this-worth-building-in-shipit) — the *compacted-summary* variant is the preferred form, not raw carry-forward.)
- Doesn't reset Claude's working files context — the worktree is fresh on the new branch but the agent is still running. This is a feature: Claude knows the codebase from the previous work.
- **Preserves ignored / untracked working state.** Because we reuse the worktree (not re-clone), gitignored and untracked files survive — `node_modules`, `.env`, `dist/`, local caches. This is the one place ShipIt mirrors Conductor's "keep ignored files" benefit; fork ([session-fork-merge.ts](../../src/server/orchestrator/services/session-fork-merge.ts)) and spawn ([117](../117-agent-spawned-sessions/plan.md)) both lose it since they clone fresh.
- Doesn't delete the old branch. It stays remotely so the PR keeps working independently.

### What is a ShipIt design choice vs. what Conductor does

Conductor's changelog only promises "new branch, same workspace, keep chats and ignored files." The following are **our** additions, not observed Conductor behavior — call them out as decisions, not requirements:

- **Branch off `origin/main` specifically.** Conductor just says "new branch"; the base is unspecified. We pick `main` (configurable later — see Future extensions).
- **PR-state reset** (`prNumber/prStatus/mergedAt` cleared, card flips to "ready"). ShipIt-specific because we own the PR lifecycle card; Conductor has no equivalent.
- **The merged-PR / confirm gating** (below). Conductor offers it as an always-available button with no precondition.
- **"Warm agent context" claim.** Conductor says "keep your chats" — i.e. UI history. Whether the underlying agent context survives is a ShipIt implementation question: because we keep the *same* agent process and `--resume` session and only swap the worktree branch, the resume context and prompt cache do carry over. State this as an implementation property we deliberately preserve, not an assumption.

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
