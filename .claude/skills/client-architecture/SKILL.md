---
description: "ShipIt React client architecture: Zustand stores, communication hooks (useApi, useSessionWebSocket, useServerEvents, useMessageHandler), component inventory, data flow patterns. Load when working on frontend components, stores, hooks, or client state."
user-invocable: true
---

# Client Architecture

The client is a React 19 SPA built with Vite and Tailwind CSS v4. State management uses Zustand stores. Communication with the server uses three channels: HTTP for reads/mutations, per-session WebSocket for streaming and real-time interaction, and SSE for global broadcasts.

## Entry Point

`src/client/main.tsx` renders the app inside a `BrowserRouter` with an `ErrorBoundary`. Two route patterns:

- `/session/:sessionId` — session view
- `*` — catch-all (home screen, `/{slug}/new` for new repo sessions)

`src/client/App.tsx` (~800 lines) is the main component. It wires together all hooks, stores, and UI components. Layout is a three-panel design: sidebar (sessions), center (chat), right (preview/files/git/terminal).

## State Management (Zustand)

11 domain-specific stores in `src/client/stores/`:

| Store | File | Key State |
|-------|------|-----------|
| Session | `session-store.ts` | `sessionId`, `messages[]`, `isLoading`, `activity`, `sessions[]`, `authUrl`, `queuedMessages[]` |
| Git | `git-store.ts` | `commits[]`, `identity`, `turnDiff`, `lastCommitPair` |
| File | `file-store.ts` | `tree[]`, `viewingFile`, `viewingFileContent`, `docFiles[]` |
| Preview | `preview-store.ts` | `status`, `selectedPort`, `installStatus`, `crashInfo` |
| Terminal | `terminal-store.ts` | `entries[]`, `mode`, `shellStarted` |
| Thread | `thread-store.ts` | `threads[]`, `activeThreadId` |
| PR | `pr-store.ts` | `result`, `status`, `descGenerating` |
| Settings | `settings-store.ts` | `permissionMode`, `systemPromptContent`, `githubStatus`, `pendingFiles[]` |
| UI | `ui-store.ts` | `rightTab`, `templates[]`, `agentList`, `modelInfo`, `toast`, `features[]` |
| Repo | `repo-store.ts` | `repos[]`, `addRepoDialogOpen` |

### Patterns

- Stores are created with `create<StateType>((set, get) => ({...}))`.
- Each store has a `reset()` method for clearing session-specific state during session switching.
- Components subscribe to individual fields via selectors: `useSessionStore((s) => s.messages)`.
- Stores are updated directly — no centralized dispatcher. Handlers call `store.getState().setX(value)`.

### Session Actions

`src/client/stores/actions/session-actions.ts` contains cross-store coordination:

- `resetSessionState()` — clears session-specific stores (messages, git, files, preview, terminal, threads)
- `resumeSessionInternal(sessionId)` — reset + fetch history
- `handleSessionResume(sessionId, navigate)` — resume + navigate
- `newSession(navigate)` — reset all + navigate home
- `fullResetAllStores()` — nuclear reset (used after server full_reset_complete)

## Communication Hooks

### `useWebSocket` (base)

`src/client/hooks/useWebSocket.ts` — generic WebSocket hook.

- Connects when URL is provided, disconnects when URL is null
- Auto-reconnect with exponential backoff: 2s -> 4s -> 8s -> 16s -> 30s cap
- Returns `{ send, lastMessage, status, reconnectAttempt, reconnect }`
- `status`: `"connecting"` | `"open"` | `"closed"`

### `useSessionWebSocket`

`src/client/hooks/useSessionWebSocket.ts` — wraps `useWebSocket` for per-session connections.

- Connects to `/ws/sessions/{sessionId}?agent={savedAgent}` when sessionId is defined
- Returns null URL (disconnects) when sessionId is undefined
- Session switching triggers URL change -> old socket closes, new one opens

### `useApi`

`src/client/hooks/useApi.ts` — HTTP client.

- Methods: `get()`, `post()`, `patch()`, `put()`, `del()`
- Returns typed responses: `Promise<T>`
- Throws `ApiError(status, message)` on failure
- Used in App.tsx callbacks and store async actions

### `useServerEvents`

`src/client/hooks/useServerEvents.ts` — SSE connection for global broadcasts.

- Connects to `/api/events`, always active
- Handles: `session_list`, `session_started`, `repo_list`, `repo_status`, `repo_warm_ready`, `auth_required`, `agent_list`, `active_runners`, `full_reset_complete`
- Updates session, repo, UI, and settings stores

### `useMessageHandler`

`src/client/hooks/useMessageHandler.ts` — processes per-session WebSocket messages.

- Listens to `lastMessage` from `useSessionWebSocket`
- Parses `WsServerMessage` and routes to appropriate store updates
- Handles 20+ message types: `agent_event`, `preview_status`, `file_tree`, `git_log`, `chat_history`, `terminal_output`, etc.
- Discards stale messages (e.g., `preview_status` from a previous session)

