# Checklist — Agent issue access

v1 landed: a tracker-neutral, read-only slice over the existing tracker registry.
Injection hardening is tracked separately in docs/176; issue writes in docs/177.

## Shared
- [x] Move `parseIssueRef` from `src/client/utils/issue-ref.ts` to `src/server/shared/issue-ref.ts`; update client import
- [x] Extend `parseIssueRef`: recognize bare Linear key `[A-Za-z]+-\d+` (not just the full URL)
- [x] Extend `parseIssueRef`: surface tracker-native `issueId` (GitHub bare number, Linear key) for `getIssue`

## Shim
- [x] Add `issue` top-level subcommand to `agent-shim/shipit.ts` with `view`/`list` handlers
- [x] `shipit issue view <pointer> [--json]` — resolve tracker via `parseIssueRef`, `--tracker` override
- [x] `shipit issue list [--tracker …] [--state …] [--json]`
- [x] `REJECTED_ISSUE_SUBCOMMANDS` to enforce read-only; extend help text

## Worker relay
- [x] `GET /agent-ops/issue/view?tracker=&id=` → session-scoped orchestrator route
- [x] `GET /agent-ops/issue/list?tracker=&state=` → session-scoped orchestrator route

## Orchestrator
- [x] `GET /api/sessions/:id/issue/view` — `getIssueForTracker`, reuse `resolveGitHubContext`
- [x] `GET /api/sessions/:id/issue/list` — reuse `listIssuesForTracker`
- [x] Service: `getIssueForTracker(credentialStore, trackerId, id, …)` → registry → `getIssue`

## Docs
- [x] Document `shipit issue view/list` in `shipit-docs/` (tracker-neutral, read-only) — new `issues.md`
- [x] Remove "ask the user to paste the issue" guidance; cross-link docs/176 (untrusted-content note in `issues.md`); keep `gh issue` blocked in `github.md` and point at `shipit issue`

## Tests
- [x] Shared `parseIssueRef` round-trip (GitHub short/URL, bare Linear key, unknown)
- [x] Service: dispatch to both trackers, unconfigured-tracker error, 404 (missing / PR number)
- [x] Integration: `shipit issue view` end-to-end against faked GitHub + Linear trackers
- [x] Shim unit tests (`view`/`list`, `--json`, `--tracker`/`--state`, read-only rejection)
- [x] Worker relay tests (`/agent-ops/issue/view|list` forwarding)

## Deferred (not v1)
- [ ] Cross-repo GitHub `--repo`
- [ ] Issue comments / timeline (interacts with docs/176)
- [ ] Issue write-back (create/edit/comment) — human-act gate (docs/177)
