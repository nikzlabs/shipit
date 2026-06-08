---
name: git-architecture
description: "ShipIt git architecture: GitManager (per-session), RepoGit (shared bare cache + per-session local clones), credential setup, auto-commit flow, session clone lifecycle, branch naming. Load when working on git operations, the bare cache, per-session clones, credentials, or repo management."
user-invocable: true
---

# Git Architecture

ShipIt uses git for version control at two levels: per-session workspace repos managed by `GitManager`, and a shared per-remote bare cache (from which each session gets its own independent local clone) managed by `RepoGit`. Both use the `simple-git` library.

> Each session gets its **own independent full clone** — `git clone --local` from the bare cache, which hardlinks objects so the clone is fast and disk-cheap. Each session owns a complete `.git/` and shares nothing mutable with its siblings.

## Two Git Layers

### GitManager (per-session)

`src/server/shared/git.ts` — operates on a single session's workspace directory.

Each session gets its own `GitManager` instance via the `createGitManager(dir)` factory. Used for:

- `init()` — initialize repo with initial commit (so rollback always has a base)
- `autoCommit(summary)` — stage all + commit if anything changed
- `log(maxCount)` — commit history
- `rollback(hash)` — hard reset to a previous commit
- `push(remote, branch)` — push with upstream tracking
- `pull(remote, branch)` — pull from remote
- `addRemote(name, url)` / `getRemotes()` — remote management
- `checkoutNewBranch(name)` / `renameBranch(old, new)` — branch operations
- `diffSummary()` — per-file diff stats for the working tree
- `diffStatVsBranch(baseBranch)` — insertions/deletions vs a base branch (for PR stats)
- `getFileAtCommit(hash, filePath)` — file content at a specific commit
- `diffNameStatus(from, to)` — changed files with status between commits
- `merge(branchName)` — merge with conflict detection

### RepoGit (bare cache)

`src/server/orchestrator/repo-git.ts` — operates on a per-remote **bare cache** directory (one bare clone per remote URL, at `{stateDir}/repo-cache/{hash}`).

Used by the orchestrator to seed and refresh the cache, then cut per-session clones from it:

- `cloneBare(url)` — bare-clone the remote into the cache dir (`git clone --bare`)
- `fetchCache(ttlMs?)` — fetch the remote into the bare cache (advances local `refs/heads/*`); TTL-throttled
- `cloneFromCache(sessionDir, remoteUrl?)` — **create a session's clone**: `git clone --local` from the cache (hardlinked objects), set `gc.auto=0`, then reset `origin` to the real remote URL
- `getDefaultBranch(remote)` — detect main/master (tries local refs first to avoid network calls)
- `deleteBranch(name)` — delete local branch
- `isEmpty()` / `createInitialCommit()` — empty-repo handling
- `readHead()` / `lastFetchAgeMs()` — cache freshness checks used by the proactive pre-fetcher

## Session Types and Git Setup

### Standalone Session

No remote repo. A fresh git repo is initialized in the session directory:

```
/workspace/sessions/{uuid}/
  .git/              <- independent repo
  (user's code)
```

`GitManager.init()` creates the repo with `--initial-branch=main` and an empty initial commit.

### Repo-backed Session

Backed by the per-remote bare cache. The session directory is its **own independent clone** — a complete repo:

```
{stateDir}/repo-cache/{hash}/            <- bare cache (one per remote URL)
  HEAD, refs/, objects/                  (bare; no working tree)

{sessionsRoot}/{uuid}/workspace/         <- the session's own clone
  .git/   (complete; objects hardlinked from the cache)
  (checked out on a unique branch)
```

Created via `RepoGit.cloneFromCache(sessionDir, remoteUrl)` (`git clone --local`, so objects are hardlinked — fast and disk-cheap), then the session's `GitManager` checks out a unique branch. Each session owns a full `.git/` and shares nothing mutable with its siblings, so multiple sessions work the same repo simultaneously without conflicts.

## Git Credentials

### Global Git Config

`src/server/orchestrator/git-config.ts` sets up a global git config file via `GIT_CONFIG_GLOBAL` environment variable:

```
/credentials/.gitconfig
  [user]
    name = ...
    email = ...
  [commit]
    gpgsign = false
  [credential "https://github.com"]
    helper = ...
```

This config is inherited by all git operations (both `GitManager` and `RepoGit`).

### CredentialStore

`src/server/orchestrator/credential-store.ts` — unified storage in `/credentials/`:

- `.gitconfig` — git identity (name, email)
- `.github-token` — GitHub personal access token
- `.agent-env` — agent API keys
- `.git-credentials` — URL-based git credentials for push/pull

The credentials directory is mounted read-only into session containers, so workers can push/pull but not modify credentials.

### GitHub Auth

`src/server/orchestrator/github-auth.ts` — manages GitHub token and API access. When authenticated:

1. Configures git credential helper to use the stored token
2. Loads GitHub user info (username, avatar) for UI display
3. Enables GitHub API operations (search repos, create PRs, etc.)

## Auto-Commit Flow

After each Claude turn completes:

1. `handleSendMessage` in the WS handler calls `onAgentFinished()`
2. The handler generates a commit summary from the turn
3. `GitManager.autoCommit(summary)` stages all changes and commits
4. Commit info is broadcast to the client via `git_committed` WS message
5. `scheduleAutoPush()` starts a debounced timer (5 seconds)
6. If no new commits within 5s, auto-push fires (if remote is configured)

## Session Clone Lifecycle

### Creation (new session on an imported repo)

1. `createSessionDir(title)` — creates the empty `{uuid}/workspace` directory
2. `RepoGit.cloneFromCache(workspaceDir, remoteUrl)` — `git clone --local` from the bare cache (hardlinked objects), set `gc.auto=0`, reset `origin` to the real remote
3. `GitManager.checkoutNewBranch(branchName)` — unique branch off the default branch
   - Branch name: `{prefix}/{short-uuid}` (e.g., `shipit/abc123`)
4. Git credentials are inherited from the global config (see below)

### Cleanup (session archived)

1. `RepoGit.deleteBranch(branchName)` — clean up the local branch in the cache, when applicable
2. Remove the session directory (its independent clone goes with it — nothing else to detach)

## Repo Import Flow

When a user imports a GitHub repo (`POST /api/repos`):

1. `RepoStore` tracks the repo with `status: "cloning"`
2. Bare-clone into `{stateDir}/repo-cache/{hash}/` via `RepoGit.cloneBare()`
3. Fetch to ensure the default branch is available in the cache
4. Set `status: "ready"`
5. Warm a session for the repo (clone-from-cache + metadata, no container)

On subsequent use, the bare cache is reused (and periodically re-fetched). Each new session gets its own fresh local clone branching from the latest default branch.

## Branch Naming

`src/server/orchestrator/git-utils.ts`:

- `generateBranchPrefix()` returns a prefix like `shipit` (configurable)
- Full branch name: `{prefix}/{short-uuid}`
- `parseGitHubRemote(url)` extracts owner/repo from GitHub URLs
