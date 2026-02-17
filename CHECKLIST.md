# Implementation Checklist

## Phase 1: Skeleton
- [x] Docker setup — Dockerfile, docker-compose.yml
- [x] Fastify backend with WebSocket — spawn Claude CLI, parse NDJSON, relay events
- [x] Minimal React frontend — chat input, message display, WebSocket connection

## Phase 2: Preview
- [x] Vite dev server manager — spawn as child process serving /workspace
- [x] Preview iframe in frontend

## Phase 3: Git & History
- [x] Git integration — auto-commit after each turn
- [x] Git history panel in UI
- [x] Rollback functionality

## Phase 4: Polish
- [x] OAuth flow detection and browser redirect
- [x] Session management (list, resume, new)
- [x] Docs tab (markdown viewer)
- [x] Inline file change display in chat (diff blocks)
- [x] Streaming UX polish (typing indicators, partial renders)

## Phase 5: Next Up
- [x] Resizable panels
- [x] Search in chat history
- [x] Test coverage — Vitest, 236 tests across server/client modules + integration

## Phase 6: Test Depth
- [x] Component-level tests — React component tests (MessageList, DiffBlock, GitHistory) with @testing-library/react
- [x] Integration/E2E tests — full WebSocket flow from client to server, Fastify test harness (19 tests via `buildApp()` DI)
- [x] Error boundary / error state UI — handle WebSocket drops and Claude CLI crashes mid-stream
- [x] Mobile responsiveness — resizable panel layout adaptation for mobile viewports
- [x] Reconnection UI — visible indicator of WebSocket connection state

## Phase 7: UX & Beyond
- [x] Persistent chat history — persist messages to the server so they survive page reloads
- [x] File tree sidebar — show the /workspace file tree alongside the preview
- [x] Preview port auto-detection — detect when a non-Vite dev server starts on a different port
- [x] Notification when Claude finishes — browser notification or tab title change for background tabs
- [x] Code block syntax highlighting — add highlight.js or shiki for code blocks in Claude responses
- [x] Keyboard shortcuts help — a `?` overlay showing all available shortcuts
- [x] Message editing/retry — let users edit and resend previous prompts
- [x] Preview port selector — when multiple ports are detected, let the user choose which one to preview (currently shows first found)
- [x] Periodic port scanning — scan on an interval, not just after Claude turns, to catch servers started via Bash tool mid-turn
- [x] File content viewer — clicking a file in the Files tab could show its contents in a read-only viewer
- [x] Terminal/logs panel — show Claude CLI stdout/stderr in a terminal-like pane for debugging
- [x] Session rename — currently titles are auto-generated from the first message
- [x] Workspace project templates — quick-start templates (Vite + React, Next.js, Express) to avoid the cold-start friction

## Phase 8: High-Impact Features

Design docs in `docs/design/`.

### Feature 1: Usage & Cost Tracking Dashboard (`docs/design/001-usage-cost-tracking.md`)
- [x] `UsageManager` class (`src/server/usage.ts`) — persists per-turn cost/duration to `/workspace/.shipit-usage.json`
- [x] Record cost in `index.ts` when `event.type === "result"` carries `total_cost_usd`
- [x] WS messages: `get_usage_stats` → `usage_stats`, server-push `usage_update` after each turn
- [x] Cost badge in header showing current session spend (e.g. `$0.42`)
- [x] `UsageModal` component with session breakdown, triggered by clicking the badge
- [x] Unit tests for `UsageManager` (record, aggregate, delete)
- [x] Integration tests for `get_usage_stats` happy-path and error-path
- [x] Component tests for `UsageModal` (zero usage, multiple sessions, close)
- [x] Handle `total_cost_usd` being `undefined` (older CLI) and `0` gracefully

### Feature 2: Project-Level System Prompt (`docs/design/002-system-prompt.md`)
- [x] Extend `ClaudeProcess.run()` to accept optional `systemPrompt` parameter
- [x] Read system prompt file in `index.ts` before each Claude spawn
- [x] WS messages: `get_system_prompt` → `system_prompt`, `set_system_prompt` → `system_prompt_saved`
- [x] Validate `set_system_prompt`: string type, max 50KB, trim whitespace, empty deletes file
- [x] `SystemPromptEditor` modal component with character count and save/cancel
- [x] Gear icon in header with active-state indicator when prompt is set
- [x] Integration tests for get/set round-trip and empty-prompt edge case
- [x] Component tests for editor (empty state, existing prompt, save, cancel, character count)

