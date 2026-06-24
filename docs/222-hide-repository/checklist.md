# Hide repository — checklist

- [x] DB migration: `repos.hidden` column (default 0, existing rows visible)
- [x] `RepoInfo.hidden` type field + `RepoStore` hydration
- [x] `RepoStore.setHidden()` + unhide-on-readd in `add()`
- [x] `setRepoHidden()` service fn (404 on unknown)
- [x] `PATCH /api/repos/:url` route + `repo_list` broadcast
- [x] Client `setRepoHidden()` store action (optimistic + revert)
- [x] Persisted Hidden-section collapse state
- [x] "Hide from sidebar" dropdown menu item
- [x] "Hidden · N" collapsible sidebar section with per-repo Show
- [x] Hidden repos' sessions filtered out of the grouping (no orphan resurface)
- [x] Add-dialog hidden-match detection + Show label
- [x] Unit tests (repo-store) + integration tests (PATCH route)
- [x] Typecheck + lint:dev clean
- [x] Mockup committed beside plan.md
