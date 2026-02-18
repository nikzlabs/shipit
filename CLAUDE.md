# CLAUDE.md

ShipIt is a browser-based IDE for vibe coding — chat with Claude, it writes code, you see results live. Powered by Claude Code CLI and your Claude subscription.

## Setup

```bash
npm install
```

## Commands

- `npm test` — run all tests (vitest). **Requires `npm install` first.**
- `npm run lint` — ESLint on `src/`
- `npm run typecheck` — TypeScript type checking (`tsc --noEmit`)
- `npm run dev` — start dev server (tsx)
- `npm run build` — build client with Vite

Run a single test file:

```bash
npx vitest run src/server/git.test.ts
```

## Project structure

```
src/
  server/          Fastify backend with WebSocket at /ws
    index.ts       Entry point — buildApp() with dependency injection
    claude.ts      ClaudeProcess — spawns CLI, parses NDJSON, emits events
    git.ts         GitManager — init, autoCommit, log, rollback
    sessions.ts    SessionManager — persists session metadata to JSON
    chat-history.ts ChatHistoryManager — per-session message persistence
    auth.ts        AuthManager — Claude CLI OAuth flow
    vite-manager.ts ViteManager — spawns/manages Vite dev server
    file-tree.ts   scanFileTree() — workspace directory listing
    file-watcher.ts FileWatcher — recursive fs.watch, debounced change events
    markdown.ts    findMarkdownFiles() — docs discovery
    port-scanner.ts Port detection for dev server previews
    usage.ts       UsageManager — per-turn cost/duration tracking
    threads.ts     ThreadManager — conversation threads and checkpoints
    templates.ts   Project scaffolding templates
    deployment-manager.ts  DeploymentManager — target registry, build, deploy dispatch
    deployment-store.ts    DeploymentStore — credentials and deploy history
    deploy-targets/        DeployTarget implementations (Vercel, Cloudflare)
    vite-error-plugin.ts   Injects error-capture script into preview HTML
    types.ts       All shared types (ClaudeEvent, WsClientMessage, WsServerMessage, etc.)
    integration_tests/  Integration tests — one file per feature area
      test-helpers.ts   Shared stubs (TestClient, FakeClaudeProcess, etc.)
  client/          React 19 frontend (Vite + Tailwind CSS v4)
    App.tsx        Main orchestrator — state, layout, WebSocket dispatch
    components/    UI components (MessageList, FileTree, PreviewFrame, etc.)
    hooks/         Custom hooks (useWebSocket, useSearch, useResizablePanel, etc.)
    index.css      Tailwind imports + custom animations
    test-setup.ts  Imports @testing-library/jest-dom/vitest
```

## Architecture

- **Server**: Fastify with a single WebSocket route (`/ws`). All client-server communication is over WebSocket using JSON messages. Message types defined in `src/server/types.ts`.
- **Client**: React 19 SPA. State lives in `App.tsx`. WebSocket communication via `useWebSocket` hook.
- **Dependency injection**: `buildApp()` accepts an `AppDeps` object so tests can inject stubs/fakes instead of real processes. All external dependencies (git, Claude CLI, Vite, port scanner, file watcher) are injectable.
- **Process management**: Claude CLI, Vite, and git are managed via child processes. Claude and Vite managers extend `EventEmitter`.
- **Session isolation**: Each session gets its own workspace directory (`/workspace/sessions/{uuid}/`) with independent git repo. Per-connection state tracks `activeSessionDir`.
- **Per-session GitManager**: `AppDeps.createGitManager` is a factory `(dir: string) => GitManager`. Each session gets its own instance.

