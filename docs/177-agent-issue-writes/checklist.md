# Checklist — Agent issue writes

Design only. Extends docs/175's read interface; depends on docs/176 (content the
agent reads before writing) and docs/172 (token isolation).

Settled: gating = do-then-surface + undo card; v1 scope = comment + edit + status
+ assignee; external MCP unchanged/unprescribed.

> **Implementation note (this PR).** docs/175's read path landed independently
> on `main` (shared `parseIssueRef`, `shipit issue view/list`, the
> `/agent-ops/issue/{view,list}` relay, the session-scoped read routes, and
> `getIssueForTracker`). This PR was rebased onto it and adds only the writes —
> reusing `getIssue` (undo snapshots) and `parseIssueRef` (pointer resolution).

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
- [x] Write idempotency across crash/retry (planning#114): replayed identical write performs the tracker write + card exactly once; distinct write still gets its own (`agent-issue-write-idempotency.test.ts`)

## Labels + priority on create/edit (planning#94)
- [x] `Tracker.createIssue`/`updateIssue` accept `labels?`/`priority?`; `TrackerResolutionError.kind` adds `label`/`priority`; `TrackerIssue.labels?`
- [x] Linear: `resolveLabelIds` (via `issueLabels`) → `labelIds`; `resolveLinearPriority` (normalized/native → numeric); labels on the read fields
- [x] GitHub: `resolveLabels` validates against `GET .../labels` (reject unknown + candidates); `--priority` rejected (no native field); labels on read
- [x] Service: `createIssueForTracker` opts `{labels,priority}`; `updateIssueForTracker` additive label merge + `previousLabels`/`previousPriority` snapshot; `undoIssueWrite` edit restores them; summary reflects attrs
- [x] Routes + relay carry `labels`/`priority`; write response returns resolved `labels`/`priority` for `--json`
- [x] Shim: `parseFlags` gains `arrays` (repeatable); `--label`/`--priority` on `create`+`edit`; GitHub-priority + invalid-priority rejection; help text
- [x] Docs: `shipit-docs/issues.md` Labels + Priority sections; per-tracker priority behavior documented
- [x] Tests: adapter (label resolution, priority mapping, rejections), service (additive edit, undo, gh-priority 422), shim (flag parsing, gh-priority reject, --json), chat-history round-trip

## comment edit (planning#88)
See plan.md → *Extension — `comment edit`*. Wanted by docs/247's migration, which
replays 1,344 comments — the one thing it writes that could not be corrected after.
- [x] `Tracker.updateComment(issueId, commentId, body)` → `{ comment, previousBody }`; `TrackerPermissionError` (refusal ≠ resolution failure → 403)
- [x] GitHub: `GET issues/comments/:id` (author + `issue_url` + prior body) → `PATCH issues/comments/:id`; a 404 reads as "no such comment", not "unreachable repo"
- [x] Linear: one `CommentOwner` query (`viewer` + comment + issue + team) → `commentUpdate`; team guard on the issue leg via `resolveUuid`
- [x] Guards, all server-side so a direct relay POST can't bypass them: comment belongs to the named issue; author is the identity ShipIt writes as; Linear team ownership
- [x] `editCommentForTracker` + `undoIssueWrite` `comment-edit` case (restores the previous body)
- [x] `POST /api/sessions/:id/issue/comment/edit` + worker relay `/agent-ops/issue/comment/edit`
- [x] Dedup key: the comment id rides in the HASHED CONTENT (`{commentId, body}`), not the `issueId` slot — two edits to different comments on one issue must not collapse
- [x] Shim `shipit issue comment edit <ref> --comment <id> -b BODY`; `comment delete` rejected with a pointer at edit
- [x] Card: new `comment-edit` verb + icon + line 2 (the NEW body); `anchorCommentId` threads through
- [x] Docs: `shipit-docs/issues.md` (incl. the own-authorship rule and no-delete), plan.md, this checklist
- [x] Tests: adapters (both kinds, all three guards), service (undo restores the body, 403 on someone else's), shim (flags, `--json`, refusal surfaced), relay, chat-history round-trip, replay + distinct-comment idempotency, client card

## Proposed — comment delete
Still out of scope; see plan.md → *Proposed — deleting a comment*. `comment edit`
now shows the shape a guard would take, but the undo asymmetry is undecided.
- [ ] `comment delete` — adapters already have `deleteComment`, reachable today only via a card's Undo. Needs an authorship guard: the id is backend-global, so an unguarded command could delete human discussion the agent never wrote.
- [ ] Decide how a delete's card presents undo, given that re-posting mints a new id, author and timestamp rather than restoring the original.

## label edit (planning#88)
See plan.md → *Extension — `label edit`*. `label create` was the only label verb
and refuses a name that already exists in any casing, so a label minted with the
wrong color or casing was permanently wrong through ShipIt — docs/247 hit that
with `Feature`, `priority: high` and `Bug`/`bug`, on 147 issues.

- [x] **Rename is in scope** — both backends rename IN PLACE (`new_name` / `issueLabelUpdate`), so no issue is re-labeled and the undo is exactly symmetric; the `Bug`/`bug` casing collision has no other fix. Guarded: a rename onto a *different* existing label is a 409 (no merging), a casing-only rename is not a collision, a no-op edit is a 409.
- [x] **`label create` keeps failing on an existing name** — not update-if-different: `--create-missing-labels` feeds it from `--label` typos, so a create must never repaint a live label. The 409 now names `label edit` instead of dead-ending.
- [x] `Tracker.findLabel` (case-insensitive, carries id + description) + `Tracker.updateLabel`; Linear re-reads the label's team and refuses another team's (`assertOwnTeam`, server-side so a direct relay POST can't bypass it)
- [x] `updateLabelForTracker` + `undoIssueWrite` `label-edit` case (restores only the fields the write changed; `labelId` is the id AFTER the write, since on GitHub the name IS the id)
- [x] `POST /api/sessions/:id/issue/label/edit` + relay `/agent-ops/issue/label/edit`; `handleLabelWrite` shares the runner/dedup/card path with `label create`
- [x] Dedup key: the `issueId` slot names THE LABEL being edited (empty for a create, whose name rides in the hashed content) — two edits to different labels must not collapse
- [x] Shim `shipit issue label edit --name NAME [--new-name] [--color] [--description]`; `--tracker` required (req 13); `label delete` refused with the reason + a pointer at edit
- [x] Card: `label-edit` verb + outline tag icon + line 2 (rename delta / recolor), non-navigable like the creation card
- [x] Docs: `shipit-docs/issues.md` (Editing a label + the no-delete rationale), plan.md, this checklist
- [x] Tests: adapters (both kinds, team guard), service (undo restores color/name, 404/409s), shim (flags, `--json`, delete refusal), integration (card persistence, replay dedup, distinct-label non-collapse, undo), chat-history round-trip, client card

## Proposed — label delete
Still out of scope; see plan.md → *Proposed — deleting a label*. Undo would mint
a fresh label that no issue carries, so it would restore the name and lose every
association — a button that lies. Both trackers delete labels from their own UI
with a warning naming how many issues it strips it from, which is the honest
place for a one-way act (§3, not a gap).
- [ ] Revisit only if someone can answer what its undo means.

## Deferred
- [ ] Jira adapter (transitions-based status) when the tracker lands
- [ ] Tracker-specific richness (projects/cycles/documents) — not via the interface
- [ ] GitHub `priority:<value>` label mapping (planning#94 option b) — deferred; `--priority` rejects on GitHub for now
