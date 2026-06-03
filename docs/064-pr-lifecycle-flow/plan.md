
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
5. **Post-merge archive** — session auto-archived, context preserved for future reuse
6. **Post-merge preview cleanup** — merged-session preview iframes are pruned once they are no longer the active session, so completed PRs do not keep background previews alive

## Problem

Today ShipIt has all the PR building blocks — but they're scattered:

1. **PR creation** lives in a modal (`PullRequestModal`) triggered from a toast notification after push. It's a multi-field form that interrupts the flow.
2. **PR status** lives in a thin status bar (`PrStatusBar`) at the top of the page. It shows CI state and has a merge button, but it's easy to miss and disconnected from the conversation.
3. **CI failures** show a red badge in the status bar with no action. The user must manually copy failure details into chat.

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
│  [View on GitHub]                                         │
└──────────────────────────────────────────────────────────┘
```

### Key UX Decisions

> **Placement update (2026-05):** the "pinned above the input" placement described below is superseded by [156-session-card-consolidation](../156-session-card-consolidation/plan.md). The card now lives at the top of the chat panel and replaces `SessionTopBar` entirely. Conversation-scoped actions (Search, Download chat, Recover-rewind, auto-fix / auto-merge) stay with the card; session-management actions (Rename, Archive) move to a hover-revealed `[⋯]` menu on each sidebar row. The phase-rendering logic in `PrLifecycleCard` is unchanged; only its mount point and surrounding chrome move.

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
- **Auto-merge** (off by default): When all CI checks pass, merges the PR using the selected method (default: squash). Uses GitHub's native auto-merge. Requires auto-merge to be enabled in the GitHub repository settings. When off, a manual "Merge" button appears instead.

Both toggles are per-session and persist until the session ends or the PR is merged. They're visible directly on the card (not buried in a menu), because they're the primary actions.

**5. Merge dropdown matches GitHub's merge options.**

The merge button has a dropdown caret for merge method (merge commit, squash, rebase). Defaults to squash (matching Desktop). Persists the user's last choice server-side (needed for auto-merge without a client connected). If CI is pending, clicking Merge enables GitHub native auto-merge. This goes beyond Desktop, which only supports squash.

**6. Merged-session preview iframes are pruned.**

`PreviewFrame` keeps ordinary session iframes mounted in an iframe pool so switching between active sessions does not reload the app preview. A merged PR is terminal, so `App.tsx` derives merged session IDs from `pr-store` and passes them into `PreviewFrame`; the active merged preview remains visible while the user is on that session, but once the user switches away its background iframe slot is removed from the pool.

**7. `PrStatusBar` is removed.**

With the inline cards handling the full lifecycle, `PrStatusBar` is removed entirely. Its functionality (branch display, CI status, merge button, view PR link) moves into the inline card.

## What Exists Today vs. What's New

| Capability | Today | After | Claude Code Desktop |
|---|---|---|---|
| PR creation | Modal with form fields | One-click inline button | `gh pr create` or similar |
| PR status | Status bar at page top | Live-updating inline card | CI status bar |
| CI monitoring | Polling badge, no details | Per-check breakdown in card | Polls via `gh` CLI |
| Auto-fix CI | None | Server-driven toggle (loop until green) | Toggle in status bar |
| Manual fix CI | None (copy-paste) | "Fix CI Issues" button (server-driven) | N/A (auto-fix only) |
| Auto-merge | None | GitHub native auto-merge (squash/merge/rebase) | Toggle in status bar (squash only) |
| Manual merge | Button in status bar | Button in card with method dropdown | N/A (auto-merge only) |
| Post-merge | Nothing | "Merged" card + session auto-archived | None documented |

## Changes Required

### Phase 1: Inline PR Lifecycle Card

The core new component. Replaces the toast-to-modal flow with an inline card.

#### `PrLifecycleCard` component

A single component that renders differently based on PR state:

```typescript
type PrCardState =
  | { phase: "ready"; files: FileStat[]; insertions: number; deletions: number }
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

