# Phase 1: Inline PR Lifecycle Card + CI Status Infrastructure

## Goal

Replace the scattered PR UI (modal, status bar, toast) with a single inline card in the chat stream. Add a server-side PR status poller that uses GitHub GraphQL to batch-fetch CI status for all sessions, broadcast via SSE, and display in both the inline card and sidebar session cards.

## What ships

1. **`PrLifecycleCard`** — inline chat component showing diff stats, PR state, CI status
2. **One-click "Create Pull Request"** — push + generate description + create PR in one call
3. **PR status poller** — orchestrator-level, one GraphQL query per repo, broadcasts via SSE
4. **Sidebar PR icons** — at-a-glance PR state + CI status on every session card
5. **Remove `PrStatusBar`** — replaced by the inline card

## Inline card

### When it appears

After Claude's turn completes (agent finishes + files committed), a `PrLifecycleCard` appears inline in the chat. It shows the diff summary and a "Create Pull Request" button.

If a PR already exists for this session's branch (e.g. session resumed, or PR created in a previous turn), the card appears in its `open` state on session load, hydrated from the PR status poller.

### Card phases

```typescript
type PrCardPhase =
  | "ready"      // files changed, no PR yet (branch may already be pushed via auto-push)
  | "creating"   // PR creation in progress
  | "open"       // PR exists, shows CI status
  | "merged"     // PR merged (rendered but non-actionable in phase 1)
  | "error";     // creation failed
```

### Rendering by phase

**`ready`** — after Claude's turn (branch may already be on remote via auto-push):

```
┌─────────────────────────────────────────────────────────┐
│  Claude changed 3 files  +42 -12                        │
│                                                          │
│  src/server/api-routes.ts       M  +18 -4               │
│  src/client/App.tsx             M  +20 -6               │
│  src/client/hooks/usePR.ts      A  +4  -2               │
│                                                          │
│  [Review Changes]  [Create Pull Request]                 │
└─────────────────────────────────────────────────────────┘
```

- "Review Changes" opens the diff panel (existing feature)
- "Create Pull Request" triggers the one-click flow

**`creating`** — while push + PR creation is in progress:

```
┌─────────────────────────────────────────────────────────┐
│  ◐ Creating pull request...                              │
└─────────────────────────────────────────────────────────┘
```

**`open`** — PR exists, CI status live:

```
┌─────────────────────────────────────────────────────────┐
│  PR #42: Add PR lifecycle flow                          │
│  main ← feature/abc123    +42 -12                       │
│                                                          │
│  ◐ CI running  2/5 checks passed                        │
│                                                          │
│  [View PR]                                               │
└─────────────────────────────────────────────────────────┘
```

CI status sub-states within `open`:

- **pending**: `◐ CI running  2/5 checks passed` (animated)
- **success**: `✓ CI passed  5/5 checks` (green)
- **failure**: `✗ CI failed  3/5 passed · 2 failed` (red)
- **none**: no CI line shown (repo has no checks configured)

**`merged`** — placeholder for phase 3, just shows:

```
┌─────────────────────────────────────────────────────────┐
│  ✓ PR #42 merged into main                              │
│                                                          │
│  [View PR]                                               │
└─────────────────────────────────────────────────────────┘
```

**`error`** — creation failed:

```
┌─────────────────────────────────────────────────────────┐
│  ✗ Failed to create pull request                        │
│  "Branch already has an open PR"                        │
│                                                          │
│  [Retry]  [View on GitHub]                               │
└─────────────────────────────────────────────────────────┘
```

### Card updates in place

The card has a stable message ID. When PR status changes (CI progresses, PR merges), the card re-renders — no new messages are created. The client stores card state in `pr-store` and the component reads from it reactively.

## One-click PR creation

### New endpoint: `POST /api/sessions/:id/pr/quick`

No request body. The server does everything:

1. **Push** the branch to origin (reuses existing git push logic)
2. **Generate title** from session name (already human-readable via session-namer)
3. **Generate description** from conversation context + git diff:
   - Reads chat history via `ChatHistoryManager`
   - Gets diff stats vs base branch
   - Gets commit log (last 20 commits)
   - One-shot Claude call with prompt (see below)
4. **Detect base branch** — `main` or `master` (whichever exists on remote)
5. **Create PR** via GitHub API (not draft)
6. **Return** `{ number, url, title, baseBranch, headBranch, insertions, deletions }`

### Description generation prompt

