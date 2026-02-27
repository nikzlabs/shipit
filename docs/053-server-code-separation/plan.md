---
status: planned
---

# 053 — Server Code Separation: Session vs Orchestrator

## Problem

All server code lives in a flat `src/server/` directory. Code that runs *inside* a session (agent process management, terminal, preview, file watching) is entangled with code that runs in the *orchestrator* (multi-session management, auth, routing, container orchestration). This makes it hard to reason about boundaries, complicates the container-mode architecture (where session code runs in a Docker container and orchestrator code runs in the main process), and increases the risk of accidentally coupling new features to the wrong layer.

Today the separation already exists conceptually — `session-worker.ts` runs inside containers, `index.ts` runs the orchestrator — but the file layout doesn't reflect it. A developer adding a new feature has no structural guidance about which layer they're working in.

## Goals

1. Make the session/orchestrator boundary **visible in the directory structure**
2. **Minimal runtime changes** — primarily file moves and import updates, with one targeted split (`GitManager` → `GitManager` + `RepoGit`) that enforces the boundary at the type level
3. Maintain full test compatibility
4. Make it obvious where new code should go

## Non-goals

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
    repo-git.ts         # RepoGit — clone, fetch, worktree lifecycle, branch deletion (split from GitManager)
    git-utils.ts        # generateBranchPrefix() and parseGitHubRemote()
    git-config.ts       # Global git config helpers
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
    chat-history.ts     # ChatHistoryManager — per-session message persistence
    threads.ts          # ThreadManager — conversation threads and checkpoints
    usage.ts            # UsageManager — per-session cost tracking
    templates.ts        # Project scaffolding templates
    markdown.ts         # findMarkdownFiles() — docs discovery
    validation.ts       # Input validation, error formatting
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
    git.ts              # GitManager — init, commit, log, push, pull, diff, rollback (split from original GitManager)
    file-tree.ts        # scanFileTree() — used by session-worker and orchestrator services
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
| `repo-git.ts` | Manages shared repos and worktree lifecycle across sessions |
| `git-utils.ts` | `generateBranchPrefix()`, `parseGitHubRemote()` — only called from orchestrator code |
| `git-config.ts` | `initGlobalGitConfig()`, `getGitIdentity()` — called at app startup and by `services/settings.ts` |
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
| `chat-history.ts` | All callers are orchestrator: `ws-handlers/send-message.ts`, `ws-handlers/thread-handlers.ts`, `services/session.ts`, `services/threads.ts` |
| `threads.ts` | All callers are orchestrator: `ws-handlers/send-message.ts`, `ws-handlers/thread-handlers.ts`, `services/threads.ts` |
| `usage.ts` | All callers are orchestrator: `ws-handlers/send-message.ts`, `services/misc.ts` |
| `templates.ts` | All callers are orchestrator: `services/templates.ts`, `services/misc.ts` |
| `markdown.ts` | All callers are orchestrator: `services/files.ts`, `features.ts` |
| `validation.ts` | All callers are orchestrator: `api-routes.ts`, `index.ts`, `ws-handlers/send-message.ts`, `ws-handlers/thread-handlers.ts` |
| `ws-handlers/*` | Orchestrator dispatches WS messages |
| `services/*` | Pure functions consumed by orchestrator routes |

### Shared (`src/server/shared/`)

Code used by **both** session and orchestrator layers. Only files with verified cross-layer usage belong here:

| File | Session callers | Orchestrator callers |
|------|----------------|---------------------|
| `types/*` | `session-worker.ts`, `agents/*.ts` | everywhere |
| `git.ts` (GitManager) | none today, but auto-commit will move to session layer in fully-containerized mode | `services/git.ts`, `services/github.ts`, `services/templates.ts`, `ws-handlers/send-message.ts`, `index.ts` |
| `file-tree.ts` | `session-worker.ts` (serves file listing to preview) | `services/files.ts`, `services/git.ts` |

## Splitting GitManager

Today `git.ts` has a single `GitManager` class (31 methods) used in two distinct contexts:

1. **On a session workspace** (`createGitManager(sessionDir)`) — everyday git: init, commit, log, push, pull, diff, rollback
2. **On a shared repo** (`createGitManager(repoDir)`) — cross-session repo management: clone, fetch, worktree add/remove, branch deletion

The same class wraps both, but the methods called in each context barely overlap (only `log(1)` for empty-repo detection). This refactoring splits it into two classes and a utility module.

### Method assignment

