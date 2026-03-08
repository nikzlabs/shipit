# CLAUDE.md

ShipIt is a browser-based IDE for vibe coding — chat with Claude, it writes code, you see results live. Powered by Claude Code CLI and your Claude subscription.

## Runtime

ShipIt always runs inside Docker containers — there is no local/bare-metal mode. The orchestrator runs in a container and spawns session worker containers.

## Setup

```bash
npm install
```

## Commands

- **`npm run test:dev`** — **preferred for development.** Runs only tests affected by your uncommitted changes + a small set of smoke tests. Much faster than the full suite. Use this while iterating.
- `npm run test:dev -- --list` — dry run: shows which test files would run without executing them.
- `npm run test:smoke` — run only the smoke tests (core connectivity, HTTP bootstrap, git, one client component).
- `npm test` — run **all** tests (full suite). Use sparingly during development — the CI runs this automatically on every PR. Only run locally if you suspect wide-reaching breakage.
- `npx vitest run src/server/git-core.test.ts` — run a single test file.
- `npm run lint` — ESLint on `src/`
- `npm run typecheck` — TypeScript type checking (`tsc --noEmit`)
- `npm run dev` — start dev server (tsx)
- `npm run build` — build client with Vite

## Project structure

```
src/
  server/
    session/         Code that runs inside a session container
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
        agent-process.ts   Base agent interface
        agent-registry.ts  Registry of available agents
        claude-adapter.ts, codex-adapter.ts  CLI adapters
        tool-map.ts        Tool name normalization
        index.ts           Barrel export

    orchestrator/    Code that runs in the main process
      index.ts       Entry point — buildApp()
      app-di.ts      Dependency injection setup
      app-lifecycle.ts  Server startup/shutdown hooks
      api-routes.ts  Route registration dispatcher
      api-routes-*.ts  Domain-specific HTTP routes (bootstrap, deploy, files,
                       git, github, preview, secrets, session)
      validation.ts  Input validation, error formatting
      repo-git.ts    RepoGit — clone, fetch, worktree lifecycle, branch deletion
      repo-store.ts  RepoStore — persists repo metadata
      git-utils.ts   generateBranchPrefix(), parseGitHubRemote()
      git-config.ts  Global git config helpers
      sessions.ts    SessionManager — persists session metadata to JSON
      session-runner.ts   SessionRunner + SessionRunnerRegistry
      container-session-runner.ts  ContainerSessionRunner (proxy)
      session-container.ts  SessionContainerManager — Docker orchestration
      container-lifecycle.ts  Container start/stop/restart logic
      container-discovery.ts  Find running containers
      container-health.ts     Container health checks
      preview-proxy.ts     Reverse proxy for container previews
      docker-proxy.ts      Docker socket proxy for secure container access
      auth.ts        AuthManager — Claude CLI OAuth
      github-auth.ts GitHubAuthManager — GitHub token + API
      github-auth-checks.ts, github-auth-prs.ts, github-auth-repos.ts
      credential-store.ts  CredentialStore — unified credentials
      secret-store.ts      SecretStore — user secrets
      deployment-manager.ts  DeploymentManager — target registry, build, deploy dispatch
      deployment-store.ts    DeploymentStore — credentials and deploy history
      deploy-targets/        DeployTarget implementations (Vercel, Cloudflare)
      features.ts    FeatureManager — scans docs/ for feature status
      session-namer.ts  AI-powered session naming
      chat-history.ts  ChatHistoryManager — per-session message persistence
      usage.ts       UsageManager — per-session cost tracking
      pr-status-poller.ts  Polls GitHub for PR/CI status updates
      proxy-agent-process.ts  Proxies agent commands to session containers
      agent-instructions.ts   Generates system prompts for agents
      templates.ts   Project scaffolding templates
      templates-backend.ts, templates-frontend.ts, templates-fullstack.ts
      markdown.ts    findMarkdownFiles() — docs discovery
      sse-client.ts  SSE client for container event streams
      worker-http.ts HTTP client for session worker endpoints
      terminal-buffer.ts  Server-side terminal output buffering
      ws-handlers/   WebSocket-only message handlers (streaming, per-connection state)
        types.ts     HandlerContext interface shared by all handlers
        send-message.ts    send_message, answer_question, home_send_with_repo
        claude-execution.ts  Claude process lifecycle management
        agent-listeners.ts   Agent event stream listeners
        post-turn.ts         Post-turn actions (auto-commit, auto-push)
        rollback-handlers.ts Git rollback via WS
        terminal-handlers.ts, misc-handlers.ts, deploy-handlers.ts
      services/      Business logic layer — pure functions consumed by routes and WS handlers
        session.ts, git.ts, github.ts, github-ci-fix.ts, deploy.ts,
        settings.ts, templates.ts, files.ts, misc.ts, repos.ts,
        replay.ts, types.ts, index.ts
      integration_tests/  Integration tests — one file per feature area
        test-helpers.ts   Shared stubs (TestClient, FakeClaudeProcess, etc.)

    shared/          Code used by both session and orchestrator
      types/         All type definitions
        index.ts, ws-client-messages.ts, ws-server-messages.ts, domain-types.ts,
        claude-types.ts, agent-types.ts, attachment-types.ts, deployment-types.ts,
        github-types.ts, terminal-types.ts, usage-types.ts
      types.ts       Barrel re-export of types/
      git.ts         GitManager — init, autoCommit, log, push, pull, diff, rollback
      file-tree.ts   scanFileTree() — workspace directory listing
      agent-registry.ts  Shared agent registry (used by both layers)
      session-config.ts  Session configuration parsing
      database.ts    Database abstraction
      utils.ts       Shared utility functions
      strip-ansi.ts  ANSI escape code stripping
      fs-constants.ts  Filesystem path constants

  client/          React 19 frontend (Vite + Tailwind CSS v4)
    App.tsx        Root component — routing, provider setup
    AppLayout.tsx  Main layout — panels, sidebar, WebSocket dispatch
    main.tsx       Vite entry point
    components/    UI components (MessageList, FileTree, PreviewFrame, etc.)
    hooks/         Custom hooks (useWebSocket, useSearch, useResizablePanel, etc.)
    stores/        Zustand state stores
      session-store.ts, ui-store.ts, git-store.ts, pr-store.ts,
      preview-store.ts, file-store.ts, terminal-store.ts,
      settings-store.ts, deploy-store.ts, repo-store.ts
      actions/     Store action creators (session-actions.ts)
    themes/        Theme CSS files (dark.css, light.css)
    utils/         Client utilities (dates, local-storage, repo-label, session-data)
    design-tokens.ts  Icon sizes, spacing, and design constants
    index.css      Tailwind imports + custom animations
    test-setup.ts  Imports @testing-library/jest-dom/vitest
```

