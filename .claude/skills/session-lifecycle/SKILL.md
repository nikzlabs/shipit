---
name: session-lifecycle
description: "ShipIt session lifecycle: session types (standalone, worktree, warm), creation paths, warm session pool mechanics, session activation flow, session switching. Load when working on session creation, warm pool, or activation logic."
user-invocable: true
---

# Session Lifecycle

This skill covers session creation, warm-up, activation, switching, and graduation. For container/runner infrastructure, see the `session-containers` skill.

## Key Components

| Component | Location | Role |
|-----------|----------|------|
| `SessionManager` | `orchestrator/sessions.ts` | Persists session metadata (title, workspace dir, remote URL, warm flag) to JSON |
| `SessionRunnerRegistry` | `orchestrator/session-runner.ts` | App-level map of session ID -> runner. Fires `onRunnerIdle` callback for container cleanup |
| `SessionRunnerInterface` | `orchestrator/session-runner.ts` | Abstract contract: agent state, message queue, viewer count, preview |
| `RepoStore` | `orchestrator/repo-store.ts` | Tracks imported repos, clone status, warm session IDs |

## Session Types

1. **Standalone session** — no repo, fresh git repo initialized in the session directory. Created via `POST /api/sessions`.
2. **Worktree session** — backed by a shared repo clone. Session directory is a git worktree branching from the repo's default branch. Created via warm pool or `claim-session`.
3. **Warm session** — a worktree session pre-created in the background (worktree + metadata only, no container). Invisible in the sidebar until the user sends their first message ("graduated"). The container is created on-demand when the WebSocket connects.

## Session Creation

### Path A: Standalone Session (no repo)

```
Client                          Server
  |                               |
  +- POST /api/sessions ---------> createSessionDir(title)
  |  {title}                      |   mkdir sessions/{uuid}
  |                               |   git init
  |                               |   configure credentials
  |                               |   sessionManager.track()
  |                               |   threadManager.init()
  |<- {sessionId, sessionDir} -----
  |                               |
  |  store pendingWsMessage       |
  |  navigate(/session/{id})      |
  |                               |
  |  useSessionWebSocket opens    |
  +- WS /ws/sessions/{id} -------> activateSession(id)
  |                               |   runnerRegistry.getOrCreate()
  |                               |     -> factory creates container
  |                               |   attachToRunner()
  |                               |
  |  useConnectionSync fires      |
  +- GET /api/sessions/{id}/history -> returns messages, commits, etc.
  |                               |
  |  send pendingWsMessage        |
  +- WS send_message ------------> handleSendMessage()
  |                               |   POST /agent/start to worker
  |<- WS streaming events ---------
```

### Path B: Warm Session (repo, pool hit)

The claim endpoint first checks for a **reusable** session: a previously-claimed warm session for this repo that was never graduated (user navigated away without sending a message). If found, it returns that session — reusing the existing container instead of creating a new one. Otherwise, it claims from the warm pool.

```
Client                          Server
  |                               |
  |  navigate(/{owner}/{repo}/new)|
  +- POST /api/repos/:url/claim-session ->
  |                               |  1. reusable ungraduated warm session?
  |                               |     YES -> return it (no new claim)
  |                               |  2. repo.warmSessionId exists?
  |                               |     YES -> clear warmSessionId
  |                               |     start warming next session (lightweight)
  |<- {sessionId} -----------------  (instant -- no container created)
  |                               |
  |  store pendingWsMessage       |
  |  navigate(/session/{id})      |
  |                               |
  |  WS /ws/sessions/{id} -------> activateSession(id)
  |                               |   runnerRegistry.getOrCreate()
  |                               |     -> reuse existing or create container
  |                               |   attachToRunner()
  |<- WS preview_status ----------   (once container boots + preview starts)
  |                               |
  |  send pendingWsMessage        |
  +- WS send_message ------------> graduates warm session
  |                               |   (rename, clear warm flag, broadcast)
```

### Path C: Claim Session (repo, no warm pool)

Same as Path B but `claim-session` creates the worktree synchronously (~1-2s).
If the client disconnected before work starts (`request.raw.destroyed`), the
endpoint short-circuits to avoid creating abandoned sessions.

1. `createSessionDir(title, { skipGitInit: true })`
2. Create git worktree from shared repo clone
3. Configure credentials
4. Return session ID to client (no container created)

The container is created on-demand when the WebSocket connects (`activateSession`
-> `getOrCreate` -> factory creates container).

The client passes an `AbortSignal` to the claim fetch. Navigating away (clicking
another session or "New Session" again) aborts the request, which the server
detects via `request.raw.destroyed`.

## Warm Session Pool

The warm pool pre-creates one session per repo so users get instant "New Session" with a running preview.

Two mechanisms prevent cascade during rapid "New Session" clicks:

1. **`warmingInProgress` set** (per repo URL) prevents concurrent `warmSessionForRepo` calls. Without this, each click triggers a replacement warm, and while those are in-flight (before `warmSessionId` is set), subsequent clicks see no warm session and fall to the slow path.

2. **`warmingPromises` map** stores the in-flight warming promise. When the claim endpoint finds no warm session but warming IS in progress, it awaits the promise and re-checks — claiming the freshly created warm session instead of falling to the expensive slow path.

### Warm-Up Sequence

Warm-up is **lightweight** — it creates the worktree and metadata only, with no runner or container. The container is created on-demand when a WebSocket connects to the session.

```
warmSessionForRepo(repoUrl):
  1. Check repo.status === "ready", no existing warm session, no warming in progress
  2. createSessionDir("Warm session", { skipGitInit: true })
  3. sessionManager.setWarm(appSessionId, true)
  4. Remove empty dir (worktree add needs it absent)
  5. repoGit.createWorktree(sessionDir, branchPrefix, startPoint)
  6. Configure git credentials
  7. repoStore.setWarmSessionId(repoUrl, appSessionId)
  8. sseBroadcast("repo_warm_ready", ...)
```

### Startup Validation + Re-Warm

On server restart, the startup sequence (deferred via `setTimeout(0)`) validates existing warm sessions and creates new ones where needed. No containers or runners are created at startup — they are created on-demand when a WebSocket connects.

1. **Validate**: For each repo with a `warmSessionId` and `status: "ready"`, check that the warm session's worktree directory still exists on disk. If missing, clear `warmSessionId` and re-warm (lightweight — worktree + metadata only).

2. **Re-warm**: For repos that have no warm session at all, create a fresh warm session via `warmSessionForRepo()` (lightweight).

### Graduation

When the user sends their first message on a warm session, `handleSendMessage` "graduates" it:
- Clears the `warm` flag
- Renames from "Warm session" to a meaningful title
- Broadcasts `session_list` update (session appears in sidebar)

## Session Activation (Per-Session WebSocket)

The client connects to `ws[s]://host/ws/sessions/{sessionId}?agent=claude`. The server handles this in `buildApp()`:

### Server-Side (on WS connect)

```
1. Validate session exists (close 4004 if not)
2. Initialize per-connection state:
   - activeAppSessionId = sessionId
   - activeSessionDir = session.workspaceDir
   - perConnectionAgentId = query.agent ?? defaultAgentId
3. activateSession(sessionId):
   a. existingRunner = runnerRegistry.get(sessionId)
   b. If exists: attachToRunner(existingRunner)
   c. Else: runner = runnerRegistry.getOrCreate(sessionId, dir, agentId)
            attachToRunner(runner)
4. Send log buffer
5. Re-send preview_status after log buffer (React batching mitigation)
```

### attachToRunner(runner)

```
1. Detach from any previous runner
2. Subscribe runner.on("message", send)
3. runner.attachViewer() -- increments viewer count
4. Replay turn event buffer (all events from current turn)
5. Send queue status if messages are queued
6. Send session_status if agent is running
7. Send preview_status ONLY IF runner.previewStatusKnown === true
   (otherwise, the runner will emit it later when SSE delivers state)
8. If previewStatusKnown === false:
   Register a one-shot "message" listener on the runner. When the first
   preview_status arrives, re-send it in a separate microtask (queueMicrotask)
   so it survives React 18 batching where rapid setLastMessage calls drop
   intermediate messages.
```

### Client-Side (on WS open)

```
useConnectionSync:
  1. GET /api/sessions/{id}/history -> messages, commits, fileTree, threads
  2. GET /api/sessions/{id}/preview-status -> HTTP fallback for preview state
     (only applied if store still has preview=null)
     If response is known: false -> retry once after 3s (by then SSE has connected)
  3. Send pendingWsMessage if present
```

## Session Switching (Client-Side)

### Switching to an Existing Session

```
handleSessionResume(sessionId, navigate):
  1. resumeSessionInternal(sessionId):
     a. Set sessionId in session store
     b. Clear messages, loading, queue
     c. Reset all session-specific stores (files, git, threads, terminal, UI, preview)
        -> preview store reset to null
     d. loadSessionHistory(sessionId) via HTTP (async)
  2. navigate("/session/{sessionId}")
     -> URL change triggers React re-render
     -> useSessionWebSocket computes new WS URL
     -> useWebSocket closes old WS, opens new WS
```

Server-side effects:
```
Old WS close:
  -> socket.on("close") fires
  -> detachFromRunner() -- decrements viewer count on old runner
  -> enforceIdleContainerLimit() -- may clean up excess idle containers

New WS open:
  -> activateSession(newSessionId)
  -> getOrCreate() gets (or creates) runner
  -> attachToRunner() -- subscribes to events, replays state
```

### Creating a New Session from Home

```
newSession(navigate):
  1. Clear sessionId
  2. Reset all session state
  3. Show templates
  4. navigate("/")
  -> WS disconnects when leaving /session/* URL
```