```
Generate a pull request description for the following changes.

## What the user asked for
"{first user message}"

## Key conversation exchanges
{last N user/assistant message pairs, truncated to ~2000 tokens}

## Code changes
{git diff --stat vs base branch}
{git log --oneline, last 20 commits}

Write a concise GitHub PR description in markdown:
1. A "## Summary" section (2-3 sentences explaining why)
2. A "## Changes" section (bullet list of key changes)
3. A "## Test plan" section (how to verify)
```

### What happens after creation

1. Card transitions to `open` phase with the returned PR data
2. The PR status poller picks up the new PR immediately when tracking starts, then refreshes on its normal cadence
3. Card begins showing live CI status

## PR status poller (server-side)

### Architecture

One poller per repo, not per session. All sessions sharing a repo share one polling loop. Polls every **15 seconds** after an immediate first poll when tracking starts. User-visible events can request an out-of-band forced refresh for a specific session's repo (session activation, PR creation, PR-tab activation, merge button) so the low-frequency background cadence does not leave the lifecycle card stale. This is one GraphQL call per repo regardless of how many sessions exist, keeping active PR/CI updates timely while leaving much more headroom in GitHub's GraphQL point budget.

```
PrStatusPoller (orchestrator)
  │
  │ every 15s, plus targeted forced refreshes
  ▼
GitHub GraphQL API (one query per repo, OPEN PRs only)
  │
  │ returns CI status for all open PRs in the repo
  ▼
Match PRs to sessions by branch name
  │
  ▼
sseBroadcast("pr_status", { updates: [...] })   (only if something changed)
  │
  ▼
All connected clients
```

### GraphQL query

```graphql
query($owner: String!, $name: String!) {
  repository(owner: $owner, name: $name) {
    pullRequests(first: 50, states: [OPEN]) {
      nodes {
        number
        title
        url
        state
        mergeable
        autoMergeRequest { mergeMethod }
        headRefName
        baseRefName
        commits(last: 1) {
          nodes {
            commit {
              additions
              deletions
              statusCheckRollup {
                state
                contexts(first: 25) {
                  nodes {
                    ... on CheckRun {
                      name
                      status
                      conclusion
                    }
                    ... on StatusContext {
                      context
                      state
                    }
                  }
                }
              }
            }
          }
        }
      }
    }
  }
}
```

One call returns CI status for all open PRs. Cost: ~241 GraphQL points for 20 PRs with 10 checks each, out of 5,000/hr budget. At 3s intervals that's ~1,200 calls/hr per repo — well within limits.

**Only OPEN PRs are queried.** Once a PR is merged, the poller detects this via the PR disappearing from the OPEN results (or via the merge endpoint response) and marks it as merged locally. Merged sessions are excluded from future queries.

### `PrStatusPoller` class

```typescript
interface PrStatusSummary {
  sessionId: string;
  prNumber: number;
  prUrl: string;
  prTitle: string;
  prState: "open" | "merged";
  baseBranch: string;
  headBranch: string;
  insertions: number;
  deletions: number;
  checks: {
    state: "pending" | "success" | "failure" | "none";
    total: number;
    passed: number;
    failed: number;
    pending: number;
  };
  mergeable: boolean;
  autoMergeEnabled: boolean;
}
```

**Responsibilities:**
- Maintains a map of `repoUrl → intervalTimer`
- On each tick: runs the GraphQL query (OPEN PRs only), matches PRs to sessions by branch name, diffs against last known state
- If any PR status changed: calls `sseBroadcast("pr_status", { updates })` with only the changed entries
- Fixed 3s interval — simple, fast, one call per repo regardless of session count
- Starts polling for a repo when any session on that repo has an open PR. Stops when all PRs on that repo are merged or sessions are archived.
- Sessions with merged PRs are excluded — once a PR disappears from the OPEN query results, it's marked merged locally and never queried again

### SSE integration

New SSE event type: `pr_status`

```typescript
// Server → Client
{
  event: "pr_status",
  data: {
    updates: PrStatusSummary[]  // only changed entries
  }
}
```

On SSE connect, the initial snapshot includes current PR status for all sessions (alongside the existing `session_list` snapshot).

### Replacing existing polling

The current per-session HTTP polling (`GET /api/sessions/:id/pr/status` every 30s in `useConnectionSync.ts`) is removed. The SSE-based poller replaces it entirely. The HTTP endpoint stays for backward compatibility but is no longer called by the client on an interval.

## Sidebar PR icons

Each session card in the sidebar shows a small icon indicating PR state:

