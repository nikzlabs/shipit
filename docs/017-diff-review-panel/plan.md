---
status: planned
---
# 017 — Visual Diff Review Panel

## Summary

Add a dedicated diff review panel that aggregates all file changes from a Claude turn, presents them in a side-by-side or unified diff view, and lets users accept/reject changes per file and leave inline comments that are sent back to Claude as structured feedback.

## Motivation

Currently, file changes appear inline in the chat as syntax-highlighted red/green blocks extracted from `tool_use` events for Edit/Write tools. This works for small single-file edits but becomes unwieldy for multi-file changes. Users have no way to:

- See all changed files at a glance after a turn
- Accept or reject individual file changes
- Comment on specific lines in a diff
- Review changes outside the chronological chat flow

The Claude Code desktop app's "signature feature" is exactly this kind of diff review with inline commenting and accept/reject per file. Integrating this into ShipIt bridges the biggest UX gap between the two products.

## How It Works

### Diff Computation

After each Claude turn completes (on `git_committed` event), the server computes a diff between the previous commit and the new commit. This is more reliable than parsing tool_use events because:

1. It captures all changes regardless of which tool made them (Edit, Write, Bash with redirect, etc.)
2. Git diff is a well-understood format with mature tooling
3. It naturally handles renames, deletions, and binary files

### Server-Side

#### New GitManager Methods

```typescript
// src/server/git.ts — additions

/** Get unified diff between two commits (or HEAD~1..HEAD if no args). */
async diff(fromCommit?: string, toCommit?: string): Promise<string> {
  const from = fromCommit ?? "HEAD~1";
  const to = toCommit ?? "HEAD";
  return this.git.diff([from, to]);
}

/** Get list of changed files between two commits. */
async diffStat(fromCommit?: string, toCommit?: string): Promise<DiffFileStat[]> {
  const from = fromCommit ?? "HEAD~1";
  const to = toCommit ?? "HEAD";
  const result = await this.git.diffSummary([from, to]);
  return result.files.map(f => ({
    path: f.file,
    insertions: f.insertions,
    deletions: f.deletions,
    binary: f.binary,
  }));
}
```

#### New Types

```typescript
// src/server/types.ts — additions

export interface DiffFileStat {
  path: string;
  insertions: number;
  deletions: number;
  binary: boolean;
}

export interface DiffHunk {
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
  lines: DiffLine[];
}

export interface DiffLine {
  type: "add" | "remove" | "context";
  content: string;
  oldLineNumber?: number;
  newLineNumber?: number;
}

export interface FileDiff {
  path: string;
  oldPath?: string;          // for renames
  insertions: number;
  deletions: number;
  binary: boolean;
  hunks: DiffHunk[];
  status: "added" | "modified" | "deleted" | "renamed";
}

// Client → Server
export interface WsGetTurnDiff {
  type: "get_turn_diff";
  /** Base commit hash (typically the commit before the turn). */
  fromCommit: string;
  /** Target commit hash (typically the turn's auto-commit). */
  toCommit: string;
}

export interface WsRejectChanges {
  type: "reject_changes";
  /** Files to reject (revert). Empty array = reject all. */
  files: string[];
  /** Optional feedback message sent to Claude about why changes were rejected. */
  feedback?: string;
}

export interface WsDiffComment {
  type: "diff_comment";
  /** Array of inline comments to send to Claude as a follow-up prompt. */
  comments: Array<{
    file: string;
    line: number;
    text: string;
  }>;
}

// Server → Client
export interface WsTurnDiff {
  type: "turn_diff";
  fromCommit: string;
  toCommit: string;
  files: FileDiff[];
  stats: { totalInsertions: number; totalDeletions: number; filesChanged: number };
}
```

#### New Message Handlers (in `src/server/index.ts`)

**`get_turn_diff`**: Computes `git diff` between two commits, parses the unified diff output into structured `FileDiff[]`, and sends the result.

**`reject_changes`**: For each rejected file, runs `git checkout <fromCommit> -- <file>` to revert it, then auto-commits the revert. Optionally sends the feedback text as a new prompt to Claude.

**`diff_comment`**: Formats the inline comments into a structured prompt and sends it to Claude as a follow-up message:
```
The user has reviewed your changes and left the following comments:

File: src/components/App.tsx, Line 42:
"This should use useMemo instead of recalculating on every render"

File: src/utils/format.ts, Line 15:
"The date format should be ISO 8601, not US format"

Please address these comments and update the code accordingly.
```

### Client-Side

#### DiffPanel Component (`src/client/components/DiffPanel.tsx`)

A new component rendered as a collapsible panel in the right column (alongside Preview, Docs, Files, Terminal tabs — or as a slide-over panel).

