---
status: planned
---
# 049 — Review Comments

## Summary

Let users leave review comments on design docs (`plan.md` files) and on any source file in the workspace. Design doc comments are section-anchored with server-side persistence and an AI review option; file comments are line-anchored with client-side persistence. Both flows culminate in a "Send" action that constructs a structured prompt and sends it to Claude.

## Motivation

When reviewing code or design docs that Claude produced (or that already exist in the repo), the fastest way to give feedback is to point at a specific location and say what's wrong. Today the user has to describe the location in prose ("in api-routes.ts around line 40, the validation is missing..." or "in the plan at docs/012-.../plan.md, section 3 says X but I want Y"). This is tedious and error-prone.

Two complementary comment flows solve this:

1. **Design doc review** — the user opens a feature's `plan.md` in the Features panel, adds section-anchored comments (or triggers AI review), curates the feedback, and presses "Send" to spawn a new session that addresses it.
2. **File comments** — the user clicks a line number in any open file, types a comment, repeats across files, and presses "Send" to batch all comments into the current session.

This also fills a gap: the `diff_comment` WebSocket message type already exists on the server but has no client UI. File comments are the general-purpose version of that idea.

---

## Part 1 — Design Doc Review Comments

### UX Flow

```
┌─────────────────────────────────────────────────────────────────┐
│  Features tab                                                   │
│                                                                 │
│  In Progress                                                    │
│  012  Deployment          [In Progress]     [Review] [Start]    │
│  017  Diff Review Panel   [In Progress]     [Review] [Start]    │
│                                                                 │
│  Planned                                                        │
│  034  Home Screen         [Planned]         [Review] [Start]    │
└─────────────────────────────────────────────────────────────────┘
                              │
                     click "Review"
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│  Review: Deployment (plan.md)               [AI Review] [Close] │
│─────────────────────────────────────────────────────────────────│
│                                                                 │
│  ## Summary                                              [+]    │
│  Add deployment support for Vercel and Cloudflare...            │
│                                                                 │
│  ## Architecture                                         [+]    │
│  The deployment system uses a plugin-based approach...          │
│                                                                 │
│    ┌─ 🤖 AI Comment ───────────────────────────────────┐       │
│    │ Consider a registry pattern instead of hardcoded   │       │
│    │ target list — makes third-party targets easier.    │       │
│    │                                      [Edit] [Del]  │       │
│    └────────────────────────────────────────────────────┘       │
│    ┌─ 👤 Comment ──────────────────────────────────────┐       │
│    │ This should also support Netlify from day one.     │       │
│    │ Netlify is our most-requested target.              │       │
│    │                                      [Edit] [Del]  │       │
│    └────────────────────────────────────────────────────┘       │
│                                                                 │
│  ## Testing                                              [+]    │
│  ...                                                            │
│                                                                 │
│─────────────────────────────────────────────────────────────────│
│  2 comments                    [Cancel]  [Send Comments ▶]      │
│                                                                 │
│  Past reviews:  2025-02-20 (3 comments, sent) ▾                 │
└─────────────────────────────────────────────────────────────────┘
```

1. **Entry point**: A "Review" button on each feature row in `FeaturesPanel`. Clicking it opens a review view for that feature's `plan.md`, loading any existing draft comments from the server.
2. **Section-anchored comments**: The rendered markdown is split by top-level headings (`## ...`). Each section has a `[+]` button. Clicking it inserts a comment input below that section.
3. **AI Review**: An "AI Review" button in the header triggers a server-side flow that runs Claude with a structured review prompt. The resulting AI comments are saved to the store and appear inline alongside human comments, visually distinguished.
4. **Comment management**: Comments appear inline below their section. Each has edit and delete buttons (on hover).
5. **Send**: The footer "Send Comments" button creates a new session, constructs a structured prompt from all comments, marks the review as "sent" in the store, and navigates to the new session's chat.
6. **Past reviews**: The footer shows a collapsible list of previous reviews for this feature, with timestamps, comment counts, and status.

### Comment Data Model

```typescript
type ReviewCommentSource = "human" | "ai";

interface ReviewComment {
  id: string;              // crypto.randomUUID()
  sectionHeading: string;  // "## Architecture" — heading this comment is anchored to
  sectionIndex: number;    // 0-based index of the section in the doc (at time of creation)
  text: string;            // The comment text
  source: ReviewCommentSource;
}

type ReviewStatus = "draft" | "sent";

interface DocReview {
  id: string;              // crypto.randomUUID()
  featureId: string;       // "012-deployment" — feature directory name
  planPath: string;        // "docs/012-deployment/plan.md"
  status: ReviewStatus;
  comments: ReviewComment[];
  docSnapshotHash: string; // SHA-256 of the plan.md content when the review was created
  sectionHeadings: string[]; // Ordered list of ## headings at snapshot time
  createdAt: string;       // ISO 8601 timestamp
  updatedAt: string;       // ISO 8601 timestamp
  sentAt?: string;         // Set when status transitions to "sent"
  sentToSessionId?: string; // Session that was created to address this review
}
```

