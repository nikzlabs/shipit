---
status: in-progress
---
# 022 — Git Worktree Parallel Sessions

## Summary

Use git worktrees transparently under the hood so that multiple sessions working on the same repository share a single clone. The first session for a repo does a full `git clone`; subsequent sessions for the same repo create worktrees from the first clone instead of re-cloning. This is invisible to the user — they just open a repo and start working.

## Motivation

ShipIt currently creates completely separate directories under `/workspace/sessions/{uuid}/` for each session. Each is an independent git repo with no shared history. This means:

1. Starting a new session from an existing project requires re-cloning (slow, wastes bandwidth)
2. Changes from one session can't be merged with another (different git repos)
3. Disk waste: each session duplicates the entire project's git objects
4. No branch-based workflow (feature branches, bug fixes in parallel)

Git worktrees solve all of these. A worktree is a separate working directory linked to the same `.git` object store. Each worktree has its own branch, index, and working files, but shares commits, remotes, and configuration.

## How It Works

### Transparent Worktree Reuse

When the user sends `home_send_with_repo` for a given repository URL:

1. **First time**: Full `git clone`, session is `standalone` — same as today
2. **Same repo again**: Instead of re-cloning, find the existing session for that repo and create a worktree from it. The new session is type `worktree` with a `parentSessionId` pointing to the original clone.

The user never sees "worktree" or "fork" UI. They just start a new session with a repo and it works — faster, with less disk usage.

### Session Types

| Type | When Created | Isolation | Git Model |
|---|---|---|---|
| **Standalone** | First clone of a repo, or new from template/blank | Independent directory | Own `.git` repo |
| **Worktree** | Subsequent session for an already-cloned repo | Separate worktree of parent repo | Shared `.git`, own branch |

### Server Flow (home_send_with_repo)

```
1. Normalize repoUrl
2. Search SessionManager for existing non-archived session with same remoteUrl
3a. If found (parent exists):
    - Create worktree: git worktree add /workspace/sessions/{newId} -b {branchName}
    - Set sessionType: "worktree", parentSessionId, branch
    - Copy credentials/identity from parent
4a. If not found:
    - Full git clone (current behavior)
    - Set sessionType: "standalone"
5. Continue with branch creation, session naming, Claude launch
```

### GitManager Methods

```typescript
// Already implemented in git.ts:
async createWorktree(worktreePath, branchName, startPoint?): Promise<void>
async removeWorktree(worktreePath): Promise<void>
async listWorktrees(): Promise<Array<{ path, branch, head }>>
async merge(branchName): Promise<{ success: boolean; conflicts?: string[] }>
async deleteBranch(branchName): Promise<void>
```

### Session Model

```typescript
export interface SessionInfo {
  // ... existing fields ...
  parentSessionId?: string;          // ID of parent (if worktree)
  branch?: string;                   // Branch name (if worktree)
  sessionType?: "standalone" | "worktree";
}
```

### WebSocket Messages

Already implemented — used by `fork_session`, `list_worktrees`, `merge_session` handlers. These remain available for future explicit fork/merge UI but the primary flow is transparent via `home_send_with_repo`.

### Cleanup

When archiving a **worktree** session:
- Remove the worktree (`git worktree remove --force`)
- Delete the branch (`git branch -D`)
- Remove session metadata

When archiving a **standalone** session with worktree children:
- Block deletion ("Delete worktree sessions first")

### Vite Management

Keep the current single-ViteManager model. Vite restarts when switching sessions (already happens). Each worktree has its own directory so Vite sees the right files.

## Architecture Considerations

### Backward Compatibility
Existing sessions continue working unchanged. `sessionType` defaults to `"standalone"` when absent. No migration needed.

### File Watcher
Each worktree directory needs its own file watcher. The current FileWatcher supports `stop()` and `start(dir)`, so it naturally handles directory changes when switching sessions.

### Thread Manager
Threads are per-session. Worktree sessions get independent thread management.

### Deployment
Each worktree session can deploy independently (it has its own working tree).

## Testing

### Unit Tests (`git-worktree.test.ts`)
1. Create worktree with new branch
2. Create worktree from specific start point
3. List worktrees
4. Remove worktree
5. Merge branch successfully
6. Merge with conflicts (detect + abort)
7. Delete branch
8. Worktree isolation (changes don't affect parent)

### Integration Tests (`worktree-sessions.test.ts`)
1. Fork session — create worktree, verify metadata
2. Fork validation — empty/invalid branch names
3. Fork without active session — error
4. List worktrees — parent + children
5. Archive parent blocked when children exist
6. Archive child cleans up worktree + branch
7. Merge session — merge worktree branch into parent
8. Merge validation — empty/missing source
9. `home_send_with_repo` reuses existing clone via worktree

## Key Files

| File | Change |
|---|---|
| `src/server/git.ts` | Worktree methods: `createWorktree()`, `removeWorktree()`, `listWorktrees()`, `merge()`, `deleteBranch()` |
| `src/server/types.ts` | `SessionInfo` extensions, WS message types |
| `src/server/sessions.ts` | `getChildren()`, `setWorktreeInfo()`, `findByRemoteUrl()` |
| `src/server/index.ts` | `home_send_with_repo` worktree reuse, `fork_session`/`list_worktrees`/`merge_session` handlers, archive guards |
| `src/server/integration_tests/worktree-sessions.test.ts` | Integration tests |
| `src/server/git-worktree.test.ts` | Unit tests |
