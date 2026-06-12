# Checklist — Issue label filter + on-page editor

- [x] `IssueFilters.labels` + `filterIssues` label clause + `distinctLabels`
- [x] Persist the labels facet to localStorage (serialize/rehydrate/prune)
- [x] `toggleLabel` store action + facet wiring through Viewer/Panel
- [x] `Labels` facet popover in `IssuesFilterBar`
- [x] `IssueLabelsEditor` (multi-select, pick-from-existing, filter box)
- [x] Editable labels row in `IssueDetail` (chip ✕ remove + Add-label trigger)
- [x] `setIssueLabels` store action (wholesale replace)
- [x] `userSetIssueLabels` service + `POST /api/issue/labels` route
- [x] Unit + component + service tests
- [x] typecheck + lint:dev green
