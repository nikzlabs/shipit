# Phase 3: Merge + Auto-Merge + Post-Merge Archive

## Goal

Complete the PR lifecycle. When CI passes, the user can merge from the inline card with their preferred merge method. Auto-merge uses GitHub's native auto-merge (GraphQL mutation) so it works even without a browser tab. After merge, the session is automatically archived.

## What ships

1. **Merge button with method dropdown** on the inline card
2. **Auto-merge toggle** — enables GitHub native auto-merge via GraphQL mutation
3. **Post-merge archive** — card shows "merged" state, session auto-archived
4. **Clear error messages** when GitHub repo settings prevent auto-merge

## Card rendering

### CI passed, auto-merge off

```
┌─────────────────────────────────────────────────────────┐
│  PR #42: Add PR lifecycle flow                          │
│  main ← feature/abc123    +42 -12                       │
│                                                          │
│  ✓ CI passed  5/5 checks                                │
│                                                          │
│  Auto-fix ○  Auto-merge ○                                │
│  [Squash and merge ▾]  [View PR]                         │
└─────────────────────────────────────────────────────────┘
```

### CI pending, auto-merge on

```
┌─────────────────────────────────────────────────────────┐
│  PR #42: Add PR lifecycle flow                          │
│  main ← feature/abc123    +42 -12                       │
│                                                          │
│  ◐ CI running  2/5 checks passed                        │
│                                                          │
│  Auto-fix ○  Auto-merge ●                                │
│  Will merge when CI passes                               │
│  [View PR]                                               │
└─────────────────────────────────────────────────────────┘
```

### Merged

```
┌─────────────────────────────────────────────────────────┐
│  ✓ PR #42 merged into main                              │
│                                                          │
│  [View PR]                                               │
└─────────────────────────────────────────────────────────┘
```

### Auto-merge error: not enabled in repo settings

```
┌─────────────────────────────────────────────────────────┐
│  ✓ CI passed  5/5 checks                                │
│                                                          │
│  ⚠ Auto-merge is not enabled for this repository.       │
│    Enable in repository settings                  ← link │
│                                                          │
│  [Squash and merge ▾]  [View PR]                         │
└─────────────────────────────────────────────────────────┘
```

### Auto-merge error: no branch protection rules

```
┌─────────────────────────────────────────────────────────┐
│  ✓ CI passed  5/5 checks                                │
│                                                          │
│  ⚠ Auto-merge requires branch protection rules.         │
│    Configure branch protection                    ← link │
│                                                          │
│  [Squash and merge ▾]  [View PR]                         │
└─────────────────────────────────────────────────────────┘
```

## Merge button

### Split button with dropdown

The primary button shows the currently selected merge method. A dropdown caret reveals all three options:

```
[Squash and merge ▾]
  ├─ Squash and merge  ✓
  ├─ Create a merge commit
  └─ Rebase and merge
```

Clicking the primary button merges immediately with the selected method. Clicking a dropdown option changes the selection (and persists it) but does not trigger merge — the user still clicks the primary button.

### Merge method persistence

Stored server-side on `PrAutomationState` (same structure as auto-fix state from phase 2):

```typescript
interface PrAutomationState {
  autoFix: {
    enabled: boolean;
    attemptCount: number;
    lastHeadSha: string;
    status: "idle" | "running" | "exhausted";
  };
  autoMerge: {
    enabled: boolean;
    mergeMethod: "squash" | "merge" | "rebase";
  };
}
```

Default: `mergeMethod: "squash"`. Updated via `POST /api/sessions/:id/pr/merge-method`.

Server-side storage is required because auto-merge needs to know the method when merging without a client connected.

### Merge endpoint

Reuses existing `POST /api/sessions/:id/pr/merge`. The request body gains an optional `method` field:

```typescript
{ method?: "squash" | "merge" | "rebase" }
```

If omitted, uses the stored preference. The endpoint calls the GitHub REST API `PUT /repos/:owner/:repo/pulls/:number/merge` with the appropriate `merge_method`.

### Button states

| CI state | Button | Behavior |
|---|---|---|
| `success` | `[Squash and merge ▾]` | Merges immediately |
| `pending` | Disabled / grayed out | — |
| `failure` | Disabled / grayed out | — |
| `none` (no CI) | `[Squash and merge ▾]` | Merges immediately (no checks to wait for) |