- **`ready`**: File list + stats, "Review Changes" and "Create Pull Request" buttons
- **`creating`**: Spinner + "Creating pull request..."
- **`open` + checks pending**: PR info + animated CI progress
- **`open` + checks success**: PR info + green checkmark + "Merge" button
- **`open` + checks failure**: PR info + red X + per-check failure summaries + "Fix CI Issues" button
- **`merged`**: Green "Merged" badge + session auto-archived
- **`error`**: Red error message + retry option

#### How the card appears

After Claude's turn completes (agent_finished + git_committed), if the session has a remote:

1. Server computes diff summary (file names, stats) — reuses existing `diffNameStatus`
2. Server sends a `pr_lifecycle_update` message with `phase: "ready"` and the file stats
3. Client renders `PrLifecycleCard` inline in the message list

This replaces the post-push toast and the PR creation modal. Auto-push continues to work independently — the branch may already be on the remote by the time the user sees the card.

When the global `autoCreatePr` setting is on (toggleable in **Settings → GitHub → Pull Requests**), the server skips the `phase: "ready"` step and goes straight to `creating` → `open`, creating the PR for the user. This fires after **every** meaningful turn (i.e. any turn whose post-turn auto-commit produced a non-empty commit) until a PR exists for the branch — see [099-auto-pr-on-meaningful-turn](../099-auto-pr-on-meaningful-turn/plan.md).

#### How the card evolves

The card message has a stable ID. State transitions:

