# Design: GitHub Authentication

## Problem

ShipIt's `GitManager` only supports local git operations (init, commit, log, rollback). Users cannot push their work to GitHub. Adding GitHub authentication and push/pull capabilities lets users persist their work to a remote repository.

## Approach: GitHub Device Flow + Personal Access Token

GitHub's [device authorization flow](https://docs.github.com/en/apps/oauth-apps/building-oauth-apps/authorizing-oauth-apps#device-flow) is the best fit for this environment:

- No redirect URI needed (server-side initiated, no browser callback)
- User opens a URL, enters a code, authorizes
- Server polls GitHub until authorization completes
- Mirrors the existing Claude OAuth UX (show URL in overlay, auto-dismiss on success)

As a fallback, users can also paste a Personal Access Token (PAT) directly.

## Architecture

### New server module: `src/server/github-auth.ts`

```
GitHubAuthManager extends EventEmitter
  - token: string | null           (in-memory, also persisted to disk)
  - checkCredentials(): boolean     (check if token file exists)
  - setToken(token): Promise<void>  (validate + persist token)
  - getStatus(): GitHubAuthStatus   (authenticated, username, etc.)
  - configureGitCredentials(): void (set git credential helper for push/pull)
  - clearCredentials(): void        (remove token + git config)

Events emitted:
  - "auth_complete"  — token validated and stored
  - "auth_failed"    — token validation failed
```

Token is stored at `/workspace/.github-token` (workspace-scoped, not global).
On startup, if the token file exists, git credentials are configured automatically.

### Git credential configuration

When a valid token is available, configure git to use it:

```bash
git config credential.helper '!f() { echo "password=$TOKEN"; }; f'
git config user.email <from-github-api>
git config user.name  <from-github-api>
```

This enables `git push` / `git pull` to work with the token without any manual setup.

### New `GitManager` methods

```typescript
async addRemote(url: string): Promise<void>
async push(remote?: string, branch?: string): Promise<string>
async pull(remote?: string, branch?: string): Promise<string>
async getRemotes(): Promise<Array<{name: string, url: string}>>
async getCurrentBranch(): Promise<string>
```

### New WebSocket message types

**Client -> Server:**

| Type | Fields | Description |
|------|--------|-------------|
| `github_set_token` | `token: string` | Set PAT (validate + store) |
| `github_get_status` | — | Query current GitHub auth status |
| `github_push` | `remote?: string, branch?: string` | Push to remote |
| `github_pull` | `remote?: string, branch?: string` | Pull from remote |
| `github_set_remote` | `name: string, url: string` | Add/update git remote |
| `github_get_remotes` | — | List configured remotes |
| `github_logout` | — | Clear stored token |
| `github_create_repo` | `name, description?, isPrivate?` | Create a new GitHub repo |

**Server -> Client:**

| Type | Fields | Description |
|------|--------|-------------|
| `github_status` | `authenticated, username?, avatarUrl?` | Auth state |
| `github_push_result` | `success, message, branch?` | Push outcome |
| `github_pull_result` | `success, message` | Pull outcome |
| `github_remotes` | `remotes[]` | List of configured remotes |
| `github_repo_created` | `success, name?, fullName?, url?, cloneUrl?, message?` | Repo creation result |

### Client UI

1. **GitHub status indicator** in the header — shows auth state (dot + username, "+ Repo" button, disconnect button).
2. **GitHubAuthOverlay** — modal for entering a PAT, mirroring `AuthOverlay` style.
3. **GitHubCreateRepoOverlay** — modal for creating a new GitHub repo (name, description, visibility).
4. **Push/pull buttons** in the `GitHistory` panel — appear when authenticated.

### Dependency injection

`AppDeps` gets a new optional field:
```typescript
githubAuthManager?: GitHubAuthManager;
```

Tests inject a `StubGitHubAuthManager` (same pattern as `StubAuthManager`).

## Security considerations

- Token is stored in `/workspace/.github-token` with mode 0600
- Token is never sent back to the client after being set (only status is sent)
- PAT validation: hit `GET /user` on GitHub API before accepting the token
- Input validation: token must be non-empty, remote URLs must match `https://github.com/...` or `git@github.com:...` patterns

## Testing plan

1. **Unit tests** (`github-auth.test.ts`): token persistence, credential checking, git config
2. **Git push/pull tests** (`git.test.ts`): new methods with local bare repos
3. **Integration tests** (`integration.test.ts`): all new WS message types with happy + error paths
4. **Client tests**: GitHubAuthOverlay + GitHubCreateRepoOverlay component rendering + callback wiring

## File changes

| File | Change |
|------|--------|
| `src/server/github-auth.ts` | New — GitHubAuthManager class with token management + createRepo |
| `src/server/github-auth.test.ts` | New — unit tests |
| `src/server/git.ts` | Add push, pull, addRemote, getRemotes, getCurrentBranch |
| `src/server/git.test.ts` | Add tests for new git methods |
| `src/server/types.ts` | Add new WS message types |
| `src/server/index.ts` | Wire GitHubAuthManager + new WS handlers |
| `src/server/integration.test.ts` | Add integration tests for new messages |
| `src/client/components/GitHubAuthOverlay.tsx` | New — PAT entry overlay |
| `src/client/components/GitHubAuthOverlay.test.tsx` | New — component tests |
| `src/client/components/GitHubCreateRepoOverlay.tsx` | New — repo creation dialog |
| `src/client/components/GitHubCreateRepoOverlay.test.tsx` | New — component tests |
| `src/client/App.tsx` | Handle new WS messages, render overlays + status |
