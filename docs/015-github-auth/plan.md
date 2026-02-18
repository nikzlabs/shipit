---
status: done
---
# GitHub Authentication

Status: **Implemented** — token-based auth (PAT), git credential configuration, push/pull, remote management, repo creation, and status UI are all complete. Device authorization flow split out to doc 030.

## Current state

`GitHubAuthManager` (`src/server/github-auth.ts`) handles:
- Token storage at `/workspace/.github-token` (mode 0600)
- Token validation via GitHub API (`GET /user`)
- Git credential configuration per session (`git config credential.helper`)
- User info retrieval (username, avatar)

## Implemented

- `GitHubAuthOverlay` for PAT entry
- `GitHubCreateRepoOverlay` for creating new repos
- Push/pull buttons in `GitHistory` panel
- GitHub status indicator in header (auth state, username, disconnect)
- `GitManager` methods: `push()`, `pull()`, `addRemote()`, `getRemotes()`, `getCurrentBranch()`

## WS messages

Client → Server: `github_set_token`, `github_get_status`, `github_push`, `github_pull`, `github_set_remote`, `github_get_remotes`, `github_logout`, `github_create_repo`

Server → Client: `github_status`, `github_push_result`, `github_pull_result`, `github_remotes`, `github_repo_created`

## Key files

- `src/server/github-auth.ts` — `GitHubAuthManager` class
- `src/server/git.ts` — `GitManager`
- `src/server/index.ts` — WS handlers, credential configuration on session create
- `src/server/types.ts` — WS message types
- `src/client/components/GitHubAuthOverlay.tsx` — PAT entry overlay
- `src/client/components/GitHubCreateRepoOverlay.tsx` — repo creation overlay
