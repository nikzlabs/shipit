# Session Repo Isolation — Checklist

## Core implementation

- [ ] Add bare cache management to `repo-git.ts` — `cloneBare()`, `fetchCache()`, `cloneFromCache()` methods
- [ ] Remove worktree methods from `repo-git.ts` — `createWorktree()`, `removeWorktree()`, `listWorktrees()`
- [ ] Configure `gc.auto=0` in session clones during `cloneFromCache()`
- [ ] Add fetch-before-clone with 60s TTL to avoid redundant fetches
- [ ] Add lock file for bare cache gc serialization with clone operations

## Container lifecycle

- [ ] Remove `INTERNAL_GIT_MOUNT` and `GIT_OVERRIDE_DIR` from `container-lifecycle.ts`
- [ ] Remove `writeGitOverride()` and `removeGitOverride()` functions
- [ ] Remove shared repo mount from `buildMounts()`
- [ ] Remove shared repo mount and git override from `buildPreviewMounts()`
- [ ] Remove `sharedRepoDir` from `ContainerConfig` in `session-container.ts`

## Session runner

- [ ] Remove `sharedRepoDirResolver` from `SessionRunnerFactory` and `SessionRunnerRegistry`
- [ ] Decouple `depCacheDirResolver` from shared repo path — use `/workspace/dep-cache/{hash}` instead

## App lifecycle

- [ ] Replace worktree creation with clone in session creation paths
- [ ] Rewrite `warmSessionForRepo()` — clone from bare cache instead of worktree
- [ ] Remove `sharedRepoDirResolver` from registry setup
- [ ] Update standby container creation — no shared repo mount

## Services

- [ ] Rewrite `archiveSession()` in `services/session.ts` — delete clone dir, remove `.git` file parsing
- [ ] Update `forkSession()` — clone from bare cache + transfer uncommitted changes
- [ ] Remove worktree creation retry logic

## Schema and types

- [ ] Remove `sessionType?: "worktree"` from `SessionInfo` in `domain-types.ts`
- [ ] Plan migration for `session_type` column in `sessions.ts` (keep optional during transition)

## Testing

- [ ] Update integration tests that create worktree sessions
- [ ] Test warm pool flow with clone-based sessions
- [ ] Test fork session with uncommitted changes transfer
- [ ] Test concurrent clone operations against same bare cache
- [ ] Test session deletion cleans up clone directory
- [ ] Verify bare cache is never mounted in containers (security invariant)
- [ ] Test `gc.auto=0` is set in session clones
