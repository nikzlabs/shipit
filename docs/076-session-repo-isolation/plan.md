---
status: planned
---

# Session Repo Isolation — Separate Clones per Session

Replace the current shared-repo + worktree architecture with fully independent git clones per session. Each session gets its own complete repository clone, eliminating the shared repo mount that can be discovered and written to by the AI agent.

## Motivation

Today, every session is a git worktree of a shared repo clone (`/workspace/repos/{hash}`). The shared repo must be mounted inside session containers so that the worktree's `.git` file references resolve. This creates two problems:

1. **Agent escape** — The AI agent can explore the filesystem, discover `/workspace/repos/{hash}` (or the hidden mount at `/.shipit-internal-git`), and write files there instead of in its worktree at `/user`. Changes written to the shared repo affect all sessions and don't appear in the session's git diff.

2. **Cross-session blast radius** — Since all sessions share the same git object store, corruption in one session (e.g. interrupted `git gc`, concurrent writes) can affect all sessions for that repo.

The current mitigation (feature 074) hides the shared repo at `/.shipit-internal-git` and overrides the `.git` file, but this is security by obscurity — the agent can still discover it via `find`, reading the `.git` file, or other means.

## Design

### Per-session full clones

Each session gets a complete `git clone` in its session directory (`/workspace/sessions/{uuid}`). No worktrees, no shared repo mount.

```
/workspace/
  sessions/
    {uuid-1}/          Full clone (has .git/ directory)
    {uuid-2}/          Full clone (has .git/ directory)
  repo-cache/          Bare repos for fast local cloning (orchestrator-only)
    {hash}/            git clone --bare {remote}
```

### Clone flow

1. **First clone of a remote** — `git clone --bare {remote}` into `/workspace/repo-cache/{hash}/`
2. **Session creation** — `git clone --local /workspace/repo-cache/{hash} /workspace/sessions/{uuid}`
   - `--local` uses hardlinks for objects on the same filesystem (fast, disk-efficient)
   - Creates a standard `.git/` directory — no worktree indirection
3. **Session container mount** — only `/workspace/sessions/{uuid}` is mounted at `/user`. No shared repo mount needed.

### Bare cache lifecycle

The bare repo cache (`/workspace/repo-cache/{hash}`) is:
- **Never mounted** in session containers — only the orchestrator accesses it. This is the core security invariant: the bare cache must never appear in any container mount (session or preview).
- **Fetched before each clone** — `git fetch --all` runs synchronously before `git clone --local`. To avoid redundant fetches, skip if last fetch was <60 seconds ago (track last-fetch timestamp per cache entry).
- **Used only for cloning** — sessions clone from it, then operate independently
- **Cleaned up** when no sessions reference the repo
- **Protected during maintenance** — `git gc` / `git repack` in the bare cache must not run concurrently with `git clone --local` (a clone could hardlink an object that gc then deletes). Use a simple lock file or serialize cache maintenance behind clone operations.

### Dependency cache

Currently, `depCacheDir` is derived from the shared repo path (`/workspace/repos/{hash}/.dep-cache`) and mounted into containers. Since the shared repo directory is being removed, the dep cache needs a new home:

```
/workspace/
  dep-cache/
    {hash}/          Per-remote-URL npm/yarn/pnpm cache (same hash as repo-cache)
```

- Mounted into session containers at the same container path as today
- `depCacheDirResolver` computes path from `remoteUrl` hash, no longer coupled to shared repo
- Standalone sessions (no `remoteUrl`) continue to have no shared dep cache

### Branch management

Today, `RepoGit` creates worktree branches and manages them centrally. With separate clones:
- Each session creates its own branch locally
- Push still goes to the remote (via credentials in the session container)
- No central branch coordination needed — branch names already include session-specific prefixes
- Branch cleanup on session destruction: `git push origin --delete {branch}` (already exists)

### Impact on warm pool

Warm sessions currently create a worktree + standby container. With separate clones:
- Warm session = `git clone --local` from bare cache + standby container
- Clone time: sub-second for typical repos (<50 MB) on same volume (hardlink copy)
- Larger repos may take longer — mitigated by the bare cache being pre-fetched

