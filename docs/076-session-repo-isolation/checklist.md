# Session Repo Isolation — Checklist

## Core implementation

- [x] Add bare cache management to `repo-git.ts` — `cloneBare()`, `fetchCache()`, `cloneFromCache()` methods
- [x] Remove worktree methods from `repo-git.ts` — `createWorktree()`, `removeWorktree()`, `listWorktrees()`
- [x] Keep `fetch()` with `--force` flag for concurrent safety on bare cache
- [x] Change `deleteBranch()` to push deletion to remote (`git push origin --delete`)
- [x] Configure `gc.auto=0` in session clones during `cloneFromCache()`
- [x] Add fetch-before-clone with 60s TTL (track last-fetch timestamp per cache entry)
- [ ] Add lock file for bare cache gc serialization with clone operations (deferred — fetchCache TTL + per-repo promise chain provide partial coverage; full lock needed if gc.auto is re-enabled)

## Container lifecycle

- [x] Remove `INTERNAL_GIT_MOUNT` and `GIT_OVERRIDE_DIR` from `container-lifecycle.ts`
- [x] Remove `writeGitOverride()` and `removeGitOverride()` functions
- [x] Remove shared repo mount block from `buildMounts()`
- [x] Remove shared repo mount and git override from `buildPreviewMounts()`
- [x] Remove `writeGitOverride()` calls from `createContainer()` and `createPreviewContainer()`
- [x] Remove `removeGitOverride()` call from `destroyContainer()`
- [x] Remove `sharedRepoDir` from `ContainerConfig` in `session-container.ts`

## Session runner

- [x] Remove `sharedRepoDirResolver` from `SessionRunnerFactory` and `SessionRunnerRegistry`
- [x] Decouple `depCacheDirResolver` from shared repo path — use `/workspace/dep-cache/{hash}` instead

## App lifecycle

- [x] Replace worktree creation with clone in session creation paths
- [x] Rewrite `warmSessionForRepo()` — clone from bare cache instead of worktree
- [x] Remove `sharedRepoDirResolver` from registry setup
- [x] Update standby container creation — no shared repo mount
- [x] Rename `getSharedRepoDir()` to `getBareCacheDir()` (deprecated alias removed)

## API routes

- [x] Rewrite `claim-session` cold path in `api-routes-session.ts` to clone from bare cache
- [x] Change `.git` file check (worktree readiness) to `.git/` directory check (clone readiness)
- [x] Update `refreshWarmSessionToLatestMain()` to fetch session clone's origin directly
- [x] Remove `setWorktreeInfo()` calls — replace with branch-only setter
- [x] Keep per-repo promise chain serialization for bare cache fetch operations

## WebSocket handlers

- [x] Update `send-message.ts` — remove `sessionType` in `setWorktreeInfo()` call
- [x] Update `send-message.ts` — fix error message about "worktree may have been cleaned up"
- [x] Update `rollback-handlers.ts` — fix comment referencing "worktree" in fork-as-new-session

## Services

- [x] Rewrite `archiveSession()` in `services/session.ts` — delete clone dir
- [x] Rewrite `forkSession()` — clone from bare cache (or local clone for repos without remoteUrl)
- [x] Rewrite `unarchiveSession()` — clone from bare cache with retry logic
- [x] Update `mergeSession()` — push source branch to origin first, then fetch+merge in target clone (with local remote fallback)

## Schema and types

- [x] Remove `sessionType?: "worktree"` from `SessionInfo` in `domain-types.ts`
- [x] Add `setBranch()` to `sessions.ts` (branch-only, no session type)
- [x] Remove deprecated `setWorktreeInfo()` wrapper
- [x] Update `app-di.ts` comment for `createRepoGit` factory
- [x] Update `api-routes-git.ts` merge endpoint comment

## Testing

- [x] Rewrite `git-worktree.test.ts` — replace worktree tests with `cloneBare`, `cloneFromCache`, `fetchCache` tests
- [x] Update `session-container.test.ts` — remove `sharedRepoDir` mount and gitdir override assertions
- [x] Update `container-lifecycle.test.ts` — remove `writeGitOverride`, `removeGitOverride` tests
- [x] Update `worktree-sessions.test.ts` — fork, list, archive, merge tests updated for clone architecture
- [x] Update `warm-sessions.test.ts` — worktree add → clone; updated repo-cache path
- [x] Update `http-phase3.test.ts` — fork and merge test comments
- [x] Update `http-reads.test.ts` — worktree endpoint test comments
- [x] Update `repos.test.ts` — worktree reference comments
- [x] Update `pr-merge.test.ts` — `setWorktreeInfo()` → `setBranch()` call
- [x] Test cross-clone merge workflow (via local remote fallback)
- [x] Test session deletion cleans up clone directory
- [x] Verify bare cache is never mounted in containers (removed from container config)
- [x] Test `gc.auto=0` is set in session clones (in `cloneFromCache`)
