# Checklist — Agent issue access

Design only so far; nothing implemented. v1 is a tracker-neutral, read-only slice
over the existing tracker registry. Injection hardening is tracked separately in
docs/176.

## Shared
- [ ] Move `parseIssueRef` from `src/client/utils/issue-ref.ts` to `src/shared/issue-ref.ts`; update client import
- [ ] Extend `parseIssueRef`: recognize bare Linear key `[A-Za-z]+-\d+` (not just the full URL)
- [ ] Extend `parseIssueRef`: surface tracker-native `issueId` (GitHub bare number, Linear key) for `getIssue`

## Shim
- [ ] Add `issue` top-level subcommand to `agent-shim/shipit.ts` with `view`/`list` handlers
- [ ] `shipit issue view <pointer> [--json]` — resolve tracker via `parseIssueRef`, `--tracker` override
- [ ] `shipit issue list [--tracker …] [--state …] [--json]`
- [ ] `REJECTED_ISSUE_SUBCOMMANDS` to enforce read-only; extend help text

## Worker relay
- [ ] `GET /agent-ops/issue/view?tracker=&id=` → session-scoped orchestrator route
- [ ] `GET /agent-ops/issue/list?tracker=&state=` → session-scoped orchestrator route

## Orchestrator
- [ ] `GET /api/sessions/:id/issue/view` — `getIssueForTracker`, reuse `resolveGitHubContext`
- [ ] `GET /api/sessions/:id/issue/list` — reuse `listIssuesForTracker`
- [ ] Service: `getIssueForTracker(credentialStore, trackerId, id, …)` → registry → `getIssue`

## Docs
- [ ] Document `shipit issue view/list` in `shipit-docs/` (tracker-neutral, read-only)
- [ ] Remove "ask the user to paste the issue" guidance; cross-link docs/176

## Tests
- [ ] Shared `parseIssueRef` round-trip (GitHub short/URL, Linear, unknown)
- [ ] Service: dispatch to both trackers, unconfigured-tracker error, 404 (missing / PR number)
- [ ] Integration: `shipit issue view` end-to-end against faked GitHub + Linear trackers

## Deferred (not v1)
- [ ] Cross-repo GitHub `--repo`
- [ ] Issue comments / timeline (interacts with docs/176)
- [ ] Issue write-back (create/edit/comment) — human-act gate