```
shared/git.ts — GitManager                orchestrator/repo-git.ts — RepoGit
(single-workspace operations)              (shared-repo & worktree management)
───────────────────────────────            ────────────────────────────────────
init()                                     clone(url, branch?)
autoCommit(summary)                        fetch(remote)
log(maxCount)                              getDefaultBranch(remote)
rollback(commitHash)                       createWorktree(path, branch, startPoint?)
push(remote, branch)                       removeWorktree(path)
pull(remote, branch)                       listWorktrees()
getCurrentBranch()                         deleteBranch(branchName)
checkoutNewBranch(branchName)
renameBranch(old, new)
addRemote(name, url)
getRemotes()
listRemoteBranches()
merge(branchName)
diffSummary()
diffNameStatus(from, to)
diffStatVsBranch(base)
getFileAtCommit(hash, path)
checkoutFiles(hash, files)

orchestrator/git-utils.ts — standalone functions
────────────────────────────────────────────────
generateBranchPrefix()
parseGitHubRemote(url)    (currently GitManager.parseGitHubRemote static)
```

### Call-site mapping

**GitManager** (called on sessionDir):

| Method | Callers |
|--------|---------|
| `init()` | `index.ts` (createSessionDir), `send-message.ts` (workspace recovery, empty repo) |
| `autoCommit()` | `send-message.ts` (after agent turn), `services/templates.ts`, `services/git.ts` (rejectChanges) |
| `log()` | `services/git.ts` (HTTP route) |
| `rollback()` | `services/git.ts` (HTTP route) |
| `push()` / `pull()` | `index.ts` (auto-push), `services/git.ts` (HTTP routes) |
| `getCurrentBranch()` | `index.ts` (auto-push), `services/git.ts`, `services/github.ts` |
| `getRemotes()` | `services/session.ts` (lazy URL), `services/git.ts` |
| `addRemote()` | `send-message.ts`, `services/git.ts`, `services/templates.ts` |
| `renameBranch()` | `send-message.ts` (branch naming after repo import) |
| `diff*()` / `getFileAtCommit()` | `services/git.ts` (turn diff), `services/github.ts` |
| `merge()` | `services/session.ts` (merge worktree) |
| `checkoutFiles()` | `services/git.ts` (rejectChanges) |

**RepoGit** (called on shared repoDir):

| Method | Callers |
|--------|---------|
| `clone()` | `send-message.ts` (home_send_with_repo, first clone) |
| `fetch()` | `send-message.ts` (home_send_with_repo, refresh) |
| `getDefaultBranch()` | `send-message.ts` (worktree start point) |
| `createWorktree()` | `send-message.ts` (home_send_with_repo), `services/session.ts` (forkSession) |
| `removeWorktree()` | `services/session.ts` (archiveSession) |
| `deleteBranch()` | `services/session.ts` (archiveSession cleanup) |
| `log(1)` | `send-message.ts` (empty repo detection — use `GitManager.log(1)` on the repo dir, no need to duplicate) |

### Implementation notes

- Both classes wrap `simple-git`. No shared base class needed — the constructors are one-liners (`this.git = simpleGit(dir)`).
- `RepoGit` gets its own `log(1)` for the empty-repo check, or the caller can construct a temporary `GitManager` for that one check. Either works; the former is cleaner.
- The DI factory in `AppDeps` splits: `createGitManager: (dir) => GitManager` stays as-is (session workspace ops). A new `createRepoGit: (dir) => RepoGit` factory is added for shared-repo operations. Alternatively, `RepoGit` can be constructed directly since it's only used in a few orchestrator call sites.
- `parseGitHubRemote()` becomes a standalone function in `git-utils.ts` (it's already static and doesn't use `simple-git`). `generateBranchPrefix()` moves there too (already a standalone export).

### Why not keep one class in `shared/`?

A single `GitManager` in `shared/` would work but defeats the purpose of the separation. The two usage patterns represent genuinely different abstractions:

- **GitManager** = "my workspace" — init, commit, push, pull, diff. This is what a session thinks about.
- **RepoGit** = "the repo pool" — clone, fetch, worktree lifecycle. This is what the orchestrator thinks about when managing shared repos across sessions.

Splitting makes it impossible to accidentally call `createWorktree()` on a session workspace or `autoCommit()` on a shared repo. The type system enforces the boundary.

## Cross-Layer Analysis: What's Actually Shared?

Every file originally proposed for `shared/` was traced method-by-method to its actual callers. The session layer is defined as files that run inside a session container: `session-worker.ts`, `claude.ts`, `terminal.ts`, `preview-manager.ts`, `preview-config.ts`, `file-watcher.ts`, `file-tree.ts`, `port-scanner.ts`, `install-runner.ts`, `agents/*.ts`. Everything else is orchestrator.

### Results

