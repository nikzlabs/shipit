# 022 — Git Worktree Parallel Sessions

## Summary

Add optional git worktree-based session isolation, allowing multiple sessions to branch from the same repository. Each session gets its own worktree (and branch), sharing git history and remotes while remaining independently modifiable. This enables parallel development workflows — work on auth in one session while refactoring the API in another, then merge.

## Motivation

ShipIt currently creates completely separate directories under `/workspace/sessions/{uuid}/` for each session. Each is an independent git repo with no shared history. This means:

1. Starting a new session from an existing project requires re-cloning or re-applying templates
2. Changes from one session can't be merged with another (different git repos)
3. No branch-based workflow (feature branches, bug fixes in parallel)
4. Disk waste: each session duplicates the entire project

Git worktrees solve all of these. A worktree is a separate working directory linked to the same `.git` object store. Each worktree has its own branch, index, and working files, but shares commits, remotes, and configuration.

## How It Works

### Session Types

After this change, ShipIt supports two session types:

| Type | When Created | Isolation | Git Model |
|---|---|---|---|
| **Standalone** | New session from template or blank | Independent directory | Own `.git` repo (current behavior) |
| **Worktree** | Forked from an existing session | Separate worktree of parent repo | Shared `.git`, own branch |

### Creating a Worktree Session

**UI flow:**
1. User is in an existing session (standalone or worktree)
2. User clicks "Fork Session" (new button in session selector or header)
3. A modal appears: "Create a parallel session from this project"
   - Branch name input (auto-suggested: `feature/session-2`, or user-chosen)
   - Optional: start from current state or from a specific commit
4. Server creates a new git worktree with the chosen branch
5. New session is added to the session list, linked to the parent repo
6. User can now switch between sessions (each has its own Vite instance, file tree, etc.)

**Server flow:**
```
1. git worktree add /workspace/sessions/{newId} -b {branchName}
2. Create session metadata linking to parent repo
3. Initialize Vite, file watcher for new worktree
4. Return new session info
```

### GitManager Additions

```typescript
// src/server/git.ts — additions

/** Create a new worktree with a new branch. */
async createWorktree(
  worktreePath: string,
  branchName: string,
  startPoint?: string,
): Promise<void> {
  const args = ["worktree", "add", worktreePath, "-b", branchName];
  if (startPoint) args.push(startPoint);
  await this.git.raw(args);
  console.log("[git] Created worktree:", worktreePath, "branch:", branchName);
}

/** Remove a worktree. */
async removeWorktree(worktreePath: string): Promise<void> {
  await this.git.raw(["worktree", "remove", worktreePath, "--force"]);
  console.log("[git] Removed worktree:", worktreePath);
}

/** List all worktrees for this repo. */
async listWorktrees(): Promise<Array<{ path: string; branch: string; head: string }>> {
  const output = await this.git.raw(["worktree", "list", "--porcelain"]);
  const worktrees: Array<{ path: string; branch: string; head: string }> = [];
  let current: Partial<{ path: string; branch: string; head: string }> = {};

  for (const line of output.split("\n")) {
    if (line.startsWith("worktree ")) {
      if (current.path) worktrees.push(current as any);
      current = { path: line.replace("worktree ", "") };
    } else if (line.startsWith("HEAD ")) {
      current.head = line.replace("HEAD ", "");
    } else if (line.startsWith("branch ")) {
      current.branch = line.replace("branch refs/heads/", "");
    }
  }
  if (current.path) worktrees.push(current as any);

  return worktrees;
}
```

### Session Model Changes

```typescript
// src/server/types.ts — extend SessionInfo

export interface SessionInfo {
  id: string;
  agentSessionId?: string;
  title: string;
  createdAt: string;
  lastUsedAt: string;
  workspaceDir?: string;
  /** If this session is a worktree, the ID of the parent session. */
  parentSessionId?: string;
  /** If this session is a worktree, the branch name. */
  branch?: string;
  /** Session type: "standalone" (default) or "worktree". */
  sessionType?: "standalone" | "worktree";
}
```

### New WebSocket Messages

```typescript
// Client → Server
export interface WsForkSession {
  type: "fork_session";
  /** Branch name for the new worktree. */
  branchName: string;
  /** Optional commit to start from (defaults to HEAD). */
  startPoint?: string;
}

export interface WsListWorktrees {
  type: "list_worktrees";
}

export interface WsMergeSession {
  type: "merge_session";
  /** Session ID to merge from. */
  sourceSessionId: string;
}

// Server → Client
export interface WsSessionForked {
  type: "session_forked";
  session: SessionInfo;
  parentSessionId: string;
}

export interface WsWorktreeList {
  type: "worktree_list";
  worktrees: Array<{
    sessionId: string;
    branch: string;
    path: string;
  }>;
}

export interface WsMergeResult {
  type: "merge_result";
  success: boolean;
  message: string;
  conflicts?: string[];
}
```

