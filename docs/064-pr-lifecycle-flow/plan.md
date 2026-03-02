---
status: planned
---

# 064 — PR Lifecycle Flow

Improve the end-to-end flow from code generation through review, push, PR creation, iteration, and merge. Today the building blocks exist (auto-commit, diff review, PR creation, merge controls) but they're loosely connected. This plan tightens the lifecycle so each step flows naturally into the next, with the right defaults for solo vs. team workflows.

See [competitors.md](./competitors.md) for detailed research on how GitHub Copilot, OpenAI Codex, Devin, Cursor, and others handle this lifecycle.

## Problem

The current flow has gaps between stages:

1. **Push happens before review.** Auto-push fires 5 seconds after commit. The diff review panel exists but is a side-tab the user must actively open — it's not a gate. Code reaches the remote before the user has looked at it.

2. **No bridge between conversation and PR.** The AI PR description generator reads git log + file stats, but not *why* the user asked for changes. The conversation is the best source for a PR description, but it's disconnected from the PR creation flow.

3. **No iterative review visibility.** When a user rejects files or sends diff comments, Claude responds with more changes, but there's no visual continuity — no "round 1 → round 2 → done" sense. The review flow is flat.

4. **No incremental PR view.** After creating a PR, continued Claude turns auto-push, but there's no "what's new since the PR was opened" or "what changed since last push" view. The user can't see what they're adding to the PR incrementally.

5. **CI failures are invisible.** The PR status bar shows CI state, but there's no "fix this" action that sends failure context to Claude.

## Design Principle: Progressive Disclosure of Review Rigor

Solo vibe-coding on a new project? Auto-commit, auto-push, one-click deploy. Working on a team repo with CI? Deliberate push, draft PR, structured review, merge controls. Same tool, different defaults based on context.

The key signal is **whether a remote is configured**:

- **No remote** (standalone session): auto-commit, no push, focus on preview + deploy. Review tab available but not surfaced.
- **Has remote** (worktree session): auto-commit, push is deliberate (not automatic), diff summary shown inline after each turn, PR creation prompted after first push.

## The Lifecycle

```
┌─────────────────────────────────────────────────────────────┐
│ 1. INTENT                                                    │
│    User sends prompt                                         │
│    (Future: Claude shows plan with confidence for complex    │
│    tasks, user approves/modifies before coding starts)       │
├─────────────────────────────────────────────────────────────┤
│ 2. CODE                                                      │
│    Claude writes → auto-commit with summary                  │
│    Live preview updates in real-time                         │
├─────────────────────────────────────────────────────────────┤
│ 3. REVIEW                                                    │
│                                                              │
│    Solo / no remote:                                         │
│      Changes tab available but not forced                    │
│      Focus → preview, iterate, deploy                        │
│                                                              │
│    Team / has remote:                                         │
│      Inline banner after Claude's turn:                      │
│      ┌───────────────────────────────────────────────┐       │
│      │ 3 files changed (+42 -12)                     │       │
│      │ [Review Changes]  [Push]  [Keep Iterating]    │       │
│      └───────────────────────────────────────────────┘       │
│      Push is deliberate, not automatic                       │
│      "Review Changes" opens diff panel                       │
│      "Keep Iterating" dismisses banner, user chats more      │
├─────────────────────────────────────────────────────────────┤
│ 4. PR CREATION                                               │
│    After first push (no PR exists):                          │
│      "Create PR?" inline prompt                              │
│      AI description from conversation context + git log      │
│      Default to draft PR                                     │
│      One-click with sensible defaults                        │
│                                                              │
│    After first push (PR already exists):                     │
│      "PR updated" notification with incremental stats        │
├─────────────────────────────────────────────────────────────┤
│ 5. ITERATION                                                 │
│    PR open → persistent status in header                     │
│    Each Claude turn: changes accumulate locally              │
│    Show incremental diff (new since last push)               │
│    "Push to PR" button when ready                            │
│    CI status visible in-app                                  │
│    CI failure → "Fix CI" sends failure logs to Claude        │
├─────────────────────────────────────────────────────────────┤
│ 6. MERGE & CLOSE                                             │
│    Merge controls (already built)                            │
│    Post-merge: clean status, offer "Start next task"         │
└─────────────────────────────────────────────────────────────┘
```