### Server-Side

#### `ReviewStore` (new)

**File**: `src/server/review-store.ts`

Follows the same pattern as `DeploymentStore` and `ThreadManager`: file-based JSON persistence, constructor accepts optional base directory for testability.

**Storage layout**:
```
{workspaceDir}/.shipit-reviews/
  {featureId}.json          # Array of DocReview objects for that feature
```

Each feature gets its own file. This keeps file sizes small and avoids contention.

**Methods**:
```typescript
class ReviewStore {
  constructor(baseDir?: string);  // defaults to /workspace/.shipit-reviews

  /** List all reviews for a feature, newest first. */
  listReviews(featureId: string): DocReview[];

  /** Get a specific review by ID. */
  getReview(featureId: string, reviewId: string): DocReview | null;

  /** Get the current draft review for a feature (status === "draft"), or null. */
  getDraft(featureId: string): DocReview | null;

  /** Create a new draft review. Only one draft per feature at a time. */
  createDraft(featureId: string, planPath: string): DocReview;

  /** Add a comment to a draft review. */
  addComment(featureId: string, reviewId: string, comment: Omit<ReviewComment, "id">): ReviewComment;

  /** Update a comment's text. */
  updateComment(featureId: string, reviewId: string, commentId: string, text: string): void;

  /** Delete a comment from a review. */
  deleteComment(featureId: string, reviewId: string, commentId: string): void;

  /** Mark a review as sent, recording the target session ID. */
  markSent(featureId: string, reviewId: string, sessionId: string): void;

  /** Delete a draft review (e.g., on cancel). */
  deleteDraft(featureId: string, reviewId: string): void;
}
```

**Concurrency**: Single-writer (only one ShipIt server per workspace), read-on-load, write-on-mutate — same as other stores.

#### HTTP Endpoints (new)

All endpoints live under `/api/features/:featureId/reviews`. Added via `registerApiRoutes()` in `api-routes.ts`.

| Method | Path | Description | Service function |
|--------|------|-------------|------------------|
| `GET` | `/api/features/:featureId/reviews` | List all reviews for a feature | `listReviews()` |
| `GET` | `/api/features/:featureId/reviews/draft` | Get current draft (or 404) | `getDraftReview()` |
| `POST` | `/api/features/:featureId/reviews` | Create a new draft review | `createDraftReview()` |
| `POST` | `/api/features/:featureId/reviews/:reviewId/comments` | Add a comment | `addReviewComment()` |
| `PATCH` | `/api/features/:featureId/reviews/:reviewId/comments/:commentId` | Update comment text | `updateReviewComment()` |
| `DELETE` | `/api/features/:featureId/reviews/:reviewId/comments/:commentId` | Delete a comment | `deleteReviewComment()` |
| `POST` | `/api/features/:featureId/reviews/:reviewId/send` | Mark as sent, return prompt | `sendReview()` |
| `DELETE` | `/api/features/:featureId/reviews/:reviewId` | Delete a draft | `deleteDraftReview()` |

Service functions live in `src/server/services/reviews.ts` and throw `ServiceError` for validation (empty text, non-existent review, etc.).

#### AI Review Flow

AI comments are stored in the same `ReviewStore` with `source: "ai"`. The difference is how they get there.

**Flow**:
1. User clicks "AI Review" button in the review panel header.
2. Client sends `POST /api/features/:featureId/reviews/:reviewId/ai-review`.
3. Server reads the `plan.md` content from disk.
4. Server calls the Claude CLI process with a structured review prompt (see below).
5. Server parses Claude's response into `ReviewComment[]` objects.
6. Server saves the AI comments to the existing draft review via `ReviewStore.addComment()`.
7. Server returns the new comments to the client.
8. Client updates the review panel UI — AI comments appear inline, visually marked.

**AI review prompt** (sent to Claude):
```
You are reviewing a design document. Read the following plan and provide structured feedback.

<document path="{planPath}">
{full plan.md content}
</document>

Respond with a JSON array of review comments. Each comment must reference a section heading from the document. Format:

```json
[
  {
    "sectionHeading": "## Architecture",
    "text": "Your feedback here"
  }
]
```

Focus on:
- Architectural concerns or missing considerations
- Edge cases not addressed
- Simplification opportunities
- Consistency with the rest of the codebase
- Missing test coverage

Be specific and actionable. Do not repeat what the document already says.
```

