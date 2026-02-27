# CLAUDE.md

ShipIt is a browser-based IDE for vibe coding — chat with Claude, it writes code, you see results live. Powered by Claude Code CLI and your Claude subscription.

## Setup

```bash
npm install
```

## Commands

- `npm test` — run all tests (vitest). **Requires `npm install` first.** Output is compact (custom LLM reporter: one summary line when green, concise failure details when red), so running the full suite is the default and preferred approach.
- `npx vitest run src/server/git-core.test.ts` — run a single test file.
- `npx vitest run --changed` — run only tests whose transitive dependencies have changed (uncommitted changes). Useful when iterating on a specific feature and you want a faster feedback loop.
- `npm run lint` — ESLint on `src/`
- `npm run typecheck` — TypeScript type checking (`tsc --noEmit`)
- `npm run dev` — start dev server (tsx)
- `npm run build` — build client with Vite

## Project structure

```
src/
  server/
    session/         Code that runs inside a session context
      claude.ts      ClaudeProcess — spawns CLI, parses NDJSON, emits events
      terminal.ts    TerminalProcess — interactive PTY
      preview-manager.ts  PreviewManager — spawns/manages preview server
      preview-config.ts   Preview config parsing (shipit.yaml)
      file-watcher.ts     FileWatcher — recursive fs.watch, debounced change events
      port-scanner.ts     Port detection for dev server previews
      install-runner.ts   Runs install commands (npm install, etc.)
      vite-error-plugin.ts  Injects error-capture script into preview HTML
      session-worker.ts   Fastify server that runs inside each container
      agents/        Agent process adapters
        agent-process.ts, agent-registry.ts, claude-adapter.ts, codex-adapter.ts

    orchestrator/    Code that runs in the main process
      index.ts       Entry point — buildApp(), DI setup, WS switch dispatcher
      api-routes.ts  HTTP REST API routes (registered via registerApiRoutes())
      validation.ts  Input validation, error formatting
      repo-git.ts    RepoGit — clone, fetch, worktree lifecycle, branch deletion
      git-utils.ts   generateBranchPrefix(), parseGitHubRemote()
      git-config.ts  Global git config helpers
      sessions.ts    SessionManager — persists session metadata to JSON
      session-runner.ts   SessionRunner + SessionRunnerRegistry
      container-session-runner.ts  ContainerSessionRunner (proxy)
      session-container.ts  SessionContainerManager — Docker orchestration
      preview-proxy.ts     Reverse proxy for container previews
      auth.ts        AuthManager — Claude CLI OAuth
      github-auth.ts GitHubAuthManager — GitHub token + API
      credential-store.ts  CredentialStore — unified credentials
      deployment-manager.ts  DeploymentManager — target registry, build, deploy dispatch
      deployment-store.ts    DeploymentStore — credentials and deploy history
      deploy-targets/        DeployTarget implementations (Vercel, Cloudflare)
      features.ts    FeatureManager — scans docs/ for feature status
      session-namer.ts  AI-powered session naming
      chat-history.ts  ChatHistoryManager — per-session message persistence
      threads.ts     ThreadManager — conversation threads and checkpoints
      usage.ts       UsageManager — per-session cost tracking
      templates.ts   Project scaffolding templates
      markdown.ts    findMarkdownFiles() — docs discovery
      ws-handlers/   WebSocket-only message handlers (streaming, per-connection state)
        types.ts     HandlerContext interface shared by all handlers
        send-message.ts  send_message, answer_question, home_send_with_repo
        session-handlers.ts, terminal-handlers.ts, misc-handlers.ts,
        deploy-handlers.ts, thread-handlers.ts
      services/      Business logic layer — pure functions consumed by routes and WS handlers
        session.ts, git.ts, github.ts, deploy.ts, settings.ts, threads.ts,
        templates.ts, files.ts, misc.ts, types.ts
      integration_tests/  Integration tests — one file per feature area
        test-helpers.ts   Shared stubs (TestClient, FakeClaudeProcess, etc.)

    shared/          Code used by both session and orchestrator
      types/         All type definitions
        index.ts, ws-client-messages.ts, ws-server-messages.ts, domain-types.ts,
        claude-types.ts, agent-types.ts, attachment-types.ts, deployment-types.ts,
        github-types.ts, terminal-types.ts, thread-types.ts, usage-types.ts
      types.ts       Barrel re-export of types/
      git.ts         GitManager — init, autoCommit, log, push, pull, diff, rollback
      file-tree.ts   scanFileTree() — workspace directory listing

  client/          React 19 frontend (Vite + Tailwind CSS v4)
    App.tsx        Main orchestrator — state, layout, WebSocket dispatch
    components/    UI components (MessageList, FileTree, PreviewFrame, etc.)
    hooks/         Custom hooks (useWebSocket, useSearch, useResizablePanel, etc.)
    index.css      Tailwind imports + custom animations
    test-setup.ts  Imports @testing-library/jest-dom/vitest
```

