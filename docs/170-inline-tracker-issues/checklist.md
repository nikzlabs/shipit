# Checklist — Inline tracker Issues tab (SHI-67)

## Prerequisite (shared with docs/156)

- [ ] `headless-sessions.create()` accepts an `IssueRef` and derives branch +
      initial prompt from it. (The Linear sub-tab additionally needs 156's
      per-deployment Linear app registration / OAuth; the GitHub sub-tab works
      on existing user GitHub auth.)

## Server

- [ ] `IssueRef` + issue/tracker domain types in `domain-types.ts`
- [ ] `trackers/tracker.ts` — `Tracker` interface (`listIssues`, `getIssue`, `id`, `label`)
- [ ] `trackers/registry.ts` — configured-tracker registry (drives sub-tabs)
- [ ] `trackers/github/` — GitHub Issues adapter (reuses `GitHubAuthManager`)
- [ ] `trackers/linear/` — Linear adapter (user OAuth + GraphQL `listIssues`)
- [ ] `GET /api/issues?tracker=...` route, repo/workspace-scoped
- [ ] Repo→tracker mapping: GitHub from git remote (+ optional `shipit.yaml` override); Linear team binding in settings
- [ ] In-app caller: fetched issue → `IssueRef` → `headless-sessions.create({ issueRef })`

## Client

- [ ] `IssuesViewer.tsx` — Issues tab + per-tracker sub-tabs + priority-sorted list
- [ ] `issues-store.ts` — per-tracker issue lists, manual refresh
- [ ] Per-row **Start session** action
- [ ] Settings UI: Linear workspace/team binding + (optional) GitHub repo override

## Tests

- [ ] Tracker adapter unit tests (Linear + GitHub listing, with stubbed auth)
- [ ] Integration test: list issues → click Start session → session seeded with `IssueRef`

## Deferred

- [ ] Webhook/polling refresh if fetch-on-open staleness proves insufficient
- [ ] Write-back (set priority / comment from the tab)
