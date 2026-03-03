---
status: done
---
# GitHub Authentication

Status: **Done** — core server-side auth, credential config, repo/PR management, and auto-push are complete. Remaining client UI items (push/pull buttons in GitHistory, header status indicator) are superseded by doc 064 (PR Lifecycle Flow), which replaces the push/PR flow with inline chat cards and removes PrStatusBar. Device authorization flow split out to doc 030.

## Current state

`GitHubAuthManager` (`src/server/orchestrator/github-auth.ts`) handles:
- Token storage at `/workspace/.github-token` (mode 0600)
- Token validation via GitHub API (`GET /user`)
- Git credential configuration per session (`git config credential.helper`)
- User info retrieval (username, avatar, email)
- Repo creation, search, and listing via GitHub API
- PR management: create, find, merge, auto-merge, check status
- Authenticated clone URL generation

## Implemented

### Server
- `GitHubAuthManager` — full token lifecycle, repo CRUD, PR operations, CI check status
- `GitManager` methods: `push()`, `pull()`, `addRemote()`, `getRemotes()`, `getCurrentBranch()`
- Service layer: `gitPush()`, `gitPull()` in `services/git.ts`
- HTTP endpoints in `api-routes.ts` for push/pull/PR operations
- Auto-push after auto-commit in `index.ts`
- PR description generation via agent

### Client
- `GitHubTokenForm` for PAT entry (in Settings > GitHub tab)
- `NewRepoDialog` for creating new repos (name, description, privacy, template)
- `PullRequestModal` for PR creation (title, body, base branch, draft, AI description)
- `GitHistory` panel — commits with rollback and diff buttons
- `useMessageHandler` handles `github_status` messages

### Not yet implemented
- Push/pull buttons in `GitHistory` panel — no client UI for manual push/pull
- GitHub status indicator in header/navigation (only shown in Settings tab)

## WS messages

Client → Server: `github_set_token`, `github_get_status`, `github_push`, `github_pull`, `github_set_remote`, `github_get_remotes`, `github_logout`, `github_create_repo`

Server → Client: `github_status`, `github_push_result`, `github_pull_result`, `github_remotes`, `github_repo_created`

Note: Many operations have migrated from WS to HTTP endpoints in `api-routes.ts`.

## Key files

- `src/server/orchestrator/github-auth.ts` — `GitHubAuthManager` class
- `src/server/shared/git.ts` — `GitManager`
- `src/server/orchestrator/index.ts` — WS handlers, auto-push, credential config on session create
- `src/server/orchestrator/api-routes.ts` — HTTP endpoints for push/pull/PR
- `src/server/orchestrator/services/git.ts` — `gitPush()`, `gitPull()` service functions
- `src/server/shared/types/github-types.ts` — WS message types
- `src/client/components/GitHubTokenForm.tsx` — PAT entry form
- `src/client/components/NewRepoDialog.tsx` — repo creation dialog
- `src/client/components/PullRequestModal.tsx` — PR creation modal
- `src/client/components/GitHistory.tsx` — commit history panel
