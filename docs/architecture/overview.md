# System Overview

ShipIt is a browser-based IDE for vibe coding. Users chat with Claude, which writes code, and they see results live in a preview pane. The system has three layers: a React SPA in the browser, a Fastify orchestrator process, and per-session Docker containers running isolated session workers.

## Layered Architecture

```
┌─────────────────────────────────────────────────────────┐
│                    Browser (React SPA)                   │
│  Zustand stores ← hooks ← WS messages / HTTP responses │
└──────────────────────┬──────────────────────────────────┘
                       │  WS /ws/sessions/:id
                       │  HTTP /api/*
                       │  SSE /api/events
                       ▼
┌─────────────────────────────────────────────────────────┐
│              Orchestrator (Fastify, single process)      │
│                                                          │
│  buildApp() → HTTP routes, WS handler, SSE broadcast    │
│  SessionRunnerRegistry → ContainerSessionRunner          │
│  SessionContainerManager → Docker API                    │
└──────────────────────┬──────────────────────────────────┘
                       │  HTTP to container IP:9100
                       │  SSE /events (long-lived)
                       ▼
┌─────────────────────────────────────────────────────────┐
│         Session Worker (one per Docker container)        │
│                                                          │
│  /agent/start, /preview/start, /files/watch, /events    │
│  Claude CLI process, PreviewManager, FileWatcher         │
└─────────────────────────────────────────────────────────┘
```

### Browser

React 19 SPA with Zustand for state management. 11 domain-specific stores (session, git, files, preview, terminal, threads, deploy, PR, settings, UI, repos). Communicates with the orchestrator via HTTP for reads/mutations, WebSocket for streaming and real-time push, and SSE for global broadcasts.

See [client.md](./client.md) for details.

### Orchestrator

Single Fastify process. Entry point is `buildApp()` in `src/server/orchestrator/index.ts`, which accepts an `AppDeps` object for dependency injection. Manages all app-level state: sessions, repos, auth, credentials, deployment targets. Routes HTTP requests to service functions, dispatches WebSocket messages to handlers, and proxies between the browser and session containers.

See [server.md](./server.md) for details.

### Session Worker

Fastify server (port 9100) running inside each Docker container (`src/server/session/session-worker.ts`). Manages the Claude CLI process, Vite preview server, file watcher, and interactive terminal for a single session. Communicates with the orchestrator via HTTP (incoming commands) and SSE (outgoing events).

See [processes.md](./processes.md) for details.

## Communication Patterns

| Source | Transport | Destination | Examples |
|--------|-----------|-------------|----------|
| Client → Server | HTTP (`/api/*`) | Route handlers → services | Create session, get history, git push |
| Client → Server | WS (per-session) | Message dispatcher → handlers | send_message, terminal_input |
| Server → Client | HTTP response | Direct | Session history, bootstrap data |
| Server → Client | WS (per-session) | `useMessageHandler` → stores | assistant_message, preview_status |
| Server → All Clients | SSE (`/api/events`) | `useServerEvents` → stores | session_list, repo_warm_ready |
| Orchestrator → Worker | HTTP POST | Worker routes | /agent/start, /preview/start |
| Worker → Orchestrator | SSE (`/events`) | `handleSSEEvent()` on runner | agent_event, preview_ready, file_changes |

### HTTP vs WebSocket Decision

HTTP is the default for new endpoints. WebSocket is reserved for:

1. **Streaming output** — incremental data over time (Claude CLI events, terminal output)
2. **Per-connection state** — state tied to a specific browser tab (session activation, agent selection)
3. **Bidirectional real-time** — rapid back-and-forth in one flow (prompt + streamed tokens, permission questions)
4. **Server-initiated push** — notifications without a preceding request (file changes, preview status)

If unsure, start with HTTP. It's simpler to test (`app.inject()`), easier to debug, and doesn't couple the operation to connection lifecycle.

## Dependency Injection

`buildApp()` accepts an `AppDeps` object where every field is optional. Production uses real implementations; tests supply mocks/stubs. This is the foundation of testability — integration tests never spawn real Docker containers, Claude CLI processes, or Vite servers.

Key injectable dependencies:

