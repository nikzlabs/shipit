# Checklist — Inline single-issue detail view (docs/189)

- [x] `GET /api/issue` public read route (no transcript card) + `GetIssueResult` type
- [x] issues-store: `selected`/`detail` state, `openIssue`/`fetchDetail`/`closeIssue`, `issueLookupId()`
- [x] `IssueDetail` component (header + deep link, status·priority, title, assignee/labels, markdown body, footer action)
- [x] `IssuesPanel` list ⇄ detail branch
- [x] List rows open the detail; row deep link removed
- [x] `IssueRefCard` / `IssueWriteCard` open the detail instead of linking out
- [x] `onOpenIssue` threaded through `MessageList` → `App` (switch tab + reveal on mobile)
- [x] Tests: server route, store flow, `IssueDetail`, card open, row open
- [x] Committed `mockup.html` visual reference
- [ ] Manual verification in the running app (open from list + from a chat card)
- [ ] Follow-up: comments thread in the detail view (needs `Tracker.listComments`)