### Vite Multi-Instance Management

Each worktree needs its own Vite dev server on a different port. This requires changes to ViteManager:

**Option A — Per-session ViteManager instances:**
```typescript
// In AppDeps, change:
viteManager?: ViteManager;
// To:
createViteManager?: () => ViteManager;
```

Each session gets its own ViteManager instance. When switching sessions, stop the previous Vite instance and start the new one (or keep both running on different ports).

**Option B — Single ViteManager, switch workspaceDir:**
Keep the current model but restart Vite when switching sessions (already happens today). This is simpler and avoids the port-conflict issue.

**Recommended: Option B** for initial implementation. True parallel Vite instances can be added later if users need to view previews from multiple sessions simultaneously.

### Merge Workflow

When a worktree session is done, the user can merge it back:

1. User clicks "Merge" on a worktree session
2. Server runs `git merge {branch}` in the parent session's worktree
3. On success: merge commit created, user notified
4. On conflict: server reports conflicted files, user resolves manually (via Claude or file editor)
5. After merge, the worktree can be removed (session deleted)

### Session Selector UI Changes

The session list should visually group worktree sessions under their parent:

```
Sessions:
┌─────────────────────────────────────┐
│ ★ E-commerce App (main)             │
│   ├── Auth feature (feature/auth)   │
│   └── API refactor (refactor/api)   │
│                                     │
│ ★ Landing Page (standalone)         │
│                                     │
│ [+ New Session]  [⑂ Fork Session]   │
└─────────────────────────────────────┘
```

### Cleanup

When a standalone session is deleted and it has worktree children:
- Option 1: Block deletion ("Delete worktree sessions first")
- Option 2: Delete all worktrees too (cascade)
- Recommended: Option 1 (safer)

When a worktree session is deleted:
- Remove the worktree (`git worktree remove`)
- Delete the branch (`git branch -D {branch}`)
- Remove session metadata

## Architecture Considerations

### Backward Compatibility
Existing sessions (standalone) continue working unchanged. The `sessionType` field defaults to `"standalone"` when absent. No migration needed.

### File Watcher
Each worktree directory needs its own file watcher. The current FileWatcher supports `stop()` and `start(dir)`, so it naturally handles directory changes. For true parallel sessions, multiple FileWatcher instances would be needed.

### Thread Manager
Threads are per-session. Worktree sessions get independent thread management. The thread data directory is session-scoped, so no conflicts.

### Deployment
Each worktree session can deploy independently (it has its own built output). The deployment store is already session-scoped.

## Testing

### Integration Tests (`src/server/integration_tests/worktree-sessions.test.ts`)
1. **Fork session**: Create standalone session → fork → verify new worktree exists with correct branch
2. **Independent changes**: Make changes in forked session → verify parent session is unaffected
3. **Merge**: Fork → make changes → merge back → verify merge commit in parent
4. **Merge conflict**: Fork → make conflicting changes in both → merge → verify conflict report
5. **Delete worktree**: Delete forked session → verify worktree and branch removed
6. **List worktrees**: Fork twice → list → verify both worktrees listed
7. **Prevent parent deletion**: Fork → try deleting parent → verify error

### Component Tests
1. Fork Session modal renders with branch name input
2. Session list groups worktrees under parent
3. Merge button appears on worktree sessions
4. Branch name validation (no spaces, valid git branch name)

## Key Files

| File | Change |
|---|---|
| `src/server/types.ts` | Extend `SessionInfo`, add fork/merge/worktree message types |
| `src/server/git.ts` | Add `createWorktree()`, `removeWorktree()`, `listWorktrees()`, `merge()` |
| `src/server/sessions.ts` | Support parent-child relationships, session type tracking |
| `src/server/index.ts` | Add `fork_session`, `list_worktrees`, `merge_session` handlers |
| `src/client/components/SessionSelector.tsx` | Grouped display, fork button, merge button |
| `src/client/components/ForkSessionModal.tsx` | New component |
| `src/client/App.tsx` | Fork/merge state and handlers |
| `src/server/integration_tests/worktree-sessions.test.ts` | Integration tests |

## Complexity

High. This fundamentally changes the session model and has tendrils across the codebase:
- Git operations (worktree management, merging)
- Session metadata (parent-child relationships)
- Resource management (Vite instances, file watchers per worktree)
- UI (grouped session list, branch display, merge flow)
- Edge cases (conflicts, cascading deletes, concurrent modifications)

Estimate: ~1500-2000 lines of new code. Recommend implementing in phases:
1. Phase 1: Fork session (create worktree, switch between)
2. Phase 2: Merge workflow
3. Phase 3: UI polish (grouped session list, branch indicators)