**Layout:**
```
┌──────────────────────────────────────────┐
│  Changes from last turn  (+42 -12)  [×]  │
├──────────┬───────────────────────────────┤
│ Files    │  Diff View                    │
│          │                               │
│ ✓ App.tsx│  @@ -40,6 +40,8 @@           │
│ ✓ api.ts │  - const old = foo;           │
│   utils/ │  + const new = bar;           │
│          │  + const extra = baz;         │
│          │       // click line to comment│
│          │                               │
├──────────┴───────────────────────────────┤
│ [Accept All]  [Reject All]  [Comment]    │
└──────────────────────────────────────────┘
```

**Features:**
- **File list** (left): Shows all changed files with insertions/deletions counts. Click to view that file's diff. Checkboxes for per-file accept/reject.
- **Diff view** (right): Unified diff with syntax highlighting. Line numbers. Color-coded additions (green) and deletions (red).
- **Inline commenting**: Click any line in the diff to open a small text input. Type a comment, press Enter to add. Comments appear as annotations in the gutter.
- **Action buttons**:
  - "Accept All" — dismisses the panel (changes are already committed)
  - "Reject Selected" — reverts checked files via `reject_changes` message
  - "Submit Comments" — sends all pending inline comments to Claude via `diff_comment` message

#### State Management

```typescript
// New state in App.tsx
const [turnDiff, setTurnDiff] = useState<TurnDiff | null>(null);
const [showDiffPanel, setShowDiffPanel] = useState(false);
```

**Trigger**: When a `git_committed` event arrives, the client stores the commit hash. A "Review Changes" button/badge appears (e.g., `+42 -12` in the header or next to the chat). Clicking it sends `get_turn_diff` with the previous and new commit hashes and opens the diff panel.

**Auto-open option**: A user setting to automatically open the diff panel after each turn (for users who want to review every change).

#### Diff Rendering

Use a client-side diff rendering library. Options:
- **`diff2html`** — mature, supports unified and side-by-side views, syntax highlighting
- **Custom rendering** — parse the structured `FileDiff[]` and render with Tailwind classes (lighter weight, more control over styling)

Recommended: start with custom rendering using the structured data from the server. The server does the parsing; the client just renders `DiffHunk[]` with appropriate styling. This avoids adding a heavy dependency and keeps the look consistent with ShipIt's Tailwind-based design.

### Diff Badge in Chat

After each Claude turn, add a small clickable badge to the assistant message in the chat:

```
Claude: I've updated the authentication module to use JWT tokens...

  [📄 3 files changed (+42 -12)]  ← clickable, opens diff panel
```

This badge uses the data from the `git_committed` event (which already includes the commit hash). The diff stats can be computed lazily (on hover or click) to avoid unnecessary git operations.

## Integration with Existing Features

### Git History
The existing GitHistory component shows commits with rollback buttons. The diff panel complements this: instead of rolling back an entire commit, users can now selectively revert files.

### Threading
When creating a checkpoint, the diff panel should auto-close (the checkpoint captures the current git state, so reviewing diffs across checkpoints would be confusing).

### Auto-fix
When auto-fix sends errors to Claude, the resulting changes should also be reviewable in the diff panel. The "accept all" flow is implicit here (auto-fix is about speed, not review).

## Testing

### Integration Tests (`src/server/integration_tests/diff-review.test.ts`)
1. **Happy path**: Send message → Claude edits files → `get_turn_diff` returns correct file list and hunks
2. **Reject changes**: Send `reject_changes` with file list → verify files are reverted in git
3. **Diff comment**: Send `diff_comment` → verify Claude receives the formatted prompt
4. **Empty diff**: `get_turn_diff` when no files changed → returns empty file list
5. **Binary files**: Ensure binary files are flagged as `binary: true` in diff stats

### Component Tests (`src/client/components/DiffPanel.test.tsx`)
1. Renders file list with correct stats
2. Clicking a file shows its diff
3. Inline comment flow (click line → input → enter → comment appears)
4. Accept/reject buttons call correct handlers
5. Empty diff state (no changes message)

## Key Files

| File | Change |
|---|---|
| `src/server/types.ts` | Add `WsGetTurnDiff`, `WsRejectChanges`, `WsDiffComment`, `WsTurnDiff`, `FileDiff`, `DiffHunk`, `DiffLine` |
| `src/server/git.ts` | Add `diff()`, `diffStat()`, `checkoutFile()` methods |
| `src/server/index.ts` | Add handlers for `get_turn_diff`, `reject_changes`, `diff_comment` |
| `src/client/components/DiffPanel.tsx` | New component |
| `src/client/components/DiffPanel.test.tsx` | Component tests |
| `src/client/App.tsx` | Add diff state, trigger on `git_committed`, wire up panel |
| `src/server/integration_tests/diff-review.test.ts` | Integration tests |

## Complexity

Medium-high. The diff computation and data flow are straightforward (git does the heavy lifting). The main complexity is in the client-side diff rendering, inline commenting UX, and the per-file accept/reject flow with its git operations. Estimate: ~1000-1500 lines of new code.
