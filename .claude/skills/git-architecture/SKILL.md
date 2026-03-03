---
description: "ShipIt git architecture: GitManager (per-session), RepoGit (shared repo clones and worktrees), credential setup, auto-commit flow, worktree lifecycle, branch naming. Load when working on git operations, worktrees, credentials, or repo management."
user-invocable: true
---

# Git Architecture

ShipIt uses git for version control at two levels: per-session workspace repos managed by `GitManager`, and shared repo clones with worktrees managed by `RepoGit`. Both use the `simple-git` library.

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

### RepoGit (shared repo)

`src/server/orchestrator/repo-git.ts` — operates on a shared repo directory (one clone per remote URL).

Used by the orchestrator for cross-session repo operations:

- `clone(url, branch?)` — clone remote repository
- `fetch(remote)` — fetch all branches
- `getDefaultBranch(remote)` — detect main/master (tries local refs first to avoid network calls)
- `createWorktree(path, branch, startPoint?)` — create new worktree with a new branch
- `removeWorktree(path)` — remove worktree (force)
- `listWorktrees()` — list all worktrees with branch and HEAD
- `deleteBranch(name)` — delete local branch
- `isEmpty()` — check for initial commit

## Session Types and Git Setup

### Standalone Session

No remote repo. A fresh git repo is initialized in the session directory:

```
/workspace/sessions/{uuid}/
  .git/              <- independent repo
  (user's code)
```

`GitManager.init()` creates the repo with `--initial-branch=main` and an empty initial commit.

### Worktree Session

Backed by a shared repo clone. The session directory is a git worktree:

```
/workspace/.vibe-repos/{encoded-url}/    <- shared clone
  .git/
  (full repo)

/workspace/sessions/{uuid}/              <- worktree
  .git  (file, points to shared clone)
  (checked out on a unique branch)
```

Created via `RepoGit.createWorktree(sessionDir, branchName, startPoint)`. Each session gets its own branch, allowing multiple sessions to work on the same repo simultaneously without conflicts.

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

## Worktree Lifecycle

### Creation (new session on an imported repo)

1. `createSessionDir(title, { skipGitInit: true })` — creates directory, skips `git init`
2. Remove empty dir (worktree add needs it absent)
3. `RepoGit.createWorktree(sessionDir, branchPrefix, startPoint)`
   - Branch name: `{prefix}/{short-uuid}` (e.g., `shipit/abc123`)
   - Start point: repo's default branch (main/master)
4. Configure git credentials in the worktree

### Cleanup (session archived)

1. `RepoGit.removeWorktree(sessionDir)` — force remove
2. `RepoGit.deleteBranch(branchName)` — clean up the local branch
3. Remove session directory

## Repo Import Flow

When a user imports a GitHub repo (`POST /api/repos`):

1. `RepoStore` tracks the repo with `status: "cloning"`
2. Clone into `/workspace/.vibe-repos/{encoded-url}/` via `RepoGit.clone()`
3. Fetch to ensure all branches are available
4. Set `status: "ready"`
5. Warm a session for the repo (create worktree + metadata, no container)

On subsequent use, the shared clone is reused. New sessions get worktrees branching from the latest default branch.

## Branch Naming

`src/server/orchestrator/git-utils.ts`:

- `generateBranchPrefix()` returns a prefix like `shipit` (configurable)
- Full branch name: `{prefix}/{short-uuid}`
- `parseGitHubRemote(url)` extracts owner/repo from GitHub URLs
