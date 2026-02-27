---
status: planned
---

# 053 — Server Code Separation: Session vs Orchestrator

## Problem

All server code lives in a flat `src/server/` directory. Code that runs *inside* a session (agent process management, terminal, preview, file watching) is entangled with code that runs in the *orchestrator* (multi-session management, auth, routing, container orchestration). This makes it hard to reason about boundaries, complicates the container-mode architecture (where session code runs in a Docker container and orchestrator code runs in the main process), and increases the risk of accidentally coupling new features to the wrong layer.

Today the separation already exists conceptually — `session-worker.ts` runs inside containers, `index.ts` runs the orchestrator — but the file layout doesn't reflect it. A developer adding a new feature has no structural guidance about which layer they're working in.

## Goals

1. Make the session/orchestrator boundary **visible in the directory structure**
2. **Zero runtime changes** — this is a pure file-move refactoring; no behavior changes, no new abstractions
3. Maintain full test compatibility
4. Make it obvious where new code should go

## Non-goals

- Introducing new abstractions, interfaces, or dependency injection patterns
- Splitting into separate packages or build targets (may come later)
- Changing the services layer (already clean — pure functions with explicit params)

## Proposed Directory Structure

```
src/server/
  session/              # Code that runs inside a session context
    claude.ts           # ClaudeProcess — spawns CLI, parses NDJSON
    terminal.ts         # TerminalProcess — interactive PTY
    preview-manager.ts  # PreviewManager — spawns/manages preview server
    preview-config.ts   # Preview config parsing (shipit.yaml)
    file-watcher.ts     # FileWatcher — recursive fs.watch
    file-tree.ts        # scanFileTree() — workspace directory listing
    port-scanner.ts     # Port detection for dev server previews
    install-runner.ts   # Runs install commands (npm install, etc.)
    vite-error-plugin.ts # Injects error-capture script into preview HTML
    session-worker.ts   # The Fastify server that runs inside each container
    agents/             # Agent process adapters (move from server/agents/)
      agent-process.ts  # AgentProcess interface
      agent-registry.ts # AgentRegistry — detects installed CLIs
      claude-adapter.ts # ClaudeAdapter — wraps ClaudeProcess
      codex-adapter.ts  # CodexAdapter — wraps Codex CLI

  orchestrator/         # Code that runs in the main process
    index.ts            # buildApp(), Fastify setup, WS dispatcher
    api-routes.ts       # HTTP REST API routes
    sessions.ts         # SessionManager — tracks all sessions
    session-runner.ts   # SessionRunner + SessionRunnerRegistry
    container-session-runner.ts  # ContainerSessionRunner (proxy)
    session-container.ts # SessionContainerManager — Docker orchestration
    preview-proxy.ts    # Reverse proxy for container previews
    auth.ts             # AuthManager — Claude CLI OAuth
    github-auth.ts      # GitHubAuthManager — GitHub token + API
    credential-store.ts # CredentialStore — unified credentials
    deployment-manager.ts # DeploymentManager — deploy target registry
    deployment-store.ts # DeploymentStore — deploy configs/history
    features.ts         # FeatureManager — scans docs/ for feature status
    session-namer.ts    # AI-powered session naming
    ws-handlers/        # WebSocket message handlers (move as-is)
      types.ts
      send-message.ts
      session-handlers.ts
      terminal-handlers.ts
      deploy-handlers.ts
      thread-handlers.ts
      misc-handlers.ts
    services/           # Pure service functions (move as-is)
      session.ts, git.ts, github.ts, deploy.ts, settings.ts,
      threads.ts, templates.ts, files.ts, misc.ts, types.ts, index.ts
    deploy-targets/     # Deploy target implementations (move as-is)
      vercel.ts
      cloudflare.ts

  shared/               # Code used by both session and orchestrator
    types/              # All type definitions (move from server/types/)
      index.ts
      ws-client-messages.ts
      ws-server-messages.ts
      domain-types.ts
      claude-types.ts
      agent-types.ts
      attachment-types.ts
      deployment-types.ts
      github-types.ts
      terminal-types.ts
      thread-types.ts
      usage-types.ts
    git.ts              # GitManager — stateless, used in both contexts
    git-config.ts       # Global git config helpers
    validation.ts       # Input validation, error formatting
    markdown.ts         # findMarkdownFiles() — docs discovery
    chat-history.ts     # ChatHistoryManager — per-session data, app-wide singleton
    threads.ts          # ThreadManager — per-session data, app-wide singleton
    usage.ts            # UsageManager — per-session cost tracking
    templates.ts        # Project scaffolding templates
```

