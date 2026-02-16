# Design Doc 009: Session Isolation

## Status: Proposed

## Problem

All sessions share a single `/workspace` directory and a single git repo. When a user starts Session A and builds a React app, then starts Session B and builds a Flask API, Session B's changes overwrite Session A's files. Switching back to Session A shows a broken project because the workspace now contains Session B's code.

This also means sessions cannot run in parallel. If two browser tabs are open — one working on Session A and one on Session B — they step on each other's files.

Specific pain points:
1. **File collisions** — Claude in Session B can delete or overwrite files created in Session A.
2. **Git history is tangled** — commits from all sessions are interleaved on one branch, making rollback per-session impossible.
3. **Preview confusion** — the Vite dev server always shows whatever is currently on disk, regardless of which session the user thinks they're in.
4. **Rollback is global** — rolling back to a commit from Session A also undoes Session B's work.
5. **No parallel sessions** — can't keep Session A's preview running while working on Session B.

### Why not git branches?

Git branches share a single working directory. Only one branch can be checked out at a time. Switching branches changes files on disk for all sessions, kills running dev servers, and makes parallel sessions impossible. Branches are useful for lightweight divergence within a session, but not for full isolation between sessions.

## Goals

1. Each session gets its own directory with its own git repo, so file changes are fully isolated.
2. Rollback only affects the current session's files.
3. File tree, file viewer, docs, and preview all reflect the active session's state.
4. Switching sessions is instant (no git checkout, no file swapping).

## Non-Goals

- Sharing files between sessions (users can copy manually or use templates).
- Shared `node_modules` across sessions (each session installs its own dependencies).
- Parallel previews across sessions (v1 uses a single Vite instance for the active session; per-session Vite is a future enhancement).
- Running multiple Claude CLI processes concurrently (currently the server has a single `ClaudeProcess` variable — starting a new turn kills any running turn, regardless of session).
- Cross-session diffing or merging.

## Prerequisites

### `/workspace` must be a Docker volume

Currently `/workspace` is created inside the container image (`mkdir -p /workspace && git init` in the Dockerfile). All data is lost when the container stops. This is already a problem today — session isolation just makes it more visible.

The Dockerfiles should declare `/workspace` as a volume, and users should mount persistent storage:

```dockerfile
# In Dockerfile
VOLUME /workspace
```

```bash
# At runtime
docker run -v shipit-data:/workspace ...
```

This ensures session directories, git repos, chat history, and metadata survive container restarts. Without a volume, session isolation still works within a single container lifetime but nothing persists.

