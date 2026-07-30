# Checklist

- [x] `RepoInfo.defaultBranch` + `repos.default_branch` migration + `RepoStore.setDefaultBranch`
- [x] `services/repo-default-branch.ts` — resolve from the bare cache, persist, broadcast
- [x] Resolve after clone completes (`POST /api/repos`) and once at boot
- [x] `GitManager.getDefaultBranch()` for server paths that already hold a clone
- [x] Client `useSessionDefaultBranch` + pure resolvers
- [x] RebaseBanner — banner text + `startRebase` base
- [x] PrActionsMenu — "Sync with \<base\>" label, tooltip, and rebase base
- [x] `useOpenPrDiff` / `PrFilesSection` — "Changes vs \<base\>"
- [x] `isDefaultBranch` — compare against the repo's real default
- [x] `git-store.fetchDiffVsBranch` — omit `?base=`, let the server resolve
- [x] Server fallbacks: `diff-vs-branch` route, `pr-lifecycle`, `route-registry`
      re-seed, `api-routes-files` docs flags, `graduate-session` ready stats
- [x] `resolvePrBaseBranch` — the base a new PR targets (`services/github.ts`
      quick-create + create paths), replacing the main → master → first ladder
- [x] `release-prepare --bootstrap` resolves the real default instead of
      accepting only main/master
- [x] Tests: repo-store, repo-default-branch service, `GitManager.getDefaultBranch`,
      `resolvePrBaseBranch`, client resolver + hook, RebaseBanner, PrActionsMenu
- [x] Audit the remaining `"main"` literals; confirm each is a documented
      fallback, a probe pair, or not a repo-default-branch concern