For feature-specific details, see `docs/NNN-feature/plan.md`.

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
- **Integration tests** live in `src/server/integration_tests/` — one file per feature area. Shared stubs and helpers (`TestClient`, `StubViteManager`, `StubAuthManager`, `FakeClaudeProcess`, `StubFileWatcher`, `waitForClaude`) are in `test-helpers.ts`. Each test file uses `buildApp()` with injected stubs, listens on port 0 (ephemeral), and connects via the `TestClient` message-buffering WebSocket wrapper. When adding a new integration test, create a new file in this directory (or add to an existing one if the feature area matches) and import helpers from `./test-helpers.js`.
- **Client component tests** use `render()` from `@testing-library/react` with `cleanup` in `afterEach`.
- **Client hook tests** use `renderHook()` with `FakeWebSocket` (stubbed via `vi.stubGlobal`) and `vi.useFakeTimers()`.
- **Mocking** — `vi.mock()` for module mocks, `vi.fn()` for function spies, manual stub/fake classes for complex dependencies. ESLint allows `any` in test files.
- **Assertions** — `toMatchObject()` for partial WS message matching, `toEqual()` for exact structure, `@testing-library/jest-dom` matchers for DOM.
- **Testability** — modules accept optional constructor parameters for isolation: `SessionManager(sessionsFile?)`, `GitManager(workspaceDir?)`, `UsageManager(usageFile?)`, `ThreadManager(threadsDir?)`, `DeploymentStore(baseDir?)`.

## How to add a new WebSocket message type

1. Add the interface to `src/server/types.ts` (both `WsClientMessage` and/or `WsServerMessage` unions)
2. Add the handler in `src/server/index.ts` inside the `socket.on("message")` callback
3. Add the client-side handler in the `useEffect` in `src/client/App.tsx` that processes `lastMessage`
4. Wire up the UI component to call `send()` with the new message type
5. Add integration tests in `src/server/integration_tests/` (happy path + error path)
6. Update `docs/001-websocket-protocol/plan.md` with the new message

## How to add a new deploy target

1. Create a new file in `src/server/deploy-targets/` implementing the `DeployTarget` interface
2. Implement `info` (metadata + config fields) and `deploy(ctx)` method
3. Optionally implement `prepare(ctx)` for pre-deploy setup
4. Register the target in `index.ts` inside the `deploymentManager` initialization block
5. The UI automatically renders config fields from `info.configFields` — no client changes needed

## How to add a new tool activity label

Add a case to `activityFromTool()` in `src/client/components/StreamingIndicator.tsx`. The function receives the tool name and its input object, and returns a `StreamingActivity` with a human-readable label.

## Quality checklist (run before marking a task done)

Every new feature must satisfy these before it's considered complete:

1. **Input validation at system boundaries** — WebSocket handlers must validate user-supplied strings (empty, whitespace-only, too long) and return `{ type: "error" }`. Never trust client input.
2. **Component tests for new UI** — every new React component (or significant UI addition to an existing component) needs a `*.test.tsx` file with `@testing-library/react`. Cover the happy path, edge cases (empty input, escape/cancel), and callback wiring.
3. **Blur/focus edge cases** — inline editors that save on blur must handle the case where blur is triggered by a parent element (e.g. backdrop dismiss) that *cancels* the edit. Use a ref guard to prevent double-fire.
4. **Integration tests for new WS messages** — every new `WsClientMessage` type needs at least one happy-path and one error-path integration test in `src/server/integration_tests/`. Add to an existing file if the feature area matches, or create a new `<feature>.test.ts` file and import shared helpers from `./test-helpers.js`.
5. **Split slow test files** — if a single test file takes more than ~10 seconds to run, split it into smaller files by feature area so Vitest can parallelize them.

## Docs structure

```
docs/
  NNN-feature-name/
    plan.md        — How the feature works, key files, patterns
    checklist.md   — Remaining work (only exists if there's open work)
```

Features are numbered by creation order. When implementing or modifying a feature, read its `plan.md` first. When a feature has remaining work, check its `checklist.md`. When adding a new feature, create `docs/NNN-new-feature/plan.md`.

Every `plan.md` must have YAML frontmatter with a `status` field. Valid values: `planned`, `in-progress`, `done`, `paused`. The feature tracking system (`src/server/features.ts`) reads this frontmatter to display feature status in the UI. Example:

```yaml
---
status: in-progress
---
```

When creating a new feature doc, set `status: planned`. Update to `in-progress` when work begins and `done` when complete. Set `paused` for features that have a design but are not currently planned for implementation. When adding a `checklist.md` for remaining work, ensure the status is `in-progress`. When a feature is done, set `status: done`, mark all checklist items as complete (`[x]`), and delete the `checklist.md` if every item is checked.
