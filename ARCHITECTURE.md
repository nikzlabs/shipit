# ShipIt — High-Level Architecture

## What Is This?

ShipIt is a browser-based IDE for "vibe coding" — you talk to Claude in a chat interface and it writes code in real-time inside a Docker container. Think of it as a hosted Claude Code session with a React frontend.

## System Overview

```
┌─────────────────────────────────────────────────────────┐
│  Browser                                                │
│  ┌───────────────────────────────────────────────────┐  │
│  │  React App (Vite-built, served as static files)   │  │
│  │                                                   │  │
│  │  ┌─────────────┐  ┌────────────────────────────┐  │  │
│  │  │ MessageInput│  │ MessageList                │  │  │
│  │  │  (textarea) │  │  (chat bubbles + tool use) │  │  │
│  │  └─────────────┘  └────────────────────────────┘  │  │
│  └──────────────┬────────────────────────────────────┘  │
│                 │ WebSocket (JSON)                       │
└─────────────────┼───────────────────────────────────────┘
                  │
┌─────────────────┼───────────────────────────────────────┐
│  Docker         │                                       │
│  Container      ▼                                       │
│  ┌──────────────────────────────────────────────────┐   │
│  │  Fastify Server (:3000)                          │   │
│  │  ├── /ws          → WebSocket endpoint           │   │
│  │  └── /*           → Static files (SPA fallback)  │   │
│  └──────────┬───────────────────────────────────────┘   │
│             │ child_process.spawn                        │
│             ▼                                           │
│  ┌──────────────────────────────────────────────────┐   │
│  │  Claude Code CLI                                 │   │
│  │  claude -p <prompt> --output-format stream-json  │   │
│  │                                                  │   │
│  │  Tools: Write, Read, Edit, Bash, Glob, Grep,    │   │
│  │         WebFetch, WebSearch                      │   │
│  └──────────┬───────────────────────────────────────┘   │
│             │ file I/O                                  │
│             ▼                                           │
│  ┌──────────────────────────────────────────────────┐   │
│  │  /workspace                                      │   │
│  │  (persistent Docker volume, git-initialized)     │   │
│  └──────────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────────┘
```

## Data Flow

```
1. User types prompt → MessageInput
2. React sends JSON over WebSocket:  { type: "send_message", text, sessionId? }
3. Fastify spawns Claude CLI as child process (or resumes session)
4. Claude CLI streams NDJSON to stdout
5. Server parses line-by-line → sends { type: "claude_event", event } over WS
6. React updates MessageList in real-time (streaming text + tool use blocks)
7. On "result" event → turn is done, UI unlocks input
```

## Key Components

### Backend (`src/server/`)

| File | Role |
|------|------|
| `index.ts` | Fastify server — `buildApp(deps?)` factory, WebSocket route, static file serving, SPA fallback. Accepts dependency injection for testing. |
| `claude.ts` | `ClaudeProcess` class — spawns CLI, parses NDJSON stream, emits events |
| `git.ts` | `GitManager` class — auto-commit after turns, git log, rollback |
| `auth.ts` | `AuthManager` class — OAuth flow detection, credential checking, auth URL capture |
| `sessions.ts` | `SessionManager` class — session CRUD, JSON file persistence |
| `chat-history.ts` | `ChatHistoryManager` class — per-session chat message persistence to disk |
| `markdown.ts` | `findMarkdownFiles` — recursive `.md` file scanner (skips node_modules, .git) |
| `file-tree.ts` | `scanFileTree` — recursive workspace directory scanner, returns tree of `FileTreeNode` objects |
| `vite-manager.ts` | `ViteManager` class — Vite dev server lifecycle (start, stop, restart) |
| `port-scanner.ts` | Port auto-detection — `checkPort`, `scanPorts` for finding non-Vite dev servers |
| `usage.ts` | `UsageManager` class — per-turn cost/duration tracking, session-level aggregation, JSON persistence |
| `file-watcher.ts` | `FileWatcher` class — recursive `fs.watch`, debounced change events, ignore patterns |
| `threads.ts` | `ThreadManager` class — conversation threads and checkpoints, JSON persistence per session |
| `types.ts` | Shared TypeScript types for all WebSocket and Claude event payloads |

The server is intentionally thin — it's a bridge between the browser and the Claude CLI. No database, no REST API.

### Frontend (`src/client/`)

| File | Role |
|------|------|
| `App.tsx` | Root component — chat state, session tracking, tab management, resizable layout, event dispatch |
| `hooks/useWebSocket.ts` | WebSocket lifecycle — connect, exponential-backoff reconnect, manual reconnect, send/receive JSON |
| `hooks/useResizablePanel.ts` | Drag-to-resize logic for the two-column layout (persists to localStorage) |
| `hooks/useSearch.ts` | Chat search logic — substring matching, match navigation, state management |
| `hooks/useMediaQuery.ts` | Responsive breakpoint detection via `matchMedia`, plus `useIsMobile()` convenience wrapper |
| `hooks/useNotification.ts` | Background tab notifications — tab title change and browser Notification on Claude completion |
| `hooks/usePreviewErrors.ts` | Listens for `postMessage` from preview iframe error-capture script, deduplicates errors, maintains rolling buffer |
| `components/ResizeHandle.tsx` | Vertical drag handle rendered between the chat and preview/docs panels |
| `components/MessageList.tsx` | Renders chat messages (with syntax-highlighted code blocks), tool invocations, streaming indicators |
| `components/StreamingIndicator.tsx` | Typing dots, thinking indicator, tool spinner, activity label derivation |
| `components/DiffBlock.tsx` | Inline file change diff display (red/green lines for Edit and Write tools) |
| `components/MessageInput.tsx` | Auto-resizing textarea, Enter-to-send, activity status bar |
| `components/PreviewFrame.tsx` | iframe pointing to dev server (Vite or auto-detected) with reload button, source indicator, error badge/panel, "Send to Claude" button, and auto-fix toggle |
| `components/DocsViewer.tsx` | Markdown file browser and renderer (using `marked`) |
| `components/FileTree.tsx` | Workspace file tree browser — expandable/collapsible directory tree with folder/file icons, click-to-view files |
| `components/FileContentViewer.tsx` | Read-only file content viewer with syntax highlighting (highlight.js) |
| `components/TerminalPanel.tsx` | Terminal/logs panel — shows Claude CLI stderr/stdout, server lifecycle events, and preview errors in a monospace terminal-like pane |
| `components/GitHistory.tsx` | Collapsible git commit list with rollback buttons |
| `components/SessionSelector.tsx` | Session management — list, resume, new, delete |
| `components/SearchBar.tsx` | Search input with match count, prev/next navigation, keyboard shortcuts |
| `components/ErrorBoundary.tsx` | React Error Boundary — catches unhandled render errors, shows fallback with reload/recover |
| `components/ConnectionBanner.tsx` | Full-width banner for WebSocket state — disconnected (with attempt count + "Reconnect now"), reconnecting, and brief "Reconnected" success flash |
| `components/MobileTabBar.tsx` | Bottom navigation bar for mobile: switch between Chat and Preview panels |
| `components/AuthOverlay.tsx` | Full-screen overlay for OAuth authentication flow |
| `components/UsageModal.tsx` | Usage/cost summary modal — current session and all-sessions breakdown, triggered by cost badge |
| `components/SystemPromptEditor.tsx` | Project-level system prompt modal — edit/save/clear instructions sent to Claude with every message |
| `components/ThreadIndicator.tsx` | Thread dropdown and checkpoint button — thread switching, checkpoint creation, fork-thread-from-checkpoint |

### Claude CLI Events (NDJSON)

The Claude CLI with `--output-format stream-json` emits newline-delimited JSON to stdout. Each line is one of these event types:

| Event type | When | Key data |
|-----------|------|----------|
| `system` (init) | Session start | `session_id`, model, available tools |
| `assistant` | Claude responds | Text blocks + tool_use blocks |
| `user` | Tool results | Tool execution output |
| `result` | Turn complete | `session_id`, `total_cost_usd`, `duration_ms` |