| State | Icon | Color |
|---|---|---|
| No PR | (nothing) | — |
| PR open, CI none | `⑂` (merge icon) | gray |
| PR open, CI pending | `⑂` | yellow (animated) |
| PR open, CI passed | `⑂ ✓` | green |
| PR open, CI failed | `⑂ ✗` | red |
| PR merged | `⑂` (filled) | purple |

The data comes from the `pr_status` SSE event — the same source as the inline card. The sidebar component reads from `pr-store` which maps `sessionId → PrStatusSummary`.

## Removing `PrStatusBar`

The `PrStatusBar` component and its rendering in `App.tsx` are removed. All its functionality (branch display, CI status, merge button, view PR link) moves to the inline card. The merge button and auto-fix/auto-merge toggles come in later phases — phase 1 only shows "View PR" as an action.

## Files changed

### New files

| File | Description |
|---|---|
| `src/client/components/PrLifecycleCard.tsx` | Inline card component |
| `src/client/components/PrLifecycleCard.test.tsx` | Component tests |
| `src/server/orchestrator/pr-status-poller.ts` | Orchestrator-level PR status poller using GitHub GraphQL |
| `src/server/orchestrator/pr-status-poller.test.ts` | Unit tests for poller |
| `src/server/orchestrator/integration_tests/pr-lifecycle.test.ts` | Integration tests |

### Modified files

| File | Description |
|---|---|
| `src/server/shared/types/ws-server-messages.ts` | Add `pr_lifecycle_update` message type |
| `src/server/shared/types/github-types.ts` | Add `PrStatusSummary` type |
| `src/server/orchestrator/index.ts` | Instantiate `PrStatusPoller`, add `pr_status` SSE event, send snapshot on connect |
| `src/server/orchestrator/api-routes.ts` | Add `POST /api/sessions/:id/pr/quick` endpoint |
| `src/server/orchestrator/services/github.ts` | Add `quickCreatePr()`, conversation-aware description generation, GraphQL query |
| `src/server/orchestrator/ws-handlers/send-message.ts` | Emit `pr_lifecycle_update` after agent turn with diff stats |
| `src/client/components/MessageList.tsx` | Render `PrLifecycleCard` for `pr_lifecycle_update` messages |
| `src/client/stores/pr-store.ts` | Rewrite: SSE-driven state, remove HTTP polling, add `quickCreate()` action, per-session status map |
| `src/client/hooks/useServerEvents.ts` | Handle `pr_status` SSE event, update pr-store |
| `src/client/hooks/useConnectionSync.ts` | Remove PR status polling logic |
| `src/client/hooks/useMessageHandler.ts` | Handle `pr_lifecycle_update` messages |
| `src/client/App.tsx` | Remove `PrStatusBar`, wire inline card |
| `src/client/components/SessionSidebar.tsx` (or equivalent) | Add PR status icon to session cards |

### Removed files

| File | Description |
|---|---|
| `src/client/components/PrStatusBar.tsx` | Replaced by inline card |
| `src/client/components/PrStatusBar.test.tsx` | Tests for removed component |

## Testing

### Integration tests (`pr-lifecycle.test.ts`)

- `POST /api/sessions/:id/pr/quick` — happy path: returns PR data, pushes branch
- `POST /api/sessions/:id/pr/quick` — error: no GitHub auth → 401
- `POST /api/sessions/:id/pr/quick` — error: branch already has PR → returns existing PR info
- PR status poller: mock GraphQL response, verify SSE broadcast fires with correct data
- PR status poller: merged PR disappears from OPEN results → marked merged locally, excluded from future queries
- PR status poller: no open PRs for a repo → polling stops for that repo

### Component tests (`PrLifecycleCard.test.tsx`)

- Renders `ready` phase with file list and stats
- Renders `creating` phase with spinner
- Renders `open` phase with PR info and CI status variants (pending, success, failure, none)
- Renders `merged` phase
- Renders `error` phase with retry button
- "Create Pull Request" click calls `quickCreate()`
- "Review Changes" click opens diff panel
- "View PR" links to GitHub URL
- Card updates when store state changes (CI transitions)

### Unit tests (`pr-status-poller.test.ts`)

- Parses GraphQL response into `PrStatusSummary` entries
- Matches PRs to sessions by branch name
- Detects state changes and only broadcasts diffs
- Stops polling for a repo when all its PRs are merged/archived
- Starts/stops polling when sessions are added/removed

## What this phase does NOT include

- Merge button / merge dropdown (phase 3)
- Auto-fix toggle / Fix CI button (phase 2)
- Auto-merge toggle (phase 3)
- Post-merge session archive (phase 3)
- Per-check failure breakdown with log excerpts (phase 2)
