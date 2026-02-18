# 019 — PR Creation: Checklist

## Server

- [ ] Add `createPullRequest()` to `GitHubAuthManager` in `src/server/github-auth.ts`
- [ ] Add `listRemoteBranches()` to `GitManager` in `src/server/git.ts`
- [ ] Add `parseGitHubRemote()` static method to `GitManager` in `src/server/git.ts`
- [ ] Add types to `src/server/types.ts`: `WsGitHubCreatePR`, `WsGitHubPRCreated`, `WsGitHubListBranches`, `WsGitHubBranches`
- [ ] Add `github_create_pr` handler in `src/server/index.ts` (validation: empty title, too-long title, missing base, missing auth, missing remote, non-GitHub remote)
- [ ] Add `github_list_branches` handler in `src/server/index.ts`

## Client

- [ ] Create `PullRequestModal.tsx` (branch selector, title, description, draft toggle, Claude-generated description button)
- [ ] Add PR modal state to `App.tsx`, wire open/close
- [ ] Add "PR" button to header (visible when authenticated + remote configured)
- [ ] Post-push toast with "Create PR" action
- [ ] Handle `github_pr_created` and `github_branches` messages in `App.tsx`

## Tests

- [ ] Integration tests: `src/server/integration_tests/pr-creation.test.ts`
  - [ ] Happy path (auth + remote → create → success with URL)
  - [ ] Missing auth → error
  - [ ] Missing remote → error
  - [ ] Non-GitHub remote → error
  - [ ] Empty title → validation error
  - [ ] Branch listing returns current + remote branches
- [ ] Component tests: `src/client/components/PullRequestModal.test.tsx`
  - [ ] Renders branch and title fields
  - [ ] Submit calls handler with correct data
  - [ ] Empty title shows validation error
  - [ ] Draft checkbox toggles
  - [ ] Success state shows PR URL
  - [ ] Cancel closes modal