## Architecture

Three-layer system: browser (React SPA) → orchestrator (Fastify) → session workers (Docker containers). Architecture knowledge is packaged as skills in `.claude/skills/` for progressive disclosure — each skill auto-loads when the task context matches.

### Available skills

| Skill | Covers |
|-------|--------|
| `server-architecture` | buildApp(), HTTP routes, services, WS handlers, DI, state scopes |
| `client-architecture` | Zustand stores, hooks, components, data flow |
| `session-lifecycle` | Session types, creation paths, warm pool, activation, switching |
| `session-containers` | Docker containers, runners, idle cleanup, reconnection |
| `session-processes` | Claude CLI, preview manager, file watcher, terminal, agents |
| `git-architecture` | GitManager, RepoGit, worktrees, credentials, auto-commit |
| `deployment-architecture` | Deploy targets, framework detection, deploy flow |
| `add-endpoint` | How to add HTTP endpoints, WS messages, deploy targets, activity labels |
| `testing-and-quality` | Test patterns, integration tests, quality checklist |
| `docs-navigator` | Feature docs index — find the right `docs/NNN-*` for a task |

## Key patterns

These are non-obvious architectural patterns that aren't apparent from the file structure alone.

### Orchestrator ↔ container communication

Session containers run a Fastify server (`session-worker.ts`) that exposes HTTP endpoints for agent control, terminal, file operations, and secrets. The orchestrator talks to containers exclusively over HTTP — never Docker exec.

- **Commands flow via HTTP**: `worker-http.ts` sends requests to the container's worker URL (e.g., `POST /agent/start`, `POST /terminal/resize`). `ContainerSessionRunner` wraps these calls and exposes them as the `SessionRunner` interface.
- **Events flow back via SSE**: Containers stream real-time events (agent output, terminal data, file changes) over `GET /events`. The orchestrator's `sse-client.ts` connects to this endpoint and relays events to the browser's WebSocket.
- **Proxy agent pattern**: `ProxyAgentProcess` implements the `AgentProcess` interface but delegates everything to the container over HTTP+SSE. This lets orchestrator code treat local and remote agents identically.
- **Two worker modes**: Containers run in either `"session"` mode (agent, terminal, files) or `"preview"` mode (dev server, secrets). Each session gets two containers.

### WS handler context (three-level DI)

WS handlers receive a composed context object with three layers. Handlers declare exactly which layers they need:

- **`ConnectionCtx`** — per-WebSocket-connection: `send()`, `broadcastLog()`, `getActiveDir()`, `activateSession()`
- **`RunnerCtx`** — per-session-runner: `agentFactory()`, `getAgent()`, turn state accumulators, message queue, terminal
- **`AppCtx`** — app-wide singletons: all managers, factories, config

Handlers that need everything use `FullCtx = ConnectionCtx & RunnerCtx & AppCtx`. Simpler handlers declare only what they need (e.g., terminal handlers need `ConnectionCtx & RunnerCtx` only).

### Service layer pattern

Three-tier: **Routes/WS handlers → Services → Managers**

- Services (`services/*.ts`) are pure async functions that compose manager calls and return typed results.
- Services take domain types (not handler context), making them testable and reusable by both HTTP routes and WS handlers.
- Application errors use `ServiceError(statusCode, message)` with HTTP semantics. Routes catch these and respond with the given status code.

