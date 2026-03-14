---
status: done
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

### Claim-session flow

`api-routes-session.ts` has a `claim-session` endpoint with significant worktree logic:
- Per-repo promise chain serializes git operations (fetch, reset, worktree add) to avoid lock contention — this serialization **remains needed** for bare cache fetches
- Checks for `.git` (file for worktrees) to verify a warm session is fully initialized — change to check `.git/` (directory) instead
- `refreshWarmSessionToLatestMain()` fetches the shared repo and hard-resets the worktree — change to fetch the session clone's origin directly and reset
- Cold path creates a session dir, deletes it, then calls `repoGit.createWorktree()` — change to clone from bare cache
- Calls `sessionManager.setWorktreeInfo()` with `sessionType: "worktree"` — remove or replace with branch-only setter

### Unarchiving sessions

`unarchiveSession()` in `services/session.ts` recreates a worktree when restoring an archived session:
- Checks `session.sessionType === "worktree"` to decide if worktree recreation is needed
- Re-clones the shared repo if it was cleaned up, then calls `repoGit.createWorktree()`
- Retries worktree creation 3x with exponential backoff for lock contention

With separate clones:
- Clone from bare cache (create cache if needed) into the session directory
- Checkout the session's branch
- Retry logic still applies but for clone operations instead of worktree add
- No need to check sessionType — all sessions with `remoteUrl` need clone restoration

### Merge sessions

`mergeSession()` in `services/session.ts` merges a worktree branch into the active session. With separate clones:
- Source session's branch must be pushed to the remote first (or fetched directly from its clone)
- Active session fetches the branch from origin and merges
- Alternative: add the source session's clone as a git remote temporarily, fetch, merge, remove remote

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
| `repo-git.ts` | Replace worktree operations (`createWorktree`, `removeWorktree`, `listWorktrees`) with bare cache management + `git clone --local`. Add `cloneBare()`, `cloneFromCache()`, `fetchCache()`. Keep `fetch()` with `--force` for concurrent safety. Keep `getDefaultBranch()`, `isEmpty()`, `createInitialCommit()`. Change `deleteBranch()` to push deletion to remote instead of local-only delete. |
| `container-lifecycle.ts` | Remove `INTERNAL_GIT_MOUNT`, `GIT_OVERRIDE_DIR`, `writeGitOverride()`, `removeGitOverride()`, shared repo mount blocks in `buildMounts()` (lines 118–140) and `buildPreviewMounts()` (lines 557–578). Remove `writeGitOverride()` calls from `createContainer()` and `createPreviewContainer()`. Remove `removeGitOverride()` call from `destroyContainer()`. (~85 lines removed) |
| `session-container.ts` | Remove `sharedRepoDir` from `ContainerConfig` interface |
| `app-lifecycle.ts` | Replace worktree creation with clone in session creation paths; rewrite warm pool flow (`warmSessionForRepo`) to clone from bare cache; remove `sharedRepoDirResolver` from registry setup; update `getSharedRepoDir()` helper to `getBareCacheDir()` |
| `api-routes-session.ts` | Rewrite `claim-session` cold path to clone from bare cache instead of worktree add; change `.git` file check to `.git/` directory check for warm session readiness; update `refreshWarmSessionToLatestMain()` to fetch session clone directly; remove `setWorktreeInfo()` calls with `sessionType: "worktree"` |
| `session-runner.ts` | Remove `sharedRepoDirResolver` from `SessionRunnerFactory` signature and `SessionRunnerRegistry` |
| `services/session.ts` | Rewrite `archiveSession()` to delete clone directory instead of `removeWorktree()` + `.git` file parsing; rewrite `forkSession()` to clone from bare cache + transfer uncommitted changes; rewrite `unarchiveSession()` to clone from bare cache instead of recreating worktree; update `mergeSession()` for cross-clone branch merging; remove `listWorktrees()` function (or rename to `listSiblings()`) |
| `domain-types.ts` | Remove `sessionType?: "worktree"` from `SessionInfo` |
| `sessions.ts` | Remove `session_type` column; rename `setWorktreeInfo()` to `setBranch()` (branch-only, no session type) |
| `ws-handlers/send-message.ts` | Remove `sessionType` reference in `setWorktreeInfo()` call; update error message about workspace unavailability |
| `ws-handlers/rollback-handlers.ts` | Update comment referencing "worktree" in fork-as-new-session |
| `api-routes-git.ts` | Update merge endpoint comment referencing "worktree branch" |
| `app-di.ts` | Update `createRepoGit` factory comment |
| `container-discovery.ts` | No shared repo fields to rediscover |
| `shared/git.ts` | No changes — `GitManager` already operates on a single directory |

## Test files to update

| Test file | Change |
|-----------|--------|
| `git-worktree.test.ts` | Rewrite or replace — tests `createWorktree`, `removeWorktree`, `listWorktrees`. Replace with tests for `cloneBare()`, `cloneFromCache()`, `fetchCache()`. |
| `session-container.test.ts` | Remove assertions for `sharedRepoDir` mount, gitdir override mount. Simplify mount expectations. |
| `container-lifecycle.test.ts` | Remove tests for `writeGitOverride()`, `removeGitOverride()`, shared repo mount logic. |
| `worktree-sessions.test.ts` | Major rewrite — fork, list worktrees, archive worktree, merge worktree tests all change. Rename to `clone-sessions.test.ts`. |
| `warm-sessions.test.ts` | Update warm session creation from worktree add to clone. Update `.git` file check to `.git/` directory check. |
| `http-phase3.test.ts` | Update fork and merge test cases. |
| `http-reads.test.ts` | Update `/api/sessions/:id/worktrees` test (endpoint may be renamed or repurposed). |
| `repos.test.ts` | Update worktree-from-nonexistent-repo test. |
| `pr-merge.test.ts` | Update `setWorktreeInfo()` call. |

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
- **Concurrent bare cache fetches** — multiple claim-session requests can trigger simultaneous `git fetch` on the same bare cache. The existing `--force` flag on fetch prevents "unable to update local ref" errors, but fetches should still be serialized per cache entry (reuse the existing per-repo promise chain from `api-routes-session.ts`).
- **Cross-clone merge complexity** — `mergeSession()` currently merges branches within the same shared repo. With separate clones, the source branch must be pushed to origin first or the source clone added as a temporary remote. Either approach adds a network round-trip.
