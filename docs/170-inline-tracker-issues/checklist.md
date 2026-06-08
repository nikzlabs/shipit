# Checklist — Inline tracker Issues tab (TRACKER-67)

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
- [x] `trackers/github/` — GitHub Issues adapter (reuses `GitHubAuthManager`,
      label-derived priority, drops PRs) — **shipped via TRACKER-80**
- [x] `trackers/linear/` — Linear adapter (API token + GraphQL `listIssues`)
- [x] `GET /api/issues?tracker=...` route, repo/workspace-scoped; now also
      accepts `?sessionId=` so the GitHub tab scopes to the active session's repo
- [x] Repo→tracker mapping: Linear team binding in settings (`CredentialStore`);
      GitHub derived from the **active session's git remote** (`parseGitHubRemote`),
      resolved in the route into a `GitHubTrackerContext` (TRACKER-80). The optional
      `shipit.yaml` repo override remains a follow-up.
- [x] In-app caller: fetched issue → `IssueRef` → `headless-sessions.create({ issueRef })`

## Client

- [x] `IssuesViewer.tsx` — Issues tab + per-tracker sub-tabs + priority-sorted list
- [x] `issues-store.ts` — per-tracker issue lists, manual refresh
- [x] Per-row **Start session** action
- [x] Settings UI: Linear workspace/team binding (`SettingsTrackers.tsx`).
      GitHub needs no settings — it reuses the existing GitHub connection and a
      repo-from-remote binding, so the GitHub sub-tab shows a "No GitHub repo in
      context" empty state (not a connect form) when unconfigured.
- [x] `issues-store.ts` sends the active `sessionId` on tracker/issue fetches so
      the server can resolve the GitHub repo binding.

## Tests

- [x] Tracker adapter unit tests — Linear listing + GitHub listing
      (`trackers/github/adapter.test.ts`: label→priority mapping, PR filtering,
      configured-state, 401/404 handling).
- [x] Integration test: `GET /api/issues` connect → bind → list, token non-echo,
      disconnect (`issues-routes.test.ts`); start-session → `IssueRef` seeding
      (`headless-sessions.test.ts`); client render test (`IssuesViewer.test.tsx`).
      GitHub: auto-configure-from-session-remote + unconfigured-without-session
      cases in `issues-routes.test.ts`.

## Deferred

- [ ] GitHub `shipit.yaml` repo override (v1 derives the repo from the git remote)
- [ ] Linear OAuth app registration (v1 uses a read-only API token)
- [ ] Webhook/polling refresh if fetch-on-open staleness proves insufficient
- [ ] Write-back (set priority / comment from the tab)
