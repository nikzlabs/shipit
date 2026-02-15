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