## Changes Required

### Phase 1: Review Gate (replaces silent auto-push)

#### Behavior change: conditional auto-push

Today `scheduleAutoPush()` fires unconditionally 5 seconds after commit. Change this to:

- **No remote configured**: no push (already the case).
- **Has remote, no PR exists**: **do not auto-push**. Show the inline review banner instead. The user pushes explicitly.
- **Has remote, PR exists, user has pushed at least once this session**: auto-push resumes (the user has already opted into the push flow for this session). This avoids friction for the iterative "chat → commit → push → chat" loop once the PR is open.

A per-session flag `manualPushMode` (default `true` for worktree sessions) controls this. Once the user pushes manually for the first time, the flag flips to `false` and auto-push resumes for the rest of the session.

#### Inline review banner

After Claude's turn completes (on `agent_finished` / `git_committed`), if `manualPushMode` is true, show an inline banner in the chat:

```
┌──────────────────────────────────────────────────────────┐
│ ✎ Claude changed 3 files  (+42 -12)                     │
│                                                          │
│  src/server/api-routes.ts   +18 -4   modified            │
│  src/client/App.tsx         +20 -6   modified            │
│  src/client/hooks/usePR.ts  +4  -2   added               │
│                                                          │
│  [Review Changes]  [Push to origin]  [Dismiss]           │
└──────────────────────────────────────────────────────────┘
```

This is a chat message (type `turn_diff_summary`), not a modal or toast — it stays in scroll history and doesn't block interaction.

**Actions:**
- **Review Changes** → switches right panel to "changes" tab with the full diff
- **Push to origin** → pushes immediately, flips `manualPushMode` off, triggers "Create PR?" if no PR exists
- **Dismiss** → hides the banner; changes are committed but not pushed. User can push later via the existing push button or by sending another message (which will accumulate more changes).

#### Files changed

| File | Change |
|---|---|
| `src/server/orchestrator/ws-handlers/send-message.ts` | Conditional auto-push based on `manualPushMode` |
| `src/server/shared/types/ws-server-messages.ts` | Add `turn_diff_summary` server message type |
| `src/client/components/TurnDiffSummary.tsx` | New — inline banner component |
| `src/client/components/TurnDiffSummary.test.tsx` | New — component tests |
| `src/client/components/MessageList.tsx` | Render `turn_diff_summary` messages |
| `src/client/stores/git-store.ts` | Add `manualPushMode` state + `pushToOrigin()` action |

### Phase 2: Conversation-Aware PR Description

#### Problem

The current PR description generator in `services/github.ts` uses `git log` and `diffStatVsBranch()`. This produces mechanical descriptions like "Added api-routes.ts, modified App.tsx." The conversation history — what the user asked for, what decisions were made — is a much richer source.

#### Approach

When creating a PR, the client sends the conversation summary along with the create-PR request. The server assembles a prompt that includes both the conversation context and the git diff stats, then generates the description via a one-shot Claude call.

The prompt structure:

```
Generate a pull request description for the following changes.

## Conversation context
The user asked: "{first user message}"
Key exchanges:
{summarized conversation — last N messages or a compressed summary}

## Changes
{git diff stat vs base branch}
{commit log}

Write a concise PR description with:
1. A summary paragraph explaining the "why"
2. A bullet list of key changes
3. Any testing notes
```

#### Files changed

| File | Change |
|---|---|
| `src/server/orchestrator/services/github.ts` | Add conversation context to PR description generation |
| `src/server/orchestrator/api-routes.ts` | Accept `conversationContext` in create-PR body |
| `src/client/components/CreatePRModal.tsx` | Pass recent messages as context |

### Phase 3: Incremental Diff View

#### Problem

