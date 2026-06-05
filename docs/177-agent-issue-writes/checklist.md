# Checklist — Agent issue writes

Design only. Extends docs/175's read interface; depends on docs/176 (content the
agent reads before writing) and docs/172 (token isolation).

Settled: gating = do-then-surface + undo card; v1 scope = comment + edit + status
+ assignee; external MCP unchanged/unprescribed.

> **Implementation note (this PR).** docs/175's read path had not actually
> landed in code (only its design doc was committed), so this PR built that
> read foundation — shared `parseIssueRef`, `shipit issue view/list`, the
> `/agent-ops/issue/*` relay, the session-scoped read routes, and
> `getIssueForTracker` — and layered the writes on top.

## Interface + adapters
- [x] Add `addComment` / `deleteComment` / `updateIssue` / `setStatus` / `setAssignee` to `Tracker` (`trackers/tracker.ts`); `TrackerComment` type; optional `availableStatuses` + `assigneeId` on read types
- [x] Linear: `commentCreate` / `commentDelete` / `issueUpdate` + state-by-type resolution + user resolution via `linearGraphql()`
- [x] GitHub: `addComment` (`POST issues/:n/comments`), `deleteComment`, `updateIssue`/state/assignees (`PATCH issues/:n`) via the `fetchGitHub` header pattern in the adapter

## Status + assignee mapping
- [x] `setStatus` accepts normalized type OR native name; per-adapter mapping (GitHub open/closed, Linear state-by-type w/ earliest-position default, Jira transitions later)
- [x] Error-with-valid-options contract on unknown/ambiguous status (`TrackerResolutionError` → 422 listing options)
- [x] `availableStatuses` exposed via read so the agent picks valid targets
- [x] `setAssignee` identity resolution: `me`, login/email/display-name, `--none`; candidates on ambiguous match; `{ raw }` for undo replay

## Service + routes
- [x] `commentOnIssueForTracker` / `updateIssueForTracker` / `setIssueStatusForTracker` / `setIssueAssigneeForTracker` + `undoIssueWrite` in `services/issues.ts`, each snapshotting prior state for undo
- [x] `POST /api/sessions/:id/issue/{comment,edit,status,assign}` (emit + persist the card)
- [x] Worker relay `/agent-ops/issue/{comment,edit,status,assign}` (inject SESSION_ID)

## Shim
- [x] `shipit issue comment/edit/status/assign`; `REJECTED_ISSUE_SUBCOMMANDS` keeps `create` (and close/delete) rejected

## Do-then-surface card
- [x] Provenance card via `emitChatCard` + `PersistedMessage.issueWrite` field; idempotent-by-id
- [x] Capture undo data (comment id; prior title/body/status snapshot; prior assignee **internal id** from raw API response, not the display name)
- [x] Card attribution: do not claim per-user authorship for Linear writes (deployment-wide PAT) — attribute to agent / workspace PAT
- [x] Undo = reverse brokered write (`undo_issue_write` WS → `undoIssueWrite`); rehydrate card + undo state on reload
- [x] History round-trip + no-duplicate-on-replay tests

## Docs
- [x] Point docs/175 "writes out of scope" here (done)
- [x] Document `shipit issue comment/edit/status/assign` in `shipit-docs/issues.md`

## Tests
- [x] Adapter write methods (Linear mutations, GitHub PATCH/POST) against fakes
- [x] Status mapping: normalized-type + native-name + ambiguous-error per tracker
- [x] Assignee resolution: me / name / not-found-candidates / unassign
- [x] Card persistence, undo, no-duplicate-on-replay (chat-history + service + client store + shim)

## Deferred
- [ ] Jira adapter (transitions-based status) when the tracker lands
- [ ] Tracker-specific richness (projects/cycles/documents) — not via the interface
