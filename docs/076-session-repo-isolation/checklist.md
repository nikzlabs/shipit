# Session Repo Isolation — Checklist

## Core implementation

- [ ] Add bare cache management to `repo-git.ts` — `cloneBare()`, `fetchCache()`, `cloneFromCache()` methods
- [ ] Remove worktree methods from `repo-git.ts` — `createWorktree()`, `removeWorktree()`, `listWorktrees()`
- [ ] Keep `fetch()` with `--force` flag for concurrent safety on bare cache
- [ ] Change `deleteBranch()` to push deletion to remote (`git push origin --delete`)
- [ ] Configure `gc.auto=0` in session clones during `cloneFromCache()`
- [ ] Add fetch-before-clone with 60s TTL (track last-fetch timestamp per cache entry)
- [ ] Add lock file for bare cache gc serialization with clone operations

## Container lifecycle

- [ ] Remove `INTERNAL_GIT_MOUNT` and `GIT_OVERRIDE_DIR` from `container-lifecycle.ts`
- [ ] Remove `writeGitOverride()` and `removeGitOverride()` functions
- [ ] Remove shared repo mount block from `buildMounts()` (lines 118–140)
- [ ] Remove shared repo mount and git override from `buildPreviewMounts()` (lines 557–578)
- [ ] Remove `writeGitOverride()` calls from `createContainer()` and `createPreviewContainer()`
- [ ] Remove `removeGitOverride()` call from `destroyContainer()`
- [ ] Remove `sharedRepoDir` from `ContainerConfig` in `session-container.ts`

## Session runner

- [ ] Remove `sharedRepoDirResolver` from `SessionRunnerFactory` and `SessionRunnerRegistry`
- [ ] Decouple `depCacheDirResolver` from shared repo path — use `/workspace/dep-cache/{hash}` instead

## App lifecycle

- [ ] Replace worktree creation with clone in session creation paths
- [ ] Rewrite `warmSessionForRepo()` — clone from bare cache instead of worktree
- [ ] Remove `sharedRepoDirResolver` from registry setup
- [ ] Update standby container creation — no shared repo mount
- [ ] Rename `getSharedRepoDir()` to `getBareCacheDir()`

## API routes

- [ ] Rewrite `claim-session` cold path in `api-routes-session.ts` to clone from bare cache
- [ ] Change `.git` file check (worktree readiness) to `.git/` directory check (clone readiness)
- [ ] Update `refreshWarmSessionToLatestMain()` to fetch session clone's origin directly
- [ ] Remove `setWorktreeInfo()` calls — replace with branch-only setter
- [ ] Keep per-repo promise chain serialization for bare cache fetch operations

## WebSocket handlers

- [ ] Update `send-message.ts` — remove `sessionType` in `setWorktreeInfo()` call
- [ ] Update `send-message.ts` — fix error message about "worktree may have been cleaned up"
- [ ] Update `rollback-handlers.ts` — fix comment referencing "worktree" in fork-as-new-session

## Services

- [ ] Rewrite `archiveSession()` in `services/session.ts` — delete clone dir, remove `.git` file parsing
- [ ] Rewrite `forkSession()` — clone from bare cache + transfer uncommitted changes via `git diff`/`git apply`
- [ ] Rewrite `unarchiveSession()` — clone from bare cache instead of recreating worktree; keep retry logic
- [ ] Update `mergeSession()` — push source branch to origin first, then fetch+merge in target clone
- [ ] Remove or rename `listWorktrees()` function (consider `listSiblings()`)

## Schema and types

- [ ] Remove `sessionType?: "worktree"` from `SessionInfo` in `domain-types.ts`
- [ ] Rename `setWorktreeInfo()` to `setBranch()` in `sessions.ts` (branch-only, no session type)
- [ ] Plan migration for `session_type` column in `sessions.ts` (keep optional during transition)
- [ ] Update `app-di.ts` comment for `createRepoGit` factory
- [ ] Update `api-routes-git.ts` merge endpoint comment

## Testing

- [ ] Rewrite `git-worktree.test.ts` — replace worktree tests with `cloneBare`, `cloneFromCache`, `fetchCache` tests
- [ ] Update `session-container.test.ts` — remove `sharedRepoDir` mount and gitdir override assertions
- [ ] Update `container-lifecycle.test.ts` — remove `writeGitOverride`, `removeGitOverride` tests
- [ ] Rewrite `worktree-sessions.test.ts` — fork, list, archive, merge tests all change (rename to `clone-sessions.test.ts`)
- [ ] Update `warm-sessions.test.ts` — worktree add → clone; `.git` file → `.git/` directory check
- [ ] Update `http-phase3.test.ts` — fork and merge test cases
- [ ] Update `http-reads.test.ts` — `/api/sessions/:id/worktrees` endpoint test
- [ ] Update `repos.test.ts` — worktree-from-nonexistent-repo test
- [ ] Update `pr-merge.test.ts` — `setWorktreeInfo()` call
- [ ] Test concurrent clone operations against same bare cache
- [ ] Test session deletion cleans up clone directory
- [ ] Verify bare cache is never mounted in containers (security invariant)
- [ ] Test `gc.auto=0` is set in session clones
- [ ] Test cross-clone merge workflow
- [ ] Test unarchive with clone restoration