| File | Session callers | Orchestrator callers | Verdict |
|------|----------------|---------------------|---------|
| `types/*` | `session-worker.ts`, `agents/*.ts` | everywhere | **Shared** |
| `git.ts` (GitManager) | none today (but logically session-scoped) | services, ws-handlers, index.ts | **Shared** |
| `file-tree.ts` | `session-worker.ts` (GET /files/tree) | `services/files.ts`, `services/git.ts` | **Shared** |
| `validation.ts` | none | `api-routes.ts`, `index.ts`, `ws-handlers/*` | **Orchestrator** |
| `git-utils.ts` | none | `ws-handlers/send-message.ts`, `services/github.ts` | **Orchestrator** |
| `git-config.ts` | none | `index.ts`, `services/settings.ts`, `github-auth.ts` | **Orchestrator** |
| `chat-history.ts` | none | `ws-handlers/send-message.ts`, `ws-handlers/thread-handlers.ts`, `services/session.ts`, `services/threads.ts` | **Orchestrator** |
| `threads.ts` | none | `ws-handlers/send-message.ts`, `ws-handlers/thread-handlers.ts`, `services/threads.ts` | **Orchestrator** |
| `usage.ts` | none | `ws-handlers/send-message.ts`, `services/misc.ts` | **Orchestrator** |
| `templates.ts` | none | `services/templates.ts`, `services/misc.ts` | **Orchestrator** |
| `markdown.ts` | none | `services/files.ts`, `features.ts` | **Orchestrator** |

### Key insight

**7 of 11 files originally proposed for `shared/` are actually orchestrator-only.** The session worker's imports are minimal: `agents/agent-process.ts`, `terminal.ts`, `preview-manager.ts`, `file-watcher.ts`, `file-tree.ts`, plus type definitions. It doesn't touch chat history, threads, usage, templates, validation, git config, or markdown. This makes sense — the session worker manages *processes* (agent, terminal, preview, file watching), while the orchestrator manages *data* (history, threads, usage, templates).

Moving these files to `orchestrator/` instead of `shared/` means the type system will prevent session-layer code from accidentally importing them, which is exactly what this refactoring aims for.

## Other Entanglement Points

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

These are app-wide singletons that organize data per-session. They were originally proposed for `shared/` on the assumption that session workers might need them.

**Cross-layer analysis shows they are orchestrator-only.** Every caller is in `ws-handlers/*.ts`, `services/*.ts`, or `index.ts` — all orchestrator code. `session-worker.ts` does not import any of them. This makes sense: the session worker manages processes (agent, terminal, preview), while the orchestrator manages data (history, threads, usage).

**This refactoring**: Move to `orchestrator/`. If a future containerization step needs them inside the session worker, they can be moved to `shared/` then — but today the type system will correctly prevent session code from reaching them.

## Migration Strategy

### Phase 1: Split GitManager

Do this first as a standalone commit — it's the only code change (as opposed to file moves):

1. Extract `generateBranchPrefix()` and `parseGitHubRemote()` into `git-utils.ts`
2. Create `repo-git.ts` with `RepoGit` class containing: `clone`, `fetch`, `getDefaultBranch`, `createWorktree`, `removeWorktree`, `listWorktrees`, `deleteBranch`, `isEmpty`
3. Remove those methods from `GitManager`
4. Update call sites:
   - `send-message.ts` (home_send_with_repo): `createGitManager(repoDir)` → `new RepoGit(repoDir)`
   - `services/session.ts` (forkSession, archiveSession): same pattern
   - All `generateBranchPrefix()` / `parseGitHubRemote()` imports → from `git-utils.ts`
5. Run `typecheck` + `test` to verify

### Phase 2: Create directories and move files

1. Create `src/server/session/`, `src/server/orchestrator/`, `src/server/shared/`
2. Move files according to the classification above:
   - `shared/` gets only 3 files: `types/`, `git.ts`, `file-tree.ts`
   - `orchestrator/` gets the bulk: index, api-routes, managers, ws-handlers, services, plus the 7 files that were originally proposed for shared (validation, chat-history, threads, usage, templates, markdown, git-config, git-utils)
   - `session/` gets the process managers: claude, terminal, preview, file-watcher, agents, session-worker
3. Update all `import` paths — this is the bulk of the work

Key import patterns to update:
- `from "./claude.js"` → `from "../session/claude.js"` (from orchestrator)
- `from "../types.js"` → `from "../shared/types/index.js"` (from session or orchestrator)
- `from "../validation.js"` → `from "./validation.js"` (stays within orchestrator)
- `from "../git.js"` → `from "../shared/git.js"` (from orchestrator services)
- `from "./chat-history.js"` → `from "./chat-history.js"` (stays within orchestrator)

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

3. **Should `RepoGit` have an `isEmpty()` method?** The only cross-context method is `log(1)` called on a shared repo dir in `send-message.ts:723` to detect an empty repo. Options: (a) give `RepoGit` its own `isEmpty()` that wraps the check, (b) construct a temporary `GitManager` at that call site. Option (a) is cleaner — it expresses intent rather than leaking the mechanism.