Once a PR is open, the user continues chatting with Claude. Changes accumulate across multiple turns. The existing diff panel shows per-turn diffs, but there's no view of "everything I've changed since I last pushed" or "everything in this PR vs. the base branch."

#### Approach

Add two new diff views accessible from the PR status bar:

1. **Unpushed changes** — diff between the last pushed commit and HEAD. Shows what will be added to the PR on next push.
2. **PR diff** — diff between the base branch and HEAD. Shows the full PR scope.

These reuse the existing `DiffPanel` in read-only mode (already supported via the `readOnly` prop from feature 046).

#### Data flow

```
PR status bar → "View unpushed changes" button
  ↓
GET /api/sessions/:id/git/diff?from={lastPushedCommit}&to=HEAD
  ↓
DiffPanel (readOnly=true, title="Unpushed changes")
```

The `lastPushedCommit` is tracked client-side — updated whenever a push succeeds.

#### Files changed

| File | Change |
|---|---|
| `src/client/stores/git-store.ts` | Track `lastPushedCommit` |
| `src/client/components/PRStatusBar.tsx` | Add "Unpushed changes" and "PR diff" buttons |
| `src/server/orchestrator/services/git.ts` | Support `HEAD` as a commit ref in `getTurnDiff` |

### Phase 4: CI Failure → Claude Fix Loop

#### Problem

When CI fails on the PR, the status bar shows a red badge, but the user has to manually copy the failure, paste it into chat, and ask Claude to fix it. This should be one click.

#### Approach

Add a "Fix CI" button to the PR status bar that appears when CI status is `failure`. Clicking it:

1. Fetches the failed check run logs via GitHub API (`GET /repos/:owner/:repo/check-runs/:id/annotations` + logs)
2. Constructs a prompt: "CI failed on this PR. Here are the failure details: {logs}. Please fix the issues."
3. Sends it as a regular chat message

This reuses the existing `send_message` flow — no new infrastructure needed.

#### Files changed

| File | Change |
|---|---|
| `src/server/orchestrator/services/github.ts` | Add `getCIFailureLogs(owner, repo, prNumber)` |
| `src/server/orchestrator/api-routes.ts` | Add `GET /api/sessions/:id/ci-failure-logs` |
| `src/client/components/PRStatusBar.tsx` | Add "Fix CI" button, fetch logs, send as message |

### Phase 5: Post-Merge Cleanup

#### Problem

After merging a PR, the session is still "connected" to the now-merged branch. There's no clear signal that the task is complete.

#### Approach

After a successful merge:

1. Update PR status bar to show "Merged" state (green, non-actionable)
2. Show an inline chat message: "PR #N merged into main."
3. Offer a "Start next task" button that creates a new session on the same repo (fresh worktree from updated default branch)

This is lightweight — mostly UI state changes.

#### Files changed

| File | Change |
|---|---|
| `src/client/components/PRStatusBar.tsx` | Merged state rendering + "Start next task" |
| `src/client/App.tsx` | Wire "Start next task" to session creation |

## Implementation Order

1. **Phase 1** (review gate) — highest impact, changes the core workflow default
2. **Phase 2** (PR descriptions) — low effort, high quality-of-life improvement
3. **Phase 3** (incremental diff) — important for multi-turn PR iteration
4. **Phase 4** (CI fix loop) — closes the feedback loop
5. **Phase 5** (post-merge) — polish

Phases 1–2 can be done together. Phases 3–5 are independent and can be done in any order.

## Non-Goals

- **Self-reviewing PRs** (à la Devin) — interesting but out of scope. Could be added later as a post-push hook that runs a Claude review pass.
- **Logical diff grouping** (organizing diffs by related change instead of alphabetical) — nice UX lift but significant complexity in the diff computation layer. Separate feature.
- **Plan mode with confidence** (Claude shows a plan before coding) — a different feature that complements this lifecycle but is independent of the review/push/PR flow.
- **Multi-agent review** — running multiple specialist reviewers in parallel. Better suited as a GitHub Action / CI integration than an in-app feature.
