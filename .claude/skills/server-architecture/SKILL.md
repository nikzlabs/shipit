---
name: server-architecture
description: "ShipIt server/orchestrator architecture: buildApp(), HTTP API routes, services layer, WebSocket handler dispatch, SSE broadcasts, dependency injection, state scopes, manager initialization, type system. Load when working on orchestrator code, routes, services, or WebSocket handlers."
user-invocable: true
---

# Server Architecture

The server is a single Fastify process (the orchestrator) that handles HTTP, WebSocket, and SSE connections from the browser. It delegates session-scoped work to Docker containers running session workers.

## Entry Point: `buildApp()`

`src/server/orchestrator/index.ts` exports `buildApp(deps: AppDeps)`, which:

1. Instantiates all managers (or accepts injected stubs from `deps`)
2. Initializes global git config and agent detection
3. Sets up Docker container manager (production) or skips it (tests)
4. Creates the session runner registry with a factory
5. Registers HTTP routes via `registerApiRoutes()`
6. Registers WebSocket handler at `/ws/sessions/:id`
7. Registers SSE endpoint at `/api/events`
8. Registers preview proxy routes
9. Sets up startup tasks (warm pool validation, orphan cleanup)
10. Returns the Fastify instance without starting it

The function returns the app without calling `listen()`, so integration tests can use `app.inject()` without binding a port.

## Dependency Injection

`buildApp()` accepts an `AppDeps` object where every field is optional. Production uses real implementations; tests supply mocks/stubs. This is the foundation of testability — integration tests never spawn real Docker containers, Claude CLI processes, or Vite servers.

Key injectable dependencies:

| Dependency | Type | Purpose |
|------------|------|---------|
| `createGitManager` | `(dir) => GitManager` | Per-session git operations |
| `createRepoGit` | `(dir) => RepoGit` | Bare cache + per-session local-clone ops |
| `sessionManager` | `SessionManager` | Session metadata persistence |
| `authManager` | `AuthManager` | Claude CLI OAuth |
| `githubAuthManager` | `GitHubAuthManager` | GitHub token + API |
| `credentialStore` | `CredentialStore` | Unified credentials |
| `agentFactory` | `(agentId) => AgentProcess` | Agent process creation (test-only) |
| `runnerFactory` | `SessionRunnerFactory` | Session runner creation |
| `sessionContainerManager` | `SessionContainerManager` | Docker orchestration |

In production, agents live inside session containers — the orchestrator never spawns them directly. The `agentFactory` dependency exists only for integration tests.

## Manager Initialization Order

```
createGitManager / createRepoGit  (factories)
SessionManager                    (session metadata)
RepoStore                         (imported repos)
ChatHistoryManager                (per-session messages)
UsageManager                      (cost tracking)
AuthManager                       (Claude CLI OAuth)
CredentialStore                   (unified credentials)
initGlobalGitConfig()             (GIT_CONFIG_GLOBAL)
AgentRegistry                     (detect installed CLIs)
GitHubAuthManager                 (GitHub token + API)
markdown.ts                       (scan workspace for docs/ markdown)
SessionContainerManager           (Docker, production only)
SessionRunnerRegistry             (active runners)
```

## State Scopes

State is managed at three scopes:

### App-Level (server lifetime)

Singleton managers created in `buildApp()`. Shared across all connections.

- `SessionManager` — session metadata (title, workspace dir, remote URL, warm flag)
- `RepoStore` — imported repos, clone status, warm session IDs
- `SessionRunnerRegistry` — active runners (no count cap; reclaim is memory-budget driven, docs/284)
- `SessionContainerManager` — Docker containers
- `CredentialStore` — git identity, GitHub token, agent auth (one encrypted file)
- `AuthManager` / `GitHubAuthManager` — authentication state
- `AgentRegistry` — detected agent CLIs

### Per-Connection (WebSocket lifetime)

State bound to a single browser tab's WebSocket connection, tracked in closure variables inside the WS handler.

- Active session ID and directory
- Active agent ID
- Attached runner reference
- Log buffer

### Per-Session (runner lifetime)

State on the `SessionRunnerInterface`, shared across all connections viewing the same session.

- Agent process and running state
- Message queue (queued prompts waiting for current turn to finish)
- Turn event buffer (replayed to new viewers)
- Terminal process
- Preview status
- Viewer count

## HTTP API (`api-routes*.ts`)

Routes are registered via `registerApiRoutes()` (`api-routes.ts`, called from `route-registry.ts`) and split by
domain across `api-routes-*.ts`. All are prefixed `/api`. For the live set, grep the route files
(`grep -n "app\.\(get\|post\|patch\|put\|delete\)" src/server/orchestrator/api-routes*.ts`) rather than trusting a copied table.

### Error Handling

Service functions throw `ServiceError(statusCode, message)`. A Fastify `onError` hook catches these and returns the appropriate HTTP status with a JSON body:

```json
{ "error": "Session not found" }
```

## Services Layer (`services/`)

