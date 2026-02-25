---
status: planned
---
# 050 — File Comments

## Summary

Add inline comments to any file in the workspace. Click a line, type a comment. When ready, press "Send" — all comments across all files are collected into a single structured prompt (with filenames, line numbers, and surrounding code context) and sent to Claude in the current session.

## Motivation

When reviewing code or docs that Claude produced (or that exist in the repo), the fastest way to give feedback is to point at a specific line and say what's wrong. Today the user has to describe the location in prose ("in api-routes.ts around line 40, the validation is missing..."). File comments let users point and annotate directly, then batch-send everything in one go.

This also fills a gap: the `diff_comment` WebSocket message type already exists on the server but has no client UI. File comments are the general-purpose version of that same idea — not limited to diffs, works on any file.

## How It Works

### UX Flow

1. User opens a file in the file viewer (Files tab, or clicks a filename in chat).
2. File renders with **line numbers** in the gutter (enhancement to `FileContentViewer`).
3. Hovering over a line number shows a `+` icon. Clicking it opens an inline comment input below that line.
4. User types a comment, presses Enter (or Cmd+Enter) to save. The comment appears as a small card pinned to that line.
5. User repeats across any number of files. A badge in the UI shows the total pending comment count.
6. User clicks "Send N comments" (visible when count > 0). All comments are collected, formatted with file context, and sent as a `send_message` to the current session.
7. After sending, all comments are cleared.

```
┌─ FileContentViewer ──────────────────────────────────────┐
│    1  import express from "express";                      │
│    2  import { authMiddleware } from "./auth.js";         │
│    3                                                      │
│  + 4  export function registerRoutes(app) {               │
│    5    app.get("/api/users", async (req, res) => {       │
│    6      const users = await db.query("SELECT * FROM     │
│    7        users WHERE active = true");                   │
│    ┌─ Comment on line 6 ─────────────────────────────┐    │
│    │ SQL injection risk — use parameterized query    │    │
│    │                                          [Del]  │    │
│    └─────────────────────────────────────────────────┘    │
│    8      res.json(users);                                │
│    9    });                                                │
│   10  }                                                   │
│                                                           │
├───────────────────────────────────────────────────────────┤
│  1 comment on this file          [Send 1 comment ▶]      │
└───────────────────────────────────────────────────────────┘
```

### Comment Data Model

Comments are **transient** — stored in client-side Zustand state, cleared after send. No server persistence, no draft management. This is a scratchpad, not a review system.

```typescript
interface FileComment {
  id: string;          // crypto.randomUUID()
  filePath: string;    // "src/server/api-routes.ts"
  line: number;        // 1-based line number
  text: string;        // The comment text
}
```

All pending comments live in a flat array in the file store.

### Prompt Construction

When the user clicks "Send," the client builds a prompt on the client side:

```typescript
function buildFileCommentsPrompt(comments: FileComment[], fileContents: Map<string, string>): string {
  // Group by file
  const byFile = new Map<string, FileComment[]>();
  for (const c of comments) {
    if (!byFile.has(c.filePath)) byFile.set(c.filePath, []);
    byFile.get(c.filePath)!.push(c);
  }

  let prompt = "I have the following comments on the code:\n\n";

  for (const [filePath, fileComments] of byFile) {
    const sorted = fileComments.sort((a, b) => a.line - b.line);
    const lines = (fileContents.get(filePath) ?? "").split("\n");

    for (const comment of sorted) {
      // Include ~3 lines of context around the commented line
      const start = Math.max(0, comment.line - 3);
      const end = Math.min(lines.length, comment.line + 2);
      const snippet = lines.slice(start, end)
        .map((l, i) => {
          const lineNum = start + i + 1;
          const marker = lineNum === comment.line ? "→" : " ";
          return `${marker} ${lineNum} │ ${l}`;
        })
        .join("\n");

      prompt += `**${filePath}:${comment.line}**\n`;
      prompt += "```\n" + snippet + "\n```\n";
      prompt += `Comment: ${comment.text}\n\n`;
    }
  }

  prompt += "Please address each comment.";
  return prompt;
}
```