## Architecture

- **Server**: Fastify with HTTP REST API (`/api/*`) and WebSocket (`/ws`). Most operations use HTTP (reads, mutations). WebSocket is reserved for streaming events (Claude output, file changes, preview status), per-connection state (session activation, agent selection), and real-time push (agent events, notifications). Business logic lives in `src/server/orchestrator/services/` — pure functions consumed by both HTTP routes and WS handlers.
- **Client**: React 19 SPA. State lives in `App.tsx`. HTTP via `useApi` hook (`src/client/hooks/useApi.ts`), WebSocket via `useWebSocket` hook.
- **Dependency injection**: `buildApp()` accepts an `AppDeps` object so tests can inject stubs/fakes instead of real processes. All external dependencies (git, Claude CLI, Vite, port scanner, file watcher) are injectable.
- **Process management**: Claude CLI, Vite, and git are managed via child processes. Claude and Vite managers extend `EventEmitter`.
- **Session isolation**: Each session gets its own workspace directory (`/workspace/sessions/{uuid}/`) with independent git repo. Per-connection state tracks `activeSessionDir`.
- **Per-session GitManager**: `AppDeps.createGitManager` is a factory `(dir: string) => GitManager`. Each session gets its own instance. A separate `createRepoGit` factory provides `RepoGit` instances for shared-repo operations (clone, worktree lifecycle).

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
- **Integration tests** live in `src/server/orchestrator/integration_tests/` — one file per feature area. Shared stubs and helpers (`TestClient`, `StubViteManager`, `StubAuthManager`, `FakeClaudeProcess`, `StubFileWatcher`, `waitForClaude`) are in `test-helpers.ts`. Each test file uses `buildApp()` with injected stubs, listens on port 0 (ephemeral), and connects via the `TestClient` message-buffering WebSocket wrapper. When adding a new integration test, create a new file in this directory (or add to an existing one if the feature area matches) and import helpers from `./test-helpers.js`.
- **Client component tests** use `render()` from `@testing-library/react` with `cleanup` in `afterEach`.
- **Client hook tests** use `renderHook()` with `FakeWebSocket` (stubbed via `vi.stubGlobal`) and `vi.useFakeTimers()`.
- **Mocking** — `vi.mock()` for module mocks, `vi.fn()` for function spies, manual stub/fake classes for complex dependencies. ESLint allows `any` in test files.
- **Assertions** — `toMatchObject()` for partial WS message matching, `toEqual()` for exact structure, `@testing-library/jest-dom` matchers for DOM.
- **Testability** — modules accept optional constructor parameters for isolation: `SessionManager(sessionsFile?)`, `GitManager(workspaceDir?)`, `UsageManager(usageFile?)`, `ThreadManager(threadsDir?)`, `DeploymentStore(baseDir?)`.

## When to use WebSocket vs HTTP

ShipIt uses HTTP for most operations and reserves WebSocket for a narrow set of cases. When adding a new feature, use this decision framework:

**Use HTTP** (default) when:
- The operation is a simple read (GET) or mutation (POST/PATCH/DELETE) with a single request-response cycle
- The client needs the result directly (e.g., to update UI state from the response)
- The operation is stateless — any client tab could make the same request
- Examples: fetching file content, renaming a session, creating a PR, saving settings

**Use WebSocket** only when one of these applies:
1. **Streaming output** — the server produces incremental data over time (Claude CLI events, deploy progress, terminal output). HTTP would require polling or SSE; WS gives us a natural push channel already connected.
2. **Per-connection state** — the operation modifies state tied to *this specific browser tab*, not the user globally. Session activation (`activate_session`) attaches a runner and file watcher to the connection. Agent selection (`set_agent`) sets the agent for this tab only. These don't make sense as HTTP because they bind to the socket's lifecycle.
3. **Bidirectional real-time interaction** — the client and server exchange messages in rapid succession as part of one logical flow: sending a prompt and receiving streamed tokens, answering permission questions mid-turn, interactive terminal I/O.
4. **Server-initiated push** — the server needs to notify the client without a preceding request: file change events, preview status updates, session status broadcasts, queue notifications.