```
ready → creating → open (pending) → open (success) → merged
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
4. PR status poller force-refreshes the session's repo immediately, then refreshes on its normal 15-second cadence via SSE

#### "Create with options..." flow (escape hatch)

Small "..." menu or secondary text link on the card opens the existing `PullRequestModal` for users who want to customize title, description, base branch, or draft status. The modal works exactly as today.

### Phase 2: CI Failure Details + Auto-Fix

This is the highest-value phase after the card itself — it's what makes the PR lifecycle truly autonomous. Claude Code Desktop already ships this as an "Auto-fix" toggle; we need feature parity plus better failure visibility.

Both the manual "Fix CI Issues" button and auto-fix are **server-driven**. The client never constructs prompts or fetches CI logs directly. The server fetches logs, constructs the fix prompt, and sends it to Claude via the existing message queue. If Claude is mid-turn, the fix prompt queues behind the current work.

See [phase-2.md](./phase-2.md) for the full design: `POST /api/sessions/:id/pr/fix-ci` endpoint, `sendSystemMessage()` for tab-less operation, attempt tracking per head SHA, and the auto-fix loop inside the PR status poller.

### Phase 3: Merge + Auto-Merge + Post-Merge Archive

Merge button with method dropdown (squash/merge/rebase), auto-merge via GitHub's native `enableAutoMerge` GraphQL mutation (works without a browser tab), and post-merge session archival.

See [phase-3.md](./phase-3.md) for the full design: split button, `PrAutomationState`, error handling for missing repo settings, merge detection via poller, and session archive flow.

## Polling budget

The PR status poller (`src/server/orchestrator/pr-status-poller.ts`) is the
sole consumer of GitHub GraphQL for ShipIt's PR lifecycle. Its cost budget
is GitHub's primary 5,000-points/hour rate limit per user. The poller is
smart about when to call (global gate), at what cadence (per-repo), and —
since [docs/155-pr-poll-query-scoping](../155-pr-poll-query-scoping/plan.md)
— how heavy each call is: `pullRequests(first: N)` is capped to the tracked
session count (plus a small discovery floor), and conversation fields are
fetched only for the PR whose tab is currently focused (via a top-level
`focused${i}: pullRequest(number: N)` alias). Combined, those two shape
changes brought the worst-case heavy poll from 11 → 1 point. The history of
that decision — including why the aliased-per-PR rewrite was rejected — is
in [`cost-measurements.md`](../155-pr-poll-query-scoping/cost-measurements.md).

**Two-strategy design.** The global *gate* decides whether *any* polling
runs. When it's open, a per-repo *cadence* decides how often each repo
polls.

**Global gate (Strategy 1).** Open when any of the following is true:

- a browser viewer is attached to any session runner (read off
  `SessionRunnerRegistry`);
- a viewer detached within the last 60 s (grace window for reloads /
  brief network blips);
- an autonomous flow is in flight: `AutoFixManager` has a session in
  `status: "running"`, `AutoMergeManager` has a session in
  `managed + enabled`, or a runner is `running` with `viewerCount === 0`
  (headless turn).

Closed otherwise. A closed gate stops the single supervisor timer entirely
— *zero* GraphQL polls until the gate reopens.

**Per-repo cadence (Strategy 2).** Each tracked session picks a per-session
cadence; the repo's cadence is the minimum (fastest) across its sessions.
Fast = `PR_STATUS_POLL_INTERVAL_MS` (15 s); slow = `PR_STATUS_SLOW_INTERVAL_MS`
(120 s).

| Per-session signal | Cadence |
|---|---|
| Auto-fix `status: "running"` for this session | Fast |
| ShipIt-managed auto-merge `enabled` for this session | Fast |
| `scheduleAutoPush` fired within the last 5 min | Fast |
| `checks.state === "pending"` | Fast |
| `mergeable === "unknown"` AND `checks.state !== "none"` | Fast |
| Anything else (success, none, settled) | Slow |

**Composition.** The supervisor wakes every fast tick (15 s). On each
tick it (1) closes the gate if it should be closed (in which case it stops
itself) and (2) for each tracked repo, issues a GraphQL poll iff the
repo's per-repo interval has elapsed since its last poll. There are no
per-repo timers — only the single supervisor — so a repo whose cadence
shifts from slow to fast picks up the new cadence on the next tick.

**Immediate freshness on user actions.** `forceRefreshSession` /
`setPrTabActive(true)` / WS viewer attach (via the orchestrator's
`attachToRunner` calling `notifyViewerAttached`) all wake the supervisor
and (for the explicit force paths) issue a one-shot poll, so the user-
perceived freshness on tab return is ≤ 1 s. The supervisor never bypasses
the GitHub rate-limit gate in `github-auth.ts`.

**Expected budget.** Typical day, 5 repos, one actively churning under a
viewer: ~290 polls/hour, comfortably under the 5,000-point budget. Worst
case (all 5 repos with pending CI simultaneously, user watching) is the
same as today's 15 s cadence — bounded to the short window CI takes to
complete.

**Open-question decisions.** Choices documented here so future contributors
don't re-litigate them when they look unusual.

1. **Disconnect grace window: 60 s.** Tolerates page reloads and short
   network blips. Aligned with `IDLE_GRACE_PERIOD_MS` in `idle-enforcer.ts`
   so a viewer hovering at the boundary doesn't see divergent behavior
   between the two systems.
2. **Slow cadence: 120 s.** Meaningfully cuts cost (~8× cheaper than 15 s)
   while keeping external-change latency — teammate review comments,
   manual merges from github.com — in the "barely noticed" range. 300 s
   would visibly lag external actions, violating "inline beats link-out."
3. **Post-push fast window: fixed 5 min.** Simpler bookkeeping than
   tracking "first non-none check appeared + buffer," and CI almost
   always registers within that window on small PRs.
4. **Autonomous-action keep-alive runs at fast cadence.** An auto-fix
   loop or managed auto-merge waiting for CI is the whole reason to
   refuse the global pause; sleeping it at 120 s would feel sluggish.
5. **UI surfacing: silent.** No "polling paused" indicator. The
   on-activation immediate refresh makes the user perceive instant
   freshness; adding a status badge burns screen real-estate for a
   detail nobody asked for.

**No webhooks.** The design is deliberately polling-only — ShipIt doesn't
require users to configure GitHub webhooks. The agent-internal signals
(`notifyAutoPush`, `markAutoFixRunning`, `setAutoMergeManaged`,
`notifyViewerAttached/Detached`) replace what a webhook would carry, and
the gate + cadence keep the polling budget bounded.

**Fresh-PR surfacing from REST (creation-lag fix).** This is the narrow
companion to the docs/155 Phase 1d *discovery* fix (`orderBy: UPDATED_AT DESC` +
light coverage aliases), which is what keeps a tracked, already-indexed PR
inside the bulk window — that fix owns the steady-state "PR shows nothing for
many minutes" case. This note covers the remaining sliver: the moments right
after the agent runs `gh pr create` (→ `/pr/agent-create` → `trackSession` +
`forceRefreshSession`) when GitHub's bulk `pullRequests` GraphQL view hasn't
indexed the new PR *at all* yet — ordering can't rescue a row that isn't in the
result set. The forced poll finds the branch *missing* and falls through to the
per-session REST verify (`verifyMissingPr` → `findPullRequestAnyState`). That
path used to broadcast **only** a removal (for stuck merged/closed recovery) and
`return` for a genuinely-open PR, so the card waited for the next poll that
finally saw the PR. `verifyMissingPr` now, when REST confirms the PR is **open**
and there is no fresher GraphQL-derived open snapshot, builds a minimal open
summary from the REST result (number/url/title/body/base/+−, `checks` seeded via
the `CiGraceTracker` so the merge button isn't prematurely enabled,
`mergeable: "unknown"`), persists and broadcasts it immediately, then lets the
next GraphQL poll enrich it. A GraphQL-derived open snapshot is never clobbered,
and merged/closed promotion is unchanged — so this composes with the coverage
aliases (which fold only `OPEN` alias nodes into the branch map) rather than
overlapping them.

**Post-turn recovery backstop.** As belt-and-suspenders for the case where the
creation route's `trackSession`/`forceRefreshSession` never ran at all (HTTP
blip to the orchestrator, restart mid-create, `remoteUrl` not yet persisted at
startup, or a PR opened out-of-band), `emitPrLifecycleAfterCommit`
(`services/pr-lifecycle.ts`) now — when the poller has no status for the
session — tracks + force-refreshes once per turn so the poller discovers the
existing PR by branch name and recovers. It is bounded to branches that have
actually been pushed (checked via the local remote-tracking ref, no network),
so un-pushed / no-PR sessions add zero GitHub calls; once a PR is known, the
early `getStatus` return short-circuits before this runs.

## Implementation Order

1. **Phase 1** (inline card + CI status poller + conversation-aware descriptions) — the foundation. See [phase-1.md](./phase-1.md).
2. **Phase 2** (CI failure details + server-driven auto-fix) — the biggest value-add after the card. See [phase-2.md](./phase-2.md).
3. **Phase 3** (merge + auto-merge + post-merge archive) — completes the lifecycle. See [phase-3.md](./phase-3.md).

Phases 2 and 3 are independent of each other but both depend on Phase 1.

## Files Changed (All Phases)

See each phase doc for the detailed file lists: [phase-1.md](./phase-1.md), [phase-2.md](./phase-2.md), [phase-3.md](./phase-3.md).

## Non-Goals

- **Self-reviewing PRs** (à la Devin) — could be added later as a post-push hook.
- **Logical diff grouping** — nice but complex, separate feature.
- **Plan mode with confidence** — independent feature that complements this lifecycle.
- **Multi-agent review** — better as a GitHub Action / CI integration.
- **PR review comments from GitHub** — showing review comments from other developers inline. Interesting future direction but out of scope.
- **Multiple PRs per session** — keep the 1:1 session-to-PR model for now.
