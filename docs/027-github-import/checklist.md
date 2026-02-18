# 027 — GitHub Import, Auto-Push, PR Status Bar + Merge: Checklist

Depends on: doc 019 (PR creation) for `github_pr_created` event and `parseGitHubRemote()`.

---

## Part 1: GitHub Repo Import

### Server
- [ ] Add `clone()` to `GitManager` in `src/server/git.ts`
- [ ] Add `getDefaultBranch()` to `GitManager` in `src/server/git.ts`
- [ ] Add `searchRepos()` to `GitHubAuthManager` in `src/server/github-auth.ts`
- [ ] Add types: `WsGitHubImportRepo`, `WsGitHubSearchRepos`, `WsGitHubImportProgress`, `WsGitHubImportComplete`, `WsGitHubSearchResults`
- [ ] Add `github_import_repo` handler (URL validation, owner/repo shorthand, clone, session creation, credential config)
- [ ] Add `github_search_repos` handler

### Client
- [ ] Create `ImportRepoOverlay.tsx` (search input, repo list, branch selector, progress indicators)
- [ ] Add "Import from GitHub" option to new session screen
- [ ] Wire import overlay state in `App.tsx`
- [ ] Auto-redirect to new session on import success

### Tests
- [ ] Integration: `src/server/integration_tests/github-import.test.ts`
  - [ ] Happy path (clone → session created → success)
  - [ ] Owner/repo shorthand expansion
  - [ ] Missing auth → error
  - [ ] Empty URL → error
  - [ ] Invalid URL → error
  - [ ] Search repos → response format
  - [ ] Progress events fire in order
- [ ] Component: `src/client/components/ImportRepoOverlay.test.tsx`

---

## Part 2: Auto-Push

### Server
- [ ] Add debounced auto-push logic after `autoCommit()` in `src/server/index.ts`
- [ ] Condition checks: authenticated, origin remote exists, credentials configured, not detached HEAD
- [ ] Non-blocking: push failures logged as `log_entry`, never block coding flow
- [ ] 5-second trailing debounce for rapid commits
- [ ] Add `autoPush` field to session metadata in `src/server/types.ts`
- [ ] Persist auto-push preference in `src/server/sessions.ts`

### Client
- [ ] Auto-push toggle in GitHub settings section (opt-out, on by default)

### Tests
- [ ] Integration: `src/server/integration_tests/auto-push.test.ts`
  - [ ] Auto-push fires after commit when conditions met
  - [ ] Debouncing: two rapid commits → one push
  - [ ] No remote → no push, no error
  - [ ] Not authenticated → no push
  - [ ] Push failure → log entry emitted, no crash

---

## Part 3: PR Status Bar + Merge

### Server
- [ ] Add `findPullRequest()` to `GitHubAuthManager` (search open PRs by head branch)
- [ ] Add `mergePullRequest()` to `GitHubAuthManager` (REST PUT to merge endpoint)
- [ ] Add `enableAutoMerge()` to `GitHubAuthManager` (GraphQL mutation)
- [ ] Add `getCheckStatus()` to `GitHubAuthManager` (combined status + check runs APIs)
- [ ] Add `diffStatVsBranch()` to `GitManager` in `src/server/git.ts`
- [ ] Add types: `WsGetPrStatus`, `WsPrStatus` (with checks, mergeable, autoMergeEnabled), `WsMergePr`, `WsMergePrResult`
- [ ] Add `get_pr_status` handler (lookup PR, diff stats, CI checks, mergeable state)
- [ ] Add `merge_pr` handler (try direct merge → fallback to auto-merge on pending CI → error on failure)

### Client
- [ ] Create `PrStatusBar.tsx` (branch flow, copy button, diff stats, CI indicator, View PR link, Merge button with dropdown)
- [ ] Merge button states: green (mergeable), yellow (auto-merge enabled), gray/disabled (checks failed or conflicts)
- [ ] Merge method dropdown (merge commit / squash / rebase), remembered per session
- [ ] Place bar below header, above workspace panels in `App.tsx`
- [ ] Add `prStatus` state to `App.tsx`
- [ ] Fetch PR status on session load + after auto-push + after PR creation
- [ ] Handle `pr_status` and `merge_pr_result` messages
- [ ] Poll every 30s while `checks.state === "pending"`
- [ ] Clear bar on successful merge, refresh on auto-merge enable

### Tests
- [ ] Integration: `src/server/integration_tests/pr-status.test.ts`
  - [ ] No PR → `pr: null`
  - [ ] Existing PR → correct metadata + diff stats + check status
  - [ ] No remote → `pr: null`
  - [ ] Not authenticated → `pr: null`
  - [ ] CI pending → correct check counts
- [ ] Integration: `src/server/integration_tests/merge-pr.test.ts`
  - [ ] Direct merge (checks passed) → success
  - [ ] Auto-merge (checks pending) → `autoMergeEnabled: true`
  - [ ] Failed checks → `success: false`
  - [ ] Squash merge → correct method passed to API
  - [ ] No active PR → error
- [ ] Component: `src/client/components/PrStatusBar.test.tsx`
  - [ ] Branch flow renders correctly
  - [ ] Copy button copies branch name
  - [ ] Diff stats with correct colors
  - [ ] View PR link opens correct URL
  - [ ] Not rendered when prStatus is null
  - [ ] CI indicators (pending/success/failure)
  - [ ] Merge button enabled/disabled states
  - [ ] Merge dropdown method selection
  - [ ] Auto-merge yellow styling
  - [ ] Merge conflicts disabled state