Example output:
```
I have the following comments on the code:

**src/server/api-routes.ts:6**
```
  4 │ export function registerRoutes(app) {
  5 │   app.get("/api/users", async (req, res) => {
→ 6 │     const users = await db.query("SELECT * FROM
  7 │       users WHERE active = true");
  8 │     res.json(users);
```
Comment: SQL injection risk — use parameterized query

Please address each comment.
```

The surrounding snippet gives Claude enough context to find the code without needing to read the whole file.

### Send Flow

The send uses the existing `send_message` WebSocket message — no new server endpoints or message types needed. The client:

1. Reads file contents for each commented file (already in memory from `FileContentViewer`, or fetched via `GET /api/sessions/:id/files/*`)
2. Calls `buildFileCommentsPrompt()` to assemble the prompt
3. Sends `{ type: "send_message", text: prompt }`
4. Clears all pending comments

This works in the current session — no new session created. The user is annotating files they're already looking at in an active session. If they want a new session, they can start one first.

## Architecture

### Client-Side Changes

#### `FileContentViewer` enhancement

**File**: `src/client/components/FileContentViewer.tsx`

Current state: renders `<pre><code>` with highlight.js, no line numbers, no interactivity.

Changes:
1. **Add line numbers**: Split content into lines, render each in a row with a line-number gutter.
2. **Add `+` button on hover**: Each line number shows a `+` icon on hover. Clicking opens a comment input below that line.
3. **Show comment cards**: If a comment exists on a line, render it as an inline card below that line.
4. **Keep syntax highlighting**: Apply highlight.js to each line's content (or highlight the full block and split — implementation detail).

The component receives comments as a prop and calls back when comments are added/deleted:

```typescript
interface FileContentViewerProps {
  content: string;
  filePath: string;
  language?: string;
  comments: FileComment[];
  onAddComment: (filePath: string, line: number, text: string) => void;
  onDeleteComment: (commentId: string) => void;
}
```

#### File store addition

**File**: `src/client/stores/file-store.ts`

Add to the existing file store:

```typescript
// New state
pendingComments: FileComment[];

// New actions
addComment: (filePath: string, line: number, text: string) => void;
deleteComment: (commentId: string) => void;
clearComments: () => void;
getCommentsForFile: (filePath: string) => FileComment[];
```

#### Send UI

The "Send N comments" affordance appears in two places:

1. **In `FileContentViewer` footer**: Shows count for the current file only. "Send N comment(s)" button. Sends all comments across all files (not just the current file), since partial sends would be confusing.
2. **Comment badge in the tab bar or header**: A small count badge (like a notification dot) somewhere persistently visible when there are pending comments. Clicking it also triggers send.

#### Wiring in `App.tsx`

- Pass `pendingComments` and comment callbacks to `FileContentViewer`.
- The send action calls `buildFileCommentsPrompt()` and dispatches `send_message` via the existing WebSocket `send()`.

### Server-Side Changes

**None.** The prompt is constructed on the client and sent as a regular `send_message`. The existing `diff_comment` handler is a precedent for this pattern but not reused here (it's tied to the diff review flow and runs in the current session's context). File comments take the simpler path of building the prompt client-side.

## Testing

### Component Tests — `FileContentViewer` (`src/client/components/FileContentViewer.test.tsx`)

1. **Renders line numbers**: Given multi-line content, renders line numbers 1..N
2. **Hover shows add button**: Hovering a line number shows `+` icon
3. **Add comment flow**: Click `+` → textarea appears → type → Enter → `onAddComment` called with correct file/line/text
4. **Cancel comment**: Click `+` → type → Escape → textarea closes, no callback
5. **Shows existing comments**: Passing comments prop → renders comment cards at correct lines
6. **Delete comment**: Click delete on card → `onDeleteComment` called with comment ID
7. **Multiple comments on different lines**: All render at correct positions
8. **Binary file**: Still shows "Binary file" message, no line numbers or comment UI

### Unit Tests — Prompt Construction

1. **Single file, single comment**: Correct snippet with 3 lines of context
2. **Single file, multiple comments**: Sorted by line number
3. **Multiple files**: Grouped by file
4. **Comment near start of file**: Context doesn't go below line 1
5. **Comment near end of file**: Context doesn't exceed file length
6. **Empty file content fallback**: Graceful when file content unavailable

### Store Tests — File Comments

1. **Add comment**: Adds to `pendingComments` array
2. **Delete comment**: Removes by ID
3. **Clear comments**: Empties array
4. **Get comments for file**: Filters by filePath

## Key Files

| File | Change |
|---|---|
| `src/client/components/FileContentViewer.tsx` | Add line numbers, comment gutter, inline comment cards |
| `src/client/components/FileContentViewer.test.tsx` | New/updated — component tests |
| `src/client/stores/file-store.ts` | Add `pendingComments` state and actions |
| `src/client/App.tsx` | Wire comments to FileContentViewer, add send handler |

## Scope & Non-Goals

**In scope**:
- Inline comments on any file, anchored to line numbers
- Client-side transient storage (Zustand, cleared on send)
- Prompt construction with file/line/snippet context
- Send via existing `send_message`

**Not in scope**:
- Server-side persistence (comments don't survive page refresh — send them or lose them)
- AI-generated comments (future: Claude reviews files and produces comments)
- Comments on rendered markdown (this is line-based, for source files)
- Diff-specific commenting (the existing `diff_comment` flow is separate)
- Comment editing (delete and re-add is fine for transient comments)
- Multi-session comments (comments are scoped to the active session's files)

## Complexity

Low. The main work is enhancing `FileContentViewer` with line numbers and comment interactivity (~150-200 lines of new JSX/CSS). The store addition is ~20 lines. Prompt construction is ~30 lines. No server changes. Total: ~250-300 lines of new code.
