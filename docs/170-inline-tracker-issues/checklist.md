# Checklist — Inline tracker Issues tab (SHI-67)

## Prerequisite (shared with docs/156)

- [x] `headless-sessions.create()` accepts an `IssueRef` and derives branch +
      initial prompt from it. (The Linear sub-tab additionally needs 156's
      per-deployment Linear app registration / OAuth; the GitHub sub-tab works
      on existing user GitHub auth.) — `seedFromIssueRef()` in
      `headless-sessions.ts`; v1 Linear auth uses a stored API token, not the
      full OAuth app registration (deferred to docs/156).

## Server

- [x] `IssueRef` + issue/tracker domain types in `domain-types.ts`
- [x] `trackers/tracker.ts` — `Tracker` interface (`listIssues`, `getIssue`, `id`, `label`)
- [x] `trackers/registry.ts` — configured-tracker registry (drives sub-tabs)
- [ ] `trackers/github/` — GitHub Issues adapter (reuses `GitHubAuthManager`) — **deferred (out of scope for SHI-67 v1)**
- [x] `trackers/linear/` — Linear adapter (API token + GraphQL `listIssues`)
- [x] `GET /api/issues?tracker=...` route, repo/workspace-scoped
- [x] Repo→tracker mapping: Linear team binding in settings (`CredentialStore`).
      GitHub-from-git-remote override is **deferred** with the GitHub adapter.
- [x] In-app caller: fetched issue → `IssueRef` → `headless-sessions.create({ issueRef })`

## Client

- [x] `IssuesViewer.tsx` — Issues tab + per-tracker sub-tabs + priority-sorted list
- [x] `issues-store.ts` — per-tracker issue lists, manual refresh
- [x] Per-row **Start session** action
- [x] Settings UI: Linear workspace/team binding (`SettingsTrackers.tsx`).
      GitHub repo override is **deferred** with the GitHub adapter.

## Tests

- [x] Tracker adapter unit tests (Linear listing, with stubbed token/GraphQL).
      GitHub adapter tests deferred with the adapter.
- [x] Integration test: `GET /api/issues` connect → bind → list, token non-echo,
      disconnect (`issues-routes.test.ts`); start-session → `IssueRef` seeding
      (`headless-sessions.test.ts`); client render test (`IssuesViewer.test.tsx`).

## Deferred

- [ ] GitHub Issues adapter + sub-tab (out of scope for this Linear-only v1)
- [ ] Linear OAuth app registration (v1 uses a read-only API token)
- [ ] Webhook/polling refresh if fetch-on-open staleness proves insufficient
- [ ] Write-back (set priority / comment from the tab)
