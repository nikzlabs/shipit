---
status: done
---

# 059 — Simplified Repo & Session Flows

## Problem

Today's flow for starting work is cumbersome:

1. Click "New Session" in the sidebar → lands on a blank HomeScreen
2. Search for / select a repo in the RepoSelector dropdown
3. Type a message and send → wait for clone + worktree + Claude to start
4. Only then does the session appear in the sidebar and the preview start

Every new session requires re-picking a repo, even if you're working on the same repo you just used. There's no concept of "repo" as a first-class entity — repos are discovered implicitly from `session.remoteUrl`. And you can't see the preview or browse the codebase until Claude starts a turn.

## Design

Two changes that simplify the experience:

1. **"New Session" becomes "Add Repository"** — repos are first-class. The sidebar shows repos persistently, each with their own "New Session" button.
2. **Pre-created session pool** — each repo always has one warm session ready. Clicking "New Session" is instant: the worktree, runner, and preview are already running. When the user sends their first message, the warm session graduates to a visible session and a new warm session begins preparing in the background.

### User-facing flow

**Adding a repo (one-time per repo):**

1. User clicks [+ Add Repository] in the sidebar
2. Dialog opens: search existing GitHub repos or create a new one (same UI as today's RepoSelector + NewRepoDialog, restructured as a modal)
3. On selection/creation: the repo is cloned (progress shown in the dialog). Once complete, the repo appears in the sidebar with a ready warm session
4. Sidebar immediately shows the repo group with a [+ New Session] button

**Starting a session (instant, every time):**

1. User clicks [+ New Session] on a repo
2. The pre-created warm session is claimed instantly — preview is already running, file tree is loaded, chat input is ready
3. User browses the code, sees the live preview, thinks about what to ask
4. User types a message and sends → session graduates:
   - Appears in the sidebar session list with an AI-generated name
   - Claude starts running
   - A new warm session begins preparing in the background for this repo

**What the user sees in the sidebar:**

```
[+ Add Repository]

owner/repo-name                    ← collapsible repo group
  [+ New Session]                  ← claims the warm session
  ● fix login bug                  ← visible session (green = active)
  ○ add dark mode                  ← visible session

another-owner/repo
  [+ New Session]
  ...
```

---

## Data Model

### RepoStore (new)

Persisted as `/workspace/.vibe-repos.json`. Tracks explicitly added repos.

```typescript
interface RepoInfo {
  /** Canonical remote URL, e.g. "https://github.com/owner/repo.git". */
  url: string;
  /** When the repo was added. */
  addedAt: string;
  /** Last time any session was created for this repo. */
  lastUsedAt: string;
  /** Clone status. "cloning" while initial clone is in progress. */
  status: "cloning" | "ready";
  /** Session ID of the current warm (pre-created) session, if any. */
  warmSessionId?: string;
}
```

Methods:

- `add(url): RepoInfo` — adds a repo, sets status to "cloning"
- `setReady(url)` — flips status to "ready" after clone completes
- `setWarmSessionId(url, sessionId)` — stores the warm session's ID
- `remove(url)` — removes the repo (caller is responsible for worktree/session cleanup)
- `list(): RepoInfo[]` — returns all repos sorted by `lastUsedAt` descending
- `get(url): RepoInfo | undefined`

### SessionInfo changes

Add a `warm` field to `SessionInfo`:

```typescript
interface SessionInfo {
  // ... existing fields ...
  /** If true, this is a pre-created warm session not yet visible in the sidebar. */
  warm?: boolean;
}
```

`SessionManager.list()` already filters by `archived !== true`. It will additionally filter by `warm !== true`, so warm sessions are invisible in the sidebar and in `session_list` broadcasts.

When a warm session graduates (user sends first message), the `warm` flag is removed and the session becomes visible.

---

## Server-Side Design

### Phase 1: RepoStore + "Add Repository"

**New file: `src/server/orchestrator/repo-store.ts`**

Follows the same pattern as `SessionManager` — JSON file persistence, synchronous in-memory reads, save-on-write.

**New HTTP endpoints (in `api-routes.ts`):**

- `GET /api/repos` — returns `repoStore.list()`
- `POST /api/repos` — adds a repo. Body: `{ url }` (or `{ repoName, description, isPrivate, templateId }` for new repos — reuses existing `createRepoWithTemplate` logic). Kicks off clone in background, returns immediately with `{ repo: RepoInfo }` where `status: "cloning"`.
- `DELETE /api/repos/:url` — removes a repo and its warm session. Does NOT delete existing visible sessions (they may have valuable work).

**Clone happens on add:** When the user adds an existing repo via `POST /api/repos`, the server:

1. Creates the `RepoInfo` with `status: "cloning"`
2. Returns immediately (client shows "cloning..." state)
3. In background: clones into `getSharedRepoDir(url)`, then calls `repoStore.setReady(url)`
4. Broadcasts `repo_status { url, status: "ready" }` over WS
5. Immediately starts warming a session (see Phase 2)

This moves the clone latency from "New Session" time to "Add Repository" time, where a loading state is expected.

**Sidebar changes (client):**

- The "New Session" button in the sidebar header becomes "Add Repository" (opens the dialog)
- Repo groups in the sidebar are driven by `RepoStore` (not derived from sessions)
- Each repo group header has a [+ New Session] button
- Repos with `status: "cloning"` show a spinner instead of the button

### Phase 2: Warm Session Pool

**Core concept:** Each repo with `status: "ready"` always has exactly one warm session. This session has a worktree, a runner, and a running preview — but is not visible in the sidebar.

**Warming a session (`warmSessionForRepo` — new function in `index.ts` or a new service):**

1. Call `createSessionDir("Warm session", { skipGitInit: true })` — creates UUID dir, tracks in SessionManager
2. Set `warm: true` on the session via `sessionManager.setWarm(appSessionId, true)`
3. Create worktree from shared repo (same logic as current `handleHomeSendWithRepo`: `repoGit.createWorktree(...)`)
4. Configure git credentials
5. Set `remoteUrl`, `worktreeInfo` on the session
6. Create a runner via `runnerRegistry.getOrCreate(appSessionId, sessionDir, defaultAgentId)` — this starts the container, preview, file watcher, install
7. Store the warm session ID on the repo: `repoStore.setWarmSessionId(url, appSessionId)`
8. Broadcast `repo_warm_ready { url, sessionId }` so the client knows the repo is ready for instant sessions

**Claiming a warm session (user clicks "New Session"):**

New HTTP endpoint: `POST /api/repos/:url/claim-session`

1. Look up `repoStore.get(url).warmSessionId`
2. If warm session exists and its runner is alive:
   - Clear `warm` flag: `sessionManager.setWarm(sessionId, false)` — but don't add to visible list yet (we'll use a `pending` concept or keep `warm` until graduation)
   - Actually, the session stays `warm: true` until graduation. The claim just tells the client "use this session ID"
   - Return `{ sessionId, sessionDir }` — the client navigates to this session and sends `activate_session`
