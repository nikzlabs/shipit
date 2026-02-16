# Next Phase: High-Impact Features

Design docs live in `docs/design/`. Each feature must satisfy the [quality checklist in CLAUDE.md](../CLAUDE.md#quality-checklist-run-before-marking-a-task-done) plus its own feature-specific requirements below.

## Feature 1: Usage & Cost Tracking Dashboard (`docs/design/001-usage-cost-tracking.md`)

Surface the `total_cost_usd` and `duration_ms` fields from `ClaudeResultEvent` (currently ignored) into a per-session and cumulative cost view.

- [ ] `UsageManager` class (`src/server/usage.ts`) — persists per-turn cost/duration to `/workspace/.shipit-usage.json`
- [ ] Record cost in `index.ts` when `event.type === "result"` carries `total_cost_usd`
- [ ] WS messages: `get_usage_stats` → `usage_stats`, server-push `usage_update` after each turn
- [ ] Cost badge in header showing current session spend (e.g. `$0.42`)
- [ ] `UsageModal` component with session breakdown, triggered by clicking the badge
- [ ] Unit tests for `UsageManager` (record, aggregate, delete)
- [ ] Integration tests for `get_usage_stats` happy-path and error-path
- [ ] Component tests for `UsageModal` (zero usage, multiple sessions, close)
- [ ] Handle `total_cost_usd` being `undefined` (older CLI) and `0` gracefully

## Feature 2: Project-Level System Prompt (`docs/design/002-system-prompt.md`)

Let users set persistent project instructions passed to every Claude invocation via `--system-prompt`. Stored at `/workspace/.shipit/system-prompt.md`.

- [ ] Extend `ClaudeProcess.run()` to accept optional `systemPrompt` parameter
- [ ] Read system prompt file in `index.ts` before each Claude spawn
- [ ] WS messages: `get_system_prompt` → `system_prompt`, `set_system_prompt` → `system_prompt_saved`
- [ ] Validate `set_system_prompt`: string type, max 50KB, trim whitespace, empty deletes file
- [ ] `SystemPromptEditor` modal component with character count and save/cancel
- [ ] Gear icon in header with active-state indicator when prompt is set
- [ ] Integration tests for get/set round-trip and empty-prompt edge case
- [ ] Component tests for editor (empty state, existing prompt, save, cancel, character count)

## Feature 3: File Watcher with Live Updates (`docs/design/003-file-watcher.md`)

Use `fs.watch` (recursive) to detect workspace file changes and push real-time notifications to clients. Auto-refresh file tree and viewer.

- [ ] `FileWatcher` class (`src/server/file-watcher.ts`) — recursive watch, 300ms debounce, ignore `node_modules`/`.git`/etc.
- [ ] Wire into `index.ts`: start on app build, broadcast `files_changed` on change events
- [ ] Server-push WS message: `files_changed` with `{ paths: string[] }`
- [ ] Client auto-refreshes file tree when Files tab is active and changes arrive
- [ ] Client auto-refreshes viewed file content when that file changes
- [ ] Change-count badge on Files tab (same pattern as Terminal unread badge)
- [ ] `StubFileWatcher` for tests with `simulateChanges()` method
- [ ] Unit tests for debounce behavior, ignore patterns, start/stop lifecycle
- [ ] Integration test: simulate file changes via stub, verify `files_changed` received

## Feature 4: Inline Tool Result Rendering (`docs/design/004-tool-result-rendering.md`)

Parse tool results from `ClaudeUserEvent` content blocks (currently discarded) and display them inline, paired with their tool invocations.

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
