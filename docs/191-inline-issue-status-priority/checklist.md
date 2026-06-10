# Checklist — inline issue status & priority editing (docs/191)

- [x] `Tracker.listStatuses()` on the interface + Linear & GitHub adapters
- [x] `ListIssuesResult.availableStatuses` + `MutateIssueResult` types
- [x] `listIssuesForTracker` attaches statuses (best-effort)
- [x] `userSetIssueStatus` / `userSetIssuePriority` services (no card / undo)
- [x] Public `POST /api/issue/status` + `POST /api/issue/priority` routes
- [x] Store: `statusesByTracker`, `setIssueStatus` / `setIssuePriority`, in-place patch
- [x] `IssueFieldControls` editors (status both trackers, priority Linear-only)
- [x] Wired into `IssueDetail`, `IssuesViewer`, `IssuesPanel`
- [x] Portal-bubble propagation guard (editing a row doesn't open detail)
- [x] Server tests (adapters, service, integration)
- [x] Client tests (store, components)
- [x] Typecheck + lint clean
- [ ] Manual browser verification of the editors in the Issues tab
