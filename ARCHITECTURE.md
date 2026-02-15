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
| `markdown.ts` | `findMarkdownFiles` — recursive `.md` file scanner (skips node_modules, .git) |
| `vite-manager.ts` | `ViteManager` class — Vite dev server lifecycle (start, stop, restart) |
| `types.ts` | Shared TypeScript types for all WebSocket and Claude event payloads |

The server is intentionally thin — it's a bridge between the browser and the Claude CLI. No database, no REST API.

### Frontend (`src/client/`)

| File | Role |
|------|------|
| `App.tsx` | Root component — chat state, session tracking, tab management, resizable layout, event dispatch |
| `hooks/useWebSocket.ts` | WebSocket lifecycle (connect, reconnect, send/receive JSON) |
| `hooks/useResizablePanel.ts` | Drag-to-resize logic for the two-column layout (persists to localStorage) |
| `hooks/useSearch.ts` | Chat search logic — substring matching, match navigation, state management |
| `components/ResizeHandle.tsx` | Vertical drag handle rendered between the chat and preview/docs panels |
| `components/MessageList.tsx` | Renders chat messages, tool invocations, streaming indicators |
| `components/StreamingIndicator.tsx` | Typing dots, thinking indicator, tool spinner, activity label derivation |
| `components/DiffBlock.tsx` | Inline file change diff display (red/green lines for Edit and Write tools) |
| `components/MessageInput.tsx` | Auto-resizing textarea, Enter-to-send, activity status bar |
| `components/PreviewFrame.tsx` | iframe pointing to Vite dev server with reload button |
| `components/DocsViewer.tsx` | Markdown file browser and renderer (using `marked`) |
| `components/GitHistory.tsx` | Collapsible git commit list with rollback buttons |
| `components/SessionSelector.tsx` | Session management — list, resume, new, delete |
| `components/SearchBar.tsx` | Search input with match count, prev/next navigation, keyboard shortcuts |
| `components/ErrorBoundary.tsx` | React Error Boundary — catches unhandled render errors, shows fallback with reload/recover |
| `components/ConnectionBanner.tsx` | Full-width banner shown when WebSocket is disconnected or reconnecting |
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

### Server → Client Messages

| Type | Fields | Purpose |
|------|--------|---------|
| `claude_event` | `event` | Relayed Claude CLI NDJSON event |
| `error` | `message` | Error description |
| `preview_status` | `running`, `port`, `url` | Vite dev server status |
| `git_log` | `commits[]` | Full git commit history |
| `git_committed` | `hash`, `message` | New auto-commit after Claude turn |
| `rollback_complete` | `commitHash` | Rollback succeeded |
| `auth_required` | `url` | OAuth URL for user to authenticate |
| `auth_complete` | — | OAuth flow finished |
| `session_list` | `sessions[]` | List of saved sessions |
| `session_started` | `session` | Session created or resumed |
| `doc_list` | `files[]` | List of markdown file paths |
| `doc_content` | `path`, `content` | Raw markdown file content |

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

### Adding Another Resizable Split

To add a vertical (top/bottom) or additional horizontal split:
1. Use the same `useResizablePanel` hook with a different `storageKey`.
2. For vertical splits, the hook would need modification to track `clientY` / `rect.height` instead of `clientX` / `rect.width`.

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

### 2. WebSocket Disconnection During Streaming

When the WebSocket connection drops while Claude is actively responding (`isLoading === true`), `App.tsx` detects the status transition from `"open"` to `"closed"` and:
1. Marks any in-flight streaming message as `streaming: false`
2. Appends an error message (`isError: true`) explaining the connection was lost
3. Clears `isLoading` and `activity` so the UI isn't stuck

The `ConnectionBanner` component (`src/client/components/ConnectionBanner.tsx`) provides a persistent full-width banner below the header whenever the WebSocket is in `"closed"` or `"connecting"` state, so the user always knows the connection status at a glance.

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