**Implementation note**: The AI review runs as a one-shot Claude CLI invocation (`claude --print` or equivalent single-turn mode), not as a streaming session. The HTTP request blocks until Claude responds (with a reasonable timeout). A loading spinner shows on the client.

**Why same pipeline**: Storing AI comments in the same `ReviewStore` means they appear in the same UI, users can edit/delete them before sending, the send flow doesn't care about source, and past reviews show the full mix.

### Client-Side — Design Doc Review

#### `DocReviewPanel` (new component)

**File**: `src/client/components/DocReviewPanel.tsx`

The main review UI. Fetches the draft review from the server on mount, renders sections with comment affordances.

**Props**:
```typescript
interface DocReviewPanelProps {
  feature: FeatureInfo;
  content: string;                // Raw markdown content of plan.md
  onSendComments: (feature: FeatureInfo, reviewId: string) => void;
  onClose: () => void;
}
```

**Behavior**:
- On mount: `GET /api/features/:featureId/reviews/draft`. If a draft exists, load its comments. If not, `POST /api/features/:featureId/reviews` to create one.
- Adding a comment: `POST /api/features/:featureId/reviews/:reviewId/comments` → update local state from response.
- Editing a comment: `PATCH .../comments/:commentId` → update local state.
- Deleting a comment: `DELETE .../comments/:commentId` → remove from local state.
- AI Review: `POST .../ai-review` → loading state → merge new comments into local state.
- Send: `POST .../send` → triggers `onSendComments` callback in parent.
- Cancel/close: if no comments, `DELETE` the draft. If comments exist, keep the draft for later.

**Section parsing**: Split the markdown content by `## ` headings. Each section is rendered as:
1. The heading + body (rendered as HTML via `marked`)
2. Any attached comments (styled cards, distinguished by source)
3. A `[+]` button to add a new comment

#### Comment Card Styling

- **Human comments**: Left border `border-l-2 border-blue-400`, background `bg-blue-950`.
- **AI comments**: Left border `border-l-2 border-purple-400`, background `bg-purple-950`. Small label "AI" in the card header.
- Both types have Edit and Delete buttons (on hover).

#### `DocReviewHistory` (same file)

A collapsible section in the review panel footer showing past reviews for this feature. Each entry shows timestamp, comment count, and status. Clicking a sent review expands it to show its comments (read-only).

#### Integration into `FeaturesPanel`

Add a "Review" button to each `FeatureRow`, alongside "Start Session". Both appear on hover.

### Prompt Construction (Design Docs)

Handled server-side in the `sendReview()` service function.

```typescript
function buildReviewPrompt(
  planPath: string,
  comments: ReviewComment[],
  currentHeadings: string[],
): string {
  const currentSet = new Set(currentHeadings);

  // Separate anchored vs orphaned
  const anchored: ReviewComment[] = [];
  const orphaned: ReviewComment[] = [];
  for (const c of comments) {
    if (c.sectionHeading === "" || currentSet.has(c.sectionHeading)) {
      anchored.push(c);
    } else {
      orphaned.push(c);
    }
  }

  // Group anchored comments by section
  const grouped = new Map<string, ReviewComment[]>();
  for (const comment of anchored) {
    const key = comment.sectionHeading || "(Introduction)";
    if (!grouped.has(key)) grouped.set(key, []);
    grouped.get(key)!.push(comment);
  }

  let prompt = `I've reviewed the design doc at ${planPath} and have the following feedback:\n\n`;

  for (const [heading, sectionComments] of grouped) {
    prompt += `### ${heading}\n\n`;
    for (const c of sectionComments) {
      prompt += `- ${c.text}\n`;
    }
    prompt += "\n";
  }

  if (orphaned.length > 0) {
    prompt += `### Comments on removed/renamed sections\n\n`;
    prompt += `The following comments reference sections that no longer exist in the document. `;
    prompt += `The feedback may still be relevant — consider whether it applies elsewhere.\n\n`;
    for (const c of orphaned) {
      prompt += `- (was: ${c.sectionHeading}) ${c.text}\n`;
    }
    prompt += "\n";
  }

  prompt += "Please read the design doc, address each piece of feedback ";
  prompt += "by updating the plan, and explain what you changed.";

  return prompt;
}
```

### Document Drift

A persistent review creates a time gap: the user writes comments against version A of the doc, but by the time they reopen the draft, the doc may be at version B.

#### Snapshot at draft creation

When a draft is created, the `DocReview` records `docSnapshotHash` (SHA-256 of the content) and `sectionHeadings` (ordered list of `## ` headings). These are stored once and never updated.

