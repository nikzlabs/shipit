---
status: planned
---

# 064 — PR Lifecycle Flow

The full PR lifecycle — create, monitor CI, fix failures, merge — should happen inline in the chat, not scattered across modals and status bars. Claude Code Desktop already ships the most complete version of this: after opening a PR, a CI status bar appears with **Auto-fix** and **Auto-merge** toggles. Auto-fix automatically reads failure output and iterates; Auto-merge squash-merges once checks pass. This plan brings that same capability to ShipIt's inline card UI.

See [competitors.md](./competitors.md) for detailed research on how GitHub Copilot, OpenAI Codex, Devin, Cursor, and others handle this lifecycle.

### Reference: Claude Code Desktop (the bar to clear)

From [Claude Code Desktop docs](https://code.claude.com/docs/en/desktop):

> After you open a pull request, a CI status bar appears in the session. Claude Code uses the GitHub CLI to poll check results and surface failures.
> - **Auto-fix**: when enabled, Claude automatically attempts to fix failing CI checks by reading the failure output and iterating.
> - **Auto-merge**: when enabled, Claude merges the PR once all checks pass. The merge method is squash.
> Use the Auto-fix and Auto-merge toggles in the CI status bar to enable either option. Claude Code also sends a desktop notification when CI finishes.

Key features to match:
1. CI status bar appears automatically after PR creation
2. Auto-fix toggle — Claude reads CI failure output, fixes, pushes, re-runs (loop until green)
3. Auto-merge toggle — squash-merge once all checks pass
4. Desktop notification when CI finishes

Where ShipIt should go further:
1. **Inline in chat** (not just a status bar) — the card is part of the conversation narrative
2. **One-click PR creation** with smart defaults (Desktop still requires `gh pr create` or a modal)
3. **Per-check failure breakdown** visible in the card (not just "CI failed")
4. **Merge method selection** (squash/merge/rebase, not squash-only)
5. **Post-merge flow** ("Start Next Task" → new session on updated default branch)

## Problem

Today ShipIt has all the PR building blocks — but they're scattered:

1. **PR creation** lives in a modal (`PullRequestModal`) triggered from a toast notification after push. It's a multi-field form that interrupts the flow.
2. **PR status** lives in a thin status bar (`PrStatusBar`) at the top of the page. It shows CI state and has a merge button, but it's easy to miss and disconnected from the conversation.
3. **CI failures** show a red badge in the status bar with no action. The user must manually copy failure details into chat.
4. **Auto-push** fires silently 5 seconds after commit — code reaches the remote before the user has reviewed it.

The result: the user is constantly context-switching between chat, toasts, modals, and the status bar to manage what should be a linear flow.

## Design: Inline PR Lifecycle Cards

The entire PR lifecycle lives as **inline cards in the chat stream**, similar to how Claude Code Web shows a "Create pull request" button after completing work. Each card is a chat message that appears at the right moment and evolves as the PR progresses.

### The Flow

```
User sends prompt
        │
        ▼
Claude writes code → auto-commit
        │
        ▼
┌──────────────────────────────────────────────────────────┐
│ INLINE CARD: Push & Create PR                             │
│                                                           │
│  Claude changed 3 files  (+42 -12)                       │
│                                                           │
│  src/server/api-routes.ts     M  +18 -4                  │
│  src/client/App.tsx           M  +20 -6                  │
│  src/client/hooks/usePR.ts    A  +4  -2                  │
│                                                           │
│  [Review Changes]  [Create Pull Request]                  │
└──────────────────────────────────────────────────────────┘
        │
        │ user clicks "Create Pull Request"
        ▼
┌──────────────────────────────────────────────────────────┐
│ INLINE CARD: PR Created → CI Running                      │
│                                                           │
│  PR #42: Add PR lifecycle flow                           │
│  main ← shipit/abc123                                     │
│                                                           │
│  ◐ CI running  2/5 checks passed                         │
│                                                           │
│  [View on GitHub]                                         │
└──────────────────────────────────────────────────────────┘
        │
        │ CI completes (auto-updates via polling)
        ▼
┌──────────────────────────────────────────────────────────┐
│ INLINE CARD: CI Failed                                    │
│                                                           │
│  PR #42: Add PR lifecycle flow                           │
│  main ← shipit/abc123                                     │
│                                                           │
│  ✗ CI failed  3/5 passed · 2 failed                      │
│    ✗ lint — Process completed with exit code 1            │
│    ✗ test — 3 tests failed                                │
│                                                           │
│  Auto-fix ○  Auto-merge ○                                │
│  [Fix CI Issues]  [View on GitHub]                        │
└──────────────────────────────────────────────────────────┘
        │
        │ user clicks "Fix CI Issues"
        │ (or auto-fix is ON → triggers automatically)
        ▼
Claude receives: "CI failed on PR #42. Failures:
  lint: ... (logs)
  test: ... (logs)
Please fix these issues."
        │
        ▼
Claude fixes → auto-commit → auto-push (PR exists)
        │
        ▼
┌──────────────────────────────────────────────────────────┐
│ INLINE CARD: CI Passed → Ready to Merge                  │
│                                                           │
│  PR #42: Add PR lifecycle flow                           │
│  main ← shipit/abc123    +42 -12                         │
│                                                           │
│  ✓ CI passed  5/5 checks                                 │
│                                                           │
│  Auto-fix ○  Auto-merge ○                                │
│  [Squash and merge ▾]  [View on GitHub]                   │
└──────────────────────────────────────────────────────────┘
        │
        │ (if auto-merge is ON → merges automatically)
        ▼
        │
        │ user clicks "Merge"
        ▼
┌──────────────────────────────────────────────────────────┐
│ INLINE CARD: Merged                                       │
│                                                           │
│  ✓ PR #42 merged into main                               │
│                                                           │
│  [Start Next Task]  [View on GitHub]                      │
└──────────────────────────────────────────────────────────┘
```

### Key UX Decisions

**1. Cards are chat messages, not UI chrome.**

Each card is a server message in the chat stream (like `assistant` messages). They scroll with the conversation. This means:
- The user sees the PR lifecycle as part of the conversation narrative
- Old cards are visible in scroll history for context
- No modals, no toasts, no separate panels needed

**2. Cards are live — they update in place.**

The "CI running" card doesn't get replaced by a new "CI passed" card. The *same card* updates as CI progresses. This avoids chat spam. Implementation: the card has a stable message ID, and the client re-renders it when PR status changes.

**3. "Create Pull Request" is one click with smart defaults.**

Clicking the button immediately creates a PR with:
- Title: derived from session name or first user message
- Description: AI-generated from conversation context + git diff (generated server-side at creation time, not requiring user input)
- Base: auto-detected default branch (main/master)
- Draft: false (ready for review)

No modal. No form fields. The user can always edit title/description on GitHub afterward. For users who want control, a small "..." menu on the button offers "Create with options..." which opens the existing modal.

**4. Auto-fix and Auto-merge toggles (matching Claude Code Desktop).**

The card includes two toggles, modeled directly on Claude Code Desktop's CI status bar:

- **Auto-fix** (off by default): When CI fails, Claude automatically reads the failure output, fixes the issues, commits, and pushes. This loops until CI passes or a retry limit (3 attempts) is hit. When off, a manual "Fix CI Issues" button appears instead.
- **Auto-merge** (off by default): When all CI checks pass, automatically squash-merges the PR. Requires auto-merge to be enabled in the GitHub repository settings. When off, a manual "Merge" button appears instead.

Both toggles are per-session and persist until the session ends or the PR is merged. They're visible directly on the card (not buried in a menu), because they're the primary actions.

**5. Merge dropdown matches GitHub's merge options.**

The merge button has a dropdown caret for merge method (merge commit, squash, rebase). Defaults to squash (matching Desktop). Persists the user's last choice. If CI is pending, clicking Merge enables GitHub auto-merge instead (existing behavior). This goes beyond Desktop, which only supports squash.

**6. The status bar becomes optional/minimal.**

With the inline cards handling the full lifecycle, `PrStatusBar` becomes redundant for the primary flow. It can remain as a compact persistent indicator (branch name + CI badge) for quick reference, but the actionable UI moves into the cards.

## What Exists Today vs. What's New

| Capability | Today | After | Claude Code Desktop |
|---|---|---|---|
| PR creation | Modal with form fields | One-click inline button | `gh pr create` or similar |
| PR status | Status bar at page top | Live-updating inline card | CI status bar |
| CI monitoring | Polling badge, no details | Per-check breakdown in card | Polls via `gh` CLI |
| Auto-fix CI | None | Toggle on card (loop until green) | Toggle in status bar |
| Manual fix CI | None (copy-paste) | "Fix CI Issues" button | N/A (auto-fix only) |
| Auto-merge | None | Toggle on card (squash/merge/rebase) | Toggle in status bar (squash only) |
| Manual merge | Button in status bar | Button in card with method dropdown | N/A (auto-merge only) |
| Post-merge | Nothing | "Merged" card + "Start Next Task" | None documented |
| Auto-push | Always on (5s debounce) | Conditional: off until PR exists | Not documented |

## Changes Required

### Phase 1: Inline PR Lifecycle Card

The core new component. Replaces the toast-to-modal flow with an inline card.

#### `PrLifecycleCard` component

A single component that renders differently based on PR state:

```typescript
type PrCardState =
  | { phase: "unpushed"; files: FileStat[]; insertions: number; deletions: number }
  | { phase: "creating" }
  | { phase: "open"; pr: PrInfo; checks: ChecksInfo }
  | { phase: "merged"; pr: PrInfo }
  | { phase: "error"; message: string };

interface PrInfo {
  number: number;
  title: string;
  url: string;
  baseBranch: string;
  headBranch: string;
  insertions: number;
  deletions: number;
}

interface ChecksInfo {
  state: "pending" | "success" | "failure" | "none";
  total: number;
  passed: number;
  failed: number;
  pending: number;
  failedChecks: Array<{ name: string; summary: string }>;
}
```

**Rendering by phase:**

- **`unpushed`**: File list + stats, "Review Changes" and "Create Pull Request" buttons
- **`creating`**: Spinner + "Creating pull request..."
- **`open` + checks pending**: PR info + animated CI progress
- **`open` + checks success**: PR info + green checkmark + "Merge" button
- **`open` + checks failure**: PR info + red X + per-check failure summaries + "Fix CI Issues" button
- **`merged`**: Green "Merged" badge + "Start Next Task" button
- **`error`**: Red error message + retry option

#### How the card appears

After Claude's turn completes (agent_finished + git_committed), if the session has a remote:

1. Server computes diff summary (file names, stats) — reuses existing `diffNameStatus`
2. Server sends a `pr_lifecycle_update` message with `phase: "unpushed"` and the file stats
3. Client renders `PrLifecycleCard` inline in the message list

This replaces both the auto-push and the post-push toast.

#### How the card evolves

The card message has a stable ID. State transitions:

```
unpushed → creating → open (pending) → open (success) → merged
                                      → open (failure) → [user fixes] → open (pending) → ...
```

The client updates the card in place when it receives new `pr_lifecycle_update` messages with the same card ID. No new messages are created — the card evolves.

#### "Create Pull Request" flow (one-click)

When user clicks the button:

1. Client calls `POST /api/sessions/:id/pr/quick` (new endpoint)
2. Server:
   a. Pushes the branch to origin
   b. Generates title from session name
   c. Generates description from conversation context + git diff (async, via Claude)
   d. Creates PR via GitHub API
   e. Returns PR info
3. Client transitions card to `phase: "open"` with the PR data
4. CI polling starts (reuses existing 30s polling from `pr-store`)

#### "Create with options..." flow (escape hatch)

Small "..." menu or secondary text link on the card opens the existing `PullRequestModal` for users who want to customize title, description, base branch, or draft status. The modal works exactly as today.

### Phase 2: CI Failure Details + Auto-Fix

This is the highest-value phase after the card itself — it's what makes the PR lifecycle truly autonomous. Claude Code Desktop already ships this as an "Auto-fix" toggle; we need feature parity plus better failure visibility.

#### Fetch CI failure logs

New endpoint: `GET /api/sessions/:id/pr/ci-logs`

Calls GitHub API to get:
- List of check runs for the PR's head SHA
- For each failed check: name, conclusion, output summary, and annotations
- If available: the full log text (GitHub API `GET /repos/:owner/:repo/actions/jobs/:id/logs`)

Returns structured data:

```typescript
interface CIFailureLog {
  checkName: string;
  conclusion: string;
  summary: string;       // check run output summary
  annotations: Array<{   // inline annotations from the check
    path: string;
    startLine: number;
    endLine: number;
    message: string;
    annotationLevel: "failure" | "warning" | "notice";
  }>;
  logExcerpt: string;    // last N lines of the log (truncated to keep prompt reasonable)
}
```

#### Manual fix: "Fix CI Issues" button

When auto-fix is off, a "Fix CI Issues" button appears on the card. Clicking it:

1. Fetches `GET /api/sessions/:id/pr/ci-logs`
2. Constructs a prompt:

```
CI checks failed on PR #{number}. Here are the failures:

## {checkName}
{summary}

Log output:
```
{logExcerpt}
```

{annotations as inline code references}

---

Please fix these CI failures. After fixing, the changes will be automatically pushed.
```

3. Sends as a regular `send_message` via WebSocket
4. Claude fixes → auto-commit → auto-push (PR exists, so auto-push is on)
5. Card auto-updates as new CI runs start

#### Auto-fix toggle

Matches Claude Code Desktop's behavior. When the toggle is ON:

1. CI polling detects failure state
2. Automatically fetches CI logs (same as manual flow)
3. Sends the fix prompt to Claude without user intervention
4. Claude fixes → commits → pushes → CI re-runs
5. If CI fails again, retry up to 3 times (prevent infinite loops)
6. After 3 failed attempts, card shows "Auto-fix exhausted — manual intervention needed" and disables auto-fix

The toggle is visible on the card itself (not hidden in a menu). Default: off. When turned on, it persists for the session.

**How Claude Code Desktop does it**: Desktop uses `gh` CLI to poll check results. When auto-fix is enabled and checks fail, Claude "automatically attempts to fix failing CI checks by reading the failure output and iterating." We replicate this via the GitHub API instead of `gh` CLI (we already have GitHub auth integration).

### Phase 3: Merge + Auto-Merge + Post-Merge

#### Manual merge button

Appears in the card when CI passes and auto-merge is off. Split button with dropdown:

```
[Squash and merge ▾]
  ├─ Squash and merge ✓
  ├─ Merge commit
  └─ Rebase and merge
```

Default: squash (matching Claude Code Desktop). Persists the user's last choice. Goes beyond Desktop, which only supports squash.

When CI is pending: button label becomes "Auto-merge when CI passes" and enables GitHub auto-merge.

Implementation reuses existing `POST /api/sessions/:id/pr/merge` endpoint.

#### Auto-merge toggle

Matches Claude Code Desktop's behavior. When the toggle is ON:

1. CI polling detects all checks passing
2. Automatically calls merge endpoint with the selected merge method (default: squash)
3. Card transitions to "merged" state
4. Requires [auto-merge to be enabled in the GitHub repository settings](https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/configuring-pull-request-merges/managing-auto-merge-for-pull-requests-in-your-repository)

The toggle is visible on the card alongside auto-fix. Default: off.

**Combined auto-fix + auto-merge**: When both toggles are on, the full autonomous loop runs: CI fails → Claude fixes → pushes → CI re-runs → CI passes → auto-merge. This is the "fire and forget" mode for confident vibe-coding.

#### Post-merge card state

After successful merge:

1. Card transitions to `phase: "merged"`
2. Shows: "PR #42 merged into main" with green checkmark
3. Shows "Start Next Task" button

**"Start Next Task"** creates a new session on the same repo:
- Fresh worktree from the updated default branch (includes the just-merged changes)
- Navigates to the new session
- Clean slate for the next piece of work

### Phase 4: Conditional Auto-Push

#### Behavior change

Today `scheduleAutoPush()` fires unconditionally 5 seconds after commit. Change to:

- **No remote**: no push (already the case)
- **Has remote, no PR exists**: do not auto-push. The inline card's "Create Pull Request" handles the first push.
- **Has remote, PR exists**: auto-push resumes. Once a PR is open, the user has opted into the push flow. Changes flow to the PR automatically.

This means:
- Before PR creation: changes accumulate locally. The user decides when to push (via "Create Pull Request").
- After PR creation: auto-push resumes. Each Claude turn's changes flow to the PR and trigger CI.

No `manualPushMode` flag needed — the logic is simply: `autoPush = hasRemote && prExists`.

### Phase 5: Conversation-Aware PR Description

#### Problem

The current PR description generator uses `git log` + `diffStatVsBranch()` — mechanical descriptions like "Added api-routes.ts, modified App.tsx." The conversation is a much richer source.

#### Approach

The `POST /api/sessions/:id/pr/quick` endpoint (from Phase 1) generates the description at PR creation time. It:

1. Reads the chat history for this session (via `ChatHistoryManager`)
2. Extracts the user's initial prompt and key exchanges
3. Gets git diff stats vs base branch
4. Sends a one-shot Claude prompt:

```
Generate a pull request description for the following changes.

## What the user asked for
"{first user message}"

## Key conversation exchanges
{last N user/assistant message pairs, summarized}

## Code changes
{git diff stat vs base branch}
{commit log — last 20 commits}

Write a concise GitHub PR description in markdown with:
1. A "## Summary" section (2-3 sentences explaining why these changes were made)
2. A "## Changes" section (bullet list of key changes)
3. A "## Test plan" section (how to verify the changes work)
```

5. Returns the generated description as part of the PR creation response

The existing `POST /api/sessions/:id/pr/description` endpoint is updated to also accept conversation context, so the modal flow (escape hatch) benefits too.

## Implementation Order

1. **Phase 1** (inline card) — the foundation. Changes the entire interaction model.
2. **Phase 4** (conditional auto-push) — pairs with Phase 1, simple server change.
3. **Phase 5** (conversation-aware descriptions) — enhances Phase 1's "quick create" endpoint.
4. **Phase 2** (CI failure + fix) — the biggest value-add after the card itself.
5. **Phase 3** (merge + post-merge) — completes the lifecycle.

Phases 1 + 4 should ship together. Phase 5 is a small addition to Phase 1's endpoint. Phases 2 and 3 are independent.

## Files Changed (All Phases)

### New files

| File | Description |
|---|---|
| `src/client/components/PrLifecycleCard.tsx` | Inline PR lifecycle card component |
| `src/client/components/PrLifecycleCard.test.tsx` | Component tests |
| `src/server/orchestrator/integration_tests/pr-lifecycle.test.ts` | Integration tests |

### Modified files

| File | Change |
|---|---|
| `src/server/shared/types/ws-server-messages.ts` | Add `pr_lifecycle_update` message type |
| `src/server/orchestrator/api-routes.ts` | Add `POST .../pr/quick`, `GET .../pr/ci-logs` |
| `src/server/orchestrator/services/github.ts` | Add `quickCreatePr()`, `getCIFailureLogs()`, conversation-aware description |
| `src/server/orchestrator/ws-handlers/send-message.ts` | Send `pr_lifecycle_update` after agent turn, conditional auto-push |
| `src/client/components/MessageList.tsx` | Render `PrLifecycleCard` for `pr_lifecycle_update` messages |
| `src/client/stores/pr-store.ts` | Add `quickCreate()`, `fetchCILogs()`, card state management |
| `src/client/hooks/useMessageHandler.ts` | Handle `pr_lifecycle_update` messages, update card in place |
| `src/client/components/PrStatusBar.tsx` | Simplify to compact indicator (branch + CI badge only) |
| `src/client/App.tsx` | Wire "Start Next Task" to session creation |

## Non-Goals

- **Self-reviewing PRs** (à la Devin) — could be added later as a post-push hook.
- **Logical diff grouping** — nice but complex, separate feature.
- **Plan mode with confidence** — independent feature that complements this lifecycle.
- **Multi-agent review** — better as a GitHub Action / CI integration.
- **PR review comments from GitHub** — showing review comments from other developers inline. Interesting future direction but out of scope.
- **Multiple PRs per session** — keep the 1:1 session-to-PR model for now.