### Feature 3: File Watcher with Live Updates (`docs/design/003-file-watcher.md`)
- [x] `FileWatcher` class (`src/server/file-watcher.ts`) — recursive watch, 300ms debounce, ignore `node_modules`/`.git`/etc.
- [x] Wire into `index.ts`: start on app build, broadcast `files_changed` on change events
- [x] Server-push WS message: `files_changed` with `{ paths: string[] }`
- [x] Client auto-refreshes file tree when Files tab is active and changes arrive
- [x] Client auto-refreshes viewed file content when that file changes
- [x] Change-count badge on Files tab (same pattern as Terminal unread badge)
- [x] `StubFileWatcher` for tests with `simulateChanges()` method
- [x] Unit tests for debounce behavior, ignore patterns, start/stop lifecycle
- [x] Integration test: simulate file changes via stub, verify `files_changed` received

### Feature 4: Inline Tool Result Rendering (`docs/design/004-tool-result-rendering.md`)
- [x] Parse `tool_result` blocks from `event.type === "user"` in `App.tsx` (currently only sets activity label)
- [x] Attach `ToolResultBlock[]` to the preceding assistant message by matching `tool_use_id`
- [x] `ToolResult` component (`src/client/components/ToolResult.tsx`) with tool-specific renderers:
  - `BashResult` — monospace output, red highlight on error, truncated at 30 lines with expand
  - `ReadResult` — syntax-highlighted file content preview, truncated at 20 lines
  - `GrepResult` — structured file/line matches
  - `GenericResult` — plain monospace fallback
- [x] Collapsible by default; expand/collapse toggle on each tool use item
- [x] Component tests for each renderer (normal output, error output, empty, long output truncation)
- [x] Handle missing `tool_use_id` match, binary content, and outputs >1MB gracefully

### Feature 5: Image & Screenshot Input (`docs/design/005-image-input.md`)
- [x] Extend `send_message` with optional `images` array (base64 + mediaType + filename)
- [x] Server-side validation: MIME whitelist, 5 MB per image, max 5 per message, 20 MB total
- [x] Pass images to Claude CLI as base64 content blocks via stdin
- [x] `MessageInput` enhancements: drag-and-drop, Ctrl+V paste, file picker, inline thumbnails with × remove
- [x] Drop zone overlay on chat panel with "Drop image here" indicator
- [x] `MessageList` renders image thumbnails in user messages (clickable lightbox with full-size preview)
- [x] Persist images in chat history for reload survival
- [x] Component tests for MessageInput (drag-and-drop, paste, thumbnails, remove, send with images)
- [x] Component tests for MessageList image rendering and ImageLightbox (open/close/backdrop/escape)
- [x] Integration tests for `send_message` with images (happy path, invalid MIME, too many, oversized, persistence)

### Feature 6: Preview Error Capture & Auto-Debug Loop (`docs/design/006-preview-error-capture.md`)
- [x] Vite plugin to inject error-capture script (`window.onerror`, `console.error` → `postMessage`)
- [x] `usePreviewErrors` hook — listen for postMessage events, deduplicate, rolling buffer
- [x] Error badge on Preview tab (red, same pattern as terminal unread badge)
- [x] Expandable error panel at bottom of preview with stack traces
- [x] "Send to Claude" button composing error details into a chat message
- [x] "Auto-fix" toggle with safety guardrails (max 3 retries, 5s cooldown, kill switch)
- [x] Preview errors forwarded to Terminal tab with `"preview"` source (orange color)
- [x] Component tests for `usePreviewErrors` (dedup, buffer limits) and PreviewFrame error UI
- [x] Integration test for `preview_error` relay to terminal log buffer

### Feature 7: Conversation Threads & Checkpoints (`docs/design/007-conversation-branching.md`)
- [x] `ThreadManager` class (`src/server/threads.ts`) — persist to `/workspace/.vibe-threads/`
- [x] WS messages: `create_checkpoint`, `fork_thread`, `switch_thread`, `list_threads`
- [x] Auto-checkpoint before message edit/retry
- [x] Conversation replay as system prompt when forking (clean context for new CLI session)
- [x] Git rollback to checkpoint commit on thread switch
- [x] `ThreadIndicator` component — thread dropdown, checkpoint button in header
- [x] Timeline view in GitHistory area with checkpoint nodes and color-coded threads
- [x] Checkpoint dividers in chat ("Checkpoint: before refactor")
- [x] Unit tests for `ThreadManager` (create, list, switch, persistence)
- [x] Integration tests for full thread workflow (messages → checkpoint → fork → verify)
- [x] Component tests for ThreadIndicator and timeline view