### `none` vs `pending` for repos that run CI

When the repo has CI signals (workflow files in the local clone, or checks
observed on any other PR in this repo) but GitHub hasn't reported any check
for the current head SHA, the poller force-overrides `none` → `pending` to
suppress the merge button while workflows are still spinning up.

The override is time-boxed by `NO_CHECKS_GRACE_MS` (60s) per session, keyed
on the current head SHA. After the grace expires without GitHub registering
anything, we accept that no workflows apply to this PR — common case: a
docs-only PR in a repo whose workflows have `paths:` filters excluding
markdown — and let the state revert to genuine `none`, which unblocks the
merge button. A new push (new head SHA) restarts the grace timer so the
next commit gets its own fresh window.

## Auto-merge toggle

### GitHub native auto-merge

Uses the existing `enableAutoMerge` GraphQL mutation already in the codebase (`github-auth.ts`). When the user toggles auto-merge ON:

1. Client calls `POST /api/sessions/:id/pr/auto-merge` with `{ enabled: true }`
2. Server calls the `enableAutoMerge` GraphQL mutation with the stored merge method
3. GitHub queues the PR for auto-merge — it will merge automatically once all required checks pass
4. Server updates `PrAutomationState.autoMerge.enabled = true`
5. Card shows "Will merge when CI passes"

When toggled OFF:

1. Client calls `POST /api/sessions/:id/pr/auto-merge` with `{ enabled: false }`
2. Server calls `disableAutoMerge` GraphQL mutation (new, uses `disablePullRequestAutoMerge` mutation)
3. Server updates state

### Why GitHub native, not server-side polling

- **Reliability** — works even if ShipIt is offline or the session runner is disposed
- **Simplicity** — no need to detect the exact moment checks pass and race to merge
- **Already exists** — the `enableAutoMerge` mutation is already in the codebase
- **User expectation** — matches what "auto-merge" means on GitHub

### Error handling

The GraphQL mutation fails in two known cases:

**1. Auto-merge not enabled in repository settings**

GitHub returns: `"Pull request auto merge is not allowed for this repository"`

Surface as: `⚠ Auto-merge is not enabled for this repository. [Enable in repository settings](https://github.com/{owner}/{repo}/settings)`

The toggle reverts to OFF. The manual merge button remains available.

**2. No branch protection rules configured**

GitHub returns: `"Pull request is in an unstable status"` or similar when no required checks exist.

Surface as: `⚠ Auto-merge requires branch protection rules. [Configure branch protection](https://github.com/{owner}/{repo}/settings/branches)`

The toggle reverts to OFF.

Both errors are returned in the POST response and broadcast via SSE so all connected clients see them:

```typescript
interface PrAutoMergeError {
  code: "auto_merge_not_enabled" | "no_branch_protection";
  message: string;
  settingsUrl: string;
}
```

### Combined auto-fix + auto-merge

When both toggles are on, the full autonomous loop runs:

```
CI fails → auto-fix sends fix prompt → Claude fixes + pushes
  → CI re-runs → CI passes → GitHub auto-merges
  → poller detects merge → session archived
```

This is the "fire and forget" mode. The user can close their browser and come back to a merged PR and archived session.

## Post-merge: detect + archive

### Detection

The `PrStatusPoller` detects merge in two ways:

1. **Merge endpoint response** — when the user (or auto-merge) merges via our API, we know immediately
2. **Poller query** — the PR disappears from the `states: [OPEN]` GraphQL results. The poller notices a previously-tracked PR is missing and checks if it was merged via a quick REST call (`GET /repos/:owner/:repo/pulls/:number` → `state: "closed", merged: true`)

### Card transition

When merge is detected:

1. Card transitions to `phase: "merged"`
2. Shows: `✓ PR #42 merged into main`
3. "View PR" link remains

### Session archive

After merge:

1. Server calls `sessionManager.archive(sessionId)` (existing method)
2. SSE broadcasts `session_list` update — the session moves to the archived section in the sidebar
3. The session remains readable (user can scroll chat history) but no new messages can be sent
4. The worktree is cleaned up on the next idle pass (existing disposal logic)

Future work may allow reusing the archived session's context (chat history, file state) when starting a new session on the same repo.

