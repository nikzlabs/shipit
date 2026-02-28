# 059 — Repo & Session Flows: Checklist

## Phase 1: RepoStore + "Add Repository"

- [x] `RepoStore` persistence layer (`repo-store.ts`) with all methods (add, setReady, setWarmSessionId, remove, list, get)
- [x] `RepoInfo` type in `domain-types.ts`
- [x] `SessionInfo.warm` field in `domain-types.ts`
- [x] `SessionManager.list()` filters `warm !== true`
- [x] `SessionManager.setWarm()` method
- [x] `GET /api/repos` endpoint
- [x] `POST /api/repos` endpoint (background clone, WS broadcast)
- [x] `DELETE /api/repos/:url` endpoint (warm session cleanup)
- [x] Services layer (`services/repos.ts` — `listRepos`, `addRepo`, `removeRepo`)
- [x] Bootstrap data includes repos
- [x] Full reset clears repo store
- [x] DI wiring in `buildApp()` for `repoStore`
- [x] RepoStore unit tests (`repo-store.test.ts`)
- [x] Integration tests for GET/POST/DELETE `/api/repos` (`repos.test.ts`)
- [x] Add "Create new repository" option in `AddRepoDialog` (navigates to HomeScreen NewRepoDialog)
- [x] Show clone progress indicator inside the dialog when cloning
- [x] Auto-close dialog when clone completes and warm session is ready

## Phase 2: Sidebar restructure

- [x] Repo-driven groups in `SessionSidebar` (keyed by `RepoStore` entries)
- [x] "Add Repository" button in sidebar header
- [x] "No Remote" group for legacy sessions
- [x] Repos with `status: "cloning"` show animated label
- [x] `useRepoStore` Zustand store (`stores/repo-store.ts`)
- [x] Client WS handlers for `repo_status`, `repo_warm_ready`, `repo_list`
- [x] Sidebar test updated for repo props
- [x] Add per-repo [+ New Session] button in `SessionSidebar` group headers
- [x] Disable button when repo is still cloning
- [x] Add sidebar test for per-repo [+ New Session] button
- [x] Add sidebar test for repo group with `status: "cloning"` display

## Phase 3: Warm session pool (server)

- [x] `warmSessionForRepo()` function in `index.ts` (all 8 steps, retry logic)
- [x] `POST /api/repos/:url/claim-session` endpoint (server-side)
- [x] Graduation logic in `handleSendMessage` (remove warm flag, rename, broadcast, re-warm)
- [x] WS messages: `repo_status`, `repo_warm_ready`, `repo_list`
- [x] `HandlerContext` additions (`repoStore`, `warmSessionForRepo`)
- [x] In claim-session fallback, create a runner via `runnerRegistry.getOrCreate`
- [x] Warm sessions for migrated repos on first startup
- [x] On startup, check each `status: "ready"` repo's warm session; re-warm if missing

## Phase 4: Warm session pool (client)

- [x] `claimSession` action in `useRepoStore`
- [x] Wire per-repo [+ New Session] button to call `POST /api/repos/:url/claim-session`
- [x] Navigate to claimed session and send `activate_session` over WS
- [x] Handle fallback when no warm session is available (synchronous creation path on server)

## Phase 5-6: HomeScreen simplification & cleanup

- [x] HomeScreen only shows when zero repos exist (first-time user experience)
- [ ] Remove `RepoSelector` and message input from `HomeScreen` (kept for zero-repo flow)
- [ ] Remove `home_send_with_repo` WS message handler (kept for zero-repo flow)

## Tests

- [x] `AddRepoDialog.test.tsx` component test (open/close, search, submit, create new, debounce)
- [x] Integration test for `POST /api/repos/:url/claim-session` (404, 400 cloning, fallback)
- [x] Sidebar tests for per-repo New Session button and cloning indicator
- [x] Integration test for `warmSessionForRepo()` lifecycle (warm → claim → graduate)
- [x] Integration test for graduation logic in `handleSendMessage` (warm flag removal, rename, broadcast)

## Hardening

- [x] Add `console.error` in `useRepoStore` async actions (`addRepo`, `removeRepo`, `claimSession`) — errors are swallowed silently