Business logic lives in `src/server/orchestrator/services/` as pure exported functions. Each function accepts explicit parameters (manager references, IDs) and returns data or throws `ServiceError`.

`ls src/server/orchestrator/services/` for the current set; `types.ts` holds `ServiceError` and the
bootstrap/settings shapes.

Services are consumed by both HTTP routes and WebSocket handlers. This keeps business logic testable independently of transport.

## WebSocket Handler Architecture

### Connection Lifecycle

The client connects to `ws[s]://host/ws/sessions/{sessionId}?agent=claude`. On connection:

1. Validate session exists (close with 4004 if not)
2. Initialize per-connection state (closures in the WS handler)
3. Call `activateSession(sessionId)` — gets or creates a runner, attaches the connection
4. Send log buffer and current status

### Message Dispatch

The `switch (msg.type)` dispatcher lives in `route-registry.ts` (not `index.ts`) and narrows
`WsClientMessage` (`shared/types/ws-client-messages.ts`) to per-file handlers in `ws-handlers/`.

### Handler Context

Handlers receive a `ctx` object combining three interfaces (see `ws-handlers/types.ts`):

**`ConnectionCtx`** — per-connection communication and session management:
- `send()`, `broadcastLog()`, `sseBroadcast()`
- `getActiveDir()`, `getActiveSessionDir()`, `getActiveAppSessionId()`
- `activateSession()`, `checkGitIdentity()`, `scheduleAutoPush()`

**`RunnerCtx`** — per-session runner delegation:
- `agentFactory(agentId)`
- `getActiveAgentId()` / `setActiveAgentId()`, `getSelectedModel()` / `setSelectedModel()`, `getSelectedReasoning()` / `setSelectedReasoning()` — per-connection identifiers that don't depend on runner state
- `getRunner()`, `getRunnerRegistry()`, `attachToRunner()`, `detachFromRunner()`

**Turn state is NOT on the context.** There are no `getIsClaudeRunning()`, `getAccumulatedText()`, `getTurnSummary()`, `getChatMessageGroups()`, `getMessageQueue()`, or `clearMessageQueue()` accessors — they were removed because they silently no-op'd after a WS disconnect. Resolve a runner with `resolveRunner(ctx)` (which prefers the registry) and read/write it directly: `runner.running`, `runner.turnSummary = "…"`. See `CLAUDE.md` → *WebSocket lifecycle MUST NOT affect server behavior*.

**`AppCtx`** — app-level managers and factories:
- `sessionManager`, `chatHistoryManager`, etc.
- `createGitManager()`, `createRepoGit()`, `createSessionDir()`
- `workspaceDir`, `sessionsRoot`, `defaultAgentId`

### Handler Files

One file per domain in `ws-handlers/` (`send-message.ts`, `terminal-handlers.ts`, `misc-handlers.ts`, …); `ls` it and read the `route-registry.ts` switch for the message→handler map.

### Critical rule: WebSocket lifecycle MUST NOT affect server behavior

WS disconnects and reconnects are routine. They MUST NOT stop agents, dispose runners, destroy containers, or corrupt persisted state. Concretely:

- **`socket.on("close")` only calls `detachFromRunner()`.** It must NOT call `enforceIdleContainerLimit()`, `runner.dispose()`, `agent.kill()`, `containerManager.destroy()`, or anything that affects state. Idle cleanup runs on a periodic timer and acts only when ShipIt is over its memory budget (see `idle-enforcer.ts: createIdleEnforcer`, docs/284).
- **`runner.dispose()` refuses to kill running agents** unless `{ force: true }` is passed. The only callers passing `force` are explicit user actions (archive, repo delete, full reset) and shutdown.
- **Inside async closures (`agent.on("event"|"done"|"error")`, `setTimeout`, `Promise.then`, recursive turns), capture `runner` / `capturedSessionId` / `capturedSessionDir` ONCE at function entry.** Never call `ctx.getRunner()` inside those closures — it returns the per-connection `attachedRunner`, which becomes null after disconnect. Mutate `runner.X` directly and emit via `runner.emitMessage()` (which broadcasts to all viewers AND buffers for reconnects), not `ctx.send()`.
- **Resolve runners via the registry**: use `resolveRunner(ctx)` from `ws-handlers/resolve-runner.ts` (or `ctx.getRunnerRegistry().get(capturedSessionId)`). The registry survives WS disconnects; `attachedRunner` doesn't.
- **`RunnerCtx` no longer exposes `setIsClaudeRunning`, `setTurnSummary`, etc.** They were a hazard — silent no-ops after disconnect. The only way to mutate runner state is `runner.X = …` on a resolved runner. See `docs/095-runner-ctx-simplification/plan.md`.

## SSE Broadcast (`/api/events`)

The orchestrator maintains a Server-Sent Events endpoint for global push to all connected clients. Events include:

- `session_list` — session created/renamed/archived/graduated
- `session_started` — new session with initial message
- `repo_list` — repo added/removed/status changed
- `repo_status` — clone progress, warm ready
- `repo_warm_ready` — warm session available for a repo
- `auth_required` / `auth_complete` — Claude auth flow
- `agent_list` — agent availability changed
- `active_runners` — which sessions have running agents
- `full_reset_complete` — workspace was reset

SSE is separate from per-session WebSocket. It broadcasts to all tabs, not just the active session.

## Type System

All types live in `src/server/shared/types/`:

| File | Contents |
|------|----------|
| `index.ts` | Barrel re-export |
| `ws-client-messages.ts` | `WsClientMessage` union |
| `ws-server-messages.ts` | `WsServerMessage` union (50+ types) |
| `domain-types.ts` | `SessionInfo`, `RepoInfo`, `ProjectTemplate` |
| `claude-types.ts` | `ClaudeEvent`, NDJSON message types |
| `agent-types.ts` | `AgentProcess`, `AgentEvent`, `AgentCapabilities` |
| `deployment-types.ts` | `GitHubDeploymentStatus` |
| `github-types.ts` | `WsGitHubStatus`, `WsGitHubPushResult`, … (GitHub WS server messages) |
| `terminal-types.ts` | `TerminalProcess`, `WsTerminalStart`, … |
| `usage-types.ts` | `UsageTurn`, `TurnUsage`, `SessionUsage`, `WeeklyUsage` |
| `attachment-types.ts` | `ImageAttachment`, `FileContextRef` |

Types are shared between server and client (client imports from `../../server/shared/types.js`).

## Persistence

**Persistence is SQLite** (`src/server/shared/database.ts`), not JSON files. The managers below are thin typed accessors over their tables; adding a persisted field means a table column plus a `database.ts` migration.

| Data | Storage | Owner |
|------|---------|-------|
| Session metadata | `sessions` table | `SessionManager` (`sessions.ts`) |
| Chat history | `messages` table | `ChatHistoryManager` (`chat-history.ts`) |
| Usage stats | `usage_turns` table | `UsageManager` (`usage.ts`) |
| Repos | `repos` table | `RepoStore` (`repo-store.ts`) |
| Secrets | `secrets` table | `SecretStore` (`secret-store.ts`) |
| Reviews, rewind snapshots, egress rules, presentations | their own tables | see `database.ts` |
| GitHub token, agent env, provider-account metadata | `{credentialsDir}/shipit-credentials.json` (encrypted **when a cipher is supplied**, not unconditionally) | `CredentialStore` (`credential-store.ts`) |
| Git identity | `.gitconfig` in the credentials dir, via `GIT_CONFIG_GLOBAL` — not a `CredentialStore` field | `git-config.ts` |
| Provider subscription auth | Per-account filesystem roots (`.claude/…`, `.codex/auth.json`) | `provider-account-manager.ts` |
| Session code | Git repo | `/workspace/sessions/{uuid}/` |

Those are four distinct stores — SQLite domain records, the CredentialStore JSON, global git config, and the provider CLI auth roots. Don't collapse them.

Deploy status is **not** persisted locally — it is read from the GitHub Deployments API (see the `deployment-architecture` skill). The `.vibe-sessions.json` / `.shipit-usage.json` names survive only as file-watcher ignore entries (`fs-constants.ts`), not as stores. There is no `ThreadManager`.

## Key Files

| File | Role |
|------|------|
| `src/server/orchestrator/index.ts` | `buildApp()` — app factory, DI setup |
| `src/server/orchestrator/route-registry.ts` | Route registration, WS connection + dispatch switch |
| `src/server/orchestrator/api-routes.ts` | HTTP REST API routes |
| `src/server/orchestrator/services/*.ts` | Business logic (pure functions) |
| `src/server/orchestrator/ws-handlers/*.ts` | WebSocket message handlers |
| `src/server/orchestrator/ws-handlers/types.ts` | `ConnectionCtx`, `RunnerCtx`, `AppCtx` interfaces |
| `src/server/orchestrator/session-runner.ts` | `SessionRunnerInterface`, `SessionRunnerRegistry` |
| `src/server/orchestrator/container-session-runner.ts` | `ContainerSessionRunner` (production runner) |
| `src/server/orchestrator/session-container.ts` | Docker container management |
| `src/server/session/session-worker.ts` | In-container Fastify server |
| `src/server/session/agents/claude/process.ts` | `ClaudeProcess` — spawns CLI, parses NDJSON (per-agent dirs since docs/155) |
| `src/server/orchestrator/service-manager.ts` | `ServiceManager` — Docker Compose lifecycle |
| `src/server/orchestrator/compose-generator.ts` | Compose override generation, volume rewriting |
| `src/server/shared/git.ts` | `GitManager` — per-session git |
| `src/server/orchestrator/repo-git.ts` | `RepoGit` — bare cache + per-session local-clone ops |
| `src/client/App.tsx` | Main React component |
| `src/client/stores/*.ts` | Zustand stores |
| `src/client/hooks/*.ts` | Custom hooks (WebSocket, API, message handling) |