#### Re-anchoring on load

When the review panel opens an existing draft and the hash doesn't match the current doc:

```typescript
function reanchorComments(
  comments: ReviewComment[],
  snapshotHeadings: string[],
  currentHeadings: string[],
): { anchored: ReviewComment[]; orphaned: ReviewComment[] } {
  const currentSet = new Map(currentHeadings.map((h, i) => [h, i]));
  const anchored: ReviewComment[] = [];
  const orphaned: ReviewComment[] = [];

  for (const comment of comments) {
    if (comment.sectionHeading === "") {
      anchored.push({ ...comment, sectionIndex: 0 });
    } else if (currentSet.has(comment.sectionHeading)) {
      anchored.push({ ...comment, sectionIndex: currentSet.get(comment.sectionHeading)! });
    } else {
      orphaned.push(comment);
    }
  }

  return { anchored, orphaned };
}
```

The primary anchor is **heading text**, not index. This handles reordering and insertion gracefully.

#### Orphaned comments UI

Comments whose section heading no longer exists appear in a yellow warning block at the top of the review panel with a "Move to section" dropdown to re-anchor, plus a delete button. They are still included in the prompt when sent.

#### Edge cases

| Scenario | Behavior |
|---|---|
| Section renamed | Comment orphaned. User re-anchors via dropdown. |
| Section deleted | Comment orphaned. User can delete or re-anchor. |
| Section reordered | Heading text still matches → auto re-anchored to new position. |
| Content changed within section | Heading matches → comment stays anchored. |
| Whole doc rewritten | All comments orphaned. Banner warns. |
| New sections added | No impact on existing comments. New `[+]` buttons appear. |
| Doc deleted | Review panel shows error: "Document not found." Draft preserved. |

### Review Lifecycle

```
[User clicks "Review"] → draft created (or existing draft loaded)
                             │
                     ┌───────┴────────┐
                     │ doc changed?   │
                     │ re-anchor      │
                     │ show drift UI  │
                     └───────┬────────┘
                             │
          ┌──────────────────┼──────────────────┐
          ▼                  ▼                   ▼
   Add human comments   AI Review         Edit/delete/re-anchor
          │                  │                   │
          └──────────────────┼──────────────────┘
                             │
                    [Send Comments]
                             │
                             ▼
              Review marked "sent"
              New session created
              Prompt includes all comments
```

**Draft persistence**: Only one draft per feature at a time. Drafts persist across page navigations and are only deleted on explicit cancel or send. Sent reviews are immutable.

---

## Part 2 — File Comments

### Existing Components

Two viewer components exist today. Comments must work in both.

| Component | File | Rendering | Line numbers | Used for |
|---|---|---|---|---|
| `FilePreviewModal` | `src/client/components/FilePreviewModal.tsx` | highlight.js (`<pre><code>`) for code; `marked` for markdown; `<img>` for images | **None** | Clicking file links in chat, file tree, grep results. Opens as a modal overlay. |
| `DiffPanel` | `src/client/components/DiffPanel.tsx` | Monaco `DiffEditor` (side-by-side, read-only) | Yes (Monaco built-in) | "View Changes" after Claude finishes a turn. Shows per-file diffs with a file list sidebar. |

**Other relevant surfaces** (no comments needed, listed for context):
- `ToolResult` — inline in chat, shows truncated file content / bash output / grep results. Uses highlight.js. Read-only snippet, not a full viewer.
- `DiffBlock` — one-liner summary card (`edit src/foo.ts +40 -12`). Not a viewer.

### Strategy: Unified Comment Widget via Monaco

Rather than building two parallel comment UIs (custom React gutter for FilePreviewModal, Monaco widgets for DiffPanel), we **upgrade FilePreviewModal to use Monaco `Editor` (read-only) for code files**. This gives us:

- Line numbers for free
- A single comment implementation using Monaco's `ViewZone` API (injected DOM elements between lines) and glyph margin decorations
- Consistent look and feel across both viewers
- Language detection already shared (`getLanguageFromPath()` in DiffPanel)

**What stays the same**: Markdown rendering (`marked`), image display, and binary placeholder in FilePreviewModal are unchanged — comments only apply to code files.

**Bundle impact**: Monaco is already loaded for DiffPanel, so no new bundle cost. The `@monaco-editor/react` package lazy-loads the Monaco core on first use.

### UX Flow