#### `assistant` Event — Content Blocks

The `assistant` event's `message.content` is an array of content blocks. Each block is one of:

**Text block** — Claude's natural language response:
```json
{ "type": "text", "text": "I'll create that file for you." }
```

**Tool use block** — a tool invocation with its inputs:
```json
{
  "type": "tool_use",
  "id": "toolu_abc123",
  "name": "Edit",
  "input": {
    "file_path": "/workspace/src/app.ts",
    "old_string": "const x = 1;",
    "new_string": "const x = 2;"
  }
}
```

Key tools and their `input` fields relevant for rendering:

| Tool | Input fields | Notes |
|------|-------------|-------|
| `Edit` | `file_path`, `old_string`, `new_string` | Rendered as inline diff (red/green) |
| `Write` | `file_path`, `content` | Rendered as all-green addition block |
| `Read` | `file_path` | Shown as compact one-liner |
| `Bash` | `command` | Shown as compact one-liner (first 80 chars) |
| `Glob` | `pattern` | Shown as compact one-liner |
| `Grep` | `pattern`, `path` | Shown as compact one-liner |

The `DiffBlock` component (`src/client/components/DiffBlock.tsx`) handles rendering `Edit` and `Write` tool uses as inline diffs in the chat. Other tools fall back to a compact single-line display in `MessageList.tsx`.

#### `user` Event — Tool Results

The `user` event's `message.content` is an array of `tool_result` blocks. Each block has a `tool_use_id` that matches a `tool_use` block from the preceding `assistant` event:

```json
{
  "type": "tool_result",
  "tool_use_id": "toolu_abc123",
  "content": "command output here...",
  "is_error": false
}
```

These results are parsed in `App.tsx` and attached to the preceding assistant message as `toolResults: ToolResultBlock[]`. The `ToolUseItem` component in `MessageList.tsx` matches results to tool use blocks by `tool_use_id` and renders a collapsible "Show output" / "Hide output" toggle.

## Inline Tool Result Rendering

When Claude uses tools, the results (Bash output, file contents, grep matches, etc.) are displayed inline in the chat beneath each tool invocation. Results are collapsible by default.

### How It Works

1. **Parsing**: `App.tsx` intercepts `user` events from the Claude CLI NDJSON stream and extracts `tool_result` blocks from `event.message.content`. Each result's `tool_use_id` links it to the corresponding tool invocation.
2. **Attachment**: Results are attached to the last assistant message's `toolResults` array by matching `tool_use_id`. This happens incrementally — new results are merged with existing ones as they arrive.
3. **Rendering**: `ToolUseItem` in `MessageList.tsx` receives the matched result as a prop and renders a "Show output" / "Hide output" toggle button. When expanded, the `ToolResult` component dispatches to a tool-specific renderer.
4. **Truncation**: Large outputs are truncated client-side (Bash: 30 lines, Read: 20 lines, Grep/Glob: 20 lines, Generic: 15 lines) with an expandable "Show all N lines" button. Outputs exceeding 1MB are truncated at parse time.

### Tool-Specific Renderers

| Renderer | Tools | Features |
|----------|-------|----------|
| `BashResult` | Bash | Monospace output, red text + border for errors, 30-line truncation |
| `ReadResult` | Read | Auto-detected syntax highlighting via highlight.js, 20-line truncation |
| `GrepResult` | Grep, Glob | File paths in blue, line numbers in yellow (ripgrep-style formatting), 20-line truncation |
| `GenericResult` | All others | Plain monospace text, red for errors, 15-line truncation |

### Key Design Decisions

- **Client-side only**: No server changes needed — the `claude_event` relay already sends `user` events. All processing happens in the browser.
- **Not persisted**: Tool results are NOT saved to chat history. They can be very large and are ephemeral — what matters is Claude's response to them.
- **Collapsed by default**: Keeps the chat readable. Users expand individual results when they need to inspect output.
- **1MB truncation**: Prevents memory issues from extremely large outputs (full file dumps, verbose test output). Applied at parse time in `App.tsx`.

### Key Files

- **`src/client/App.tsx`** — Parses `tool_result` blocks from `user` events, attaches to assistant messages.
- **`src/client/components/MessageList.tsx`** — `ToolUseItem` matches results by `tool_use_id`, renders collapse/expand toggle.
- **`src/client/components/ToolResult.tsx`** — Tool-specific renderers: `BashResult`, `ReadResult`, `GrepResult`, `GenericResult`.
- **`src/client/components/ToolResult.test.tsx`** — Component tests for all renderers.

## WebSocket Message Protocol

All client-server communication uses JSON over a single WebSocket connection at `/ws`. Types are defined in `src/server/types.ts`.

### Client → Server Messages