### WS message type system

Messages use discriminated unions with a `type` literal field (`ws-client-messages.ts`, `ws-server-messages.ts`). The dispatch switch in `index.ts` narrows each message to its specific type before passing to the handler — handlers receive the narrowed type, not the union.

### Post-turn flow

After Claude finishes a turn (`agent_result` event in `claude-execution.ts`):
1. `postTurnCommit()` auto-commits changes
2. `scheduleAutoPush()` debounces a push (5s) if GitHub auth is configured
3. PR lifecycle card is emitted if a remote exists

**Critical**: Session context (sessionId, sessionDir) is captured at turn *start*, not at the "done" event. This prevents session switches mid-turn from corrupting commits.

### Client dual-channel communication

The browser uses two parallel channels:
- **Per-session WebSocket** (`/ws/sessions/{id}`) — streaming agent output, diffs, preview status. Managed by `useWebSocket` with exponential backoff reconnection (2s → 30s cap).
- **Global SSE** (`/api/events` via `useServerEvents`) — session list, repo status, auth events, PR status. Always active.

### Client store patterns

- **Cross-store access**: Stores reference each other via `useXStore.getState()` inside actions, not subscriptions. This avoids circular dependencies.
- **Coordinated resets**: `stores/actions/session-actions.ts` is the single source of truth for resetting stores during session switches.
- **Hydration order**: HTTP bootstrap loads once on mount → per-session WS triggers `loadSessionHistory()` on connect → WS messages stream real-time updates. Guards prevent race conditions (e.g., WS data arriving before HTTP response).
- **Stale message guard**: `useMessageHandler` checks `data.sessionId !== currentSessionId` to discard messages from previous sessions after a switch.

### Integration test patterns

- **`TestClient`** buffers WS messages from connection time, preventing races where the server sends before the test listens. Tests call `receive()` which returns buffered or waits for new messages.
- **Container mocking**: `isTestMode` flag in `buildApp()` enables `POST /api/_test/sessions` to create sessions without Docker.
- **Fakes with test controls**: `FakeClaudeProcess`, `StubGitHubAuthManager`, etc. have injection methods (`setPrData()`, `setCheckStatus()`) for test scenarios.

## Workflow

- **Read before coding** — before changing a feature, read its `docs/NNN-feature/plan.md` and the source files listed under "Key files". Trace the data flow for similar features to understand existing patterns.
- **Identify all touchpoints** — plan which files need changes (server, client, types, tests) before writing code.
- **Co-locate tests** — place tests next to source files (`foo.ts` → `foo.test.ts`). Follow patterns from neighboring test files.
- **Update docs when done** — update the relevant `plan.md` with new subsystems, patterns, or key files you added. Mark completed checklist items with `[x]`; if all items are done, delete `checklist.md`.

## Code conventions

- **ESM throughout** — `"type": "module"` in package.json. Use `.js` extensions in relative imports (e.g., `import { foo } from "./bar.js"`).
- **Type imports** — use `import type { X } from "./path.js"` for type-only imports.
- **Node built-ins** — use `node:` prefix (e.g., `import fs from "node:fs"`).
- **Naming** — classes: PascalCase, functions: camelCase, events/WS message types: snake_case, constants: UPPER_SNAKE_CASE.
- **React** — functional components only, hooks for all state/effects. React 19 JSX transform (no `import React` needed).
- **Icons** — use `@phosphor-icons/react` for all icons. Never hardcode `<svg>` elements. Use the `ICON_SIZE` constants from `src/client/design-tokens.ts` (XS=12, SM=16, MD=20, LG=32, XL=48) for icon sizes. See the `design-language` skill for full icon and styling guidance.
- **Styling** — Tailwind CSS v4 utility classes. Dark-mode-only color scheme (gray-950 backgrounds).
- **Strict TypeScript** — `strict: true` in tsconfig. Target ES2022, module ESNext with bundler resolution.

## Docs structure

```
docs/
  NNN-feature-name/
    plan.md        — How the feature works, key files, patterns
    checklist.md   — Remaining work items or tracking notes
```

Feature docs describe individual features and may include planned-but-not-implemented designs.

Features are numbered by creation order. When implementing or modifying a feature, read its `plan.md` first. When a feature has remaining work, check its `checklist.md`. When adding a new feature, create `docs/NNN-new-feature/plan.md`.

Every `plan.md` must have YAML frontmatter with a `status` field. Valid values: `planned`, `in-progress`, `done`, `paused`. The feature tracking system (`src/server/orchestrator/features.ts`) reads this frontmatter to display feature status in the UI. Example:

```yaml
---
status: in-progress
---
```

When creating a new feature doc, set `status: planned`. Update to `in-progress` when work begins and `done` when complete. Set `paused` for features that have a design but are not currently planned for implementation. A `checklist.md` can exist alongside any status — it tracks remaining work items regardless of whether the feature is actively in progress. When a feature is done, set `status: done` and mark all checklist items as complete (`[x]`).
