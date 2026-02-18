---
status: done
---
# 019 — In-App Pull Request Creation

Status: **Implemented** — PR modal, server handlers, branch listing, and tests are all complete. Post-push toast split out to doc 031, Claude-generated PR description split out to doc 032.

## Summary

Add the ability to create GitHub pull requests directly from ShipIt's UI, completing the push → PR → review workflow without leaving the browser.

## Implemented

- `PullRequestModal` component with branch selector, title, description, draft toggle
- `github_create_pr` handler with full validation (empty title, too-long title, missing base, missing auth, missing remote, non-GitHub remote)
- `github_list_branches` handler returning current + remote branches
- `GitHubAuthManager.createPullRequest()` method
- `GitManager.listRemoteBranches()` and `GitManager.parseGitHubRemote()` methods
- PR button in header (visible when authenticated + remote configured)
- WS message types: `WsGitHubCreatePR`, `WsGitHubPRCreated`, `WsGitHubListBranches`, `WsGitHubBranches`
- Integration tests (7 cases) and component tests (12 cases)

## Key Files

| File | Role |
|---|---|
| `src/server/types.ts` | `WsGitHubCreatePR`, `WsGitHubPRCreated`, `WsGitHubListBranches`, `WsGitHubBranches` |
| `src/server/github-auth.ts` | `createPullRequest()` method |
| `src/server/git.ts` | `listRemoteBranches()`, `parseGitHubRemote()` |
| `src/server/index.ts` | `github_create_pr` and `github_list_branches` handlers |
| `src/client/components/PullRequestModal.tsx` | PR creation modal |
| `src/client/components/PullRequestModal.test.tsx` | Component tests |
| `src/client/App.tsx` | PR modal state and message handling |
| `src/server/integration_tests/pr-creation.test.ts` | Integration tests |