| Type | Fields | Purpose |
|------|--------|---------|
| `send_message` | `text`, `sessionId?` | Send a user message to Claude CLI |
| `get_git_log` | — | Request git commit history |
| `rollback` | `commitHash` | Roll back workspace to a specific commit |
| `list_sessions` | — | List all saved sessions |
| `new_session` | — | Clear current session, start fresh |
| `delete_session` | `sessionId` | Delete a saved session |
| `rename_session` | `sessionId`, `title` | Rename a saved session |
| `list_docs` | — | List `.md` files in /workspace |
| `get_doc` | `path` | Request content of a markdown file |
| `get_chat_history` | `sessionId` | Request persisted chat messages for a session |
| `get_file_tree` | — | Request workspace directory tree |
| `get_file_content` | `path` | Request contents of a file in /workspace |
| `clear_logs` | — | Clear the server-side terminal log buffer |
| `preview_error` | `message`, `stack?`, `source?`, `line?` | Report a preview iframe error to the terminal log buffer |
| `get_usage_stats` | — | Request aggregated usage/cost data across all sessions |
| `get_system_prompt` | — | Request current project-level system prompt |
| `set_system_prompt` | `content` | Save or delete the project-level system prompt |
| `list_threads` | — | Request all threads and checkpoints for the current session |
| `create_checkpoint` | `label?` | Create a checkpoint on the active thread |
| `fork_thread` | `checkpointId` | Create a new thread from a checkpoint (rolls back git, truncates history) |
| `switch_thread` | `threadId` | Switch to an existing thread (rolls back git to thread's checkpoint) |

### Server → Client Messages

| Type | Fields | Purpose |
|------|--------|---------|
| `claude_event` | `event` | Relayed Claude CLI NDJSON event |
| `error` | `message` | Error description |
| `preview_status` | `running`, `port`, `url`, `source?`, `detectedPorts?` | Dev server status — `source` is `"vite"` (managed), `"detected"` (port scan), or omitted (not running). `detectedPorts` lists all non-Vite ports found by scanning. |
| `git_log` | `commits[]` | Full git commit history |
| `git_committed` | `hash`, `message` | New auto-commit after Claude turn |
| `rollback_complete` | `commitHash` | Rollback succeeded |
| `auth_required` | `url` | OAuth URL for user to authenticate |
| `auth_complete` | — | OAuth flow finished |
| `session_list` | `sessions[]` | List of saved sessions |
| `session_started` | `session` | Session created or resumed |
| `session_renamed` | `session` | Session renamed successfully |
| `doc_list` | `files[]` | List of markdown file paths |
| `doc_content` | `path`, `content` | Raw markdown file content |
| `chat_history` | `sessionId`, `messages[]` | Persisted chat messages for a session |
| `file_tree` | `tree[]` | Workspace directory tree (array of `FileTreeNode`) |
| `file_content` | `path`, `content` | Raw file content for the file viewer |
| `log_entry` | `source`, `text`, `timestamp` | Terminal log line — `source` is `"stderr"`, `"stdout"`, `"server"`, or `"preview"` |
| `usage_stats` | `stats` | Aggregated usage data with per-session and total costs/turns |
| `usage_update` | `sessionId`, `totalCostUsd`, `totalDurationMs`, `turnCount` | Pushed after each turn that carries `total_cost_usd` |
| `system_prompt` | `content` | Current system prompt text (empty string if not set) |
| `system_prompt_saved` | `content` | Confirmation after saving/deleting the system prompt |
| `thread_list` | `threads[]`, `activeThreadId` | All threads with their checkpoints for the session |
| `checkpoint_created` | `checkpoint`, `threads[]`, `activeThreadId` | Checkpoint created, with updated thread data |
| `thread_forked` | `thread`, `threads[]`, `activeThreadId` | New thread created from checkpoint |
| `thread_switched` | `thread`, `threads[]`, `activeThreadId` | Switched to a different thread |
| `files_changed` | `paths[]` | Server-push: list of relative paths that changed in the workspace (debounced) |

### Adding a New Message Type

1. Add the interface to `src/server/types.ts` (both `WsClientMessage` and/or `WsServerMessage` unions)
2. Add the handler in `src/server/index.ts` inside the `socket.on("message")` callback
3. Add the client-side handler in the `useEffect` in `src/client/App.tsx` that processes `lastMessage`
4. Wire up the UI component to call `send()` with the new message type

## Streaming UX & Activity Tracking

The streaming UX provides real-time visual feedback while Claude is working. It's built on three layers:

### Activity State Machine

The `activity` state in `App.tsx` tracks what Claude is currently doing, derived from Claude CLI events:

```
send_message → { label: "Thinking..." }
     │
     ▼
system.init → (no change)
     │
     ▼
assistant (text only) → { label: "Thinking..." }
assistant (tool_use)  → { label: "Editing .../file.ts", tool: "Edit" }
     │
     ▼
user (tool result) → { label: "Processing results..." }
     │
     ▼
result → activity = undefined (idle)
```

The activity label is derived from the *last* tool_use block in each assistant event via `activityFromTool()` in `StreamingIndicator.tsx`. This gives context-specific labels like "Editing src/app.ts", "Running command...", "Searching code...", etc.

### Visual Indicators

| Location | What | When |
|----------|------|------|
| Chat (ThinkingIndicator) | Bouncing dots + activity label | Loading, no assistant message yet |
| Chat (TypingDots) | Inline bouncing dots | On streaming assistant messages |
| Chat (ToolSpinner) | Spinning border on last tool | Tool is actively executing |
| Input bar | Bouncing dots + activity label | Claude is working (input disabled) |

### Key Components

- **`StreamingIndicator.tsx`** — All streaming UI primitives (`TypingDots`, `ThinkingIndicator`, `ToolSpinner`, `activityFromTool`)
- **`MessageList.tsx`** — Consumes `activity` prop for the thinking indicator, passes `isStreaming` to tool items
- **`MessageInput.tsx`** — Consumes `activity` prop to show status above the disabled input
- **`index.css`** — CSS keyframe animations: `typing-bounce` (dots), `spin-slow` (tool spinner)

### Adding a New Tool Label

To add activity tracking for a new Claude CLI tool, add a case to `activityFromTool()` in `src/client/components/StreamingIndicator.tsx`. The function receives the tool name and its input object, and returns a `StreamingActivity` with a human-readable label.

## Resizable Panels

The two-column layout (chat on the left, preview/docs on the right) is resizable via a vertical drag handle.

### How It Works

1. `useResizablePanel` hook (`src/client/hooks/useResizablePanel.ts`) manages the split state as a fraction (0–1) representing the left panel's width.
2. On `mousedown` on the handle, global `mousemove`/`mouseup` listeners compute the new fraction from the cursor position relative to the container.
3. The fraction is clamped to a configurable `minFraction` (default 0.25) so neither panel can collapse below 25%.
4. Both panels use inline `style={{ width }}` with percentage values instead of Tailwind width classes, so the layout updates every frame during drag.
5. `userSelect: none` is applied to the body during drag to prevent accidental text selection.
6. The final position is persisted to `localStorage` (key: `vibe-panel-split`) on mouse-up so it survives page reloads.

### Key Files

- **`hooks/useResizablePanel.ts`** — The hook: state, mouse event wiring, localStorage persistence.
- **`components/ResizeHandle.tsx`** — The visual handle: 8px transparent hit area with a 2px centered indicator line.
- **`index.css`** — `.resize-handle` class sets width and cursor.

### Touch Support

The resize handle also supports touch events for tablet users. On `touchstart`, global `touchmove`/`touchend` listeners mirror the mouse logic, computing the split fraction from `touch.clientX`. The `ResizeHandle` component accepts an optional `onTouchStart` prop forwarded from the hook.

### Adding Another Resizable Split

To add a vertical (top/bottom) or additional horizontal split:
1. Use the same `useResizablePanel` hook with a different `storageKey`.
2. For vertical splits, the hook would need modification to track `clientY` / `rect.height` instead of `clientX` / `rect.width`.

## Mobile Responsiveness

On viewports narrower than 768px (Tailwind `md` breakpoint), the two-column layout switches to a single-panel view with a bottom tab bar for navigation.

### How It Works

1. **`useIsMobile` hook** (`src/client/hooks/useMediaQuery.ts`) uses `window.matchMedia("(max-width: 767px)")` to detect mobile viewports and re-render when the viewport crosses the breakpoint.
2. **`App.tsx`** conditionally renders either:
   - **Mobile**: A single full-width panel (chat or preview/docs) with a `MobileTabBar` at the bottom for switching.
   - **Desktop**: The side-by-side resizable split layout with `ResizeHandle`.
3. **`MobileTabBar` component** (`src/client/components/MobileTabBar.tsx`) renders a fixed bottom navigation bar with Chat and Preview tabs.
4. **Responsive spacing**: Components like `MessageList`, `MessageInput`, and the header use responsive Tailwind classes (`px-3 sm:px-6`, `gap-2 sm:gap-3`) for tighter padding on small screens.

### Key Files

- **`hooks/useMediaQuery.ts`** — `useMediaQuery(query)` generic hook and `useIsMobile()` convenience wrapper.
- **`components/MobileTabBar.tsx`** — Bottom tab bar with Chat/Preview tabs, SVG icons, `aria-current` for accessibility.
- **`App.tsx`** — Conditional layout rendering based on `isMobile`.

### Key Design Decisions

- **Single panel, not stacked**: On mobile, showing both panels stacked vertically wastes screen space. A tab bar switch is more natural on phones.
- **No resize handle on mobile**: The drag handle is hidden because there's only one panel visible.
- **Touch on tablets**: Tablets (≥768px) still get the desktop layout with the resize handle, but with touch event support so dragging works without a mouse.
- **Bottom tab bar**: Follows the native mobile app pattern (iOS/Android) for primary navigation, placed at the bottom for thumb reach.

## Search in Chat History

The search feature lets users find text within the chat conversation using Ctrl+F (Cmd+F on macOS).

### How It Works

1. **`useSearch` hook** (`src/client/hooks/useSearch.ts`) performs case-insensitive substring matching across all `ChatMessage.text` values. It returns an array of `SearchMatch` objects, each with a `messageIndex` (which message), `start` (character offset), and `length`.
2. **`SearchBar` component** (`src/client/components/SearchBar.tsx`) renders a slide-down input bar at the top of the chat column with match count, prev/next navigation, and close button.
3. **`MessageList`** receives `searchMatches` and `currentMatch` props. It groups matches by message index, then renders `HighlightedText` — a component that splits message text into plain and `<mark>` segments. The "current" match gets a brighter highlight and a ref used for `scrollIntoView`.
4. **`App.tsx`** owns the `searchOpen` boolean and the `useSearch` hook. It listens for Ctrl+F to toggle the search bar.

### Keyboard Shortcuts

| Key | Action |
|-----|--------|
| ? | Toggle keyboard shortcuts help overlay |
| Ctrl+F / Cmd+F | Open / close search bar |
| Enter | Go to next match (in search); send message (in input) |
| Shift+Enter | Go to previous match (in search); new line (in input) |
| Escape | Close search bar / shortcuts overlay |

### CSS Classes (`index.css`)

- `.search-highlight` — semi-transparent yellow background on all matches
- `.search-highlight--current` — brighter yellow with dark text on the actively navigated match

### Key Design Decisions

- **Client-side only** — no server involvement; search runs entirely in the browser against the in-memory `messages` array.
- **Substring match** — simple `indexOf` loop rather than regex, so user input is treated as literal text (no escaping issues).
- **Scroll-to-match** — uses `scrollIntoView({ block: "center" })` so the current match appears centered in the chat scroll area.
- **Match index clamping** — when the messages array changes (new messages arrive) and the match count shrinks, the current index is automatically clamped to stay in bounds.

## Code Block Syntax Highlighting

Claude's responses often contain fenced code blocks (`` ```language ... ``` ``). These are rendered with syntax highlighting powered by [highlight.js](https://highlightjs.org/).

### How It Works

1. **`parseMessageSegments(text)`** in `MessageList.tsx` splits message text into alternating `TextSegment` and `CodeSegment` objects using a regex that matches fenced code blocks. Each segment tracks its character offset in the original text.
2. **`CodeBlock` component** renders each code segment: `hljs.highlight()` (when the language is specified) or `hljs.highlightAuto()` (when omitted) produces HTML, rendered via `dangerouslySetInnerHTML` inside `<pre><code class="hljs">`.
3. **Text segments** continue to render through `HighlightedText` with full search match support. Search match offsets are adjusted per segment via `getSegmentMatches()`.
4. **Messages without code blocks** skip the segment pipeline entirely and render as before (single `HighlightedText` with `whitespace-pre-wrap`).

### Styling

- Code blocks use `bg-gray-950` (darker than the message bubble's `bg-gray-800`) for visual contrast.
- A language label bar appears above code blocks when a language is specified.
- The `github-dark` highlight.js theme (`highlight.js/styles/github-dark.css`) provides token colors.
- The `hljs` class on `<code>` elements ensures highlight.js theme styles apply correctly.

### Streaming Behavior

During streaming, unclosed code blocks (opening `` ``` `` without closing) are treated as plain text until the closing fence arrives. This causes a visual transition from raw text to highlighted code when the block completes — acceptable since it matches user expectations during real-time streaming.

### Key Design Decisions

- **highlight.js over shiki**: highlight.js is simpler to integrate (synchronous API, CSS themes) and supports 190+ languages out of the box. Shiki offers better accuracy via TextMate grammars but requires async initialization and WASM.
- **Segment-based rendering**: Rather than full markdown rendering (which would require reworking search highlighting), the text is split into segments. This preserves the existing `HighlightedText` search infrastructure while adding code highlighting.
- **No inline code highlighting**: Single-backtick inline code is not highlighted — only fenced code blocks. This keeps the implementation focused and avoids disrupting the flow of plain text.

## Background Tab Notifications

When Claude finishes responding while the user is on a different browser tab, the app provides two forms of notification:

### Tab Title Change

The document title changes from "ShipIt" to "\u2713 Claude finished \u2014 ShipIt" when a `result` event fires while the tab is hidden. This is visible in the browser's tab bar. The original title is restored when the user returns to the tab via the `visibilitychange` event.

### Browser Notification

If the user has granted notification permission, a native `Notification` is sent with the body "Claude has finished responding." Permission is requested lazily \u2014 the first time the user sends a message, `Notification.requestPermission()` is called. This avoids prompting on page load when the user hasn't interacted yet.

### How It Works

1. **`useNotification` hook** (`src/client/hooks/useNotification.ts`) tracks tab visibility via `document.hidden` and the `visibilitychange` event. It exposes two functions:
   - `notify(body)` \u2014 if the tab is hidden, changes the document title and sends a browser notification (if permitted).
   - `requestPermission()` \u2014 calls `Notification.requestPermission()` if permission is `"default"`.
2. **`App.tsx`** calls `notify()` when a `result` event is received, and `requestPermission()` inside `handleSend`.

### Key Design Decisions

- **No server involvement** \u2014 notifications are purely client-side, driven by existing `result` events.
- **Lazy permission request** \u2014 triggered on first message send, not on page load, for a better UX.
- **Title-only when notifications are denied** \u2014 the tab title change works without any permissions and is the primary notification mechanism.
- **No notification when tab is visible** \u2014 avoids unnecessary distractions when the user is already watching.

## Error Handling & Recovery

The app handles three categories of runtime errors:

### 1. React Render Errors (ErrorBoundary)

`ErrorBoundary` (`src/client/components/ErrorBoundary.tsx`) wraps the entire `<App />` in `main.tsx`. If any component throws during rendering, the boundary catches it and shows a full-screen fallback with:
- The error message
- A **Reload Page** button (hard refresh)
- A **Try to Recover** button (clears the error state and re-renders the tree)

This prevents the white-screen-of-death. Must be a class component because React only supports error boundaries via `getDerivedStateFromError` / `componentDidCatch`.

### 2. WebSocket Disconnection & Reconnection

#### Mid-Stream Disconnection

When the WebSocket connection drops while Claude is actively responding (`isLoading === true`), `App.tsx` detects the status transition from `"open"` to `"closed"` and:
1. Marks any in-flight streaming message as `streaming: false`
2. Appends an error message (`isError: true`) explaining the connection was lost
3. Clears `isLoading` and `activity` so the UI isn't stuck

#### Automatic Reconnection (`useWebSocket`)

The `useWebSocket` hook (`src/client/hooks/useWebSocket.ts`) handles reconnection automatically with exponential backoff:

```
Attempt 0 → 2s delay
Attempt 1 → 4s delay
Attempt 2 → 8s delay
Attempt 3 → 16s delay
Attempt 4+ → 30s cap
```

The hook exposes `reconnectAttempt` (consecutive failed attempts since last success, resets to 0 on open) and `reconnect()` (bypasses backoff timer, reconnects immediately, resets attempt counter). Jitter is intentionally omitted — a single browser tab doesn't cause thundering-herd problems.

#### Visual Feedback (`ConnectionBanner`)

The `ConnectionBanner` component (`src/client/components/ConnectionBanner.tsx`) provides a persistent full-width banner below the header with four states:

| WsStatus | Visual | Details |
|----------|--------|---------|
| `open` (steady) | Hidden | Normal state |
| `open` (just reconnected) | Green "Reconnected" | Auto-hides after 3s |
| `connecting` | Yellow "Reconnecting..." | Shown during WebSocket handshake |
| `closed` | Red "Connection lost" | Shows attempt count (if >1) and a "Reconnect now" button |

The header also contains a small colored pill (`green`/`yellow`/`red`) showing the raw connection status. The `MessageInput` is disabled whenever `status !== "open"`, preventing the user from sending messages into the void.

### 3. Claude CLI Errors

When the CLI process crashes or returns an error, the server sends `{ type: "error", message }` over WebSocket. The client:
1. Marks any in-flight streaming message as `streaming: false`
2. Appends the error as a message with `isError: true`
3. Error messages render with distinct red styling (`bg-red-900`, red border) so they're visually distinguished from normal assistant messages

### Error Message Styling

Messages with `isError: true` get a red background and border in `MessageList.tsx`, making them visually distinct from normal assistant responses. This applies to both server-sent errors and client-detected connection losses.

## Session Management

Sessions use two decoupled IDs:
- **App session ID**: A `crypto.randomUUID()` generated by the server when a session is created (on first message or template application). This is the stable identifier used for workspace directories, metadata, chat history, and usage tracking.
- **Agent session ID**: The Claude CLI's `session_id` from the `system.init` event. Stored as `SessionInfo.agentSessionId` and used for `--resume` on subsequent turns.

Session titles are auto-generated from the first message (first 80 chars), but users can rename them via the session dropdown (pencil icon → inline text editor → Enter or blur to save, Escape to cancel).

## Session Isolation

Each session gets its own workspace directory with its own git repo, preventing file collisions between sessions.

### Directory Layout

```
/workspace/
  sessions/
    abc123/          ← Session A's workspace
      .git/
      package.json
      src/
    def456/          ← Session B's workspace
      .git/
      index.html
  .vibe-sessions.json
  .vibe-chat-history/
  .shipit-usage.json
  .shipit/
    system-prompt.md
```

### How It Works

1. **Session creation**: On first `send_message` (without `sessionId`) or `apply_template`, the server generates a UUID, creates `/workspace/sessions/{uuid}/`, initializes a git repo, and configures GitHub credentials if available.
2. **Per-connection state**: Each WebSocket connection tracks `activeAppSessionId` and `activeSessionDir`. All file/git operations use these instead of the root `/workspace`.
3. **Per-session GitManager**: `AppDeps.createGitManager` is a factory `(dir: string) => GitManager` that creates GitManager instances for each session directory. The legacy single `gitManager` is a fallback for sessions without a `workspaceDir`.
4. **Session switching**: `get_chat_history` activates a session, updating `activeSessionDir` and restarting the FileWatcher for the new directory.
5. **ClaudeProcess.run()**: Accepts a `cwd` parameter so the CLI runs in the session's directory.
6. **ViteManager**: `start(workspaceDir?)` and `restart(workspaceDir?)` accept a directory parameter for session-scoped previews.
7. **Session deletion**: `delete_session` removes the session's directory from disk (`fs.rm` with `recursive: true`).
8. **Migration**: Sessions created before isolation (no `workspaceDir`) fall back to the root `/workspace` directory.

### Key Files

- **`src/server/index.ts`** — `createSessionDir()` helper, per-connection `activeSessionDir` state, `getActiveDir()` / `getActiveGitManager()` helpers.
- **`src/server/types.ts`** — `SessionInfo.workspaceDir` and `SessionInfo.agentSessionId` fields.
- **`src/server/sessions.ts`** — `track(id, title?, workspaceDir?)`, `get(id)`, `setAgentSessionId()`.
- **`src/server/claude.ts`** — `run()` accepts `cwd` parameter.
- **`src/server/vite-manager.ts`** — `start(workspaceDir?)`, `restart(workspaceDir?)`.
- **`src/server/github-auth.ts`** — `configureGitCredentials(targetDir?)`.
- **`docker/Dockerfile.dev`**, **`docker/Dockerfile.prod`** — `VOLUME /workspace`, no `git init`.

## Persistent Chat History

Chat messages are persisted to disk per session so conversations survive page reloads, browser restarts, and session switching.

### Storage

- **Location**: `/workspace/.vibe-chat-history/{sessionId}.json`
- **Format**: JSON array of `PersistedMessage` objects (same shape as client-side `ChatMessage` minus the `streaming` field)
- **Session ID sanitization**: Non-alphanumeric characters (except `-` and `_`) are replaced with `_` to prevent path traversal

### How It Works

1. **Saving messages** — The server persists messages as they flow through the WebSocket handler in `index.ts`:
   - **User messages**: Saved when `send_message` is received. For new sessions (no `sessionId` yet), the user message is saved once the `system.init` event provides the session ID. For resumed sessions, it's saved immediately.
   - **Assistant messages**: The final assistant text and tool use blocks are accumulated during streaming and saved when the `result` event fires.
   - **Error messages**: CLI crashes and process errors are saved with `isError: true`.

2. **Loading messages** — The client requests history via `{ type: "get_chat_history", sessionId }` and the server responds with `{ type: "chat_history", sessionId, messages }`. This happens:
   - **On page reload**: The client stores the current session ID in `localStorage` (key: `vibe-current-session`). On WebSocket connect, if a saved session ID exists, it requests that session's history.
   - **On session resume**: When the user explicitly resumes a session via `SessionSelector`, the client requests that session's history.

3. **Cleanup** — When a session is deleted via `delete_session`, both the session metadata and its chat history file are removed.

### Key Files

- **`src/server/chat-history.ts`** — `ChatHistoryManager` class: append, load, delete, listSessions. Uses synchronous `fs` for simplicity (same pattern as `SessionManager`).
- **`src/server/index.ts`** — Wires up `ChatHistoryManager` in the WebSocket handler: saves messages during Claude turns, handles `get_chat_history` requests.
- **`src/client/App.tsx`** — Client-side integration: `localStorage` persistence of session ID, history request on connect/resume, `chat_history` message handler.

### Key Design Decisions

- **Server-side persistence, not client-side**: Messages are stored on the server so they survive across different browsers/devices connecting to the same container.
- **Per-session files**: Each session gets its own JSON file rather than a single monolithic store. This keeps individual files small and makes cleanup trivial.
- **No streaming state in persisted messages**: The `streaming` flag is transient UI state and is always set to `false` when loading history.
- **localStorage for session continuity**: The current session ID is saved to `localStorage` so page reloads automatically restore the last active session's chat.

## File Tree Sidebar

The Files tab in the right panel shows the workspace directory structure as an expandable tree. This is a read-only navigational aid — consistent with the "pure vibe coding" philosophy, users see what files exist without editing them directly.

### How It Works

1. **`scanFileTree` function** (`src/server/file-tree.ts`) recursively scans the workspace directory and returns an array of `FileTreeNode` objects. Each node has a `name`, `path` (relative to workspace), `type` ("file" or "directory"), and optional `children` array.
2. **Client requests the tree** via `{ type: "get_file_tree" }` when the user clicks the "Files" tab. The server responds with `{ type: "file_tree", tree }`.
3. **`FileTree` component** (`src/client/components/FileTree.tsx`) renders the tree with expand/collapse buttons, folder/file icons, and indentation based on depth.
4. **Auto-refresh**: When Claude finishes a turn and a `git_committed` event arrives, the file tree is automatically refreshed if the Files tab is active.

### Filtered Directories

The scanner skips directories that add noise without value:
- `node_modules`, `.git`, `.vibe-chat-history`, `dist`, `.next`, `.cache`, `.vite`
- Hidden files/directories (starting with `.`) except `.env` and `.env.local`

### Tree Sorting

Within each directory level, entries are sorted with directories first, then files, both groups sorted alphabetically. This matches the convention used by VS Code and other IDEs.

### UI Behavior

- **Auto-expand**: Root-level directories (depth 0) are auto-expanded on first render. Deeper directories start collapsed.
- **Toggle**: Clicking a directory name toggles its expanded/collapsed state.
- **Empty state**: When the workspace has no files, a placeholder message suggests asking Claude to create a project.
- **Reload button**: Manual refresh button in the header bar re-scans the filesystem.

### Key Files

- **`src/server/file-tree.ts`** — `scanFileTree(dir)`: recursive async directory scanner.
- **`src/server/types.ts`** — `FileTreeNode` type and `WsFileTree` / `WsGetFileTree` message types.
- **`src/client/components/FileTree.tsx`** — React component: `TreeNode` (recursive), `FileTree` (root wrapper with empty state and header).
- **`src/client/App.tsx`** — State management: `fileTree` state, `file_tree` message handler, tab switching, auto-refresh on commit.

## File Content Viewer

Clicking a file in the Files tab opens a read-only viewer showing the file's contents with syntax highlighting. This lets users inspect files without leaving the browser — consistent with the "pure vibe coding" philosophy where Claude writes the code and users review it.

### How It Works

1. **Click handler**: When the user clicks a file in `FileTree`, `App.tsx` sends `{ type: "get_file_content", path }` over WebSocket.
2. **Server handler**: The server resolves the path relative to the workspace directory, validates against path traversal (same pattern as `get_doc`), reads the file, and responds with `{ type: "file_content", path, content }`.
3. **`FileContentViewer` component** renders the content inside a `<pre><code class="hljs">` block with syntax highlighting via `hljs.highlight()` (when the language is known from the file extension) or `hljs.highlightAuto()` (for unknown extensions).
4. **Closing the viewer** returns to the file tree view. The viewer and tree share the same tab space — when a file is selected, the viewer replaces the tree; clicking "Close" brings back the tree.

### Language Detection

`languageFromPath()` maps file extensions to highlight.js language names. Common extensions are mapped explicitly (`.ts` → TypeScript, `.json` → JSON, `.py` → Python, etc.). Files without a recognized extension fall back to `highlightAuto()`. Special-case filenames like `Dockerfile` are also handled.

### Selected File Highlighting

When a file is selected, it gets a blue highlight in the file tree (`bg-blue-900/50`). File rows are rendered as `<button>` elements so they're clickable and keyboard-accessible.

### Key Files

- **`src/server/index.ts`** — `get_file_content` handler: path validation, file read, response.
- **`src/server/types.ts`** — `WsGetFileContent`, `WsFileContent` message types.
- **`src/client/components/FileContentViewer.tsx`** — Read-only viewer with syntax highlighting.
- **`src/client/components/FileTree.tsx`** — `onFileClick` and `selectedFile` props for click-to-view.
- **`src/client/App.tsx`** — `viewingFile`/`viewingFileContent` state, message handler, conditional rendering.

### Safety Guards

- **Path traversal protection**: Uses the same `path.resolve()` + `startsWith()` check as the `get_doc` handler, preventing reads outside `/workspace`.
- **Large file guard**: Files over 1 MB are rejected with a friendly message (`isBinary: true` + size info). Prevents sending huge payloads over WebSocket.
- **Binary file detection**: The server reads the raw buffer first and checks for null bytes. Binary files (images, compiled output) get a "Binary file — cannot display" message instead of garbled text.

### Auto-refresh on Commit

When a `git_committed` event arrives while the file viewer is open, `App.tsx` re-requests the file content so the viewer stays up to date. This means if Claude edits the file you're viewing, you see the change immediately.

### Key Design Decisions

- **Reuses highlight.js**: The same library already used for code block highlighting in `MessageList.tsx`. No new dependencies.
- **Server-side file read**: Content is fetched from the server rather than using a hypothetical client-side FS API. This keeps the architecture consistent — the server is the only thing that touches the filesystem.
- **Single source of truth for `FileTreeNode`**: The type is defined in `src/server/types.ts` and re-exported from `FileTree.tsx` — no duplication.
- **No editing**: This is deliberately read-only. Editing is Claude's job in the vibe coding model.

## File Watcher with Live Updates

The file tree and file viewer update automatically when files change in the workspace — no manual refresh needed. A `FileWatcher` monitors `/workspace` and pushes change notifications to connected clients.

### How It Works

1. **`FileWatcher` class** (`src/server/file-watcher.ts`) uses Node.js `fs.watch` with `recursive: true` to monitor the workspace directory. When files are created, modified, or deleted, it collects the changed paths and emits a debounced "changes" event.
2. **`index.ts`** creates a `FileWatcher` (injectable via `AppDeps.fileWatcher`), starts it on the workspace directory, and listens for "changes" events. Each event triggers a `files_changed` broadcast to all connected WebSocket clients.
3. **`App.tsx`** handles the `files_changed` message:
   - If the Files tab is active, auto-refreshes the file tree via `get_file_tree`.
   - If a file is open in the viewer and was modified, auto-refreshes its content via `get_file_content`.
   - If the Files tab is *not* active, increments a change-count badge (same pattern as the Terminal unread badge).
4. The badge count resets when the user switches to the Files tab.

### Debouncing & Deduplication

- **300ms debounce window** (configurable via constructor) collapses rapid-fire filesystem events into a single notification. This prevents event storms during bulk operations like `npm install` or template application.
- **Set-based deduplication** merges multiple events for the same file within the debounce window — each file path appears at most once.
- Each new change resets the debounce timer, so a burst of changes produces one event after the last change plus 300ms.

### Ignore Patterns

The watcher filters out directories that generate noise without value:
- `node_modules`, `.git`, `.vite`, `.next`, `.cache`, `dist`
- ShipIt internal files: `.shipit-usage.json`, `.vibe-sessions.json`, `.vibe-chat-history`

These patterns are checked by splitting the file path into segments and testing if any segment matches the ignore list.

### Dependency Injection

`AppDeps.fileWatcher` accepts a `FileWatcher` instance. Tests inject a `StubFileWatcher` (extends `EventEmitter`) with `start()`/`stop()` no-ops and a `simulateChanges(paths)` method that emits "changes" events manually, avoiding real filesystem watching.

### Key Files

- **`src/server/file-watcher.ts`** — `FileWatcher` class: recursive watch, debounce, ignore patterns, start/stop lifecycle.
- **`src/server/file-watcher.test.ts`** — Unit tests: debounce batching, deduplication, ignore patterns (node_modules, .git, .vibe-chat-history, .shipit-usage.json), start/stop lifecycle, subdirectory paths, idempotent start.
- **`src/server/types.ts`** — `WsFilesChanged` message type.
- **`src/server/index.ts`** — Wires up `FileWatcher`, broadcasts `files_changed`, stops on app close.
- **`src/server/integration.test.ts`** — Integration tests: broadcast to single/multiple clients, sequential events, disconnect cleanup.
- **`src/client/App.tsx`** — `files_changed` handler: auto-refresh file tree and viewer, change-count badge on Files tab.

## Preview Port Auto-Detection

The preview pane works with any dev server, not just Vite. The server detects non-Vite dev servers in two ways: after each Claude turn completes, and via periodic background scanning while clients are connected. This catches servers started mid-turn (e.g., via the Bash tool) without waiting for Claude to finish.

### How It Works

1. **`port-scanner.ts`** provides two functions:
   - `checkPort(port)` — TCP connect probe with 300ms timeout. Returns `true` if a server is listening.
   - `scanPorts(ports, excludePorts)` — Checks multiple ports concurrently, returns the list of open ones.

2. **Port scanning triggers** — the server calls `runPortScan()` (which uses the injectable `detectPorts` function) in two situations:
   - **After each Claude turn** (`done` event) — immediate scan when Claude finishes.
   - **Periodic interval** (every 5 seconds by default) — runs while at least one WebSocket client is connected. The interval starts when the first client connects and stops when the last disconnects. This catches servers started mid-turn by tools like Bash. The interval is configurable via `portScanIntervalMs` in `AppDeps` (set to 0 to disable, useful in tests).

   Both paths exclude the Fastify server port and the managed Vite port. A broadcast only happens when the set of detected ports changes.

3. **Priority logic** in `getPreviewStatus()`:
   - If Vite is running → use Vite (source: `"vite"`), include `detectedPorts` if any
   - Else if ports were detected → use the first detected port (source: `"detected"`), include all `detectedPorts`
   - Else → not running

4. **The client** receives `preview_status` with the `source` and `detectedPorts` fields:
   - When only one port is available: shows a green badge (Vite) or yellow badge (auto-detected) with an "(auto-detected)" label
   - When multiple ports are available: shows a `<select>` dropdown in the preview bar, letting the user choose which port to preview
   - The dropdown lists Vite (if running) plus all detected ports, each labeled with its port number

### Scanned Ports

`DEFAULT_SCAN_PORTS`: 3001, 4000, 4200, 5000, 5173, 5174, 8000, 8080, 8888

Port 3000 is excluded because it's the ShipIt server's own port. The managed Vite port (5173) is also excluded from scanning when Vite is already running.

### Port Selector UI

When multiple ports are available (either multiple detected ports, or Vite plus detected ports), `PreviewFrame` renders a `<select>` dropdown instead of a static port label. The user's selection is tracked as `selectedPort` state in `App.tsx` — when a new `preview_status` arrives, if the previously selected port is no longer available, the selection resets to the default. The iframe `key` includes the active port so switching ports forces a full iframe reload.

### Dependency Injection

The `detectPorts` function is injectable via `AppDeps` for testing. Integration tests inject a stub that returns a controlled port array, avoiding real TCP scanning. The `portScanIntervalMs` option controls the periodic scan interval — set to 0 in most test suites to avoid interference, and to a short value (e.g., 200ms) in the periodic scanning tests.

### Key Files

- **`src/server/port-scanner.ts`** — Port scanning utilities (`checkPort`, `scanPorts`, `DEFAULT_SCAN_PORTS`).
- **`src/server/index.ts`** — Integration: `runPortScan()` shared between the `done` handler and the periodic interval, `getPreviewStatus()` builds preview messages with all detected ports, interval lifecycle tied to client connections.
- **`src/client/components/PreviewFrame.tsx`** — Preview iframe with port selector dropdown (when multiple ports available), source indicator, reload button.
- **`src/client/App.tsx`** — Derives `detectedPorts` from `preview` state, manages `selectedPort` selection, passes both to `PreviewFrame`.

## Terminal/Logs Panel

The Terminal tab in the right panel shows Claude CLI output (stderr and non-JSON stdout) in a terminal-like pane. This is useful for debugging — it surfaces diagnostic output that would otherwise only appear in the server's console.

### Log Sources

Each log entry has a `source` field indicating where it originated:

| Source | Meaning |
|--------|---------|
| `stderr` | Claude CLI stderr output (debug info, warnings, error messages) |
| `stdout` | Non-JSON lines from Claude CLI stdout (anything that isn't valid NDJSON — typically CLI status messages) |
| `server` | Server lifecycle events: process start, exit (with exit code), and process errors |
| `preview` | Errors captured from the preview iframe (runtime errors, console.error, unhandled rejections) |

### Data Flow

1. **`ClaudeProcess`** (`src/server/claude.ts`) emits `"log"` events for stderr output and non-JSON stdout lines (in addition to the existing `"event"` and `"auth_required"` emissions).
2. **`index.ts`** listens for `"log"` events on each `ClaudeProcess` instance and calls `broadcastLog()`, which wraps the text in a `WsLogEntry` message with a timestamp and broadcasts it to all connected WebSocket clients.
3. **Server lifecycle events** (process started, exited, errored) are also emitted via `broadcastLog()` with `source: "server"`.
4. **Log buffer**: The server maintains a circular buffer of the most recent 500 log entries. When a new client connects, the entire buffer is sent so the client sees historical output.
5. **`clear_logs`** client message empties the server-side buffer.
6. **`App.tsx`** accumulates `log_entry` messages in state (capped at 500 on the client side) and passes them to `TerminalPanel`.

### UI Component

`TerminalPanel` (`src/client/components/TerminalPanel.tsx`) renders log entries in a monospace font with:
- **Timestamp** (HH:MM:SS) in muted gray
- **Source label** (`[err]`, `[out]`, `[srv]`, `[pre]`) color-coded: red for stderr, gray for stdout, blue for server, orange for preview
- **Log text** with `whitespace-pre-wrap` to preserve formatting
- **Source filter**: Toggleable filter buttons for each source type in the header bar. Color-coded active/inactive states. At least one source must remain active (prevents hiding all). Shows a filter-specific empty state ("No logs match the current filter") when all visible entries are filtered out.
- **Auto-scroll**: Scrolls to bottom as new entries arrive, unless the user has scrolled up
- **Clear button**: Resets both client state and server buffer
- **Empty state**: "No output yet" placeholder when no logs exist
- **Unread badge**: When the Terminal tab is not active, a blue badge shows the count of new log entries since the tab was last viewed. Resets when switching to the Terminal tab.

### Key Files

- **`src/server/claude.ts`** — Emits `"log"` events for stderr and non-JSON stdout.
- **`src/server/types.ts`** — `WsLogEntry` (server→client) and `WsClearLogs` (client→server) message types.
- **`src/server/index.ts`** — `broadcastLog()` helper, 500-entry circular log buffer, sends buffer on client connect, `clear_logs` handler.
- **`src/client/components/TerminalPanel.tsx`** — Terminal UI component with auto-scroll and source-colored labels.
- **`src/client/App.tsx`** — Terminal tab in right panel, `logEntries` state, `log_entry` message handler.

## Preview Error Capture & Auto-Debug

The preview pane captures runtime errors from the iframe (JavaScript errors, console.error, unhandled promise rejections) and surfaces them in the UI. Users can manually send errors to Claude for fixing, or enable auto-fix mode for a hands-free debug loop.

### How It Works

1. **Error Capture Script**: A Vite plugin (`src/server/vite-error-plugin.ts`) injects a `<script>` into the preview HTML that intercepts `window.onerror`, `unhandledrejection`, and `console.error`/`console.warn`. Captured errors are sent to the parent frame via `postMessage` with a `source: "shipit-preview"` identifier.

2. **Client-Side Hook**: The `usePreviewErrors` hook (`src/client/hooks/usePreviewErrors.ts`) listens for these `postMessage` events, deduplicates rapid-fire identical errors within a 1-second window, and maintains a rolling buffer of up to 50 errors.

3. **Terminal Relay**: Errors are also forwarded to the server via `preview_error` WebSocket messages. The server adds them to the terminal log buffer with `source: "preview"`, so they appear in the Terminal tab with an orange `[pre]` label.

4. **Error Panel**: `PreviewFrame` shows a red error badge with the count when errors exist. Clicking the badge opens a collapsible error panel with error details, stack traces, and per-error "Fix" buttons.

5. **Send to Claude**: The "Send to Claude" button formats all errors into a human-readable prompt and sends it as a user message, asking Claude to fix the issues.

6. **Auto-Fix Toggle**: An opt-in toggle in the preview header bar. When enabled:
   - New errors automatically trigger a "fix these errors" message to Claude (when Claude is idle)
   - 5-second cooldown between auto-fix attempts prevents rapid loops
   - Same-error signature detection tracks retries (max 3 before auto-disabling)
   - Any manual user message acts as a kill switch and disables auto-fix

### Safety Guardrails

- **Max 3 retries**: If the same set of errors persists after 3 fix attempts, auto-fix disables itself
- **5s cooldown**: Prevents sending back-to-back fix requests
- **Kill switch**: Any manual user message cancels auto-fix mode
- **Idle-only**: Auto-fix only triggers when Claude is not already processing a message

### Key Files

- **`src/server/vite-error-plugin.ts`** — Error capture script and Vite plugin for HTML injection.
- **`src/server/vite-manager.ts`** — Writes wrapper Vite config that includes the error-capture plugin.
- **`src/client/hooks/usePreviewErrors.ts`** — `usePreviewErrors` hook: `postMessage` listener, dedup, rolling buffer.
- **`src/client/components/PreviewFrame.tsx`** — Error badge, error panel, "Send to Claude" button, auto-fix toggle, `formatErrorForMessage()`.
- **`src/client/App.tsx`** — Wires hook to PreviewFrame, auto-fix effect with safety guardrails, error relay to server.
- **`src/server/index.ts`** — `preview_error` handler: validation, terminal log relay.
- **`src/server/types.ts`** — `WsPreviewError` message type, `"preview"` log source.

## Tech Stack

| Layer | Technology |
|-------|-----------|
| Server | Fastify 5, `@fastify/websocket`, `@fastify/static`, TypeScript |
| Frontend | React 19, Vite 6, Tailwind CSS 4, TypeScript |
| AI | Claude Code CLI (globally installed in container) |
| Runtime | Node 20, Docker |
| Testing | Vitest 4, @testing-library/react, jsdom |
| Dev | `tsx` (dev server), Vite dev proxy for WebSocket |

## Docker Setup

Two persistent volumes:
- **`workspace`** → `/workspace` — session workspace directories, metadata, chat history, usage data
- **`claude-auth`** → `/root/.claude` — CLI OAuth credentials

The Dockerfile installs Claude Code CLI globally and pre-builds the React frontend. `/workspace` is declared as a `VOLUME` — session directories and git repos are initialized at runtime by the server (not in the Dockerfile).

## Keyboard Shortcuts Help Overlay

Pressing `?` (when not focused on an input field) toggles a modal overlay listing all available keyboard shortcuts, grouped by category (General, Chat, Search).

### How It Works

1. **`App.tsx`** registers a global `keydown` listener for `?`. It skips the event if the active element is an `INPUT`, `TEXTAREA`, or `SELECT` to avoid triggering while the user is typing.
2. **`KeyboardShortcutsOverlay`** (`src/client/components/KeyboardShortcutsOverlay.tsx`) renders a fixed-position modal with `role="dialog"` and `aria-label="Keyboard shortcuts"`. The shortcut data is defined as a static array of `ShortcutGroup` objects, each containing a title and an array of `ShortcutEntry` (keys + description).
3. The overlay closes on `Escape`, `?`, clicking the backdrop, or clicking the close button.

### Key Design Decisions

- **Static shortcut data** — the shortcut list is a constant array inside the component, not fetched from a registry. This is simple and sufficient since there are few shortcuts and they don't change dynamically.
- **Input guard** — the `?` listener checks `e.target.tagName` to avoid capturing keystrokes while the user is typing in the chat input or search bar.
- **Accessible** — uses `role="dialog"`, `aria-label`, and a visible close button labeled "Esc".

## Message Editing & Retry

Users can edit or retry any previous user message. Hovering over a user message reveals edit (pencil) and retry (refresh) buttons.

### How It Works

1. **Edit**: Clicking the pencil icon replaces the message bubble with an inline `MessageEditor` — a textarea pre-filled with the original text. The user modifies the text and submits via "Save & Send" or Enter. Escape or "Cancel" dismisses the editor.
2. **Retry**: Clicking the refresh icon immediately resends the same message text without opening the editor.
3. **On submit (edit or retry)**: `App.tsx`'s `handleEditMessage(index, newText)` truncates the `messages` array to before the edited message, appends a new user message with the (possibly modified) text, and sends it via `send_message`. All messages after the edited one (including Claude's responses) are removed from the UI.
4. **Claude context**: Since the CLI uses `--resume`, Claude retains its full conversation history server-side. The edited/retried message is sent as a new turn. This means Claude sees the full prior conversation plus the new message — it doesn't "forget" earlier messages that were removed from the UI.

### Key Design Decisions

- **No server changes**: Editing is purely a client-side operation. No new WebSocket message types are needed.
- **Truncation, not replacement**: Rather than trying to modify Claude's conversation history (which would require CLI-level support), we truncate the UI and send a new message. This is the same approach used by ChatGPT and similar UIs.
- **Buttons hidden during loading**: Edit/retry buttons are suppressed while Claude is responding to avoid conflicting sends.
- **Hover reveal**: Buttons use `group-hover:flex` to appear on hover, keeping the UI clean when not interacting.

### Key Files

- **`src/client/components/MessageList.tsx`** — `MessageEditor` component (inline textarea editor), edit/retry button rendering, `editingIndex` state.
- **`src/client/App.tsx`** — `handleEditMessage` callback: truncates messages and sends the new text.

## Project-Level System Prompt

Users can define a persistent system prompt that is sent to Claude with every message. This lets users encode project conventions, preferred libraries, and style guidelines without repeating them.

### Storage

The system prompt is stored at `/workspace/.shipit/system-prompt.md`. This keeps ShipIt config separate from user code while remaining git-trackable. If the file doesn't exist, no system prompt is sent (Claude CLI uses its default behavior, still picking up any top-level `CLAUDE.md`).

### How It Works

1. **Reading**: Before each Claude spawn (`send_message` or `answer_question`), the server reads `/workspace/.shipit/system-prompt.md`. If the file exists and contains non-empty content, it's passed as the `--system-prompt` argument to the Claude CLI.
2. **Writing**: The `set_system_prompt` handler validates content (string type, max 50KB), trims whitespace, creates the `.shipit` directory if needed, and writes the file. An empty/whitespace-only prompt deletes the file.
3. **UI**: A gear icon in the header opens the `SystemPromptEditor` modal. The icon is blue when a prompt is set, gray when empty. The modal includes a textarea with character count, save/cancel buttons, and keyboard shortcuts (Escape to close, Ctrl+Enter to save).

### Validation

- Content must be a string (rejects non-string types with an error)
- Maximum 50,000 characters (rejects with an error)
- Whitespace is trimmed before saving
- Empty/whitespace-only content deletes the file

### Key Files

- **`src/server/claude.ts`** — `run()` accepts optional `systemPrompt` parameter, passes `--system-prompt` to CLI.
- **`src/server/types.ts`** — `WsGetSystemPrompt`, `WsSetSystemPrompt`, `WsSystemPrompt`, `WsSystemPromptSaved` message types.
- **`src/server/index.ts`** — `readSystemPrompt()` helper, `get_system_prompt`/`set_system_prompt` handlers, passes system prompt to `claude.run()`.
- **`src/client/components/SystemPromptEditor.tsx`** — Modal editor with textarea, character count, save/cancel.
- **`src/client/App.tsx`** — State management (`systemPromptOpen`, `hasSystemPrompt`, `systemPromptContent`), gear icon in header, WS message handlers.

## Conversation Threads & Checkpoints

Users can create checkpoints (snapshots of conversation + git state) and fork from them to explore alternative approaches. Each thread has its own conversation history and git state.

### How It Works

1. **Checkpoints**: A checkpoint captures the current conversation message index and git commit hash. Users create checkpoints via the flag button in the `ThreadIndicator` UI. Checkpoints are stored within their parent thread's data.

2. **Forking**: Creating a thread from a checkpoint:
   - Snapshots the current thread data (to protect against git rollback — see below)
   - Rolls back the git working tree to the checkpoint's commit via `git reset --hard`
   - Restores the thread data snapshot (since the JSON file lives in the git-tracked workspace)
   - Creates a new thread record with the checkpoint as its parent
   - Truncates the chat history to the checkpoint's message index
   - The new thread becomes active

3. **Switching**: Switching to an existing thread rolls back git to that thread's parent checkpoint's commit (if it has one) and restores the corresponding chat history.

### Critical Design: Snapshot-Before-Rollback

Thread data files (`/workspace/.vibe-threads/{sessionId}.json`) live inside the git working tree. When `fork_thread` or `switch_thread` does `git reset --hard`, it reverts these files to their committed state. The solution:

```
1. Snapshot thread data in memory
2. Perform git reset --hard
3. Restore thread data from snapshot (ThreadManager.restore())
4. Continue with thread creation/switch
```

This pattern is used in both the `fork_thread` and `switch_thread` handlers in `index.ts`.

### Storage

- **Location**: `/workspace/.vibe-threads/{sessionId}.json`
- **Format**: JSON with `threads[]` and `activeThreadId`
- **Session ID sanitization**: Same pattern as `ChatHistoryManager` — non-alphanumeric characters (except `-` and `_`) replaced with `_`

### Key Files

- **`src/server/threads.ts`** — `ThreadManager` class: init, listThreads, createCheckpoint, forkThread, switchThread, restore, delete. JSON file persistence per session.
- **`src/server/types.ts`** — `ThreadInfo`, `CheckpointInfo` shared types; `WsCreateCheckpoint`, `WsForkThread`, `WsSwitchThread`, `WsListThreads` client messages; `WsCheckpointCreated`, `WsThreadList`, `WsThreadSwitched`, `WsThreadForked` server messages.
- **`src/server/index.ts`** — WS handlers for all four thread message types, thread data initialization on session create, cleanup on session delete.
- **`src/client/components/ThreadIndicator.tsx`** — Thread dropdown with thread switching, checkpoint creation input, fork-thread-from-checkpoint buttons.
- **`src/client/App.tsx`** — Thread state management (`threads`, `activeThreadId`), WS message handlers, callback wiring to `ThreadIndicator`.

## Build & Run

```bash
# Tests
npm test             # Run all tests (server + client)
npm run test:watch   # Watch mode

# Development (no Docker)
npm run dev          # tsx runs Fastify, serves pre-built client

# Development (with Vite HMR)
npx vite             # Port 5173, proxies /ws → localhost:3000

# Production (Docker)
docker compose up --build   # Builds + runs on port 3000
```