3. If no warm session (still preparing, or failed):
   - Create one synchronously (the slightly-slower path, same as today minus the clone)
   - Return once ready
4. Start warming the next session in the background (kick off `warmSessionForRepo` again)

**Graduating a warm session (user sends first message):**

This happens inside `handleSendMessage` when it detects the active session has `warm: true`:

1. Remove the `warm` flag → session becomes visible in the sidebar
2. Generate session name from the message text (existing `generateSessionName` logic)
3. Rename the branch with the slug (existing logic from `handleHomeSendWithRepo`)
4. Broadcast `session_list` so the sidebar updates
5. Proceed with normal `runClaudeWithMessage` flow

The key insight: Claude is started fresh on each `send_message` anyway, so there's nothing special about the first message — it's just a normal `send_message` with some metadata bookkeeping (graduation) beforehand.

**Background warming after graduation:**

After a session graduates, `warmSessionForRepo(repoUrl)` is called to prepare the next warm session. This runs entirely in the background — the user never waits for it.

**What the warm session runner does while waiting:**

- Preview server starts (runs `npm install` if needed, then the dev server)
- File watcher monitors the worktree
- Port scanner detects the dev server port
- All of this happens before the user even clicks "New Session"

When the user claims the session and sends `activate_session`, `attachToRunner` replays the current state (preview status, file tree) immediately.

### Phase 3: Cleanup & Edge Cases

**Server restart:** On startup, for each repo with `status: "ready"` in `RepoStore`, check if the warm session's worktree and runner still exist. If not, re-warm. This can be lazy (warm on first "New Session" click) or eager (warm all repos on startup). Lazy is simpler and avoids startup latency.

**Repo removal:** `DELETE /api/repos/:url`:

1. If a warm session exists, dispose its runner and remove the worktree
2. Remove the repo from `RepoStore`
3. Existing visible sessions for this repo remain in the session list (they have their own worktrees). The user can archive them individually.