1. User opens a file via the file tree, a chat link, or a grep result → `FilePreviewModal` opens with Monaco (read-only) for code files.
2. **Glyph margin `+` icon**: Hovering over the glyph margin (left of line numbers) highlights the row. Clicking opens a comment input widget below that line.
3. User types a comment, presses Cmd/Ctrl+Enter to save. The comment appears as an inline card (Monaco `ViewZone`) pinned to that line.
4. User can also add comments in `DiffPanel` on the **modified** (right) side — same glyph margin interaction, same ViewZone rendering.
5. User repeats across files. A badge shows total pending comment count.
6. User clicks "Send N comments". All comments are formatted with file context and sent as a `send_message` to the current session.
7. After sending, all comments are cleared.

```
┌─ FilePreviewModal (Monaco read-only) ────────────────────┐
│  src/server/api-routes.ts                        [Close]  │
│───────────────────────────────────────────────────────────│
│  ┊  1  import express from "express";                     │
│  ┊  2  import { authMiddleware } from "./auth.js";        │
│  ┊  3                                                     │
│  +  4  export function registerRoutes(app) {              │
│  ┊  5    app.get("/api/users", async (req, res) => {      │
│  ┊  6      const users = await db.query("SELECT * FROM    │
│  ┊  7        users WHERE active = true");                  │
│  ┊  ┌─ 💬 Line 6 ────────────────────────────────┐       │
│  ┊  │ SQL injection risk — use parameterized      │       │
│  ┊  │ query instead.                   [Edit][Del]│       │
│  ┊  └─────────────────────────────────────────────┘       │
│  ┊  8      res.json(users);                               │
│  ┊  9    });                                              │
│  ┊ 10  }                                                  │
│───────────────────────────────────────────────────────────│
│  1 comment on this file          [Send 1 comment ▶]      │
└───────────────────────────────────────────────────────────┘

(┊ = glyph margin, + = hover affordance on line 4)
```

In DiffPanel, comments appear on the **modified** (right) editor only:

```
┌─ DiffPanel ──────────────────────────────────────────────┐
│  ┌─ Files ─┐  ┌─ Original ──────┬─ Modified ────────┐   │
│  │ M foo.ts │  │  5  old code    │  5  new code      │   │
│  │ A bar.ts │  │  6  ...         │  6  ...            │   │
│  │          │  │                  │  ┌─ 💬 Line 6 ──┐ │   │
│  │          │  │                  │  │ This broke   │ │   │
│  │          │  │                  │  │ the API  [Del]│ │   │
│  │          │  │                  │  └───────────────┘ │   │
│  │          │  │  7  ...         │  7  ...            │   │
│  └──────────┘  └────────────────┴────────────────────┘   │
│  1 comment                       [Send 1 comment ▶]      │
└──────────────────────────────────────────────────────────┘
```

### Comment Data Model

Comments are stored in a **persisted Zustand store** (`localStorage`) keyed by session ID. They survive page refresh but are scoped to the session they were created in. Cleared after send.

```typescript
interface FileComment {
  id: string;          // crypto.randomUUID()
  filePath: string;    // "src/server/api-routes.ts"
  line: number;        // 1-based line number
  text: string;        // The comment text
}
```

### Client-Side — File Comments

#### Monaco Comment Widgets (shared between both viewers)

**File**: `src/client/components/MonacoCommentWidgets.ts`

A utility module that adds comment UI to any Monaco editor instance. Used by both `FilePreviewModal` and `DiffPanel`.

```typescript
interface CommentWidgetManager {
  /** Render existing comments as ViewZones + decorations */
  setComments(comments: FileComment[]): void;

  /** Show the "add comment" input below a line */
  openCommentInput(line: number): void;

  /** Clean up all ViewZones and decorations */
  dispose(): void;
}

/**
 * Attaches comment widgets to a Monaco editor instance.
 * - Adds glyph margin click handler (opens comment input)
 * - Renders existing comments as ViewZones (inline DOM below the line)
 * - Each comment card has Edit and Delete buttons
 */
function createCommentWidgetManager(
  editor: monaco.editor.IStandaloneCodeEditor | monaco.editor.IStandaloneDiffEditor,
  options: {
    filePath: string;
    onAddComment: (line: number, text: string) => void;
    onEditComment: (commentId: string, text: string) => void;
    onDeleteComment: (commentId: string) => void;
    side?: "modified";  // For diff editor — only attach to modified side
  },
): CommentWidgetManager;
```

**Implementation approach**:

