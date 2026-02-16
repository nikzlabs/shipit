# CLAUDE.md

## Setup

```bash
npm install
```

## Commands

- `npm test` — run all tests (vitest). **Requires `npm install` first.**
- `npm run lint` — ESLint on `src/`
- `npm run typecheck` — TypeScript type checking (`tsc --noEmit`)
- `npm run dev` — start dev server (tsx)
- `npm run build:client` — build client with Vite

Run a single test file:

```bash
npx vitest run src/server/git.test.ts
```

## Project structure

```
src/
  server/          Fastify backend with WebSocket at /ws
    index.ts       Entry point — buildApp() with dependency injection
    claude.ts      Spawns Claude CLI as child process (NDJSON streaming)
    git.ts         GitManager — init, autoCommit, log, rollback
    sessions.ts    SessionManager — persists session metadata to JSON
    chat-history.ts ChatHistoryManager — per-session message persistence
    auth.ts        AuthManager — Claude CLI OAuth flow
    vite-manager.ts ViteManager — spawns/manages Vite dev server
    file-tree.ts   scanFileTree() — workspace directory listing
    markdown.ts    findMarkdownFiles() — docs discovery
    port-scanner.ts Port detection for dev server previews
    types.ts       All shared types (ClaudeEvent, WsClientMessage, WsServerMessage, etc.)
  client/          React 19 frontend (Vite + Tailwind CSS v4)
    App.tsx        Main orchestrator — responsive split-panel layout
    components/    UI components (MessageList, FileTree, PreviewFrame, etc.)
    hooks/         Custom hooks (useWebSocket, useSearch, useResizablePanel, etc.)
    index.css      Tailwind imports + custom animations
    test-setup.ts  Imports @testing-library/jest-dom/vitest
```

## Architecture

- **Server**: Fastify with a single WebSocket route (`/ws`). All client-server communication is over WebSocket using JSON messages. Message types defined in `src/server/types.ts`.
- **Client**: React 19 SPA. State lives in `App.tsx`. WebSocket communication via `useWebSocket` hook.
- **Dependency injection**: `buildApp()` accepts an `AppDeps` object so tests can inject stubs/fakes instead of real processes.
- **Process management**: Claude CLI, Vite, and git are managed via child processes. Claude and Vite managers extend `EventEmitter`.

## Code conventions

- **ESM throughout** — `"type": "module"` in package.json. Use `.js` extensions in relative imports (e.g., `import { foo } from "./bar.js"`).
- **Type imports** — use `import type { X } from "./path.js"` for type-only imports.
- **Node built-ins** — use `node:` prefix (e.g., `import fs from "node:fs"`).
- **Naming** — classes: PascalCase, functions: camelCase, events/WS message types: snake_case, constants: UPPER_SNAKE_CASE.
- **React** — functional components only, hooks for all state/effects. React 19 JSX transform (no `import React` needed).
- **Styling** — Tailwind CSS v4 utility classes. Dark-mode-only color scheme (gray-950 backgrounds).
- **Strict TypeScript** — `strict: true` in tsconfig. Target ES2022, module ESNext with bundler resolution.

## Testing conventions

Tests use Vitest with two project configs in `vitest.config.ts`:
- **Server tests** (`src/server/**/*.test.ts`) — Node environment
- **Client tests** (`src/client/**/*.test.{ts,tsx}`) — jsdom environment with React Testing Library

Key patterns:
- **Server tests** use temp directories (`fs.mkdtempSync`) cleaned up in `afterEach` with `fs.rmSync(tmpDir, { recursive: true, force: true })`.
- **Integration tests** use `buildApp()` with injected stubs — `StubViteManager`, `StubAuthManager`, `FakeClaudeProcess` (all extend EventEmitter). Server listens on port 0 (ephemeral). A `TestClient` helper class handles WebSocket message buffering.
- **Client component tests** use `render()` from `@testing-library/react` with `cleanup` in `afterEach`.
- **Client hook tests** use `renderHook()` with `FakeWebSocket` (stubbed via `vi.stubGlobal`) and `vi.useFakeTimers()`.
- **Mocking** — `vi.mock()` for module mocks, `vi.fn()` for function spies, manual stub/fake classes for complex dependencies. ESLint allows `any` in test files.
- **Assertions** — `toMatchObject()` for partial WS message matching, `toEqual()` for exact structure, `@testing-library/jest-dom` matchers for DOM.

## Quality checklist (run before marking a task done)

Every new feature must satisfy these before it's considered complete:

1. **Input validation at system boundaries** — WebSocket handlers must validate user-supplied strings (empty, whitespace-only, too long) and return `{ type: "error" }`. Never trust client input.
2. **Component tests for new UI** — every new React component (or significant UI addition to an existing component) needs a `*.test.tsx` file with `@testing-library/react`. Cover the happy path, edge cases (empty input, escape/cancel), and callback wiring.
3. **Blur/focus edge cases** — inline editors that save on blur must handle the case where blur is triggered by a parent element (e.g. backdrop dismiss) that *cancels* the edit. Use a ref guard to prevent double-fire.
4. **Integration tests for new WS messages** — every new `WsClientMessage` type needs at least one happy-path and one error-path integration test in `src/server/integration.test.ts`.

## Next phase: high-impact features

Design docs live in `docs/design/`. Each feature below must satisfy the quality checklist above plus its own feature-specific requirements.

### Feature 1: Usage & Cost Tracking Dashboard (`docs/design/001-usage-cost-tracking.md`)

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

### Feature 2: Project-Level System Prompt (`docs/design/002-system-prompt.md`)

Let users set persistent project instructions passed to every Claude invocation via `--system-prompt`. Stored at `/workspace/.shipit/system-prompt.md`.

- [ ] Extend `ClaudeProcess.run()` to accept optional `systemPrompt` parameter
- [ ] Read system prompt file in `index.ts` before each Claude spawn
- [ ] WS messages: `get_system_prompt` → `system_prompt`, `set_system_prompt` → `system_prompt_saved`
- [ ] Validate `set_system_prompt`: string type, max 50KB, trim whitespace, empty deletes file
- [ ] `SystemPromptEditor` modal component with character count and save/cancel
- [ ] Gear icon in header with active-state indicator when prompt is set
- [ ] Integration tests for get/set round-trip and empty-prompt edge case
- [ ] Component tests for editor (empty state, existing prompt, save, cancel, character count)

### Feature 3: File Watcher with Live Updates (`docs/design/003-file-watcher.md`)

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

### Feature 4: Inline Tool Result Rendering (`docs/design/004-tool-result-rendering.md`)

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
