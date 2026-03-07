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
- **Never mounted** in session containers — only the orchestrator accesses it
- **Fetched periodically** — `git fetch --all` to keep it current
- **Used only for cloning** — sessions clone from it, then operate independently
- **Cleaned up** when no sessions reference the repo

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

### Disk usage

- **Current**: shared clone (~1x repo size) + worktrees (negligible — just working tree files)
- **Proposed**: bare cache (~1x) + full clone per session (~1x each, but hardlinked objects)
- With `--local` hardlinks on the same volume, object storage is shared at the filesystem level without any mount exposure
- Risk: `git gc` or `git repack` in any session can break hardlinks, creating full copies. Mitigation: configure `gc.auto=0` in session clones and run gc only in the bare cache.

## Key files to change

| File | Change |
|------|--------|
| `repo-git.ts` | Replace worktree operations with bare cache + local clone |
| `container-lifecycle.ts` | Remove `sharedRepoDir` mount, remove `.git` override logic |
| `session-container.ts` | Remove `sharedRepoDir` from `ContainerConfig` |
| `app-lifecycle.ts` | Update session creation to clone instead of add-worktree |
| `session-runner.ts` | Remove `sharedRepoDirResolver` |
| `container-discovery.ts` | No shared repo fields to rediscover |
| `shared/git.ts` | No changes — `GitManager` already operates on a single directory |

## Migration

- Existing worktree sessions continue working until destroyed
- New sessions use the clone-based approach
- The bare cache is populated lazily on first session creation for a repo
- `sharedRepoDir` field remains optional during migration, removed once all worktree sessions are gone

## Risks

- **Hardlink breakage** — `git gc` in a session clone can de-hardlink objects, increasing disk usage. Mitigate with `gc.auto=0`.
- **Stale bare cache** — if the cache isn't fetched, new clones miss recent commits. Mitigate with fetch-on-clone.
- **Concurrent clones** — multiple sessions cloning from the same bare cache simultaneously. Git handles this safely via lockfiles.
