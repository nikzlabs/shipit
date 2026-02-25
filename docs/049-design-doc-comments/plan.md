---
status: planned
---
# 049 — Design Doc Review Comments

## Summary

Let users leave inline review comments on design docs (`plan.md` files), then press "Send" to spawn a new session that addresses the comments. This enables a human-in-the-loop review workflow: read a plan, annotate the parts that need changes, and hand off to Claude in a single action.

## Motivation

The Features panel already has a "Start Session" button that tells Claude to "work on feature X." But that's a blank-slate instruction — it doesn't communicate *what specifically* the user wants changed. Today, if a user reads a `plan.md` and disagrees with the caching strategy in section 3, they have to manually type out the context ("in the plan at docs/012-.../plan.md, section 3 says X but I want Y"). This is tedious and error-prone.

A structured review-and-send flow solves this:

1. **Read** — user opens the design doc in the app (already possible via the Docs tab).
2. **Annotate** — user adds comments anchored to specific sections of the doc.
3. **Send** — one click creates a new session with a structured prompt containing the full doc context and all comments, so Claude knows exactly what to address.

This mirrors the code diff review flow (`diff_comment`) but applied to design docs instead of code changes.

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
│  Review: Deployment (plan.md)                          [Close]  │
│─────────────────────────────────────────────────────────────────│
│                                                                 │
│  ## Summary                                              [+]    │
│  Add deployment support for Vercel and Cloudflare...            │
│                                                                 │
│  ## Architecture                                         [+]    │
│  The deployment system uses a plugin-based approach...          │
│                                                                 │
│    ┌─ Comment ──────────────────────────────────────────┐       │
│    │ This should also support Netlify from day one.     │       │
│    │ Netlify is our most-requested target.        [Del] │       │
│    └────────────────────────────────────────────────────┘       │
│                                                                 │
│  ## Config Fields                                        [+]    │
│  Each target declares its config fields...                      │
│                                                                 │
│    ┌─ Comment ──────────────────────────────────────────┐       │
│    │ Add validation for required vs optional fields.    │       │
│    │ Currently there's no way to mark a field as    ... │       │
│    │                                             [Del]  │       │
│    └────────────────────────────────────────────────────┘       │
│                                                                 │
│  ## Testing                                              [+]    │
│  ...                                                            │
│                                                                 │
│─────────────────────────────────────────────────────────────────│
│  2 comments                    [Cancel]  [Send Comments ▶]      │
└─────────────────────────────────────────────────────────────────┘
```

1. **Entry point**: A "Review" button on each feature row in `FeaturesPanel`. Clicking it opens a review view for that feature's `plan.md`.
2. **Section-anchored comments**: The rendered markdown is split by top-level headings (`## ...`). Each section has a `[+]` button in the right gutter. Clicking it inserts a comment input below that section. Users type their feedback and press Enter (or click a confirm button) to attach the comment.
3. **Comment management**: Comments appear inline below their section. Each comment has a delete button. Users can add multiple comments per section.
4. **Send**: The footer shows the comment count and a "Send Comments" button. Clicking it:
   - Creates a new session (same repo context as the current session)
   - Constructs a structured prompt with the doc path, section headings, and all comments
   - Sends the prompt to Claude
   - Navigates the user to the new session's chat

### Comment Data Model

Comments are transient (in-memory only). They exist from the moment the user opens the review view until they either send or cancel. No persistence needed — this is a one-shot review workflow, not a long-lived annotation system.

```typescript
// src/client/components/DocReviewPanel.tsx — local state

interface DocReviewComment {
  id: string;              // crypto.randomUUID()
  sectionHeading: string;  // "## Architecture" — the heading this comment is anchored to
  sectionIndex: number;    // 0-based index of the section in the doc
  text: string;            // The user's comment text
}
```

### Prompt Construction

When the user clicks "Send Comments," the client constructs a prompt and sends it through the existing session-creation flow. The prompt format:

```
I've reviewed the design doc at {planPath} and have the following feedback:

## Section: {sectionHeading1}

- {comment1 text}
- {comment2 text}

## Section: {sectionHeading2}

- {comment3 text}

Please read the design doc, address each comment by updating the plan, and explain what you changed.
```

If the feature also has a `checklist.md`, append:
```
Also check {checklistPath} for any related items that need updating.
```