## Classification Rationale

### Session (`src/server/session/`)

Code that operates within a **single session's workspace** and manages processes tied to that session's lifecycle:

| File | Why session? |
|------|-------------|
| `claude.ts` | Spawns a Claude CLI process for one session |
| `terminal.ts` | PTY for one session's terminal |
| `preview-manager.ts` | Manages one session's preview server |
| `preview-config.ts` | Parses one session's shipit.yaml |
| `file-watcher.ts` | Watches one session's workspace directory |
| `file-tree.ts` | Scans one session's file tree |
| `port-scanner.ts` | Detects ports in one session's dev server |
| `install-runner.ts` | Runs install in one session |
| `vite-error-plugin.ts` | Injects into one session's preview |
| `session-worker.ts` | **The** session process in container mode |
| `agents/*` | Agent adapters are spawned per-session |

### Orchestrator (`src/server/orchestrator/`)

Code that manages **multiple sessions**, handles **routing/auth**, or orchestrates **cross-session concerns**:

| File | Why orchestrator? |
|------|-------------------|
| `index.ts` | App setup, DI, WS dispatcher, container lifecycle |
| `api-routes.ts` | HTTP routing across all sessions |
| `sessions.ts` | Tracks all sessions (list, rename, archive) |
| `session-runner.ts` | Registry of active runners (one per session) |
| `container-session-runner.ts` | Proxies to session worker in container |
| `session-container.ts` | Docker container orchestration |
| `preview-proxy.ts` | Reverse proxy routing to containers |
| `auth.ts` | App-wide Claude OAuth |
| `github-auth.ts` | App-wide GitHub auth |
| `credential-store.ts` | App-wide credential storage |
| `deployment-manager.ts` | App-wide deploy target registry |
| `deployment-store.ts` | Per-session deploy configs (app-wide store) |
| `features.ts` | App-wide feature scanning |
| `ws-handlers/*` | Orchestrator dispatches WS messages |
| `services/*` | Pure functions consumed by orchestrator routes |

### Shared (`src/server/shared/`)

Code used by **both** layers:

| File | Why shared? |
|------|-------------|
| `types/*` | Type definitions used everywhere |
| `git.ts` | GitManager is created per-session but also used by orchestrator (listing remotes, worktree management) |
| `git-config.ts` | Global git config, used by both layers |
| `validation.ts` | Input validation used in both WS handlers and session worker |
| `markdown.ts` | Simple utility, no layer affiliation |
| `chat-history.ts` | App-wide singleton, but stores per-session data; used by both orchestrator (HTTP routes) and potentially session worker |
| `threads.ts` | Same pattern as chat-history |
| `usage.ts` | Same pattern as chat-history |
| `templates.ts` | Used by orchestrator services but contains session-level logic (scaffolding into a workspace) |

## Key Entanglement Points (and how this refactoring handles them)

### 1. HandlerContext is the biggest coupling surface

`HandlerContext` (in `ws-handlers/types.ts`) contains ~40 methods mixing per-connection state, per-session runner delegation, and app-wide manager references. This is the main "god object" bridging orchestrator and session.

**This refactoring**: HandlerContext stays in `orchestrator/ws-handlers/types.ts`. It already imports types from managers rather than concrete implementations. The imports just get longer paths. No structural change needed — HandlerContext is inherently an orchestrator concept (it exists per WebSocket connection in the main process).

### 2. SessionRunner vs SessionWorker duality

`SessionRunner` (in-process, test mode) and `ContainerSessionRunner` (proxy to worker) implement the same `SessionRunnerInterface`. The interface itself references session-layer types (`AgentProcess`, `TerminalProcess`).