Current warm pool flow in `app-lifecycle.ts`:
1. Create session dir → delete it → `repoGit.createWorktree(sessionDir, branch, startPoint)`

New flow:
1. Fetch bare cache (if stale) → `git clone --local /workspace/repo-cache/{hash} /workspace/sessions/{uuid}` → checkout branch

### Forking sessions

Currently `forkSession()` creates a new worktree from the shared repo at the source session's branch. With separate clones:
- Clone from bare cache into new session dir
- Checkout the source session's branch
- Copy uncommitted changes: run `git diff` in source session, apply patch in new session (or `rsync` the working tree and re-stage)
- This is slightly more complex than the worktree approach but avoids any shared state

### Preview containers

Preview containers (`buildPreviewMounts()`) currently receive the same `INTERNAL_GIT_MOUNT` and git override as session containers. Under the new model:
- Preview containers mount only the session directory — no shared repo mount, no git override
- Same simplification as session containers

### Disk usage

- **Current**: shared clone (~1x repo size) + worktrees (working tree files per session, negligible git overhead)
- **Proposed**: bare cache (~1x) + full clone per session (working tree files per session + hardlinked objects)
- With `--local` hardlinks on the same volume, git object storage is shared at the filesystem level without any mount exposure. The working tree cost (checked-out files) is identical to the worktree approach — net disk impact is neutral.
- Risk: `git gc` or `git repack` in any session can break hardlinks, creating full object copies. Mitigation: configure `gc.auto=0` in session clones and run gc only in the bare cache.

## Key files to change

| File | Change |
|------|--------|
| `repo-git.ts` | Replace worktree operations (`createWorktree`, `removeWorktree`, `listWorktrees`) with bare cache management + `git clone --local` |
| `container-lifecycle.ts` | Remove `INTERNAL_GIT_MOUNT`, `GIT_OVERRIDE_DIR`, `writeGitOverride()`, `removeGitOverride()`, shared repo mount in `buildMounts()` and `buildPreviewMounts()` |
| `session-container.ts` | Remove `sharedRepoDir` from `ContainerConfig` |
| `app-lifecycle.ts` | Replace worktree creation with clone in session creation paths; rewrite warm pool flow (`warmSessionForRepo`) to clone from bare cache instead of creating worktree; remove `sharedRepoDirResolver` from registry setup |
| `session-runner.ts` | Remove `sharedRepoDirResolver` from `SessionRunnerFactory` signature and `SessionRunnerRegistry` |
| `services/session.ts` | Rewrite `archiveSession()` to delete clone directory instead of `removeWorktree()` + `.git` file parsing; update `forkSession()` to clone instead of worktree creation |
| `domain-types.ts` | Remove `sessionType?: "worktree"` from `SessionInfo` |
| `sessions.ts` | Remove `session_type` database column; migration to drop column after all worktree sessions are gone |
| `container-discovery.ts` | No shared repo fields to rediscover |
| `shared/git.ts` | No changes — `GitManager` already operates on a single directory |

## Migration

- Existing worktree sessions continue working until destroyed
- New sessions use the clone-based approach
- The bare cache is populated lazily on first session creation for a repo
- `sharedRepoDir` field remains optional during migration, removed once all worktree sessions are gone

## Risks

- **Hardlink breakage** — `git gc` in a session clone can de-hardlink objects, increasing disk usage. Mitigate with `gc.auto=0` in all session clones.
- **Stale bare cache** — if the cache isn't fetched, new clones miss recent commits. Mitigate with synchronous fetch-before-clone (with 60s TTL to avoid redundant fetches).
- **Concurrent clones** — multiple sessions cloning from the same bare cache simultaneously. Git handles this safely via lockfiles.
- **Bare cache gc during clone** — if `git gc` runs in the bare cache while a `git clone --local` is in progress, hardlinked objects could be deleted from under the clone. Mitigate by serializing cache maintenance behind a lock that clone operations also acquire.
- **Fork session complexity** — forking now requires cloning + patching uncommitted changes instead of a simple worktree add. Mitigate by using `git diff` / `git apply` or `rsync` for working tree state transfer.