### `useConnectionSync`

`src/client/hooks/useConnectionSync.ts` — initialization on mount and WS connect.

- On mount: `GET /api/bootstrap` -> populates session, repo, UI, settings stores
- On WS open: `GET /api/sessions/{id}/history` -> loads messages, commits, threads
- HTTP fallback: `GET /api/sessions/{id}/preview-status` (retries once after 3s if unknown)
- Sends pending WS message if stored

## Other Hooks

| Hook | File | Purpose |
|------|------|---------|
| `useAutoFix` | `useAutoFix.ts` | Monitors preview errors, auto-sends fix requests to Claude (3 retries, 5s cooldown) |
| `useKeyboardShortcuts` | `useKeyboardShortcuts.ts` | Ctrl+F (search), ? (shortcuts overlay), Esc (interrupt) |
| `useNotification` | `useNotification.ts` | Tab visibility tracking, browser notifications on agent finish |
| `useTheme` | `useTheme.ts` | Dark/light mode toggle (localStorage) |
| `useSearch` | `useSearch.ts` | Case-insensitive message search |
| `useResizablePanel` | `useResizablePanel.ts` | Drag-to-resize split panels |
| `usePreviewErrors` | `usePreviewErrors.ts` | Captures errors from preview iframe |
| `useMediaQuery` | `useMediaQuery.ts` | Mobile detection |

## Components

~40 components in `src/client/components/`. Major ones:

### Layout
- **`SessionSidebar`** — session list with rename/archive, repo grouping
- **`MobileTabBar`** — bottom tab navigation on mobile
- **`StatusBar`** — bottom bar with git branch, preview status
- **`ResizeHandle`** — drag handle between panels

### Chat
- **`MessageList`** — renders messages, tool calls, tool results, checkpoint dividers
- **`MessageInput`** — text input + image upload + file autocomplete + permission mode selector
- **`StreamingIndicator`** — activity label during Claude turns (thinking, writing, running)
- **`QueueIndicator`** — shows queued message count
- **`ToolResult`** — renders individual tool results (file diffs, bash output)
- **`DiffBlock`** — syntax-highlighted diff display
- **`TodoPanel`** — displays Claude's TodoWrite output
- **`AskUserQuestion`** — renders permission/question prompts from Claude

### Right Panel
- **`PreviewFrame`** — iframe for dev server preview + port selector + error display
- **`FileTree`** — workspace file browser with expand/collapse
- **`FileContentViewer`** — view/edit individual file contents
- **`GitHistory`** — commit timeline with diff viewer
- **`DiffPanel`** — file-by-file diff with accept/reject actions
- **`TerminalPanel`** — build logs display
- **`InteractiveTerminal`** — xterm.js shell (lazy loaded)
- **`DocsViewer`** — markdown file viewer
- **`FeaturesPanel`** — feature status dashboard
- **`ThreadTimeline`** — conversation checkpoint visualization

### Modals & Overlays
- **`AuthOverlay`** — Claude/GitHub authentication flows
- **`DeploymentStatusRow`** (in `PrLifecycleCard.tsx`) — shows deploy status from GitHub Deployments API
- **`PullRequestModal`** — create/merge PR
- **`Settings`** — git identity, system prompt, agent config
- **`UsageModal`** — cost/token breakdown
- **`KeyboardShortcutsOverlay`** — shortcut reference
- **`OnboardingWizard`** — first-time setup

### Home
- **`HomeScreen`** — session list, import repo, templates
- **`TemplateSelector`** — project template picker
- **`RepoSelector`** — repo selector with search
- **`AddRepoDialog`** — import GitHub repo dialog

## Data Flow: Sending a Message

```
User types in MessageInput -> handleSend() callback in App.tsx
  |
  +- If session exists:
  |    Add user message to session store
  |    Set isLoading
  |    WS send: { type: "send_message", text, sessionId, images?, files?, permissionMode? }
  |
  +- If no session (home page):
       POST /api/sessions { title }
       Store pending WS message
       Navigate to /session/{id}
       -> WS auto-connects -> useConnectionSync sends pending message
  |
  v
useMessageHandler receives WS responses:
  agent_event (assistant) -> append text to messages, update activity
  agent_event (tool_use)  -> show tool activity label
  agent_event (result)    -> mark complete, clear loading
  git_committed           -> update git store
  files_changed           -> refresh file tree
  preview_status          -> update preview store
```

## Local Storage

| Key | Purpose |
|-----|---------|
| `shipit-theme` | Dark/light mode |
| `vibe-permission-mode` | Auto/plan/normal permission mode |
| `vibe-sidebar-collapsed` | Sidebar collapsed state |
| `vibe-agent-id` | Preferred agent (claude/codex) |
| `vibe-panel-split` | Right panel split ratio |

## Styling

Tailwind CSS v4 with dark-mode-only color scheme (gray-950 backgrounds). Custom animations defined in `src/client/index.css`: typing-bounce, spin-slow, resize-handle cursor. All components use utility classes directly — no CSS modules or styled-components.
