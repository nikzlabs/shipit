---
status: planned
---
# 049 — Design Doc Review Comments

## Summary

Let users (and AI) leave review comments on design docs (`plan.md` files), persist them for later reference, and press "Send" to spawn a new session that addresses the comments. Both human and AI comments flow through the same storage and review UI, with different entry points.

## Motivation

The Features panel already has a "Start Session" button that tells Claude to "work on feature X." But that's a blank-slate instruction — it doesn't communicate *what specifically* the user wants changed. Today, if a user reads a `plan.md` and disagrees with the caching strategy in section 3, they have to manually type out the context ("in the plan at docs/012-.../plan.md, section 3 says X but I want Y"). This is tedious and error-prone.

A structured review-and-send flow solves this:

1. **Read** — user opens the design doc in the app (already possible via the Docs tab).
2. **Annotate** — user adds comments anchored to specific sections of the doc. Or, user triggers an AI review and Claude generates structured comments.
3. **Curate** — user sees all comments (human and AI) in a single review panel. They can edit, delete, or add more.
4. **Send** — one click creates a new session with a structured prompt containing the full doc context and all comments.

Persisting comments means reviews aren't lost if the user navigates away, and past reviews can be referenced later.

## How It Works

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
4. **Comment management**: Comments appear inline below their section. Each has edit and delete buttons. Users can modify AI comments before sending.
5. **Send**: The footer "Send Comments" button:
   - Creates a new session (same repo context)
   - Constructs a structured prompt from all comments
   - Marks the review as "sent" in the store
   - Navigates to the new session's chat
6. **Past reviews**: The footer shows a collapsible list of previous reviews for this feature, with timestamps, comment counts, and status.

### Comment Data Model

```typescript
// Shared type — used by both client and server

type ReviewCommentSource = "human" | "ai";

interface ReviewComment {
  id: string;              // crypto.randomUUID()
  sectionHeading: string;  // "## Architecture" — heading this comment is anchored to
  sectionIndex: number;    // 0-based index of the section in the doc
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
  createdAt: string;       // ISO 8601 timestamp
  updatedAt: string;       // ISO 8601 timestamp
  sentAt?: string;         // Set when status transitions to "sent"
  sentToSessionId?: string; // Session that was created to address this review
}
```

## Architecture

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

**Same pipeline, different entry point.** AI comments are stored in the same `ReviewStore` with `source: "ai"`. The difference is how they get there.

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

**Parsing**: The server extracts the JSON array from Claude's response (handling markdown code fences). Comments that reference non-existent sections are dropped. Each valid comment gets `source: "ai"` and a generated `id`.

**Implementation note**: The AI review runs as a one-shot Claude CLI invocation (`claude --print` or equivalent single-turn mode), not as a streaming session. This keeps it simple — no session runner, no WebSocket streaming. The HTTP request blocks until Claude responds (with a reasonable timeout). A loading spinner shows on the client.