### Feature 8: Inline File Editing (`docs/design/008-inline-file-editing.md`)
- [ ] Add CodeMirror 6 dependency (`codemirror`, `@codemirror/lang-*`, `@codemirror/theme-one-dark`)
- [ ] Replace read-only `<pre><code>` in FileContentViewer with CodeMirror 6 editor
- [ ] Toggle between read-only and edit mode (pencil icon)
- [ ] Save via Ctrl+S / Cmd+S → `save_file` WS message → server writes + auto-commits
- [ ] Unsaved indicator (dot on filename), auto-save on tab/file switch
- [ ] Conflict dialog when Claude edits the same file user has open
- [ ] Server `save_file` handler with path traversal guard, 1 MB limit, file-must-exist check
- [ ] Integration tests for `save_file` (write, auto-commit, path traversal rejection)
- [ ] Component tests for FileEditor (CodeMirror render, Ctrl+S, unsaved indicator, conflict dialog)

### Feature 9: Session Isolation (`docs/design/009-session-isolation.md`)
- [x] Docker: declare `VOLUME /workspace`, remove `git init` from Dockerfiles (runtime init via `GitManager`)
- [x] Per-session workspace directories under `/workspace/sessions/{sessionId}/` with own git repo
- [x] Refactor `buildApp()`: single `gitManager` → per-session `GitManager` factory; update `AppDeps` interface
- [x] `SessionManager` stores `workspaceDir` per session; creates directory + `git init` on session create
- [x] `ClaudeProcess.run()` accepts `cwd` parameter (5th positional arg) instead of hardcoded `/workspace`
- [x] `ViteManager.start()`/`restart()` accept `workspaceDir` parameter; restart on session switch
- [x] `GitHubAuthManager` supports per-session credential configuration (token in each session's git repo)
- [x] Server: replace hardcoded `WORKSPACE` — all file ops use per-connection `activeSessionDir` (null until session active)
- [x] Server: `apply_template` targets session directory; `delete_session` removes session directory
- [x] Server: path traversal guard on all file operations relative to session directory
- [x] `FileWatcher` restarts on session switch to watch the new session directory (single watcher, not per-connection)
- [x] Client: session switch refreshes file tree, git log, and closes open file viewer
- [x] Migration: sessions without `workspaceDir` fall back to `/workspace` (legacy shared workspace)
- [x] Integration tests for session isolation (two sessions with independent files, scoped rollback)
- [x] Handle edge cases: delete active session, missing session directory, multi-client, disk space

### Feature 10: Deployment Integration — Pluggable Targets (`docs/design/010-deployment-integration.md`)
- [ ] `DeployTarget` interface + types (`src/server/deploy-targets/deploy-target.ts`) — `ConfigField`, `DeployTargetInfo`, `DeployContext`, `DeployResult`
- [ ] `VercelTarget` (`src/server/deploy-targets/vercel.ts`) — `vercel deploy --yes --prod --token=xxx`, URL from stdout
- [ ] `CloudflareTarget` (`src/server/deploy-targets/cloudflare.ts`) — `wrangler pages deploy`, `prepare()` for project creation, URL regex extraction
- [ ] `DeploymentManager` registry + orchestrator (`src/server/deployment-manager.ts`) — target registration, framework detection, build, `deploy()` dispatch
- [ ] `DeploymentStore` (`src/server/deployment-store.ts`) — generic credential persistence (`Record<string, string>`), deployment history per session
- [ ] WS messages: `list_deploy_targets`, `deploy_configure`, `initiate_deploy`, `get_deploy_history`, `cancel_deploy`, `get_deploy_config`, `delete_deploy_config`
- [ ] Server WS handlers in `index.ts` — target-agnostic dispatch (validate `targetId` in registry, validate credentials against `configFields`)
- [ ] Framework auto-detection from `package.json` (Vite, Next.js, CRA, static site)
- [ ] Build step: run `npm run build` before deploy, stream output to terminal with `source: "deploy"`
- [ ] `DeployModal` component — dynamic config form from `configFields`, target picker, env selection, deploy trigger, progress, success/error states
- [ ] Deploy button in header with status indicator (idle, deploying spinner, last deploy green dot)
- [ ] Terminal panel: deploy logs with `source: "deploy"` in blue styling
- [ ] Deployment history display in modal (last N deployments with URLs, timestamps, status)
- [ ] "Send to Claude" on deploy errors (compose build/deploy error into chat message)
- [ ] Unit tests for `VercelTarget` and `CloudflareTarget` (mock spawn, verify CLI args, URL extraction)
- [ ] Unit tests for `DeploymentManager` (target registration, framework detection, build, dispatch)
- [ ] Unit tests for `DeploymentStore` (credential CRUD, history, session cleanup)
- [ ] Integration tests for deploy flow (configure → deploy → verify status/complete, unknown target, missing creds, deploy while deploying)
- [ ] Component tests for `DeployModal` (dynamic config fields, target picker, deploy trigger, progress, complete, error, history)

## Nice to Have
- [ ] Multi-file diff view — when Claude edits multiple files in one turn, show a grouped diff summary
- [ ] Export conversation
- [ ] Multi-client collaboration — shared session URLs with spectator/participant modes