This is similar to how `diff_comment` formats inline code comments into a structured prompt, but scoped to doc sections rather than file lines.

### Session Creation

The session-creation flow reuses the existing `handleFeatureStartSession` pattern in `App.tsx`:

1. Reset session state (`setSessionId(undefined)`, `resetSessionState()`)
2. Send `new_session` over WebSocket
3. Construct the review prompt from the collected comments
4. Send `send_message` with the prompt
5. Switch to chat panel

This keeps the feature entirely client-side — no new server endpoints or WebSocket message types needed. The server already handles `new_session` + `send_message` which is all we need.

## Architecture

### Client-Side Components

#### `DocReviewPanel` (new component)

**File**: `src/client/components/DocReviewPanel.tsx`

The main review UI. Receives the feature info and doc content, renders sections with comment affordances.

**Props**:
```typescript
interface DocReviewPanelProps {
  feature: FeatureInfo;
  content: string;                // Raw markdown content of plan.md
  onSendComments: (feature: FeatureInfo, comments: DocReviewComment[]) => void;
  onClose: () => void;
}
```

**Internal state**:
- `comments: DocReviewComment[]` — the accumulated comments
- `activeInput: number | null` — which section's comment input is currently open

**Section parsing**: Split the markdown content by `## ` headings. Each section is rendered as:
1. The heading (rendered as HTML via `marked`)
2. The body text (rendered as HTML via `marked`)
3. Any attached comments (rendered as styled cards)
4. A `[+]` button to add a new comment

#### `DocReviewSection` (new component)

**File**: `src/client/components/DocReviewPanel.tsx` (same file, not exported)

Renders a single section: heading, body, comments, add-comment button, and comment input.

#### Integration into `FeaturesPanel`

Add a "Review" button to each `FeatureRow`. The button is shown alongside the existing "Start Session" button. Both appear on hover.

#### Integration into `App.tsx`

**New state**:
```typescript
const [reviewFeature, setReviewFeature] = useState<FeatureInfo | null>(null);
const [reviewContent, setReviewContent] = useState<string | null>(null);
```

**New callback**: `handleFeatureReview(feature: FeatureInfo)`:
1. Fetch the doc content via `GET /api/sessions/:id/docs/{planPath}`
2. Set `reviewFeature` and `reviewContent`
3. Render `DocReviewPanel` in the right panel (replacing the current tab content)

**New callback**: `handleSendReviewComments(feature: FeatureInfo, comments: DocReviewComment[])`:
1. Build the review prompt from comments
2. Follow the same flow as `handleFeatureStartSession` but with the review prompt
3. Clear the review state (`setReviewFeature(null)`)

### Server-Side

**No new server endpoints needed.** The feature composes existing capabilities:

- Doc content: `GET /api/sessions/:id/docs/*` (already exists)
- Session creation: `new_session` WebSocket message (already exists)
- Sending prompt: `send_message` WebSocket message (already exists)

This is a pure client-side feature that orchestrates existing server APIs.

## Detailed Design

### Section Parsing

Parse markdown into sections by splitting on level-2 headings (`## `). Content before the first `## ` heading is treated as section 0 (the preamble, which often contains the `# Title` and intro text).