**Why same pipeline**: Storing AI comments in the same `ReviewStore` means:
- They appear in the same UI, interleaved with human comments by section.
- Users can edit or delete AI comments before sending (they're not read-only).
- The "Send Comments" flow doesn't care about the source — it formats all comments into the prompt identically.
- Past reviews show the mix of human and AI comments for reference.

**Why not a separate flow**: If AI comments went through a different pipeline (e.g., directly creating a session), the user would lose the ability to curate them. The whole point of review comments is that a human decides what feedback to send. AI comments are suggestions that the user approves, modifies, or discards.

### Client-Side Components

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

**Section parsing**: Split the markdown content by `## ` headings (same as v1 spec). Each section is rendered as:
1. The heading + body (rendered as HTML via `marked`)
2. Any attached comments (styled cards, distinguished by source)
3. A `[+]` button to add a new comment

#### Comment Card Styling

- **Human comments**: Left border `border-l-2 border-blue-400`, light background `bg-blue-50 dark:bg-blue-950`.
- **AI comments**: Left border `border-l-2 border-purple-400`, light background `bg-purple-50 dark:bg-purple-950`. Small label "AI" in the card header.
- Both types have Edit and Delete buttons (on hover).

#### `DocReviewHistory` (new component, same file)

A collapsible section in the review panel footer showing past reviews for this feature. Each entry shows timestamp, comment count, and status (draft/sent). Clicking a sent review expands it to show its comments (read-only).

#### Integration into `FeaturesPanel`

Add a "Review" button to each `FeatureRow`, alongside "Start Session". Both appear on hover.

**New prop**: `onReviewFeature: (feature: FeatureInfo) => void`.

#### Integration into `App.tsx`

**New state**:
```typescript
const [reviewFeature, setReviewFeature] = useState<FeatureInfo | null>(null);
const [reviewContent, setReviewContent] = useState<string | null>(null);
```

**`handleFeatureReview(feature)`**:
1. Fetch doc content via `GET /api/sessions/:id/docs/{planPath}`
2. Set `reviewFeature` and `reviewContent`
3. Render `DocReviewPanel` in the right panel

**`handleSendReviewComments(feature, reviewId)`**:
1. The `POST .../send` endpoint returns the assembled prompt and marks the review as sent
2. Follow the same flow as `handleFeatureStartSession`: reset state → `new_session` → `send_message` with the prompt
3. Clear the review state

### Prompt Construction

Handled server-side in the `sendReview()` service function. This ensures prompt format is consistent regardless of client version and allows the server to read the latest doc content.

```typescript
function buildReviewPrompt(planPath: string, comments: ReviewComment[]): string {
  // Group comments by section
  const grouped = new Map<string, ReviewComment[]>();
  for (const comment of comments) {
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

  prompt += "Please read the design doc, address each piece of feedback ";
  prompt += "by updating the plan, and explain what you changed.";

  return prompt;
}
```

The `POST .../send` endpoint:
1. Calls `buildReviewPrompt()` to assemble the prompt
2. Marks the review as `sent` in the store
3. Returns `{ prompt, reviewId }` to the client
4. Client uses the prompt with `new_session` + `send_message`

## Detailed Design

### Section Parsing

```typescript
interface MarkdownSection {
  heading: string;     // "## Architecture" or "" for preamble
  rawContent: string;  // Everything from this heading to the next
  index: number;       // 0-based
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

### Comment Input UX

When the user clicks `[+]` on a section:
1. A textarea appears below the section content (above existing comments)
2. Auto-focused
3. Cmd/Ctrl+Enter submits (Shift+Enter for newlines, plain Enter for newlines too — since comments can be multi-line, use Cmd/Ctrl+Enter as the submit shortcut)
4. Escape cancels
5. After submitting, the comment is POSTed to the server, and on success appears as a card

### AI Review UX

When the user clicks "AI Review":
1. Button shows a loading spinner. Other interactions remain enabled (user can keep adding human comments).
2. On success, new AI comments appear inline in their respective sections with a brief highlight animation.
3. On error (timeout, parse failure), a toast/inline error message appears. The user can retry.
4. AI comments are visually distinct (purple accent) but fully editable/deletable.

### Review Lifecycle

```
[User clicks "Review"] → draft created (or existing draft loaded)
                             │
          ┌──────────────────┼──────────────────┐
          ▼                  ▼                   ▼
   Add human comments   AI Review         Edit/delete comments
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

**Draft persistence**: Only one draft per feature at a time. If the user closes the review panel and reopens it later, the draft with its comments is still there. The draft is only deleted if the user explicitly cancels (and confirms) or sends it.

**Sent reviews are immutable**: Once a review is sent, its comments are frozen. The user can view them in the history section but not edit them. To make new comments, they start a new draft.

### Keyboard Shortcuts

- **Escape** in the review panel: closes the panel (with confirmation if draft has comments)
- **Cmd/Ctrl+Enter** in a comment textarea: submits the comment
- **Escape** in a comment textarea: cancels the input without adding a comment

## Testing

### Unit Tests — `ReviewStore` (`src/server/review-store.test.ts`)

1. **Create draft**: Creates a draft, returns it with correct fields
2. **One draft per feature**: Creating a second draft for the same feature returns the existing one
3. **Add comment**: Adds a comment with correct ID, source, section info
4. **Update comment**: Updates text, preserves other fields
5. **Delete comment**: Removes comment, other comments unaffected
6. **Mark sent**: Sets status to "sent", records sessionId and sentAt
7. **Delete draft**: Removes draft, listReviews returns empty
8. **List reviews**: Returns all reviews for a feature, newest first
9. **Persistence**: Create draft → restart store (new instance, same dir) → draft is still there
10. **Isolation**: Reviews for feature A don't appear in feature B

### Integration Tests — HTTP endpoints (`src/server/integration_tests/doc-reviews.test.ts`)

1. **Create draft**: `POST /api/features/:featureId/reviews` → 200 with draft
2. **Get draft**: `GET .../draft` → returns existing draft; 404 when none
3. **Add comment**: `POST .../comments` → 200 with new comment
4. **Add comment validation**: Empty text → 400
5. **Update comment**: `PATCH .../comments/:id` → 200
6. **Delete comment**: `DELETE .../comments/:id` → 200
7. **Send review**: `POST .../send` → 200 with assembled prompt
8. **Send review validation**: No comments → 400
9. **List reviews**: `GET .../reviews` → includes sent reviews
10. **AI review** (if feasible to test with stub Claude): `POST .../ai-review` → adds AI comments

### Component Tests — `DocReviewPanel` (`src/client/components/DocReviewPanel.test.tsx`)

1. **Renders sections**: Given markdown with 3 `## ` headings, renders 3 sections plus preamble
2. **Add comment flow**: Click `[+]` → textarea appears → type text → Cmd+Enter → comment card appears
3. **Delete comment**: Click delete → comment removed
4. **Cancel input**: Click `[+]` → type text → Escape → textarea closes, no comment added
5. **Send button disabled**: No comments → Send button is disabled
6. **Send button enabled**: Add a comment → Send button is enabled
7. **Send callback**: Click Send → `onSendComments` called
8. **AI vs human styling**: AI comments have purple accent, human comments have blue accent
9. **Edit comment**: Click edit → textarea with existing text → modify → save → updated
10. **Past reviews**: Sent reviews appear in history section

### Component Tests — `FeaturesPanel` update

1. **Review button visible**: Each feature row shows a "Review" button on hover
2. **Review button callback**: Clicking "Review" calls `onReviewFeature` with the feature

### Prompt Construction Tests (unit, in `review-store.test.ts` or `services/reviews.test.ts`)

1. `buildReviewPrompt` with comments across 3 sections → correctly grouped prompt
2. `buildReviewPrompt` with feature that has a checklist → includes checklist reference
3. `buildReviewPrompt` with mixed human/AI comments → both included (no source distinction in prompt)

## Key Files

| File | Change |
|---|---|
| `src/server/review-store.ts` | New — `ReviewStore` class, file-based JSON persistence |
| `src/server/review-store.test.ts` | New — unit tests for ReviewStore |
| `src/server/services/reviews.ts` | New — service functions for review CRUD + prompt construction |
| `src/server/api-routes.ts` | Add review HTTP endpoints |
| `src/server/index.ts` | Instantiate `ReviewStore`, inject into deps |
| `src/server/types/domain-types.ts` | Add `DocReview`, `ReviewComment`, `ReviewStatus`, `ReviewCommentSource` types |
| `src/client/components/DocReviewPanel.tsx` | New — review UI with section parsing, comment management |
| `src/client/components/DocReviewPanel.test.tsx` | New — component tests |
| `src/client/components/FeaturesPanel.tsx` | Add "Review" button, `onReviewFeature` prop |
| `src/client/App.tsx` | Add review state, callbacks, render `DocReviewPanel` |
| `src/server/integration_tests/doc-reviews.test.ts` | New — HTTP endpoint integration tests |

## Scope & Non-Goals

**In scope**:
- Section-anchored comments on `plan.md` files (human and AI)
- Server-side persistence via `ReviewStore`
- HTTP CRUD endpoints for reviews and comments
- AI review via one-shot Claude CLI invocation
- Review history (view past sent reviews)
- Send → new session workflow

**Not in scope (future work)**:
- Comments on `checklist.md` files (same pattern, easy to add later)
- Comments on arbitrary markdown files (only feature `plan.md` for now)
- Collaborative review (multiple users commenting simultaneously)
- Comment resolution tracking (marking individual comments as "addressed" after the session runs)
- Streaming AI review (currently blocks until complete; could add SSE/WS streaming later)
- Review diffs (comparing what changed between the doc version reviewed and the current version)

## Complexity

Medium. The server-side work (ReviewStore + HTTP endpoints + service layer) follows well-established patterns in the codebase. The AI review flow adds moderate complexity due to Claude CLI invocation and response parsing. The client-side DocReviewPanel is the bulk of the new UI work (~300-400 lines). Total estimate: ~800-1200 lines of new code across server and client.
