# GitHub Authentication

Status: **Partially implemented** — token-based auth and git credential configuration exist. Push/pull UI and device flow are not yet built.

## Current state

`GitHubAuthManager` (`src/server/github-auth.ts`) handles:
- Token storage at `/workspace/.github-token` (mode 0600)
- Token validation via GitHub API (`GET /user`)
- Git credential configuration per session (`git config credential.helper`)
- User info retrieval (username, avatar)

## Planned

- GitHub device authorization flow (no redirect URI needed, matches Claude OAuth UX)
- Push/pull buttons in `GitHistory` panel
- GitHub status indicator in header (auth state, username, disconnect)
- `GitHubAuthOverlay` for PAT entry
- `GitHubCreateRepoOverlay` for creating new repos
- New `GitManager` methods: `push()`, `pull()`, `addRemote()`, `getRemotes()`, `getCurrentBranch()`

## Planned WS messages

Client → Server: `github_set_token`, `github_get_status`, `github_push`, `github_pull`, `github_set_remote`, `github_get_remotes`, `github_logout`, `github_create_repo`

Server → Client: `github_status`, `github_push_result`, `github_pull_result`, `github_remotes`, `github_repo_created`

## Key files

- `src/server/github-auth.ts` — `GitHubAuthManager` class
- `src/server/git.ts` — `GitManager` (to be extended with push/pull)
- `src/server/index.ts` — WS handlers, credential configuration on session create
- `src/server/types.ts` — WS message types