1. **Glyph margin decoration**: Add a CSS class to the glyph margin that shows a `+` icon on hover (via `editor.deltaDecorations`). Listen for `onMouseDown` events in the glyph margin area to trigger comment input.

2. **Comment input (ViewZone)**: When the user clicks the glyph margin, insert a `ViewZone` below that line containing a React-rendered `<textarea>` with submit/cancel buttons. `ViewZone.domNode` is a plain DOM element — use `createRoot()` to render React into it.

3. **Comment cards (ViewZone)**: Each saved comment becomes a `ViewZone` with a rendered card showing the comment text, edit button, and delete button. Cards use the same blue accent styling as design doc human comments (`border-l-2 border-blue-400 bg-blue-950`).

4. **Glyph margin icons**: Lines with comments get a comment icon in the glyph margin (using `GlyphMarginClassName` decoration).

5. **Diff editor access**: For `DiffPanel`, use `editor.getModifiedEditor()` to get the right-side editor instance, then attach widgets to that.

#### `FilePreviewModal` changes

**File**: `src/client/components/FilePreviewModal.tsx`

Current state: renders code with highlight.js in `<pre><code>`, no line numbers, no interactivity.

Changes for code files only (markdown/image/binary unchanged):
1. Replace `<pre><code>` with Monaco `Editor` (read-only, `vs-dark` theme)
2. On `editorDidMount`, call `createCommentWidgetManager()` to attach comment UI
3. Pass comments from the comment store, wire up add/edit/delete callbacks
4. Add a footer bar showing comment count + "Send N comments" button

```typescript
// Inside FilePreviewModal, for code files:
<Editor
  value={content}
  language={getLanguageFromPath(filePath)}
  theme="vs-dark"
  options={{
    readOnly: true,
    minimap: { enabled: false },
    lineNumbers: "on",
    glyphMargin: true,         // Required for comment affordance
    folding: false,
    scrollBeyondLastLine: false,
    fontSize: 12,
    renderOverviewRuler: false,
  }}
  onMount={(editor) => {
    commentManagerRef.current = createCommentWidgetManager(editor, {
      filePath,
      onAddComment: (line, text) => commentStore.addComment(sessionId, filePath, line, text),
      onEditComment: (id, text) => commentStore.editComment(sessionId, id, text),
      onDeleteComment: (id) => commentStore.deleteComment(sessionId, id),
    });
    commentManagerRef.current.setComments(comments);
  }}
/>
```

#### `DiffPanel` changes

**File**: `src/client/components/DiffPanel.tsx`

Current state: Monaco `DiffEditor`, read-only, no decorations.

Changes:
1. Enable `glyphMargin: true` in the diff editor options
2. On `editorDidMount`, call `createCommentWidgetManager()` with `side: "modified"` to attach comment UI to the right-side editor
3. When the selected file changes, dispose the old manager and create a new one for the new file
4. Wire up the comment store callbacks
5. Add a footer section showing total comment count + "Send N comments" button

```typescript
<DiffEditor
  original={selectedFile.oldContent}
  modified={selectedFile.newContent}
  language={language}
  theme="vs-dark"
  options={{
    readOnly: true,
    renderSideBySide: true,
    minimap: { enabled: false },
    glyphMargin: true,           // NEW — enables comment affordance
    scrollBeyondLastLine: false,
    fontSize: 12,
    lineNumbers: "on",
    folding: false,
    // ... existing options
  }}
  onMount={(editor) => {
    commentManagerRef.current = createCommentWidgetManager(editor, {
      filePath: selectedFile.path,
      onAddComment: (line, text) => commentStore.addComment(sessionId, selectedFile.path, line, text),
      onEditComment: (id, text) => commentStore.editComment(sessionId, id, text),
      onDeleteComment: (id) => commentStore.deleteComment(sessionId, id),
      side: "modified",
    });
    commentManagerRef.current.setComments(commentsForFile);
  }}
/>
```

#### Comment store (new)

**File**: `src/client/stores/comment-store.ts`

A dedicated Zustand store with `persist` middleware (`localStorage`). Separate from the file store because it has a different lifecycle.

```typescript
import { create } from "zustand";
import { persist } from "zustand/middleware";

interface FileCommentStore {
  commentsBySession: Record<string, FileComment[]>;
  addComment: (sessionId: string, filePath: string, line: number, text: string) => void;
  editComment: (sessionId: string, commentId: string, text: string) => void;
  deleteComment: (sessionId: string, commentId: string) => void;
  clearComments: (sessionId: string) => void;
  getCommentsForFile: (sessionId: string, filePath: string) => FileComment[];
  getAllComments: (sessionId: string) => FileComment[];
  getCommentCount: (sessionId: string) => number;
}
```

