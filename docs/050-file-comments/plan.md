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

Comments are stored in a **persisted Zustand store** (`localStorage`) keyed by session ID. They survive page refresh and server restart, but are scoped to the session they were created in. Cleared after send.

```typescript
interface FileComment {
  id: string;          // crypto.randomUUID()
  filePath: string;    // "src/server/api-routes.ts"
  line: number;        // 1-based line number
  text: string;        // The comment text
}

// Store shape (persisted to localStorage per session)
interface FileCommentState {
  // sessionId → FileComment[]
  commentsBySession: Record<string, FileComment[]>;
}
```

### Prompt Construction

When the user clicks "Send," the client builds a prompt with inline snippets for each comment and attaches the full files via the existing `FileContextRef` mechanism. This gives Claude both the precise line-level context (snippets) and the full file contents (attachments) for broader understanding.

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

/** Collect FileContextRef[] for all files that have comments. */
function getCommentedFileRefs(comments: FileComment[]): FileContextRef[] {
  const paths = new Set(comments.map((c) => c.filePath));
  return [...paths].map((path) => ({ path }));
}
```

Example prompt:
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

The snippets give Claude precise line-level context. The attached full files (via `FileContextRef`) let it understand the broader structure without us bloating the prompt with entire file contents inline.

### Send Flow

The send uses the existing `send_message` WebSocket message — no new server endpoints or message types needed. `send_message` already supports `files?: FileContextRef[]` for attaching file context. The client:

1. Reads file contents for each commented file (already in memory from `FileContentViewer`, or fetched via `GET /api/sessions/:id/files/*`)
2. Calls `buildFileCommentsPrompt()` to assemble the prompt text
3. Calls `getCommentedFileRefs()` to build the file attachment list
4. Sends `{ type: "send_message", text: prompt, files: fileRefs }`
5. Clears all pending comments for the current session

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

#### Comment store (new)

**File**: `src/client/stores/comment-store.ts`

A dedicated Zustand store with `persist` middleware (`localStorage`). Separate from the file store because it has a different lifecycle (persisted, session-scoped) and different concerns.

```typescript
import { create } from "zustand";
import { persist } from "zustand/middleware";

interface FileCommentStore {
  // sessionId → FileComment[]
  commentsBySession: Record<string, FileComment[]>;

  addComment: (sessionId: string, filePath: string, line: number, text: string) => void;
  deleteComment: (sessionId: string, commentId: string) => void;
  clearComments: (sessionId: string) => void;
  getCommentsForFile: (sessionId: string, filePath: string) => FileComment[];
  getAllComments: (sessionId: string) => FileComment[];
  getCommentCount: (sessionId: string) => number;
}

const useCommentStore = create<FileCommentStore>()(
  persist(
    (set, get) => ({ /* ... */ }),
    { name: "shipit-file-comments" },
  ),
);
```

Keying by session ID ensures comments from one session don't leak into another. When a session is archived/deleted, its comments can be cleaned up (or left to expire — localStorage is bounded).

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

### Store Tests — Comment Store

1. **Add comment**: Adds to correct session's array
2. **Delete comment**: Removes by ID within session
3. **Clear comments**: Empties session's array, other sessions unaffected
4. **Get comments for file**: Filters by filePath within session
5. **Session isolation**: Comments from session A not visible in session B
6. **Persistence**: Uses Zustand persist middleware (localStorage)

## Key Files

| File | Change |
|---|---|
| `src/client/components/FileContentViewer.tsx` | Add line numbers, comment gutter, inline comment cards |
| `src/client/components/FileContentViewer.test.tsx` | New/updated — component tests |
| `src/client/stores/comment-store.ts` | New — persisted Zustand store for file comments |
| `src/client/App.tsx` | Wire comments to FileContentViewer, add send handler |

## Scope & Non-Goals

**In scope**:
- Inline comments on any file, anchored to line numbers
- Client-side persisted storage (Zustand + localStorage, keyed by session, cleared on send)
- Prompt construction with inline snippets + full file attachments via `FileContextRef`
- Send via existing `send_message`

**Not in scope**:
- Server-side persistence (localStorage is sufficient for a single-user tool)
- AI-generated comments (future: Claude reviews files and produces comments)
- Comments on rendered markdown (this is line-based, for source files)
- Diff-specific commenting (the existing `diff_comment` flow is separate)
- Comment editing (delete and re-add is fine at this scope)
- Cross-session comments (comments are scoped to the session they were created in)

## Complexity

Low. The main work is enhancing `FileContentViewer` with line numbers and comment interactivity (~150-200 lines of new JSX/CSS). The store addition is ~20 lines. Prompt construction is ~30 lines. No server changes. Total: ~250-300 lines of new code.
