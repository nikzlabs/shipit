---
status: planned
---

# 046 — Git History Diff View

## Problem

The git history tab (`GitHistory.tsx`) shows a list of commits with rollback buttons, but there's no way to inspect what actually changed in a given commit. Users need to understand what each commit introduced before deciding whether to rollback.

The existing `DiffPanel` is purpose-built for the **turn diff** workflow (accept/reject changes from the latest Claude turn). It's tightly coupled to `lastCommitPair` and includes accept/reject actions that don't apply when browsing historical commits. We need a read-only diff view that can be triggered from the history tab.

## Design

### Approach: Reuse `DiffPanel` in read-only mode

Rather than building a separate diff component, extend `DiffPanel` to support a read-only mode. The Monaco DiffEditor, file list sidebar, and diff stats are all reusable. The only difference is that historical diffs should **not** show accept/reject buttons.

### User interaction

1. User is on the **History** tab viewing the commit list
2. Each commit row shows a **"diff"** button (visible on hover, like the existing rollback button)
3. Clicking "diff" switches to the **Changes** tab and loads the diff for that commit (parent..commit)
4. The `DiffPanel` renders in **read-only mode** — no checkboxes, no accept/reject buttons, just a "Close" button
5. Clicking "Close" returns to the History tab

### Data flow

```
GitHistory commit row → onClick "diff"
  ↓
onViewDiff(commitHash) callback fires
  ↓
App.tsx handler:
  1. Fetches GET /api/sessions/:id/git/diff?from={parentHash}&to={commitHash}
  2. Sets gitStore.turnDiff = response
  3. Sets gitStore.historyDiffMode = true  (new flag)
  4. Switches rightTab to "changes"
  ↓
DiffPanel renders with diff data
  - historyDiffMode=true → hides checkboxes and accept/reject buttons
  - Shows only Close button
  ↓
Close → clears historyDiffMode, switches back to "history" tab
```

### Key design decisions

1. **Reuse existing `/api/sessions/:id/git/diff` endpoint.** It already accepts `from` and `to` query params and returns `TurnDiffData`. For a single commit diff, `from` = parent commit hash, `to` = commit hash.

2. **Determine parent hash client-side.** The commit list already contains consecutive commits. The parent of `commits[i]` is `commits[i+1]`. For the oldest commit in the list (no parent loaded), either skip the diff button or use the git "empty tree" hash (`4b825dc642cb6404f32168ace`) as the `from` — this shows the initial commit as all additions.

3. **Add `readOnly` prop to `DiffPanel`** rather than creating a separate component. When `readOnly=true`:
   - Hide file checkboxes
   - Hide "Accept All" and "Reject Selected" buttons
   - Show only a "Close" button in the action bar
   - Optionally show the commit message in the header

4. **Add `historyDiffMode` flag to git store** to track whether we're viewing a historical diff vs a turn diff. This controls:
   - Which "Close" behavior to use (return to history tab vs return to preview)
   - Whether to clear `lastCommitPair` when closing

5. **Diff for first commit** (no parent): use `git diff --no-index /dev/null` equivalent. The `getTurnDiff` service function uses `getFileAtCommit` which would fail for the parent of the initial commit. We'll handle this by passing an empty tree hash as `from`, which `git diff` supports natively.

## Changes required

### Server (minimal)

No server changes needed. The existing `GET /api/sessions/:id/git/diff?from=X&to=Y` endpoint and `getTurnDiff()` service function handle arbitrary commit ranges already. The `GitManager.diffNameStatus(from, to)` and `GitManager.getFileAtCommit(hash, path)` methods work with any valid commit references.

One small addition: support the empty tree hash for diffing the initial commit. If `getFileAtCommit` is called with the empty tree hash, it will naturally return empty content (since no files exist in an empty tree). We should verify this works correctly and add a fallback if needed.

### Client

#### `src/client/components/GitHistory.tsx`
- Add `onViewDiff: (commitHash: string, parentHash: string | null) => void` prop
- Add a "diff" button to each commit row (hover-visible, like rollback)
- Determine parent hash: `commits[i+1]?.hash ?? null`

#### `src/client/components/DiffPanel.tsx`
- Add optional `readOnly?: boolean` prop
- Add optional `commitMessage?: string` prop
- When `readOnly=true`:
  - Hide all checkbox inputs in file list
  - Hide "Accept All" / "Reject Selected" buttons in action bar
  - Show commit message in header (if provided)
  - Keep the file list, diff viewer, and stats unchanged

#### `src/client/stores/git-store.ts`
- Add `historyDiffMode: boolean` state (default `false`)
- Add `setHistoryDiffMode: (mode: boolean) => void` action
- Reset `historyDiffMode` in the `reset()` action

#### `src/client/App.tsx`
- Wire `onViewDiff` handler in `GitHistory`:
  1. Compute `from` (parent hash or empty tree hash for initial commit)
  2. Fetch diff from API
  3. Set `turnDiff` and `historyDiffMode = true`
  4. Switch `rightTab` to `"changes"`
- Modify `DiffPanel` rendering: pass `readOnly={historyDiffMode}` and `commitMessage`
- Modify close handler: if `historyDiffMode`, clear the diff state and switch back to "history" tab

### Tests

#### `src/client/components/GitHistory.test.tsx`
- Test that diff button appears on commit rows
- Test that `onViewDiff` is called with correct hashes
- Test that last commit (no parent) passes `null` as parent

#### `src/client/components/DiffPanel.test.tsx`
- Test that `readOnly=true` hides checkboxes and action buttons
- Test that commit message is shown when provided
- Test that close button is still present in read-only mode

#### `src/server/integration_tests/` (existing)
- Verify that the existing diff endpoint works with arbitrary commit ranges (likely already covered by `diff-review.test.ts`)

## Empty tree hash constant

Git's empty tree hash is `4b825dc642cb6404f32168ace2c04d9f6e8f59b6`. This is a well-known constant that represents a tree with no files. Using it as the `from` commit in a diff shows the initial commit as all additions. We'll define this as a constant:

```typescript
const GIT_EMPTY_TREE = "4b825dc642cb6404f32168ace2c04d9f6e8f59b6";
```

## Scope

This feature is intentionally minimal:
- No multi-commit range selection (just single commit diffs)
- No cherry-pick or revert from the diff view (rollback already exists)
- No inline commenting on historical diffs
- No diff caching (diffs are fetched fresh each time; they're fast for typical commit sizes)