**Runner eviction:** The `SessionRunnerRegistry` has a `maxConcurrentRunners` limit (default 10). Warm session runners count toward this limit. If the limit is hit, warm runners are evicted first (they're the cheapest to recreate). The registry's existing eviction logic (`!r.running && r.viewerCount === 0`) already handles this — warm runners have 0 viewers.

**Multiple rapid "New Session" clicks:** If the user claims a warm session and immediately clicks "New Session" again before the next warm session is ready, the second claim falls through to the synchronous creation path. This is the rare case and only adds ~1-2s (worktree creation, no clone needed).

---

## Client-Side Design

### New state: `useRepoStore`

```typescript
interface RepoState {
  repos: RepoInfo[];
  setRepos: (repos: RepoInfo[]) => void;
  updateRepo: (url: string, partial: Partial<RepoInfo>) => void;
}
```

Populated on connect via `GET /api/repos`. Updated via WS broadcasts (`repo_status`, `repo_warm_ready`).

### Sidebar restructure

`SessionSidebar` changes:

- Header button: "Add Repository" instead of "New Session"
- Groups are keyed by `RepoStore` entries, not derived from `session.remoteUrl`
- Each group header has a [+ New Session] button (disabled if repo is still cloning or no warm session ready)
- Sessions with `warm: true` are excluded from the group's session list
- "No Remote" group remains for legacy sessions without a repo

### "Add Repository" dialog

A modal (replaces the inline `RepoSelector` on HomeScreen) with:

- Search input for existing GitHub repos (reuses `searchRepos` API)
- "Create new repository" option (reuses `NewRepoDialog` flow)
- Progress indicator during clone
- Auto-closes when clone completes and warm session is ready

### Claiming a warm session

When the user clicks [+ New Session] on a repo:

1. `POST /api/repos/:url/claim-session` → gets `{ sessionId }`
2. Navigate to `/session/:sessionId`
3. Send `activate_session { sessionId }` over WS
4. The runner is already running → preview status, file tree arrive immediately
5. Chat area is empty, input is focused — ready for the user's first message

### Session graduation (client side)

When the user sends a message in a warm session:

- `send_message` is sent as normal (with `sessionId`)
- Server graduates the session and broadcasts `session_list` / `session_renamed`
- The sidebar updates to show the new session
- No special client logic needed — the existing message handler and sidebar rendering handle it

### HomeScreen removal

With this design, the HomeScreen (`HomeScreen.tsx`, `RepoSelector.tsx`) is no longer the primary entry point. It can be:

- **Removed entirely** — the sidebar + "Add Repository" dialog replaces its function
- **Kept as a fallback** — shown only when there are zero repos (first-time user experience)

Recommendation: keep a minimal version for the zero-repo state that just shows "Add a repository to get started" with a prominent button. Remove the repo selector and message input from it.

---

## New WS Messages

**Server → Client:**

```typescript
interface WsRepoStatus {
  type: "repo_status";
  url: string;
  status: "cloning" | "ready";
}

interface WsRepoWarmReady {
  type: "repo_warm_ready";
  url: string;
  sessionId: string;
}
```

**Client → Server:** None needed — repo operations use HTTP. Session activation uses the existing `activate_session` message.

---

## New HTTP Endpoints

| Method | Path | Purpose |
|--------|------|---------|
| GET | `/api/repos` | List all added repos |
| POST | `/api/repos` | Add a repo (clone begins) |
| DELETE | `/api/repos/:url` | Remove a repo |
| POST | `/api/repos/:url/claim-session` | Claim the warm session for a repo |

---

## Migration

Existing users have sessions with `remoteUrl` set but no `RepoStore`. On first startup with the new code:

1. Scan all sessions for unique `remoteUrl` values
2. For each, create a `RepoInfo` entry with `status: "ready"` (the shared repo dir already exists from previous `home_send_with_repo` calls)
3. Start warming a session for each

This is a one-time migration that runs at server start.

---

## Implementation Order

1. **RepoStore** — new persistence layer, HTTP endpoints, migration from session-derived repos
2. **Sidebar restructure** — repo-driven groups, "Add Repository" dialog, per-repo "New Session" button
3. **"Add Repository" clone flow** — clone on add, progress WS broadcast, repo status in sidebar
4. **Warm session pool** — `warmSessionForRepo`, claim endpoint, graduation logic in `handleSendMessage`
5. **HomeScreen simplification** — minimal zero-repo state, remove RepoSelector/HomeScreen message input
6. **Cleanup** — remove `home_send_with_repo` WS message (replaced by claim + send_message), remove old HomeScreen components

---

## Key Files

| File | Change |
|------|--------|
| `src/server/orchestrator/repo-store.ts` | New — RepoStore persistence |
| `src/server/orchestrator/api-routes.ts` | New endpoints for repos |
| `src/server/orchestrator/index.ts` | `warmSessionForRepo`, migration, DI wiring |
| `src/server/orchestrator/ws-handlers/send-message.ts` | Graduation logic in `handleSendMessage` |
| `src/server/orchestrator/session-runner.ts` | No changes (existing eviction handles warm runners) |
| `src/server/orchestrator/sessions.ts` | `warm` field, filter warm from `list()` |
| `src/server/shared/types/domain-types.ts` | `RepoInfo` type, `warm` on `SessionInfo` |
| `src/server/shared/types/ws-server-messages.ts` | `repo_status`, `repo_warm_ready` messages |
| `src/client/components/SessionSidebar.tsx` | Repo-driven groups, "Add Repository", per-repo "New Session" |
| `src/client/components/HomeScreen.tsx` | Simplify to zero-repo state only |
| `src/client/components/RepoSelector.tsx` | Move into "Add Repository" dialog |
| `src/client/hooks/useRepoStore.ts` | New — Zustand store for repos |
