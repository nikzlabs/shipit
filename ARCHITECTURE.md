# Vibe — High-Level Architecture

## What Is This?

Vibe is a browser-based IDE for "vibe coding" — you talk to Claude in a chat interface and it writes code in real-time inside a Docker container. Think of it as a hosted Claude Code session with a React frontend.

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
| `port-scanner.ts` | Port auto-detection — `checkPort`, `scanPorts`, `detectDevServer` for finding non-Vite dev servers |
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
| `components/ResizeHandle.tsx` | Vertical drag handle rendered between the chat and preview/docs panels |
| `components/MessageList.tsx` | Renders chat messages, tool invocations, streaming indicators |
| `components/StreamingIndicator.tsx` | Typing dots, thinking indicator, tool spinner, activity label derivation |
| `components/DiffBlock.tsx` | Inline file change diff display (red/green lines for Edit and Write tools) |
| `components/MessageInput.tsx` | Auto-resizing textarea, Enter-to-send, activity status bar |
| `components/PreviewFrame.tsx` | iframe pointing to dev server (Vite or auto-detected) with reload button and source indicator |
| `components/DocsViewer.tsx` | Markdown file browser and renderer (using `marked`) |
| `components/FileTree.tsx` | Workspace file tree browser — expandable/collapsible directory tree with folder/file icons |
| `components/GitHistory.tsx` | Collapsible git commit list with rollback buttons |
| `components/SessionSelector.tsx` | Session management — list, resume, new, delete |
| `components/SearchBar.tsx` | Search input with match count, prev/next navigation, keyboard shortcuts |
| `components/ErrorBoundary.tsx` | React Error Boundary — catches unhandled render errors, shows fallback with reload/recover |
| `components/ConnectionBanner.tsx` | Full-width banner for WebSocket state — disconnected (with attempt count + "Reconnect now"), reconnecting, and brief "Reconnected" success flash |
| `components/MobileTabBar.tsx` | Bottom navigation bar for mobile: switch between Chat and Preview panels |
| `components/AuthOverlay.tsx` | Full-screen overlay for OAuth authentication flow |

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
| `list_docs` | — | List `.md` files in /workspace |
| `get_doc` | `path` | Request content of a markdown file |
| `get_chat_history` | `sessionId` | Request persisted chat messages for a session |
| `get_file_tree` | — | Request workspace directory tree |

### Server → Client Messages

| Type | Fields | Purpose |
|------|--------|---------|
| `claude_event` | `event` | Relayed Claude CLI NDJSON event |
| `error` | `message` | Error description |
| `preview_status` | `running`, `port`, `url`, `source?` | Dev server status — `source` is `"vite"` (managed), `"detected"` (port scan), or omitted (not running) |
| `git_log` | `commits[]` | Full git commit history |
| `git_committed` | `hash`, `message` | New auto-commit after Claude turn |
| `rollback_complete` | `commitHash` | Rollback succeeded |
| `auth_required` | `url` | OAuth URL for user to authenticate |
| `auth_complete` | — | OAuth flow finished |
| `session_list` | `sessions[]` | List of saved sessions |
| `session_started` | `session` | Session created or resumed |
| `doc_list` | `files[]` | List of markdown file paths |
| `doc_content` | `path`, `content` | Raw markdown file content |
| `chat_history` | `sessionId`, `messages[]` | Persisted chat messages for a session |
| `file_tree` | `tree[]` | Workspace directory tree (array of `FileTreeNode`) |

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
| Ctrl+F / Cmd+F | Open / close search bar |
| Enter | Go to next match |
| Shift+Enter | Go to previous match |
| Escape | Close search bar |

### CSS Classes (`index.css`)

- `.search-highlight` — semi-transparent yellow background on all matches
- `.search-highlight--current` — brighter yellow with dark text on the actively navigated match

### Key Design Decisions

- **Client-side only** — no server involvement; search runs entirely in the browser against the in-memory `messages` array.
- **Substring match** — simple `indexOf` loop rather than regex, so user input is treated as literal text (no escaping issues).
- **Scroll-to-match** — uses `scrollIntoView({ block: "center" })` so the current match appears centered in the chat scroll area.
- **Match index clamping** — when the messages array changes (new messages arrive) and the match count shrinks, the current index is automatically clamped to stay in bounds.

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

- The `session_id` comes from the first `system.init` event
- Subsequent messages include it so the server passes `--resume <id>` to the CLI
- This preserves full conversation context across turns
- Sessions live as long as the container's Claude auth is valid

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

## Preview Port Auto-Detection

The preview pane works with any dev server, not just Vite. After each Claude turn, the server scans common dev ports to find running servers that Claude may have started (e.g., Express on 3001, Django on 8000).

### How It Works

1. **`port-scanner.ts`** provides three functions:
   - `checkPort(port)` — TCP connect probe with 300ms timeout. Returns `true` if a server is listening.
   - `scanPorts(ports, excludePorts)` — Checks multiple ports concurrently, returns the list of open ones.
   - `detectDevServer(excludePorts)` — Scans `DEFAULT_SCAN_PORTS` and returns the first open port, or `null`.

2. **After each Claude turn** (`done` event in `index.ts`), the server calls `detectPort()` (defaulting to `detectDevServer`), excluding the Fastify server port and the managed Vite port.

3. **Priority logic** in `getPreviewStatus()`:
   - If Vite is running → use Vite (source: `"vite"`)
   - Else if a port was detected → use that port (source: `"detected"`)
   - Else → not running

4. **The client** receives `preview_status` with the `source` field and shows:
   - A green badge for Vite, yellow badge for auto-detected servers
   - An "(auto-detected)" label in the preview bar

### Scanned Ports

`DEFAULT_SCAN_PORTS`: 3001, 4000, 4200, 5000, 5173, 5174, 8000, 8080, 8888

Port 3000 is excluded because it's the Vibe server's own port. The managed Vite port (5173) is also excluded from scanning when Vite is already running.

### Dependency Injection

The `detectPort` function is injectable via `AppDeps` for testing. Integration tests inject a stub that returns a controlled port number, avoiding real TCP scanning.

### Key Files

- **`src/server/port-scanner.ts`** — Port scanning utilities.
- **`src/server/index.ts`** — Integration: calls `detectPort` in the `done` handler, `getPreviewStatus()` for building preview messages.
- **`src/client/components/PreviewFrame.tsx`** — Shows source indicator and updated placeholder text.
- **`src/client/App.tsx`** — Passes `source` through to `PreviewFrame`.

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
- **`workspace`** → `/workspace` — the project files Claude reads/writes
- **`claude-auth`** → `/root/.claude` — CLI OAuth credentials

The Dockerfile installs Claude Code CLI globally, pre-builds the React frontend, and initializes a git repo in `/workspace`.

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