#### Send UI

The "Send N comments" affordance appears in:
1. **`FilePreviewModal` footer**: Shows count for the current file. Sends all comments across all files.
2. **`DiffPanel` footer**: Same affordance, next to the existing close button.
3. **Comment badge in the header or chat input area**: A persistent count badge when there are pending comments, visible even when no viewer is open.

### Prompt Construction (File Comments)

Built client-side. No new server endpoints needed — sends via existing `send_message`.

```typescript
function buildFileCommentsPrompt(comments: FileComment[], fileContents: Map<string, string>): string {
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

Full files are also attached via `FileContextRef` so Claude has broader context.

### Send Flow (File Comments)

1. Read file contents for each commented file (already in memory or fetched via API)
2. Call `buildFileCommentsPrompt()` to assemble prompt text
3. Call `getCommentedFileRefs()` to build file attachment list
4. Send `{ type: "send_message", text: prompt, files: fileRefs }`
5. Clear all pending comments for the current session

---

## Shared Design Details

### Section Parsing (Design Doc)

```typescript
interface MarkdownSection {
  heading: string;     // "## Architecture" or "" for preamble
  rawContent: string;
  index: number;
}

function parseMarkdownSections(content: string): MarkdownSection[] {
  const sections: MarkdownSection[] = [];
  const lines = content.split("\n");
  let current: MarkdownSection = { heading: "", rawContent: "", index: 0 };

  for (const line of lines) {
    if (line.startsWith("## ")) {
      if (current.heading || current.rawContent.trim()) {
        sections.push(current);
      }
      current = { heading: line, rawContent: line + "\n", index: sections.length };
    } else {
      current.rawContent += line + "\n";
    }
  }
  if (current.heading || current.rawContent.trim()) {
    sections.push(current);
  }

  return sections;
}
```

### Keyboard Shortcuts

- **Escape** in the review panel: closes the panel (with confirmation if draft has comments)
- **Cmd/Ctrl+Enter** in a comment textarea: submits the comment
- **Escape** in a comment textarea: cancels the input without adding a comment

---

## Testing

### Unit Tests — `ReviewStore` (`src/server/review-store.test.ts`)

1. Create draft with correct fields including `docSnapshotHash` and `sectionHeadings`
2. One draft per feature: creating a second returns the existing one
3. Add comment with correct ID, source, section info
4. Update comment text, preserve other fields
5. Delete comment, other comments unaffected
6. Mark sent: sets status, records sessionId and sentAt
7. Delete draft
8. List reviews: newest first
9. Persistence across store instances
10. Isolation between features

### Unit Tests — Re-anchoring (`src/server/services/reviews.test.ts`)

1. No drift: same headings → all anchored
2. Section reordered → re-anchored to new index
3. Section deleted → orphaned
4. Section renamed → orphaned (no fuzzy matching)
5. New section added → existing comments unaffected
6. Preamble comment always anchored
7. All sections deleted → all non-preamble orphaned

### Integration Tests — HTTP endpoints (`src/server/integration_tests/doc-reviews.test.ts`)

1. Create draft: `POST` → 200
2. Get draft: `GET .../draft` → 200 or 404
3. Add comment: `POST .../comments` → 200
4. Add comment validation: empty text → 400
5. Update comment: `PATCH` → 200
6. Delete comment: `DELETE` → 200
7. Send review: `POST .../send` → 200 with prompt
8. Send validation: no comments → 400
9. List reviews: includes sent
10. AI review (stub Claude): adds AI comments

### Component Tests — `DocReviewPanel` (`src/client/components/DocReviewPanel.test.tsx`)

1. Renders sections from markdown headings
2. Add comment flow: click `[+]` → type → Cmd+Enter → card appears
3. Delete comment
4. Cancel input: Escape closes textarea
5. Send button disabled with no comments, enabled with comments
6. Send callback fires
7. AI vs human styling (purple vs blue accent)
8. Edit comment flow
9. Past reviews in history section
10. Drift banner when doc hash differs
11. Orphaned comments in warning block with "Move to section" dropdown

### Unit Tests — `MonacoCommentWidgets` (`src/client/components/MonacoCommentWidgets.test.ts`)

1. `setComments()` creates ViewZones at correct line positions
2. `openCommentInput()` inserts an input ViewZone below the target line
3. Submitting input calls `onAddComment` with correct line and text
4. Cancelling input (Escape) removes the ViewZone without calling `onAddComment`
5. Delete button calls `onDeleteComment` with correct ID
6. Edit button replaces card with editable textarea, save calls `onEditComment`
7. `dispose()` removes all ViewZones and decorations
8. Glyph margin decorations added for lines with comments
9. Works with diff editor (modified side only)

### Component Tests — `FilePreviewModal` comment integration (`src/client/components/FilePreviewModal.test.tsx`)

1. Code files render with Monaco Editor (not `<pre><code>`)
2. Markdown/image files still use existing renderers (no Monaco)
3. Comment manager created on editor mount
4. Comments from store displayed via `setComments()`
5. Footer shows comment count and "Send" button
6. Send button disabled with 0 comments, enabled with 1+

### Component Tests — `DiffPanel` comment integration (`src/client/components/DiffPanel.test.tsx`)

1. Glyph margin enabled in diff editor options
2. Comment manager created on mount with `side: "modified"`
3. Switching files disposes old manager and creates new one
4. Footer shows total comment count across all files
5. Comments scoped to selected file path

### Unit Tests — File Comment Prompt Construction

1. Single file, single comment: correct snippet with context
2. Single file, multiple comments: sorted by line
3. Multiple files: grouped by file
4. Comment near start/end of file: context doesn't overflow
5. Empty file content fallback

### Store Tests — Comment Store

1. Add comment to correct session
2. Edit comment text by ID
3. Delete comment by ID
4. Clear comments for session, others unaffected
5. Get comments filtered by file
6. Session isolation
7. Persistence via localStorage

### Prompt Construction Tests — Design Doc

1. Comments across 3 sections → correctly grouped prompt
2. Mixed human/AI comments → both included
3. Orphaned comments → under "removed/renamed sections" heading
4. All comments orphaned → still valid prompt

---

## Key Files

| File | Change |
|---|---|
| `src/server/review-store.ts` | New — `ReviewStore` class, file-based JSON persistence |
| `src/server/review-store.test.ts` | New — unit tests for ReviewStore |
| `src/server/services/reviews.ts` | New — service functions for review CRUD + prompt construction |
| `src/server/orchestrator/api-routes.ts` | Add review HTTP endpoints |
| `src/server/orchestrator/index.ts` | Instantiate `ReviewStore`, inject into deps |
| `src/server/shared/types/domain-types.ts` | Add `DocReview`, `ReviewComment`, `FileComment` types |
| `src/client/components/DocReviewPanel.tsx` | New — review UI with section parsing, comment management |
| `src/client/components/DocReviewPanel.test.tsx` | New — component tests |
| `src/client/components/FeaturesPanel.tsx` | Add "Review" button, `onReviewFeature` prop |
| `src/client/components/MonacoCommentWidgets.ts` | New — shared ViewZone/decoration logic for comments in any Monaco editor |
| `src/client/components/MonacoCommentWidgets.test.ts` | New — unit tests |
| `src/client/components/FilePreviewModal.tsx` | Replace highlight.js with Monaco Editor for code files; attach comment widgets |
| `src/client/components/DiffPanel.tsx` | Enable glyph margin, attach comment widgets to modified editor |
| `src/client/stores/comment-store.ts` | New — persisted Zustand store for file comments |
| `src/client/App.tsx` | Wire both comment flows, add review state and send handlers |
| `src/server/integration_tests/doc-reviews.test.ts` | New — HTTP endpoint integration tests |

## Scope & Non-Goals

**In scope**:
- Section-anchored comments on `plan.md` files (human and AI), server-persisted
- Line-anchored comments on any source file (FilePreviewModal + DiffPanel), client-side persisted
- Editable comments in both viewers (add, edit, delete)
- HTTP CRUD endpoints for design doc reviews
- AI review via one-shot Claude CLI invocation
- Review history for design docs
- Send → new session (design doc reviews) / send → current session (file comments)
- Prompt construction for both flows
- Upgrade FilePreviewModal from highlight.js to Monaco for code files

**Not in scope (future work)**:
- Comments on `checklist.md` files
- Comments on rendered markdown (file comments are line-based, for source files)
- Collaborative review (multiple users)
- Comment resolution tracking
- Streaming AI review
- Cross-session file comments
- Comments on the original (left) side of diffs

## Complexity

Medium. Server-side work (ReviewStore + HTTP endpoints + service layer) follows established patterns. AI review flow adds moderate complexity. The `MonacoCommentWidgets` module (~200-250 lines) is the key shared abstraction — ViewZone management, glyph margin handlers, and React-in-DOM rendering. DocReviewPanel is ~300-400 lines. FilePreviewModal Monaco upgrade is ~50 lines of changes. DiffPanel changes are ~30 lines. Comment store is ~30 lines. Total: ~900-1300 lines of new code.
