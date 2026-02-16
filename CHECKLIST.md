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
- [ ] `FileWatcher` class (`src/server/file-watcher.ts`) — recursive watch, 300ms debounce, ignore `node_modules`/`.git`/etc.
- [ ] Wire into `index.ts`: start on app build, broadcast `files_changed` on change events
- [ ] Server-push WS message: `files_changed` with `{ paths: string[] }`
- [ ] Client auto-refreshes file tree when Files tab is active and changes arrive
- [ ] Client auto-refreshes viewed file content when that file changes
- [ ] Change-count badge on Files tab (same pattern as Terminal unread badge)
- [ ] `StubFileWatcher` for tests with `simulateChanges()` method
- [ ] Unit tests for debounce behavior, ignore patterns, start/stop lifecycle
- [ ] Integration test: simulate file changes via stub, verify `files_changed` received

### Feature 4: Inline Tool Result Rendering (`docs/design/004-tool-result-rendering.md`)
- [ ] Parse `tool_result` blocks from `event.type === "user"` in `App.tsx` (currently only sets activity label)
- [ ] Attach `ToolResultBlock[]` to the preceding assistant message by matching `tool_use_id`
- [ ] `ToolResult` component (`src/client/components/ToolResult.tsx`) with tool-specific renderers:
  - `BashResult` — monospace output, red highlight on error, truncated at 30 lines with expand
  - `ReadResult` — syntax-highlighted file content preview, truncated at 20 lines
  - `GrepResult` — structured file/line matches
  - `GenericResult` — plain monospace fallback
- [ ] Collapsible by default; expand/collapse toggle on each tool use item
- [ ] Component tests for each renderer (normal output, error output, empty, long output truncation)
- [ ] Handle missing `tool_use_id` match, binary content, and outputs >1MB gracefully

## Nice to Have
- [ ] Multi-file diff view — when Claude edits multiple files in one turn, show a grouped diff summary
- [ ] Dark/light theme
- [ ] Export conversation
