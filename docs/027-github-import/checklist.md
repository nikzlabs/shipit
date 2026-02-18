# 027 — GitHub Import: Remaining Work

Parts 2 (auto-push) and 3 (PR status bar + merge) are fully implemented and tested. Part 1 (repo import) has partial server-side support — `git.clone()`, `git.getDefaultBranch()`, `searchRepos()`, and the `home_send_with_repo` embedded clone flow all exist — but the dedicated import message protocol and client overlay are missing.

## Remaining

### Part 1: Repo Import

- [ ] Add `WsGitHubImportRepo`, `WsGitHubImportProgress`, `WsGitHubImportComplete`, `WsGitHubSearchResults` message types to `src/server/types.ts`
- [ ] Add dedicated `github_import_repo` handler in `src/server/index.ts` (the plan's full handler with session creation, clone, credential setup, and progress events)
- [ ] Create `src/client/components/ImportRepoOverlay.tsx` (search input, repo list, branch selector, progress indicators, auto-redirect on success)
- [ ] Create `src/client/components/ImportRepoOverlay.test.tsx` (renders search, typing triggers search, selecting populates URL, submit calls handler, progress indicators, success redirects, cancel closes)
- [ ] Expand `src/server/integration_tests/github-import.test.ts` with comprehensive cases: happy path, `owner/repo` shorthand, missing auth, empty URL, invalid URL, search repos, progress events in order
