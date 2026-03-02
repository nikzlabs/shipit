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
ThreadManager                     (conversation threads)
DeploymentManager                 (register Vercel, Cloudflare)
DeploymentStore                   (deploy history)
FeatureManager                    (scan docs/)
SessionContainerManager           (Docker, production only)
SessionRunnerRegistry             (active runners)
```

## HTTP API (`api-routes.ts`)

Routes are registered via `registerApiRoutes()`. All routes are prefixed with `/api`.

### Reads (GET)

| Endpoint | Service Function | Purpose |
|----------|-----------------|---------|
| `/api/bootstrap` | `getBootstrapData` | Sessions, repos, agents, settings, templates |
| `/api/sessions/:id/files` | `getFileTree` | Workspace file tree |
| `/api/sessions/:id/files/*` | `getFileContent` | Individual file content |
| `/api/sessions/:id/docs` | `listDocs` | Markdown files in workspace |
| `/api/sessions/:id/docs/*` | `getDocContent` | Individual doc content |
| `/api/sessions/:id/git/log` | `getGitLog` | Commit history |
| `/api/sessions/:id/git/diff` | `getTurnDiff` | Diff for a commit range |
| `/api/sessions/:id/git/remotes` | `getGitRemotes` | Git remotes |
| `/api/sessions/:id/git/branches` | `getGitBranches` | Remote branches |
| `/api/sessions/:id/status` | `getSessionStatus` | Agent running, queue, preview |
| `/api/sessions/:id/preview-status` | — | Preview state (runner query) |
| `/api/sessions/:id/history` | `getChatHistory` | Messages, commits, threads |
| `/api/sessions/:id/usage` | `getUsageStats` | Cost/token stats |
| `/api/sessions/:id/deploy/history` | `getDeployHistory` | Deploy records |
| `/api/sessions/:id/deploy/setup` | `getDeploySetup` | Deploy targets + config |
| `/api/sessions/:id/pr/status` | `getPrStatus` | PR state from GitHub |
| `/api/sessions/:id/threads` | `listThreads` | Conversation threads |
| `/api/sessions/:id/worktrees` | `listWorktrees` | Git worktrees |
| `/api/sessions/:id/features` | `listFeatures` | Feature docs status |
| `/api/github/repos` | `searchGitHubRepos` | Search GitHub repos |
| `/api/settings/*` | various | Git identity, agent config |

### Mutations (POST/PATCH/DELETE)

| Endpoint | Service Function | Purpose |
|----------|-----------------|---------|
| `POST /api/sessions` | `createSessionDir` | Create standalone session |
| `PATCH /api/sessions/:id` | `renameSession` | Rename session |
| `DELETE /api/sessions/:id` | `archiveSession` | Archive session |
| `POST /api/sessions/:id/git/rollback` | `gitRollback` | Reset to commit |
| `POST /api/sessions/:id/git/reject` | `rejectChanges` | Reject Claude's changes |
| `POST /api/sessions/:id/git/push` | `gitPush` | Push to remote |
| `POST /api/sessions/:id/git/pull` | `gitPull` | Pull from remote |
| `POST /api/sessions/:id/pr/create` | `createPullRequest` | Create GitHub PR |
| `POST /api/sessions/:id/pr/merge` | `mergePullRequest` | Merge GitHub PR |
| `POST /api/sessions/:id/deploy/config` | `saveDeployConfig` | Save deploy config |
| `POST /api/sessions/:id/threads/checkpoint` | `createCheckpoint` | Create thread checkpoint |
| `POST /api/repos` | `addRepo` | Import a GitHub repo |
| `POST /api/repos/:url/claim-session` | — | Claim warm session |
| `POST /api/settings/*` | various | Save settings |

### Error Handling

Service functions throw `ServiceError(statusCode, message)`. A Fastify `onError` hook catches these and returns the appropriate HTTP status with a JSON body:

```json
{ "error": "Session not found" }
```

## Services Layer (`services/`)

Business logic lives in `src/server/orchestrator/services/` as pure exported functions. Each function accepts explicit parameters (manager references, IDs) and returns data or throws `ServiceError`.

| File | Domain |
|------|--------|
| `session.ts` | Session CRUD, fork, merge, worktrees |
| `git.ts` | Log, diff, remotes, branches, rollback, push, pull |
| `github.ts` | GitHub search, PR operations, auth |
| `deploy.ts` | Deploy config, history, target operations |
| `files.ts` | File tree, content, binary detection |
| `settings.ts` | Git identity, agent config, API keys, system prompt |
| `threads.ts` | Thread list, checkpoint, fork/switch |
| `repos.ts` | Repo list, add, remove, templates |
| `templates.ts` | Project scaffolding |
| `misc.ts` | Bootstrap, features, usage, full reset |
| `types.ts` | `ServiceError`, `BootstrapData`, `AgentInfo`, `GlobalSettings` |

Services are consumed by both HTTP routes and WebSocket handlers. This keeps business logic testable independently of transport.

## WebSocket Handler Architecture

### Connection Lifecycle

The client connects to `ws[s]://host/ws/sessions/{sessionId}?agent=claude`. On connection:

1. Validate session exists (close with 4004 if not)
2. Initialize per-connection state (closures in the WS handler)
3. Call `activateSession(sessionId)` — gets or creates a runner, attaches the connection
4. Send log buffer and current status

### Message Dispatch

```typescript
socket.on("message", async (raw: Buffer) => {
  const msg = JSON.parse(raw.toString()) as WsClientMessage;
  switch (msg.type) {
    case "send_message": return sendMessageHandlers.handleSendMessage(ctx, msg);
    case "answer_question": return sendMessageHandlers.handleAnswerQuestion(ctx, msg);
    case "terminal_start": return terminalHandlers.handleTerminalStart(ctx);
    case "terminal_input": return terminalHandlers.handleTerminalInput(ctx, msg);
    case "initiate_deploy": return deployHandlers.handleInitiateDeploy(ctx, msg);
    case "fork_thread": return threadHandlers.handleForkThread(ctx, msg);
    // ... more cases
  }
});
```

### Handler Context

Handlers receive a `ctx` object combining three interfaces (see `ws-handlers/types.ts`):

**`ConnectionCtx`** — per-connection communication and session management:
- `send()`, `broadcastLog()`, `sseBroadcast()`
- `getActiveDir()`, `getActiveSessionDir()`, `getActiveAppSessionId()`
- `activateSession()`, `checkGitIdentity()`, `scheduleAutoPush()`

**`RunnerCtx`** — per-session runner delegation (agent, queue, terminal, turn state):
- `getAgent()`, `setAgent()`, `getIsClaudeRunning()`
- `getMessageQueue()`, `clearMessageQueue()`
- `getRunner()`, `attachToRunner()`, `detachFromRunner()`
- `getAccumulatedText()`, `getTurnSummary()`, `getChatMessageGroups()`

**`AppCtx`** — app-level managers and factories:
- `sessionManager`, `chatHistoryManager`, `threadManager`, etc.
- `createGitManager()`, `createRepoGit()`, `createSessionDir()`
- `workspaceDir`, `sessionsRoot`, `defaultAgentId`

### Handler Files

| File | Messages Handled |
|------|-----------------|
| `send-message.ts` | `send_message`, `answer_question`, `home_send_with_repo` |
| `terminal-handlers.ts` | `terminal_start`, `terminal_input`, `terminal_resize` |
| `deploy-handlers.ts` | `initiate_deploy`, `cancel_deploy` |
| `thread-handlers.ts` | `fork_thread`, `switch_thread` |
| `misc-handlers.ts` | `interrupt_claude`, `set_agent`, `cancel_queued_message`, `init_preview_config`, `diff_comment`, `clear_logs` |

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
| `ws-client-messages.ts` | `WsClientMessage` union (13 types) |
| `ws-server-messages.ts` | `WsServerMessage` union (50+ types) |
| `domain-types.ts` | `SessionInfo`, `RepoInfo`, `ProjectTemplate` |
| `claude-types.ts` | `ClaudeEvent`, NDJSON message types |
| `agent-types.ts` | `AgentProcess`, `AgentEvent`, `AgentCapabilities` |
| `deployment-types.ts` | `DeployTargetInfo`, `DeployConfigField` |
| `github-types.ts` | `GitHubRepo`, `PullRequestInfo` |
| `terminal-types.ts` | `TerminalProcess` interface |
| `thread-types.ts` | `ThreadInfo`, `CheckpointInfo` |
| `usage-types.ts` | `UsageRecord`, cost tracking |
| `attachment-types.ts` | `ImageAttachment`, `FileContextRef` |

Types are shared between server and client (client imports from `../../server/shared/types.js`).
