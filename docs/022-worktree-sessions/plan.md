---
status: done
---
# 022 — Git Worktree Parallel Sessions

## Summary

Use git worktrees transparently under the hood so that multiple sessions working on the same repository share a single clone. The repo is cloned once into a shared location (`/workspace/repos/{hash}/`); every session — including the first — is a worktree from that shared clone. This is invisible to the user — they just open a repo and start working.

## Motivation

ShipIt currently creates completely separate directories under `/workspace/sessions/{uuid}/` for each session. Each is an independent git repo with no shared history. This means:

1. Starting a new session from an existing project requires re-cloning (slow, wastes bandwidth)
2. Changes from one session can't be merged with another (different git repos)
3. Disk waste: each session duplicates the entire project's git objects
4. No branch-based workflow (feature branches, bug fixes in parallel)

Git worktrees solve all of these. A worktree is a separate working directory linked to the same `.git` object store. Each worktree has its own branch, index, and working files, but shares commits, remotes, and configuration.

## How It Works

### Directory Structure

```
/workspace/
  repos/{hash}/          ← shared clone (one per unique repo URL, keyed by SHA-256 hash)
    .git/
    ...files (main working tree, not used directly by any session)
  sessions/{uuid}/       ← every session is a worktree from the shared clone
    .git                 ← worktree link file (not a directory)
    ...files (independent working tree)
```

### Transparent Worktree Reuse

When the user sends `home_send_with_repo` for a given repository URL:

1. Compute `repoDir = /workspace/repos/{sha256(repoUrl).slice(0,16)}/`
2. If `repoDir` doesn't exist → `git clone` into it (first time)
3. If `repoDir` exists → `git pull` to update (fetch latest)
4. Create worktree: `git worktree add /workspace/sessions/{uuid} -b {branchPrefix}` from the shared clone
5. Mark session as `sessionType: "worktree"` with `branch` metadata

No session depends on another session. All sessions reference the shared clone in `/workspace/repos/`.

### Session Model

```typescript
export interface SessionInfo {
  // ... existing fields ...
  branch?: string;                   // Worktree branch name
  sessionType?: "standalone" | "worktree";
}
```

Note: `parentSessionId` was removed. Sessions are independent — they all point at the same shared repo via `remoteUrl`.

### GitManager Methods

```typescript
// Already implemented in git.ts:
async createWorktree(worktreePath, branchName, startPoint?): Promise<void>
async removeWorktree(worktreePath): Promise<void>
async listWorktrees(): Promise<Array<{ path, branch, head }>>
async merge(branchName): Promise<{ success: boolean; conflicts?: string[] }>
async deleteBranch(branchName): Promise<void>
```

### WebSocket Messages

Already implemented — used by `fork_session`, `list_worktrees`, `merge_session` handlers. These remain available for future explicit fork/merge UI but the primary flow is transparent via `home_send_with_repo`.

### Cleanup

When archiving a **worktree** session:
- Find the shared repo dir (via `getSharedRepoDir(remoteUrl)`, or from `.git` file for standalone worktrees)
- Remove the worktree (`git worktree remove --force`)
- Delete the branch (`git branch -D`)
- Remove session metadata

No blocking of parent archival — sessions are independent.

### fork_session

Forking works for both repo-backed and standalone sessions:
- **Repo-backed** (has `remoteUrl`): creates worktree from the shared clone in `/repos/`
- **Standalone** (no `remoteUrl`): creates worktree from the session's own `.git` dir

### list_worktrees

Lists all non-archived sessions sharing the same `remoteUrl` as the active session.

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
4. List worktrees — standalone session returns empty
5. Archive child cleans up worktree + branch
6. Merge session — merge worktree branch into active session
7. Merge validation — empty/missing source
8. `home_send_with_repo` — all sessions are worktrees from shared clone
9. `home_send_with_repo` — worktree session changes are independent

## Key Files

| File | Change |
|---|---|
| `src/server/git.ts` | Worktree methods: `createWorktree()`, `removeWorktree()`, `listWorktrees()`, `merge()`, `deleteBranch()` |
| `src/server/types.ts` | `SessionInfo` extensions (`branch`, `sessionType`), WS message types |
| `src/server/sessions.ts` | `findAllByRemoteUrl()`, `setWorktreeInfo()` |
| `src/server/index.ts` | Shared repo clone (`getSharedRepoDir`), `home_send_with_repo` worktree flow, `fork_session`/`list_worktrees`/`merge_session` handlers, archive cleanup |
| `src/server/integration_tests/worktree-sessions.test.ts` | Integration tests |
| `src/server/git-worktree.test.ts` | Unit tests |