**This refactoring**: `SessionRunnerInterface` stays in `orchestrator/session-runner.ts`. It imports types from `session/agents/agent-process.ts` and `session/terminal.ts`. The interface definition doesn't move layers — the orchestrator needs to know the shape of what it's managing, but the implementations live in their respective layers.

### 3. AgentRegistry spans both layers

`AgentRegistry` detects installed agent CLIs (orchestrator concern) but is also referenced when creating agent processes (session concern, inside `session-worker.ts`).

**This refactoring**: `agents/` directory moves to `session/agents/`. The `AgentRegistry` class moves there too, since it's primarily about agent CLI detection and the agents themselves are session-scoped processes. The orchestrator imports it for the detection step at startup.

### 4. ChatHistoryManager / ThreadManager / UsageManager

These are app-wide singletons that organize data per-session. They're created once by the orchestrator but could theoretically be used inside session workers too.

**This refactoring**: Move to `shared/`. They're genuinely shared — the orchestrator creates and owns them, but the data model is inherently per-session.

## Migration Strategy

### Phase 1: Create directories and move files

1. Create `src/server/session/`, `src/server/orchestrator/`, `src/server/shared/`
2. Move files according to the classification above
3. Update all `import` paths — this is the bulk of the work

### Phase 2: Update import paths

The main mechanical work. Every `import` in every moved file needs path adjustment. Additionally, files that *import from* moved files (including client code that imports server types, and test files) need updates.

Key import patterns to update:
- `from "./claude.js"` → `from "./session/claude.js"` (from orchestrator)
- `from "../types.js"` → `from "../shared/types/index.js"` (from session or orchestrator)
- `from "../validation.js"` → `from "../shared/validation.js"` (from orchestrator handlers)

### Phase 3: Barrel exports (optional, for convenience)

Add `src/server/session/index.ts` and `src/server/orchestrator/index.ts` barrel files re-exporting public APIs. This keeps external imports (from tests, client) shorter.

### Phase 4: Verify

1. `npm run typecheck` — all imports resolve
2. `npm test` — all tests pass
3. `npm run lint` — no lint errors
4. `npm run build` — client build succeeds

## Risk Assessment

| Risk | Likelihood | Impact | Mitigation |
|------|-----------|--------|-----------|
| Broken imports after move | High (mechanical) | Low (caught by typecheck) | Run `typecheck` after every batch of moves |
| Test file import breakage | High (mechanical) | Low (caught by test run) | Update test imports in same commit as source moves |
| Circular dependency introduced | Low | Medium | Files already avoid cycles; moving doesn't create new ones |
| Git blame disrupted | Certain | Low | Use `git log --follow` for history; unavoidable with file moves |
| Merge conflicts with in-flight PRs | Medium | Medium | Coordinate timing; do the move in one focused PR |

## Feasibility Assessment

**Verdict: Feasible, low-risk, high-value.**

- **Mechanical, not architectural**: This is purely moving files and updating imports. No runtime behavior changes, no new abstractions, no API changes.
- **TypeScript catches everything**: Any broken import is a compile error. `npm run typecheck` gives 100% confidence.
- **Tests provide safety net**: Full test suite validates no behavioral regression.
- **Clear classification**: Very few files are ambiguous. The session/orchestrator boundary already exists conceptually in the container architecture (session-worker.ts vs index.ts).
- **Estimated effort**: 1-2 focused sessions. The bulk is mechanical import rewriting.
- **One caveat**: This will touch nearly every file in `src/server/`, so it should be done in a single focused PR to minimize merge conflicts with parallel work.

## Open Questions

1. **Should `agents/` live under `session/` or be top-level?** The registry is used at orchestrator startup, but agent processes themselves are session-scoped. Proposed: keep under `session/` since that's where they execute.

2. **Should services stay under `orchestrator/` or move to `shared/`?** Services are pure functions called from HTTP routes (orchestrator), but they operate on session data. Proposed: keep under `orchestrator/` since they're consumed exclusively by orchestrator code (routes and WS handlers).

3. **Should the `shared/` singletons (ChatHistoryManager, ThreadManager, UsageManager) eventually become session-scoped?** In a fully containerized world, each session container could own its own history/threads/usage. This refactoring doesn't answer that — it just puts them in `shared/` to acknowledge the ambiguity.