## SSE broadcast shape

The `PrStatusSummary` from phase 2 is extended:

```typescript
interface PrStatusSummary {
  // ... existing fields ...
  autoMerge: {                    // NEW
    enabled: boolean;
    mergeMethod: "squash" | "merge" | "rebase";
    error?: PrAutoMergeError;
  };
}
```

## New endpoints

### `POST /api/sessions/:id/pr/auto-merge`

**Request:**

```typescript
{ enabled: boolean }
```

**Server logic:**

1. If enabling: call `enableAutoMerge` GraphQL mutation with stored merge method
2. If disabling: call `disableAutoMerge` GraphQL mutation
3. Update `PrAutomationState`
4. Broadcast updated status via SSE
5. If mutation fails: return error with `code` and `settingsUrl`

**Response (success):**

```typescript
{ enabled: boolean; mergeMethod: "squash" | "merge" | "rebase" }
```

**Response (error):**

```typescript
{ error: { code: "auto_merge_not_enabled" | "no_branch_protection"; message: string; settingsUrl: string } }
```

### `POST /api/sessions/:id/pr/merge-method`

**Request:**

```typescript
{ method: "squash" | "merge" | "rebase" }
```

**Server logic:**

1. Update `PrAutomationState.autoMerge.mergeMethod`
2. If auto-merge is currently enabled: call `disableAutoMerge` then `enableAutoMerge` with new method (GitHub requires re-enabling to change method)
3. Broadcast updated status via SSE

**Response:**

```typescript
{ mergeMethod: "squash" | "merge" | "rebase" }
```

## Files changed

### New files

None — all changes fit into existing files.

### Modified files

| File | Change |
|---|---|
| `src/server/shared/types/github-types.ts` | Add `PrAutoMergeError`, extend `PrStatusSummary` with `autoMerge` |
| `src/server/orchestrator/github-auth.ts` | Add `disableAutoMerge()` GraphQL mutation |
| `src/server/orchestrator/pr-status-poller.ts` | Detect merged PRs (missing from OPEN results), trigger session archive, manage `autoMerge` state |
| `src/server/orchestrator/api-routes.ts` | Add `POST .../pr/auto-merge`, `POST .../pr/merge-method` |
| `src/server/orchestrator/services/github.ts` | Add `toggleAutoMerge()`, `updateMergeMethod()` |
| `src/client/components/PrLifecycleCard.tsx` | Merge button + dropdown, auto-merge toggle, error messages with links, merged state |
| `src/client/components/PrLifecycleCard.test.tsx` | Tests for merge button, auto-merge toggle, error states, merged state |
| `src/client/stores/pr-store.ts` | Add `merge()`, `toggleAutoMerge()`, `setMergeMethod()` actions |
| `src/server/orchestrator/integration_tests/pr-ci-fix.test.ts` | Extend with auto-merge tests (or create new `pr-merge.test.ts` if file gets large) |

## Testing

### Integration tests

- `POST .../pr/auto-merge` enable — calls `enableAutoMerge` mutation, returns success
- `POST .../pr/auto-merge` enable — repo doesn't allow auto-merge → returns error with `settingsUrl`
- `POST .../pr/auto-merge` enable — no branch protection → returns error with `settingsUrl`
- `POST .../pr/auto-merge` disable — calls `disableAutoMerge` mutation
- `POST .../pr/merge-method` — updates stored preference, re-enables auto-merge with new method if active
- `POST .../pr/merge` with `method` — merges with specified method
- Poller detects merged PR → session archived, SSE broadcast sent
- Combined flow: auto-fix + auto-merge both enabled → CI fails → fix → CI passes → merged → archived

### Component tests

- Merge button renders when CI passed, disabled when CI pending/failing
- Dropdown shows three merge methods, selected method has checkmark
- Clicking dropdown option calls `setMergeMethod()`, does not trigger merge
- Clicking primary button calls `merge()`
- Auto-merge toggle calls `toggleAutoMerge()`
- "Will merge when CI passes" shown when auto-merge enabled + CI pending
- Error messages render with correct links for both error cases
- Toggle reverts to OFF on error
- Merged state renders correctly
- Button disabled in merged state

## What this phase does NOT include

- "Start Next Task" button (future — may reuse archived session context in a new session)
