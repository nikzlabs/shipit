# Phase 8: High-Impact Features — Design Document

## Overview

Phases 1–7 delivered a complete vibe coding IDE: chat-driven development, live preview, git undo, session persistence, file browsing, terminal logs, templates, and a polished streaming UX. The app works end-to-end.

Phase 8 targets features that unlock **entirely new workflows** — not polish, but capabilities that fundamentally change what users can do with ShipIt. Each feature was selected for its ratio of user impact to implementation complexity.

---

## Feature 1: Image & Screenshot Input (Multimodal Chat)

### Why This Matters

The single most requested vibe coding workflow is: *"Make it look like this"* with a screenshot. Currently, users must describe visual designs in words. Claude Code CLI already supports image inputs — ShipIt just doesn't expose them to the browser.

This is the highest-impact feature because it enables the core promise of vibe coding: show, don't tell.

### User Stories

1. User drags a Figma screenshot into the chat → Claude builds the UI to match
2. User pastes a photo of a hand-drawn wireframe → Claude scaffolds the layout
3. User screenshots a bug in the preview → sends it to Claude with "fix this"
4. User pastes a competitor's website screenshot → "Build something like this"

### Design

#### UI Changes

**MessageInput enhancements:**
- Add a paperclip/image button next to the send button
- Support drag-and-drop onto the chat input area (full left panel acts as drop zone)
- Support Ctrl+V / Cmd+V paste of clipboard images
- Show image thumbnails inline in the input area before sending, with an × to remove
- Multiple images per message (up to 5)
- Accepted formats: PNG, JPEG, GIF, WebP (same as Claude's vision support)
- Max size: 5 MB per image (reject larger with a toast message)

**MessageList enhancements:**
- User messages with images render thumbnails inline (clickable to expand)
- Lightbox overlay for full-size image viewing

**Drop zone UX:**
- When dragging a file over the chat panel, show a blue overlay border with "Drop image here"
- Only accept image MIME types — ignore non-image files with a brief toast

#### Protocol Changes

New WebSocket message type:

```typescript
// Client → Server
interface WsSendMessage {
  type: "send_message";
  text: string;
  sessionId?: string;
  images?: Array<{
    data: string;      // base64-encoded image data
    mediaType: string; // "image/png", "image/jpeg", etc.
    filename?: string; // optional original filename
  }>;
}
```

The `images` field is optional and backward-compatible. When present, the server writes each image to a temp file in the workspace and passes the file paths to the Claude CLI via the prompt or stdin.

#### Server Changes

**`index.ts` — `send_message` handler:**
1. Validate each image: check base64 is valid, mediaType is allowed, size ≤ 5 MB decoded
2. Write images to `/workspace/.vibe-images/{sessionId}/{timestamp}-{index}.{ext}`
3. Construct the Claude CLI invocation with image references

**`claude.ts` — image support:**

Claude Code CLI supports images via stdin when using `--input-format stream-json`. The server sends a user message with image content blocks:

```json
{
  "type": "user",
  "message": {
    "content": [
      { "type": "image", "source": { "type": "base64", "media_type": "image/png", "data": "..." } },
      { "type": "text", "text": "Make it look like this" }
    ]
  }
}
```

Alternatively, if using `-p` mode, images can be referenced via file path in the prompt. The implementation should prefer whichever approach the CLI version supports.

**Validation:**
- Image count: max 5 per message
- Image size: max 5 MB per image (base64 decoded)
- MIME type whitelist: `image/png`, `image/jpeg`, `image/gif`, `image/webp`
- Total payload: max 20 MB per WebSocket message (reject with `{ type: "error" }`)

#### Chat History Persistence

Extend `WsChatHistoryMessage`:

```typescript
interface WsChatHistoryMessage {
  role: "user" | "assistant";
  text: string;
  toolUse?: Array<ToolUseBlock>;
  images?: Array<{
    path: string;       // server-side path to saved image
    mediaType: string;
  }>;
  isError?: boolean;
}
```

Images are saved to disk alongside chat history. On history reload, the client requests images via a new `get_image` message (or the server inlines base64 for small images).

#### Testing

- **Unit:** Validate image payload (size, type, count limits) in `index.ts` tests
- **Integration:** Send a `send_message` with `images`, verify the Claude process receives the image data, verify error on invalid MIME type / oversized payload
- **Component:** `MessageInput.test.tsx` — drag-and-drop, paste, thumbnail rendering, remove button; `MessageList.test.tsx` — image display in user messages

#### Open Questions

- Should we support uploading non-image files (PDFs, code files) as attachments? Claude supports PDFs. Could be a follow-up.
- Image compression: should we resize images client-side before upload to reduce payload? Probably yes for images > 2000px on either dimension.

---

## Feature 2: Preview Error Capture & Auto-Debug Loop

### Why This Matters

The biggest friction point in vibe coding today: the preview breaks, the user sees a white screen or a console error, and they have to manually open devtools, copy the error, and paste it into chat. This breaks the flow completely.

Capturing preview errors automatically and surfacing them in the chat — or even auto-sending them to Claude — closes the debug loop and makes ShipIt feel like a real development environment, not just a chat window next to an iframe.

### User Stories

1. Claude writes code that throws a runtime error → error appears in ShipIt's terminal/chat → user clicks "Send to Claude" → Claude fixes it
2. Preview shows a blank page → ShipIt detects no rendering and surfaces the console errors → user sends them with one click
3. Continuous auto-fix mode: errors are automatically sent to Claude, who fixes them in a loop until the preview works (with a safety limit)

### Design

#### Architecture

The key challenge: the preview iframe runs on a different port (5173 for Vite, or an auto-detected port). Same-origin policy prevents direct console capture. Solution: **inject a tiny error-reporting script** into the preview.

**Approach: Vite Plugin (for managed Vite previews)**

Create a Vite plugin that injects a small `<script>` into the HTML that:
1. Listens for `window.onerror` and `window.onunhandledrejection`
2. Overrides `console.error` and `console.warn`
3. Sends captured errors to the parent window via `window.parent.postMessage()`

```javascript
// Injected into preview (< 1KB)
(function() {
  const send = (type, data) =>
    window.parent.postMessage({ source: 'shipit-preview', type, ...data }, '*');

  window.onerror = (msg, src, line, col, err) => {
    send('error', { message: msg, source: src, line, col, stack: err?.stack });
    return false; // don't suppress
  };

  window.addEventListener('unhandledrejection', (e) => {
    send('error', { message: String(e.reason), stack: e.reason?.stack });
  });

  const origError = console.error;
  console.error = (...args) => {
    send('console', { level: 'error', args: args.map(String) });
    origError.apply(console, args);
  };

  const origWarn = console.warn;
  console.warn = (...args) => {
    send('console', { level: 'warn', args: args.map(String) });
    origWarn.apply(console, args);
  };
})();
```

**Approach: Proxy mode (for non-Vite auto-detected servers)**

For non-Vite servers (detected via port scanning), ShipIt's Fastify server acts as a reverse proxy for the preview port, injecting the error-capture script into HTML responses. This works for any HTTP server without modification.

#### Client Changes

**New: `usePreviewErrors` hook**

```typescript
interface PreviewError {
  id: string;
  type: 'error' | 'console';
  level?: 'error' | 'warn';
  message: string;
  source?: string;
  line?: number;
  col?: number;
  stack?: string;
  timestamp: string;
}

function usePreviewErrors(): {
  errors: PreviewError[];
  clearErrors: () => void;
  hasErrors: boolean;
}
```

Listens for `message` events on `window`, filters by `source === 'shipit-preview'`, deduplicates rapid-fire errors, maintains a rolling buffer.

**PreviewFrame enhancements:**
- Red error badge on the Preview tab when errors exist (similar to terminal's unread badge)
- Expandable error panel at the bottom of the preview: list of errors with stack traces
- "Send to Claude" button on each error (or "Send all errors") — composes a message like:

```
The preview is showing these errors:

1. TypeError: Cannot read properties of undefined (reading 'map')
   at App.tsx:42:15

Please fix these errors.
```

- "Auto-fix" toggle: when enabled, new errors are automatically sent to Claude (with debounce and a max retry count of 3 to prevent infinite loops)

**TerminalPanel integration:**
- Preview console errors also appear in the Terminal tab with a new source: `"preview"`
- Color-coded: preview errors in orange (distinct from stderr red)

#### Server Changes

Minimal. The error capture is entirely client-side (preview → parent window postMessage → React state). The only server change is:

- `ViteManager`: add a Vite plugin that injects the error-capture snippet into `index.html`
- Optional: new proxy route for non-Vite previews (`/preview-proxy/:port/*`)

#### Protocol Changes

New log source for terminal integration:

```typescript
// Preview errors forwarded to terminal
interface WsLogEntry {
  type: "log_entry";
  source: "stderr" | "stdout" | "server" | "preview";  // add "preview"
  text: string;
  timestamp: string;
}
```

The client sends preview errors to the server via a new message type so they appear in all connected clients' terminals:

```typescript
// Client → Server
interface WsPreviewError {
  type: "preview_error";
  message: string;
  stack?: string;
  source?: string;
  line?: number;
}
```

#### Testing

- **Unit:** `usePreviewErrors` hook test with fake `postMessage` events, deduplication, buffer limits
- **Component:** PreviewFrame error badge, error panel expand/collapse, "Send to Claude" button wiring
- **Integration:** Verify `preview_error` messages are relayed to terminal log buffer

#### Auto-Fix Loop Safety

The auto-fix feature needs strict guardrails:
- **Max retries:** 3 consecutive auto-fix attempts per unique error signature
- **Cooldown:** 5 seconds between auto-fix sends (debounce)
- **Kill switch:** any user message cancels auto-fix mode
- **Visual indicator:** pulsing orange border on preview when auto-fix is active, with a "Stop" button

---

## Feature 3: Conversation Branching & Checkpoints

### Why This Matters

The documented issue in `ISSUES.md` #1: when a user edits a message, the UI truncates but Claude retains full history. This creates confusion ("as I mentioned earlier" referencing invisible messages). It's the most fundamental UX problem in the app.

Conversation branching solves this by giving users real checkpoint/branch semantics that align UI state with Claude's context. It also enables exploration: try an approach, branch back, try another — without losing either path.

### User Stories

1. User is halfway through building a feature → wants to try a different approach → creates a checkpoint → explores → doesn't like it → branches back to the checkpoint
2. User edits a message → ShipIt automatically creates a branch from that point → new CLI session with conversation replayed to that point → clean context
3. User views branch history → can switch between branches → each branch has its own git state and conversation

### Design

#### Core Concept: Checkpoints

A **checkpoint** is a snapshot of:
- The conversation messages (up to that point)
- The git commit hash at that point
- The Claude CLI session ID

Branching from a checkpoint means:
1. Rolling back git to the checkpoint's commit
2. Starting a new Claude CLI session
3. Replaying the conversation prefix as system context for the new session
4. Continuing from the checkpoint with a clean slate

#### Data Model

```typescript
interface Checkpoint {
  id: string;                    // UUID
  sessionId: string;             // Claude CLI session that created this
  messageIndex: number;          // index in the conversation
  commitHash: string;            // git state at this point
  createdAt: string;
  label?: string;                // optional user-provided label
}

interface Branch {
  id: string;                    // UUID
  parentCheckpointId?: string;   // null for the initial branch
  sessionId: string;             // Claude CLI session for this branch
  name: string;                  // "main", "Branch 1", etc.
  checkpoints: Checkpoint[];
  isActive: boolean;
}
```

#### Protocol Changes

```typescript
// Client → Server
interface WsCreateCheckpoint {
  type: "create_checkpoint";
  label?: string;
}

interface WsBranchFromCheckpoint {
  type: "branch_from_checkpoint";
  checkpointId: string;
}

interface WsSwitchBranch {
  type: "switch_branch";
  branchId: string;
}

interface WsListBranches {
  type: "list_branches";
}

// Server → Client
interface WsCheckpointCreated {
  type: "checkpoint_created";
  checkpoint: Checkpoint;
}

interface WsBranchList {
  type: "branch_list";
  branches: Branch[];
  activeBranchId: string;
}

interface WsBranchSwitched {
  type: "branch_switched";
  branchId: string;
  messages: WsChatHistoryMessage[];  // conversation for this branch
}
```

#### Server Changes

**New: `BranchManager` class (`src/server/branches.ts`)**

Persists branch/checkpoint state to `/workspace/.vibe-branches/`.

Key methods:
- `createCheckpoint(sessionId, messageIndex, commitHash, label?)` — snapshot the current state
- `branchFrom(checkpointId)` — create a new branch from a checkpoint
- `switchBranch(branchId)` — switch active branch (returns conversation + commit hash)
- `listBranches()` — return all branches with their checkpoints

**`index.ts` changes:**

- `create_checkpoint` handler: saves checkpoint with current git HEAD and message index
- `branch_from_checkpoint` handler: git rollback to checkpoint commit, start new CLI session, replay conversation prefix as system prompt
- `switch_branch` handler: git checkout to branch's latest commit, load branch's conversation, update active branch
- Auto-checkpoint: automatically create a checkpoint before each edit/retry

**Conversation replay for new branches:**

When branching from a checkpoint at message index N, the server constructs a system prompt containing the conversation up to message N:

```
You are continuing a conversation. Here is the conversation so far:

User: [message 0]
Assistant: [message 1]
...
User: [message N-1]

Continue from here. The user's next message follows.
```

This gives Claude the context without the `--resume` session's hidden history problem.

#### UI Changes

**BranchIndicator component (header area):**
- Shows current branch name next to the session selector
- Dropdown to switch branches
- "Create checkpoint" button (bookmark icon)

**Timeline view (in GitHistory area):**
- Visual branch timeline showing checkpoints as nodes
- Click a checkpoint to branch from it
- Color-coded branches

**Message-level integration:**
- Checkpoints appear as subtle dividers in the chat: "Checkpoint: before refactor"
- The edit/retry action auto-creates a checkpoint before branching

#### Complexity & Phasing

This is the most complex feature. Recommended sub-phases:

1. **8a: Manual checkpoints** — create/list checkpoints, no branching yet (just bookmarks for git rollback)
2. **8b: Branch from checkpoint** — full branching with conversation replay and new CLI sessions
3. **8c: Branch switching** — switch between branches, git checkout, conversation swap

#### Testing

- **Unit:** `BranchManager` — create, list, switch, persistence, edge cases
- **Integration:** Full branch workflow: send messages → checkpoint → branch → verify new session gets conversation prefix → verify git state matches
- **Component:** BranchIndicator dropdown, checkpoint dividers, timeline view

---

## Feature 4: Cost & Duration Dashboard

### Why This Matters

The type system already has `total_cost_usd` and `duration_ms` in `ClaudeResultEvent`. This data flows through the system but is never shown to the user. For users on metered plans (Claude Pro/Max), understanding per-turn and cumulative costs is essential. This is also the lowest-effort, highest-certainty feature in this document.

### Design

#### Per-Turn Display

After each Claude response, show a subtle footer below the assistant message:

```
┌──────────────────────────────────────────────┐
│  Claude's response text...                   │
│                                              │
│  ─────────────────────────────────────────── │
│  ⏱ 12.3s  ·  $0.04                          │
└──────────────────────────────────────────────┘
```

- Duration: formatted as seconds (e.g., "12.3s") or "2m 15s" for longer turns
- Cost: formatted as dollars (e.g., "$0.04") — hidden if `total_cost_usd` is 0 or undefined (some subscriptions don't report cost)
- Styling: `text-xs text-gray-500` — subtle, not distracting

#### Session Summary

In the header or a new "Stats" section of the session selector:

```
Session: "Build a dashboard"
Messages: 14 (7 turns)
Total cost: $0.87
Total time: 4m 32s
```

#### Data Flow

**State changes in `App.tsx`:**

```typescript
interface TurnStats {
  costUsd?: number;
  durationMs?: number;
}

// Per-message stats (keyed by message index)
const [turnStats, setTurnStats] = useState<Map<number, TurnStats>>(new Map());

// Session totals
const [sessionCostUsd, setSessionCostUsd] = useState(0);
const [sessionDurationMs, setSessionDurationMs] = useState(0);
```

On `result` event:
1. Extract `total_cost_usd` and `duration_ms` from the event
2. Associate with the current assistant message index
3. Accumulate into session totals

**Chat history persistence:**

Extend `WsChatHistoryMessage` with optional `costUsd` and `durationMs` fields so stats survive page reloads.

#### UI Components

**`TurnStats` component** (in `MessageList.tsx`):
- Renders below assistant messages that have associated stats
- Conditionally shows cost (only if > 0) and duration
- Collapsed by default, expandable for token-level breakdown (if available)

**Session stats** (in `SessionSelector.tsx` or header):
- Total cost and duration for the current session
- Shown as a small `$0.87 · 4m 32s` label

#### Testing

- **Component:** `TurnStats` renders cost/duration, hides when zero/undefined, formats correctly
- **Integration:** Verify `result` event data flows to client and is displayed
- **Persistence:** Verify stats survive page reload via chat history

---

## Feature 5: Inline File Editing

### Why This Matters

"Pure vibe coding" — the philosophy that users never edit code directly — sounds clean in theory. In practice, users regularly want to make trivial changes: tweak a color value, fix a typo, adjust a margin. Asking Claude to do these takes 10-30 seconds. Typing it directly takes 2 seconds.

Adding a minimal inline editor doesn't compromise the vibe coding model — it *complements* it. The user can make quick tweaks and then return to conversational development. The editor still auto-commits, maintaining the git-as-undo guarantee.

### User Stories

1. User sees `color: blue` in the file viewer → clicks to edit → changes to `color: red` → saves → preview updates via HMR
2. User notices a typo in a string → edits it directly instead of asking Claude
3. User makes a manual edit → git auto-commits → the change appears in git history like any other change

### Design

#### Approach: CodeMirror 6 in FileContentViewer

Replace the read-only `<pre><code>` in `FileContentViewer` with a CodeMirror 6 editor instance. CodeMirror 6 is:
- Small (tree-shakeable, ~50KB gzipped for basic setup)
- Fast (handles large files well)
- Extensible (syntax highlighting, keymaps, themes)
- The standard for browser-based code editors

#### UI Changes

**FileContentViewer → FileEditor:**
- Toggle between read-only and edit mode (pencil icon in the header bar)
- Edit mode: CodeMirror 6 with the file's language mode
- Save: Ctrl+S / Cmd+S sends the modified content to the server
- Unsaved indicator: dot on the tab or filename when modified
- Auto-save on tab switch or file switch (with confirmation if unsaved changes exist)
- Discard: Escape or "Discard" button reverts to the last saved version

#### Protocol Changes

```typescript
// Client → Server
interface WsSaveFile {
  type: "save_file";
  path: string;
  content: string;
}

// Server → Client
interface WsFileSaved {
  type: "file_saved";
  path: string;
  commitHash: string;  // auto-committed
}
```

#### Server Changes

**`index.ts` — `save_file` handler:**
1. Validate path (same traversal guard as `get_file_content`)
2. Write the file content to disk
3. Auto-commit via `GitManager.autoCommit("Manual edit: {filename}")`
4. Broadcast `file_saved` to all clients
5. Trigger preview refresh if Vite is running (HMR handles this automatically)

**Validation:**
- Path must be within `/workspace`
- Content must be a string (not binary)
- File must already exist (no creating new files via the editor — that's Claude's job)
- Max file size: 1 MB (same as viewer limit)

#### Dependencies

New dependency: `codemirror` and language packages.

```json
{
  "codemirror": "^6.0.0",
  "@codemirror/lang-javascript": "^6.0.0",
  "@codemirror/lang-html": "^6.0.0",
  "@codemirror/lang-css": "^6.0.0",
  "@codemirror/lang-json": "^6.0.0",
  "@codemirror/lang-python": "^6.0.0",
  "@codemirror/lang-markdown": "^6.0.0",
  "@codemirror/theme-one-dark": "^6.0.0"
}
```

Bundle impact: ~80KB gzipped (acceptable for the value delivered).

#### Complexity Considerations

- **Conflict with Claude:** If Claude edits a file while the user has unsaved changes in the editor, the user's changes would be overwritten. Solution: when a `git_committed` event arrives and the user has unsaved changes to the same file, show a conflict dialog: "Claude modified this file. Keep your changes or load Claude's version?"
- **New file creation:** Intentionally excluded. Creating files is Claude's domain. The editor only modifies existing files.
- **Directory creation:** Not supported. The editor is file-level only.

#### Testing

- **Component:** FileEditor renders CodeMirror, Ctrl+S triggers save, unsaved indicator, mode toggle
- **Integration:** `save_file` writes to disk, auto-commits, returns `file_saved` with commit hash; path traversal rejected
- **Conflict:** Verify conflict dialog when Claude and user edit the same file

---

## Feature 6: System Prompt & Project Context

### Why This Matters

Currently, there's no way to give Claude persistent instructions that apply to every turn. Users working on a specific project often need to say things like "always use Tailwind for styling" or "follow the existing code conventions" repeatedly. A configurable system prompt — or automatic context injection from workspace files — solves this.

### User Stories

1. User creates a `.shipit/context.md` in the workspace → Claude automatically reads it at the start of every turn
2. User opens a settings panel → types "Always use TypeScript strict mode and Tailwind CSS" → this is prepended to every prompt
3. User's project has a `CLAUDE.md` → ShipIt detects it and auto-includes it (like Claude Code does natively)

### Design

#### Approach: Workspace Context File

Claude Code CLI already reads `CLAUDE.md` files automatically. ShipIt should:

1. **Auto-detect `CLAUDE.md`**: If a `CLAUDE.md` exists in `/workspace`, show it in a dedicated "Context" section in the Docs tab, with an edit button
2. **Create from UI**: A "Project Context" button that creates/edits `/workspace/CLAUDE.md`
3. **ShipIt-specific context**: A `.shipit/system-prompt.txt` file that ShipIt prepends to every message sent to Claude (for ShipIt-specific instructions that shouldn't be in CLAUDE.md)

#### UI Changes

**Settings/Context panel:**
- Accessible from the header (gear icon) or as a sub-tab in Docs
- Shows the current system prompt (editable inline)
- Shows `CLAUDE.md` status (exists/doesn't exist, last modified)
- "Edit CLAUDE.md" button → opens in the file editor (Feature 5) or inline textarea
- Template suggestions: common context snippets users can add with one click

**Context indicator:**
- Small icon in the header when a system prompt or CLAUDE.md is active
- Tooltip shows a preview of the context

#### Protocol Changes

```typescript
// Client → Server
interface WsGetSystemPrompt {
  type: "get_system_prompt";
}

interface WsSaveSystemPrompt {
  type: "save_system_prompt";
  content: string;
}

// Server → Client
interface WsSystemPrompt {
  type: "system_prompt";
  content: string;          // current system prompt text
  hasClaudeMd: boolean;     // whether /workspace/CLAUDE.md exists
}
```

#### Server Changes

**`index.ts` — system prompt injection:**

When handling `send_message`, if `/workspace/.shipit/system-prompt.txt` exists, prepend its contents to the prompt:

```typescript
const systemPrompt = readSystemPrompt(workspaceDir);
const fullPrompt = systemPrompt
  ? `${systemPrompt}\n\n---\n\nUser request: ${text}`
  : text;
```

Note: `CLAUDE.md` is handled natively by Claude Code CLI and doesn't need server-side injection. The `.shipit/system-prompt.txt` is for ShipIt-specific context.

**`save_system_prompt` handler:**
1. Write to `/workspace/.shipit/system-prompt.txt`
2. Auto-commit
3. Respond with `system_prompt` message

#### Testing

- **Integration:** Verify system prompt is prepended to Claude CLI input
- **Integration:** Verify `save_system_prompt` writes file and returns content
- **Component:** Context panel renders, edit saves, indicator shows when active

---

## Implementation Priority

| # | Feature | Impact | Effort | Priority |
|---|---------|--------|--------|----------|
| 4 | Cost & duration dashboard | High | Low | **P0 — Do first** |
| 1 | Image & screenshot input | Very High | Medium | **P0 — Do second** |
| 2 | Preview error capture | Very High | Medium | **P1** |
| 6 | System prompt & context | Medium | Low | **P1** |
| 5 | Inline file editing | High | Medium-High | **P2** |
| 3 | Conversation branching | Very High | High | **P2** |

### Rationale

- **Cost/duration** is P0 because it's nearly zero effort (types already exist) and universally needed.
- **Image input** is P0 because it's the single biggest gap in the vibe coding workflow and Claude already supports it.
- **Preview error capture** is P1 because it closes the debug loop — the second biggest friction point.
- **System prompt** is P1 because it's low effort and significantly improves output quality.
- **File editing** is P2 because it requires a new dependency (CodeMirror) and careful conflict handling.
- **Branching** is P2 because it's the most complex feature (new data model, CLI session management, git branch coordination) but solves a real pain point.

### Dependency Graph

```
Cost/Duration ──────────────────────────────────────┐
                                                     │
Image Input ────────────────────────────────────────┤
                                                     │
Preview Error Capture ──┬── Auto-Fix Loop            ├── Phase 8
                        │   (requires error capture) │
System Prompt ──────────┤                            │
                        │                            │
File Editing ───────────┤── Conflict Resolution      │
                        │   (requires file editing)  │
Branching ──────────────┴── Branch Switching          │
                            (requires checkpoints)   ┘
```

Features within the same priority tier can be parallelized. Features across tiers are independent unless noted.

---

## Non-Goals for Phase 8

These were considered and explicitly deferred:

- **Multi-client collaboration** — requires WebSocket room/channel architecture, conflict resolution, presence tracking. High complexity, moderate demand. Defer to Phase 9.
- **Plugin/extension system** — premature abstraction at this stage. Defer until the feature set stabilizes.
- **Deployment integration** (Vercel, Netlify) — valuable but orthogonal. Separate feature track.
- **AI model selection** — Claude Code CLI uses the subscription's default model. Model choice belongs to the CLI, not ShipIt.