The `git init` in the Dockerfile should also be removed — `GitManager.init()` already handles repo initialization at runtime, and it would conflict with a mounted volume anyway (you'd init inside the image layer, then mount over it).

## Design

### Core Concept: Directory Per Session

Each session gets its own workspace directory:

```
/workspace/
  sessions/
    abc123/          ← Session A's workspace
      .git/
      package.json
      src/
      node_modules/
    def456/          ← Session B's workspace
      .git/
      index.html
      style.css
  .vibe-sessions.json
  .vibe-chat-history/
  .shipit-usage.json
```

Session metadata, chat history, and usage stats remain in the root `/workspace` directory (they're already per-session by ID). Only the project files live inside `sessions/{id}/`.

### Data Model Changes

#### `SessionInfo` (in `types.ts`)

```typescript
export interface SessionInfo {
  id: string;
  title: string;
  createdAt: string;
  lastUsedAt: string;
  workspaceDir?: string;  // NEW — e.g. "/workspace/sessions/abc123"
}
```

The `workspaceDir` is optional for backward compatibility with pre-existing sessions. It is set once at session creation and never changes.

#### New constant

```typescript
const SESSIONS_ROOT = "/workspace/sessions";
```

### Server Changes

#### Restructure: single GitManager → per-session GitManager

Currently `buildApp()` creates one `GitManager` instance at startup:

```typescript
// Current (single instance):
const gitManager = deps.gitManager ?? new GitManager();
await gitManager.init();
```

This must become per-session. The recommended approach is a factory/helper that creates `GitManager` instances on demand:

```typescript
// New (per-session):
function getGitManager(sessionDir: string): GitManager {
  return new GitManager(sessionDir);
}
```

`simple-git` instances are lightweight (just a config object pointing at a directory), so creating them per-request is fine. No caching needed.

The `AppDeps` interface also changes:

```typescript
export interface AppDeps {
  // ...existing fields...
  // Remove: gitManager?: GitManager;
  // Add:
  createGitManager?: (workspaceDir: string) => GitManager;
}
```

Tests inject a factory that returns stubs. This is the biggest structural change in this feature.

#### Session workspace lifecycle

**On new session creation** (when `system.init` fires):

```typescript
const sessionDir = path.join(SESSIONS_ROOT, sessionId);
await fs.mkdir(sessionDir, { recursive: true });

// Initialize a fresh git repo for this session
const git = getGitManager(sessionDir);
await git.init();

sessionManager.track(sessionId, title, sessionDir);
```

**On template application** — apply template into the session's directory instead of `/workspace`:

```typescript
// Current: applyTemplate(template, workspaceDir)    // workspaceDir = "/workspace"
// New:     applyTemplate(template, activeSessionDir) // activeSessionDir = "/workspace/sessions/abc123"
```

**On session delete** — clean up the directory:

```typescript
const session = sessionManager.list().find(s => s.id === id);
if (session?.workspaceDir) {
  await fs.rm(session.workspaceDir, { recursive: true, force: true });
}
```

#### `ClaudeProcess.run()` — add `cwd` parameter

Current signature uses positional parameters:

```typescript
// Current:
run(prompt: string, sessionId?: string, systemPrompt?: string, images?: ImageAttachment[]): void {
  this.proc = spawn("claude", args, { cwd: "/workspace", ... });
}
```

Add `cwd` as a fifth positional parameter (keeps the change minimal and avoids breaking the existing call pattern):

```typescript
// New:
run(prompt: string, sessionId?: string, systemPrompt?: string, images?: ImageAttachment[], cwd?: string): void {
  this.proc = spawn("claude", args, { cwd: cwd ?? "/workspace", ... });
}
```

Callers in `index.ts` add `activeSessionDir` as the last argument:

```typescript
// Current: claude.run(msg.text, msg.sessionId, systemPrompt, images)
// New:     claude.run(msg.text, msg.sessionId, systemPrompt, images, activeSessionDir)
```

#### `ViteManager` — accept `workspaceDir` parameter

Current `start()` and `restart()` take no parameters and hardcode `WORKSPACE_DIR`:

```typescript
// Current:
start(): void {
  this.proc = spawn(VITE_BIN, [...], { cwd: WORKSPACE_DIR });
}
restart(): void {
  this.stop();
  this.start();
}
```

Add a `workspaceDir` parameter:

```typescript
// New:
start(workspaceDir?: string): void {
  const cwd = workspaceDir ?? WORKSPACE_DIR;
  this.proc = spawn(VITE_BIN, [...], { cwd });
}
restart(workspaceDir?: string): void {
  this.stop();
  this.start(workspaceDir);
}
```

On session switch, the server calls `viteManager.restart(activeSessionDir)`. Only the active session has a live preview (see Non-Goals).

#### `GitHubAuthManager` — per-session credential configuration

`GitHubAuthManager` accepts a `workspaceDir` and runs `git config credential.helper` in that directory. With per-session repos, the GitHub token must be configured in each session's git repo. When the user provides a GitHub token:

```typescript
// Current: gitHubAuth.configureGitCredentials(token)  → configures /workspace/.git
// New:     gitHubAuth.configureGitCredentials(token, activeSessionDir)
```

Alternatively, configure credentials in each session directory when a session is activated and a token exists.

#### `FileWatcher` — scoped to active session, not per-connection

`FileWatcher` is a single instance shared across all WebSocket connections. It watches one directory at a time — the active session's directory:

```typescript
fileWatcher.stop();
fileWatcher.start(session.workspaceDir);
```

**Limitation:** If multiple clients are connected viewing different sessions, only the active session's directory is watched. File change notifications only fire for the session the server is currently "focused" on. This is acceptable for v1 since the server also only runs one Vite instance and one Claude process at a time. True per-connection watchers are a future enhancement alongside per-session Vite.

#### `scanFileTree` / `findMarkdownFiles` — already accept a directory parameter

Both functions already accept a `dir` parameter. Just pass the session's workspace:

```typescript
// Current: scanFileTree("/workspace")
// New:     scanFileTree(activeSessionDir)
```

#### `index.ts` — track active session per WebSocket connection

```typescript
// Per-connection state:
let activeSessionDir: string | null = null;

// When session is determined (on send_message, get_chat_history, etc.):
const session = sessionManager.list().find(s => s.id === sessionId);
if (session?.workspaceDir) {
  activeSessionDir = session.workspaceDir;
}

// Guard: reject file/git operations when no session is active
if (!activeSessionDir) {
  send({ type: "error", message: "No active session" });
  return;
}
```

All file operations (`get_file_tree`, `get_file_content`, `list_docs`, `get_git_log`, `rollback`) use `activeSessionDir` instead of the hardcoded `WORKSPACE` constant.

#### Concurrent Claude turns

Currently `index.ts` has a single `let claude: ClaudeProcess | null = null`. Starting a new turn kills any in-progress turn — this is an **interruption mechanism**, not a lock. This behavior is unchanged by session isolation.

However, with isolated session directories, the risk is reduced: even if Turn A for Session 1 is killed when Turn B for Session 2 starts, Session 1's files remain intact on disk (they're in a separate directory). The interrupted turn may leave uncommitted changes, but those are confined to Session 1's workspace.

### Path Security

Session directories are derived from session IDs, which are generated by the Claude CLI (UUIDs). However, the `get_file_content` handler must still guard against path traversal relative to the session directory:

```typescript
const resolved = path.resolve(activeSessionDir, requestedPath);
if (!resolved.startsWith(activeSessionDir)) {
  send({ type: "error", message: "Path traversal not allowed" });
  return;
}
```

### New WebSocket Messages

No new message types needed. Existing messages naturally scope to the active session because the server uses `activeSessionDir` for all operations.

Optional informational addition:

| Direction | Type | Payload |
|-----------|------|---------|
| Server → Client | `session_info` | `{ workspaceDir: string }` — pushed when session activates, so client can display project path |

### Client Changes

Minimal changes needed. The client already works per-session via `sessionId`. When switching sessions:
1. Client sends `get_chat_history` (already does this).
2. Server updates `activeSessionDir` and responds.
3. Client refreshes file tree and git log (already does this on session switch).
4. Preview iframe reloads (Vite restart handles this).

The client does not need to know about `workspaceDir` — all paths are relative and the server handles scoping.

### Migration

Existing sessions (created before this feature) have no `workspaceDir` field. Their files live commingled in `/workspace` root with no way to automatically separate which files belong to which session.

**Recommended approach:** Sessions without `workspaceDir` fall back to `/workspace` directly. This means old sessions still see the same shared (and potentially broken) file state — the same behavior as today. New sessions created after the feature get isolated directories and are fully isolated from each other and from old sessions.

Over time, users naturally create new sessions and stop using old ones. No automated migration is needed, but the UI could show a hint on old sessions: "This session uses a legacy shared workspace."

### Edge Cases

1. **Disk space** — Each session has its own `node_modules`. For a typical React project, that's ~200MB. With 5 sessions, that's ~1GB. Acceptable for a dev container. Could optimize later with symlinked or shared `node_modules` if needed.

2. **Delete the active session** — Switch to another session (or show the session list) before deleting the directory. The server must set `activeSessionDir = null` and reject file operations until a new session is activated.

3. **Template application** — Templates are applied into the session's directory. If the session already has files, the template overlays on top (same as current behavior).

4. **Git push/pull** — Each session has its own git repo. Push/pull operate on the session's repo. If two sessions push to the same GitHub remote, they'll have different histories and the second push will need force-push. The GitHub token must be configured per-session repo (see `GitHubAuthManager` section above).

5. **Port conflicts** — With Vite Option A (single instance), only one session's preview runs at a time, so no port conflict. If Claude starts a dev server via Bash in a session that's not the active one, it could conflict with the active session's Vite. The port scanner detects this but can't resolve it automatically.

6. **Session directory missing** — If a session's directory is manually deleted but the metadata still exists, recreate the directory and `git init` on next access. Warn the user that files were lost.

7. **Multi-client connections** — If two browser tabs connect and activate different sessions, the server's single FileWatcher and ViteManager follow the most recent activation. This is a known limitation (see Non-Goals).

### Performance Considerations

1. **Session creation** — `mkdir` + `git init` + initial commit: ~100ms. Fast enough.
2. **No switching overhead** — Unlike git branches, there's no checkout step. Files are always on disk in the right place.
3. **Disk usage** — O(sessions * project_size). Each session independently installs dependencies. Trade-off: disk space for true isolation.
4. **Vite restart** — 1-3s on session switch. Avoidable with per-session Vite at the cost of memory (future enhancement).

### File Layout

| File | Change |
|------|--------|
| `docker/Dockerfile.dev` | Declare `VOLUME /workspace`, remove `git init` |
| `docker/Dockerfile.prod` | Declare `VOLUME /workspace`, remove `git init` |
| `src/server/index.ts` | Replace hardcoded `WORKSPACE` with per-session `activeSessionDir`; create session dirs; refactor from single `gitManager` to per-session factory; update all callers |
| `src/server/claude.ts` | Add `cwd` parameter to `run()` |
| `src/server/vite-manager.ts` | Add `workspaceDir` parameter to `start()`/`restart()` |
| `src/server/sessions.ts` | Accept `workspaceDir` in `track()`, persist in session metadata; delete directory on session delete |
| `src/server/types.ts` | Add optional `workspaceDir` to `SessionInfo` |
| `src/server/github-auth.ts` | Support per-session credential configuration |
| `src/server/templates.ts` | No changes (already accepts target directory) |
| `src/server/git.ts` | No changes (already accepts `workspaceDir` in constructor) |
| `src/server/file-tree.ts` | No changes (already accepts `dir` parameter) |
| `src/server/markdown.ts` | No changes (already accepts `dir` parameter) |
| `src/server/file-watcher.ts` | No changes (already accepts `dir` in `start()`) |
| `src/server/integration.test.ts` | Test session isolation (two sessions with independent files, rollback scoped) |

### Quality Checklist

- [ ] Input validation: Validate `sessionId` is a safe directory name (alphanumeric + hyphens). Guard all file operations with path traversal checks relative to session directory.
- [ ] Integration tests: Two sessions create files independently, verify file isolation. Rollback in Session A doesn't affect Session B. Delete session cleans up directory.
- [ ] Unit tests: Session directory creation/deletion lifecycle. Per-session GitManager factory. ViteManager restart with new workspaceDir.
- [ ] Edge cases: Delete active session, session with missing directory (recreation), concurrent access, multi-client.
- [ ] Performance: Verify session creation < 500ms including git init.

### Relationship to Feature 7 (Conversation Branching)

Feature 7 (Conversation Branching & Checkpoints) addresses branching *within* a session — exploring alternative approaches in the same conversation. Feature 9 (Session Isolation) addresses isolation *between* sessions — ensuring separate sessions don't interfere with each other's files.

These features are complementary and orthogonal:
- Feature 9 gives each session its own git repo in its own directory.
- Feature 7's checkpoints/branches operate within that session's git repo.

### Future Enhancements

- **Per-session Vite** — Run separate Vite instances on different ports for parallel previews across sessions.
- **Per-connection FileWatcher** — Watch each connected client's active session directory independently.
- **Shared `node_modules`** — Use symlinks or a shared cache to reduce disk usage.
- **Session templates** — Clone an existing session's workspace as a starting point for a new session.
- **Session export** — Tar/zip a session directory for backup or sharing.
