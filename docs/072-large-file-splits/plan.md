---
status: done
---

# 072 — Large File Splits

## Problem

Several source files have grown past 700+ lines and accumulate multiple distinct responsibilities. This hurts readability, makes code review harder, increases merge-conflict surface, and slows down targeted testing.

## Scope

Split the 11 largest non-test source files into focused, single-responsibility modules. Each split must be behaviour-preserving — no logic changes, only file moves and re-exports.

## Guiding Principles

- **One responsibility per file.** Each new module should have a clear, single purpose.
- **No logic changes.** Splits are pure refactors — move code, update imports, re-export where needed for backwards compatibility.
- **Incremental.** Each file can be split in an independent PR. No big-bang refactor.
- **Preserve public API.** Barrel re-exports from the original file path keep existing imports working during transition. Downstream callers can be migrated later.
- **Tests move with code.** If a test file exists, update its imports to point at the new modules.

---

## Tier 1 — High Priority

### 1. `src/server/orchestrator/api-routes.ts` (1500 lines)

Currently registers every HTTP endpoint in a single function. Split by domain:

| New file | Contents |
|----------|----------|
| `api-routes-bootstrap.ts` | `GET /bootstrap`, metadata endpoints |
| `api-routes-files.ts` | File tree, file content, write/edit |
| `api-routes-git.ts` | Git log, branches, remotes, commit, push, pull, diff, rollback |
| `api-routes-session.ts` | Session CRUD, switching, renaming |
| `api-routes-terminal.ts` | Terminal start, write, resize, kill |
| `api-routes-preview.ts` | Preview start/stop |
| `api-routes-github.ts` | GitHub repos, PRs, auth, CI |
| `api-routes-deploy.ts` | Deployment endpoints |
| `api-routes.ts` | Barrel — calls each sub-registrar, keeps `registerApiRoutes()` signature |

### 2. `src/server/orchestrator/container-session-runner.ts` (1064 lines)

Bundles an SSE client, HTTP helpers, a terminal buffer util, a proxy agent class, and the main runner. Extract utilities:

| New file | Contents |
|----------|----------|
| `sse-client.ts` | `connectSSE()` function and event parsing |
| `worker-http.ts` | `workerPost()`, `workerGet()`, response helpers |
| `terminal-buffer.ts` | `truncateTerminalBuffer()` |
| `proxy-agent-process.ts` | `ProxyAgentProcess` class |
| `container-session-runner.ts` | Main `ContainerSessionRunner` class (imports the above) |

### 3. `src/client/components/MessageList.tsx` (908 lines)

Six+ sub-components inlined in one file:

| New file | Contents |
|----------|----------|
| `message-tools.tsx` | `ToolCallGroup`, `ToolUseItem`, `ToolProgressBar` |
| `message-markdown.tsx` | `parseMessageSegments()`, `MarkdownContent`, `MarkdownTooltip`, `CodeBlock` |
| `message-highlighting.tsx` | `getSegmentMatches()`, `HighlightedText` |
| `message-editor.tsx` | `MessageEditor` component |
| `message-media.tsx` | `ImageLightbox`, `MessageFileAttachments`, `MessageImages` |
| `MessageList.tsx` | Main list component (imports sub-components) |

### 4. `src/server/orchestrator/ws-handlers/send-message.ts` (843 lines)

Three large functions dominate the file:

| New file | Contents |
|----------|----------|
| `agent-listeners.ts` | `wireAgentListeners()` |
| `claude-execution.ts` | `runClaudeWithMessage()` |
| `post-turn.ts` | `postTurnCommit()`, auto-push, PR lifecycle helpers |
| `send-message.ts` | `handleSendMessage()`, `handleAnswerQuestion()` (slim orchestrator) |

---

## Tier 2 — Good Candidates

### 5. `src/server/orchestrator/index.ts` (1420 lines)

| New file | Contents |
|----------|----------|
| `app-di.ts` | Dependency injection / manager initialization |
| `app-lifecycle.ts` | Server startup, session recycling, shutdown, health monitoring |
| `index.ts` | `buildApp()` factory, route registration, WebSocket switch |

### 6. `src/server/orchestrator/docker-proxy.ts` (955 lines)

| New file | Contents |
|----------|----------|
| `docker-proxy-auth.ts` | `containerBelongsToSession()`, `networkBelongsToSession()`, `volumeBelongsToSession()`, `getExecParentContainerId()` |
| `docker-proxy-sanitize.ts` | `sanitizeContainerCreate()` |
| `docker-proxy-helpers.ts` | `respond()`, `readBody()`, `forwardToDocker()`, `pipeToDocker()` |
| `docker-proxy.ts` | Route definitions and `createDockerProxy()` factory |

### 7. `src/server/orchestrator/session-container.ts` (832 lines)

| New file | Contents |
|----------|----------|
| `container-lifecycle.ts` | `create()`, `destroy()`, `cleanup()`, mount/env builders |
| `container-discovery.ts` | `rediscover()`, orphan cleanup, IP lookup |
| `container-health.ts` | Health monitoring via Docker events |
| `session-container.ts` | `SessionContainerManager` class (delegates to above) |

### 8. `src/server/orchestrator/github-auth.ts` (785 lines)

| New file | Contents |
|----------|----------|
| `github-auth-repos.ts` | `createRepo()`, `listUserRepos()`, `searchRepos()` |
| `github-auth-prs.ts` | `createPullRequest()`, `findPullRequest()`, `mergePullRequest()`, `enableAutoMerge()`, `disableAutoMerge()` |
| `github-auth-checks.ts` | `getCheckStatus()`, `getCheckRunAnnotations()`, `getJobLogs()` |
| `github-auth.ts` | Token lifecycle, git credential config, orchestrator class |

### 9. `src/server/orchestrator/services/github.ts` (705 lines)

| New file | Contents |
|----------|----------|
| `github-ci-fix.ts` | `fetchCIFailureLogs()`, `stripCILogBloat()`, `extractErrorLines()`, `buildCIFixPrompt()`, `triggerCIFix()` |
| `github.ts` | PR service functions, status reads, auto-merge, auth |

---

## Tier 3 — Data-Driven / Lower Priority

### 10. `src/server/orchestrator/templates.ts` (1187 lines)

Mostly template data. Split by category:

| New file | Contents |
|----------|----------|
| `template-gitignores.ts` | Gitignore string constants |
| `templates-frontend.ts` | React, Vue, Svelte, Vanilla template objects |
| `templates-fullstack.ts` | Next.js, Astro template objects |
| `templates-backend.ts` | Express, Hono, Fastify template objects |
| `templates.ts` | `listTemplates()`, `getTemplate()`, `applyTemplate()` — imports and merges arrays |

### 11. `src/client/App.tsx` (847 lines)

Extract layout sections into child components:

| New file | Contents |
|----------|----------|
| `AppLayout.tsx` | Grid layout shell (sidebar + chat + preview) |
| `AuthOverlay.tsx` | Authentication modal/overlay |
| `App.tsx` | State, effects, and top-level orchestration |

---

## Migration Strategy

1. Pick one file at a time.
2. Create the new modules, move code, update imports within the new files.
3. In the original file, replace moved code with imports and re-exports.
4. Run `npm run typecheck` and `npm run test:dev` to verify.
5. Update any imports across the codebase that referenced moved symbols directly.
6. Remove re-exports from the original file once all callers are migrated.

Each split is a standalone PR to keep reviews small and easy to revert.