| Dependency | Type | Purpose |
|------------|------|---------|
| `createGitManager` | `(dir) => GitManager` | Per-session git operations |
| `createRepoGit` | `(dir) => RepoGit` | Shared-repo and worktree ops |
| `sessionManager` | `SessionManager` | Session metadata persistence |
| `authManager` | `AuthManager` | Claude CLI OAuth |
| `githubAuthManager` | `GitHubAuthManager` | GitHub token + API |
| `credentialStore` | `CredentialStore` | Unified credentials |
| `agentFactory` | `(agentId) => AgentProcess` | Agent process creation (test-only) |
| `runnerFactory` | `SessionRunnerFactory` | Session runner creation |
| `sessionContainerManager` | `SessionContainerManager` | Docker orchestration |

In production, agents live inside session containers — the orchestrator never spawns them directly. The `agentFactory` dependency exists only for integration tests.

## State Scopes

State is managed at three scopes:

### App-Level (server lifetime)

Singleton managers created in `buildApp()`. Shared across all connections.

- `SessionManager` — session metadata (title, workspace dir, remote URL, warm flag)
- `RepoStore` — imported repos, clone status, warm session IDs
- `SessionRunnerRegistry` — active runners (max 10 concurrent)
- `SessionContainerManager` — Docker containers
- `CredentialStore` — git identity, GitHub token, agent API keys
- `AuthManager` / `GitHubAuthManager` — authentication state
- `DeploymentManager` / `DeploymentStore` — deployment targets and history
- `AgentRegistry` — detected agent CLIs

### Per-Connection (WebSocket lifetime)

State bound to a single browser tab's WebSocket connection, tracked in closure variables inside the WS handler.

- Active session ID and directory
- Active agent ID
- Attached runner reference
- Log buffer
- Auto-push timer

### Per-Session (runner lifetime)

State on the `SessionRunnerInterface`, shared across all connections viewing the same session.

- Agent process and running state
- Message queue (queued prompts waiting for current turn to finish)
- Turn event buffer (replayed to new viewers)
- Terminal process
- Preview status
- Viewer count
- Idle timer

## Persistence

| Data | Storage | Location |
|------|---------|----------|
| Session metadata | JSON file | `SessionManager` (`/workspace/.vibe-sessions.json`) |
| Chat history | Per-session JSON | `ChatHistoryManager` (`/workspace/sessions/{id}/.chat-history.json`) |
| Git identity | Global git config | `CredentialStore` (`/credentials/.gitconfig`) |
| GitHub token | File | `CredentialStore` (`/credentials/.github-token`) |
| Agent API keys | File | `CredentialStore` (`/credentials/.agent-env`) |
| Usage stats | JSON file | `UsageManager` (`/workspace/.shipit-usage.json`) |
| Deploy history | JSON file | `DeploymentStore` (`/workspace/.deploy-history.json`) |
| Threads | Directory of JSON | `ThreadManager` (`/workspace/.vibe-threads/`) |
| Repos | JSON file | `RepoStore` (`/workspace/.vibe-repos.json`) |
| Session code | Git repo | `/workspace/sessions/{uuid}/` |

## Key Files

| File | Role |
|------|------|
| `src/server/orchestrator/index.ts` | `buildApp()` — app factory, DI setup, WS dispatcher |
| `src/server/orchestrator/api-routes.ts` | HTTP REST API routes |
| `src/server/orchestrator/services/*.ts` | Business logic (pure functions) |
| `src/server/orchestrator/ws-handlers/*.ts` | WebSocket message handlers |
| `src/server/orchestrator/ws-handlers/types.ts` | `ConnectionCtx`, `RunnerCtx`, `AppCtx` interfaces |
| `src/server/orchestrator/session-runner.ts` | `SessionRunnerInterface`, `SessionRunnerRegistry` |
| `src/server/orchestrator/container-session-runner.ts` | `ContainerSessionRunner` (production runner) |
| `src/server/orchestrator/session-container.ts` | Docker container management |
| `src/server/session/session-worker.ts` | In-container Fastify server |
| `src/server/session/claude.ts` | `ClaudeProcess` — spawns CLI, parses NDJSON |
| `src/server/session/preview-manager.ts` | `PreviewManager` — Vite dev server |
| `src/server/shared/git.ts` | `GitManager` — per-session git |
| `src/server/orchestrator/repo-git.ts` | `RepoGit` — shared-repo and worktree ops |
| `src/client/App.tsx` | Main React component |
| `src/client/stores/*.ts` | Zustand stores |
| `src/client/hooks/*.ts` | Custom hooks (WebSocket, API, message handling) |
