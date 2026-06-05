# Checklist — Agent issue writes

Design only. Extends docs/175's read interface; depends on docs/176 (content the
agent reads before writing) and docs/172 (token isolation).

Settled: gating = do-then-surface + undo card; v1 scope = comment + edit + status
+ assignee; external MCP unchanged/unprescribed.

## Interface + adapters
- [ ] Add `addComment` / `updateIssue` / `setStatus` / `setAssignee` to `Tracker` (`trackers/tracker.ts`); `TrackerComment` type; optional `availableStatuses` on read types
- [ ] Linear: `commentCreate` / `issueUpdate` + state-by-type resolution + user resolution via `linearGraphql()`
- [ ] GitHub: `addComment` (`POST issues/:n/comments`), `updateIssue`/state/assignees (`PATCH issues/:n`) via `fetchGitHub()`

## Status + assignee mapping
- [ ] `setStatus` accepts normalized type OR native name; per-adapter mapping (GitHub open/closed, Linear state-by-type w/ default, Jira transitions later)
- [ ] Error-with-valid-options contract on unknown/ambiguous status
- [ ] `availableStatuses` exposed via read so the agent picks valid targets
- [ ] `setAssignee` identity resolution: `me`, login/email/display-name, `--none`; candidates on ambiguous match

## Service + routes
- [ ] `commentOnIssueForTracker` / `updateIssueForTracker` / `setIssueStatusForTracker` / `setIssueAssigneeForTracker` in `services/issues.ts`, each snapshotting prior state for undo
- [ ] `POST /api/sessions/:id/issue/{comment,edit,status,assign}`
- [ ] Worker relay `/agent-ops/issue/{comment,edit,status,assign}` (inject SESSION_ID)

## Shim
- [ ] `shipit issue comment/edit/status/assign`; remove these from `REJECTED_ISSUE_SUBCOMMANDS`; keep `create` rejected

## Do-then-surface card
- [ ] Provenance card via `emitChatCard` + `PersistedMessage` field; idempotent-by-id
- [ ] Capture undo data (comment id; prior title/body/status/assignee snapshot)
- [ ] Undo = reverse brokered write; rehydrate card + undo state on reload
- [ ] History round-trip + no-duplicate-on-replay tests

## Docs
- [ ] Point docs/175 "writes out of scope" here (done)
- [ ] Document `shipit issue comment/edit/status/assign` in `shipit-docs/`

## Tests
- [ ] Adapter write methods (Linear mutations, GitHub PATCH/POST) against fakes
- [ ] Status mapping: normalized-type + native-name + ambiguous-error per tracker
- [ ] Assignee resolution: me / name / not-found-candidates / unassign
- [ ] Card persistence, undo, no-duplicate-on-replay

## Deferred
- [ ] Jira adapter (transitions-based status) when the tracker lands
- [ ] Tracker-specific richness (projects/cycles/documents) — not via the interface