**Gray area — lean HTTP:**
- If an operation triggers server-side effects that push WS events (e.g., `fork_session` triggers a `session_list` broadcast), that's fine — the trigger is HTTP, the notification is WS. Don't put the trigger on WS just because it has side effects.
- If you're unsure, start with HTTP. It's simpler to test (`app.inject()`), easier to debug (curl), and doesn't couple the operation to connection lifecycle. You can always add a WS broadcast for notifications on top.

**Current WS message types** (18 client → server):
`send_message`, `answer_question`, `home_send_with_repo`, `new_session`, `activate_session`, `set_agent`, `interrupt_claude`, `fork_thread`, `switch_thread`, `initiate_deploy`, `cancel_deploy`, `cancel_queued_message`, `init_preview_config`, `diff_comment`, `clear_logs`, `terminal_start`, `terminal_input`, `terminal_resize`

See `docs/001-websocket-protocol/plan.md` for the full endpoint and message reference.

## How to add a new server endpoint

**Prefer HTTP** for new endpoints unless the operation requires per-connection state or real-time streaming (see decision framework above).

### Adding an HTTP endpoint (most cases)

1. Add the service function in the appropriate `src/server/orchestrator/services/*.ts` file — pure function that accepts explicit parameters (session ID, managers) and returns data or throws `ServiceError`
2. Add the Fastify route in `src/server/orchestrator/api-routes.ts` — call the service function, handle errors, return JSON
3. On the client, call the endpoint via `useApi` hook (`apiGet()` / `apiPost()` / etc.) from `src/client/hooks/useApi.ts`
4. Add integration tests using `app.inject()` in `src/server/orchestrator/integration_tests/`

### Adding a WebSocket message (streaming, per-connection state only)

1. Add the interface to `src/server/shared/types/ws-client-messages.ts` (and/or `ws-server-messages.ts` for server-to-client)
2. Add the handler in the appropriate `src/server/orchestrator/ws-handlers/*-handlers.ts` file
3. Add a `case` to the `switch (msg.type)` dispatcher in `src/server/orchestrator/index.ts`
4. Add the client-side handler in `src/client/hooks/useMessageHandler.ts`
5. Add integration tests in `src/server/orchestrator/integration_tests/`

**Key conventions:**
- Use `Extract<WsClientMessage, { type: "..." }>` to get the narrowed message type — don't import individual message interfaces.
- Handler functions are `async` only if they `await` something; otherwise use `void` return.
- Access per-connection state via `ctx` getters/setters (`ctx.getActiveAppSessionId()`, `ctx.setActiveSessionDir(...)`, etc.), not closure variables.
- Access app-level managers directly from `ctx` (`ctx.sessionManager`, `ctx.deploymentStore`, etc.).
- Import `getErrorMessage` from `./validation.js` for consistent error formatting (within orchestrator).

## How to add a new deploy target

1. Create a new file in `src/server/orchestrator/deploy-targets/` implementing the `DeployTarget` interface
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
4. **Integration tests for new endpoints** — every new HTTP endpoint or WS message type needs at least one happy-path and one error-path integration test in `src/server/orchestrator/integration_tests/`. HTTP tests use `app.inject()`. WS tests use the `TestClient` helper. Add to an existing file if the feature area matches, or create a new `<feature>.test.ts` file and import shared helpers from `./test-helpers.js`.
5. **Split slow test files** — if a single test file takes more than ~10 seconds to run, split it into smaller files by feature area so Vitest can parallelize them.

## Docs structure

```
docs/
  NNN-feature-name/
    plan.md        — How the feature works, key files, patterns
    checklist.md   — Remaining work (only exists if there's open work)
```

Features are numbered by creation order. When implementing or modifying a feature, read its `plan.md` first. When a feature has remaining work, check its `checklist.md`. When adding a new feature, create `docs/NNN-new-feature/plan.md`.

Every `plan.md` must have YAML frontmatter with a `status` field. Valid values: `planned`, `in-progress`, `done`, `paused`. The feature tracking system (`src/server/orchestrator/features.ts`) reads this frontmatter to display feature status in the UI. Example:

```yaml
---
status: in-progress
---
```

When creating a new feature doc, set `status: planned`. Update to `in-progress` when work begins and `done` when complete. Set `paused` for features that have a design but are not currently planned for implementation. When adding a `checklist.md` for remaining work, ensure the status is `in-progress`. When a feature is done, set `status: done` and mark all checklist items as complete (`[x]`).
