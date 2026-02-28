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
- [ ] Add "Create new repository" option in `AddRepoDialog` (reuse `NewRepoDialog` flow)
- [ ] Show clone progress indicator inside the dialog instead of closing immediately
- [ ] Auto-close dialog when clone completes and warm session is ready

## Phase 2: Sidebar restructure

- [x] Repo-driven groups in `SessionSidebar` (keyed by `RepoStore` entries)
- [x] "Add Repository" button in sidebar header
- [x] "No Remote" group for legacy sessions
- [x] Repos with `status: "cloning"` show animated label
- [x] `useRepoStore` Zustand store (`stores/repo-store.ts`)
- [x] Client WS handlers for `repo_status`, `repo_warm_ready`, `repo_list`
- [x] Sidebar test updated for repo props
- [ ] Add per-repo [+ New Session] button in `SessionSidebar` group headers
- [ ] Disable button when repo is still cloning or warm session is not ready
- [ ] Add sidebar test for per-repo [+ New Session] button
- [ ] Add sidebar test for repo group with `status: "cloning"` display

## Phase 3: Warm session pool (server)

- [x] `warmSessionForRepo()` function in `index.ts` (all 8 steps, retry logic)
- [x] `POST /api/repos/:url/claim-session` endpoint (server-side)
- [x] Graduation logic in `handleSendMessage` (remove warm flag, rename, broadcast, re-warm)
- [x] WS messages: `repo_status`, `repo_warm_ready`, `repo_list`
- [x] `HandlerContext` additions (`repoStore`, `warmSessionForRepo`)
- [ ] In claim-session fallback, create a runner via `runnerRegistry.getOrCreate` so the session is fully ready
- [ ] Call `warmSessionForRepo` for each migrated repo after creating `RepoInfo` entries
- [ ] On startup, check each `status: "ready"` repo's warm session; re-warm if missing

## Phase 4: Warm session pool (client — critical gap)

- [ ] Wire per-repo [+ New Session] button to call `POST /api/repos/:url/claim-session`
- [ ] Navigate to claimed session and send `activate_session` over WS
- [ ] Handle fallback when no warm session is available (synchronous creation path)

## Phase 5-6: HomeScreen simplification & cleanup

- [ ] Simplify `HomeScreen` to zero-repo state only ("Add a repository to get started")
- [ ] Remove `RepoSelector` and message input from `HomeScreen`
- [ ] Remove `home_send_with_repo` WS message handler (replaced by claim + send_message)
- [ ] Remove old `HomeScreen` components no longer needed

## Tests (missing)

- [ ] Add `AddRepoDialog.test.tsx` component test (happy path, search, empty input)
- [ ] Add integration test for `POST /api/repos/:url/claim-session` (happy path + no warm session fallback)
- [ ] Add integration test for warm session pool flow (warm → claim → graduate → re-warm)
- [ ] Add integration test for clone-in-background + WS broadcast