```typescript
interface MarkdownSection {
  heading: string;     // "## Architecture" or "" for preamble
  rawContent: string;  // Everything from this heading to the next
  index: number;       // 0-based
}

function parseMarkdownSections(content: string): MarkdownSection[] {
  // Split on lines that start with "## "
  // Keep the heading with its section
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
1. A textarea appears below the section content (above existing comments for that section)
2. Auto-focused
3. Enter submits the comment (Shift+Enter for newlines)
4. Escape cancels
5. After submitting, the textarea closes and the comment appears as a card

Comment cards show the comment text with a delete (X) button. Clicking delete removes the comment with no confirmation (it's easy to re-add).

### Prompt Assembly

```typescript
function buildReviewPrompt(feature: FeatureInfo, comments: DocReviewComment[]): string {
  const grouped = new Map<string, DocReviewComment[]>();
  for (const comment of comments) {
    const key = comment.sectionHeading || "(Introduction)";
    if (!grouped.has(key)) grouped.set(key, []);
    grouped.get(key)!.push(comment);
  }

  let prompt = `I've reviewed the design doc at ${feature.planPath} and have the following feedback:\n\n`;

  for (const [heading, sectionComments] of grouped) {
    prompt += `### ${heading}\n\n`;
    for (const c of sectionComments) {
      prompt += `- ${c.text}\n`;
    }
    prompt += "\n";
  }

  prompt += "Please read the design doc, address each piece of feedback by updating the plan, and explain what you changed.";

  if (feature.checklistPath) {
    prompt += `\n\nAlso review ${feature.checklistPath} for any related items that need updating.`;
  }

  return prompt;
}
```

### Visual Design

The review panel replaces the right panel content (same slot as Preview, Docs, Files, etc.). It uses the same layout conventions:

- **Header bar**: Feature name, doc path, close button. Same style as DocsViewer header.
- **Content area**: Scrollable. Rendered markdown sections with comment gutter.
- **Footer bar**: Comment count, Cancel and Send buttons. Send button is primary (blue), disabled when no comments exist.

**Comment cards**: Light background (`bg-blue-50 dark:bg-blue-950`), left border accent (`border-l-2 border-blue-400`), small text. Delete button appears on hover.

**Add-comment button** (`[+]`): Small, appears in the right margin of each section heading. On hover, shows tooltip "Add comment."

### Keyboard Shortcuts

- **Escape** in the review panel: closes the panel (with confirmation if there are unsaved comments)
- **Cmd/Ctrl+Enter** in a comment textarea: submits the comment
- **Escape** in a comment textarea: cancels the input without adding a comment

## Testing

### Component Tests (`src/client/components/DocReviewPanel.test.tsx`)

1. **Renders sections**: Given markdown with 3 `## ` headings, renders 3 sections plus preamble
2. **Add comment flow**: Click `[+]` → textarea appears → type text → Enter → comment card appears
3. **Delete comment**: Click delete on a comment card → comment removed
4. **Cancel input**: Click `[+]` → type text → Escape → textarea closes, no comment added
5. **Send button disabled**: No comments → Send button is disabled
6. **Send button enabled**: Add a comment → Send button is enabled
7. **Send callback**: Add comments → click Send → `onSendComments` called with correct comment data
8. **Close callback**: Click close → `onClose` called
9. **Multiple comments per section**: Add 2 comments to same section → both appear
10. **Empty section handling**: Section with no content still shows `[+]` button

### FeaturesPanel Update Tests

1. **Review button visible**: Each feature row shows a "Review" button on hover
2. **Review button callback**: Clicking "Review" calls `onReviewFeature` with the feature

### Integration Tests

No new server-side integration tests needed — this feature composes existing endpoints. The session-creation flow is already covered by existing `send_message` and `new_session` tests.

Optionally, add an E2E-style test that verifies the prompt construction logic (unit test in the component test file):
1. `buildReviewPrompt` with 0 comments → throws or returns empty (edge case)
2. `buildReviewPrompt` with comments across 3 sections → correctly grouped prompt
3. `buildReviewPrompt` with feature that has a checklist → includes checklist reference

## Key Files

| File | Change |
|---|---|
| `src/client/components/DocReviewPanel.tsx` | New component — review UI with section parsing, comment management, prompt construction |
| `src/client/components/DocReviewPanel.test.tsx` | Component tests |
| `src/client/components/FeaturesPanel.tsx` | Add "Review" button to `FeatureRow`, new `onReviewFeature` prop |
| `src/client/components/FeaturesPanel.test.tsx` | Update tests for new button |
| `src/client/App.tsx` | Add review state, `handleFeatureReview` and `handleSendReviewComments` callbacks, render `DocReviewPanel` |

## Scope & Non-Goals

**In scope**:
- Section-anchored comments on `plan.md` files
- One-shot send → new session workflow
- Transient comments (no persistence)

**Not in scope (future work)**:
- Persistent comment threads (save comments, come back later)
- Comments on arbitrary markdown files (only feature `plan.md` for now)
- Comments on `checklist.md` files (can be added later with same pattern)
- Collaborative review (multiple users commenting simultaneously)
- Comment resolution tracking (marking comments as "addressed")
- Line-level commenting within a section (too granular for design docs)

## Complexity

Low-medium. This is a client-only feature that composes existing server APIs. The main work is the `DocReviewPanel` component (~200-300 lines) and wiring it into `App.tsx` and `FeaturesPanel`. No new server code, no new WebSocket messages, no new HTTP endpoints.
