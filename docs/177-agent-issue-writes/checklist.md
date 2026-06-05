# Checklist — Agent issue writes

Design only. Extends docs/175's read interface; depends on docs/176 (content the
agent reads before writing) and docs/172 (token isolation).

## Interface + adapters
- [ ] Add `addComment` / `updateIssue` to `Tracker` (`trackers/tracker.ts`); `TrackerComment` type
- [ ] Linear: `commentCreate` / `issueUpdate` mutations via existing `linearGraphql()`
- [ ] GitHub: `addComment` (`POST issues/:n/comments`) + `updateIssue` (`PATCH issues/:n`) via `fetchGitHub()`

## Service + routes
- [ ] `commentOnIssueForTracker` / `updateIssueForTracker` in `services/issues.ts`
- [ ] `POST /api/sessions/:id/issue/comment` and `/issue/edit`
- [ ] Worker relay `/agent-ops/issue/comment` + `/issue/edit` (inject SESSION_ID)

## Shim
- [ ] `shipit issue comment <pointer> -b <body>` and `shipit issue edit <pointer> [--title][--body]`
- [ ] Remove these verbs from `REJECTED_ISSUE_SUBCOMMANDS`; keep `create` rejected

## Outward-action handling
- [ ] Provenance card ("agent commented on …") via `emitChatCard` + `PersistedMessage` field
- [ ] Idempotent-by-id append (no double render on reconnect/reload) + history round-trip test
- [ ] Decide confirmation model (do-then-surface + undo vs first-write confirm)

## Docs
- [ ] Update docs/175 "writes out of scope" to point here
- [ ] Document `shipit issue comment`/`edit` in `shipit-docs/`

## Tests
- [ ] Adapter write methods (Linear mutation, GitHub PATCH/POST) against fakes
- [ ] Service dispatch + unconfigured/permission-error handling
- [ ] Card persistence + no-duplicate-on-replay

## Deferred (near-term, separate)
- [ ] `status` / `assignee` writes (cross-tracker state-model mapping)
- [ ] MCP escape hatch for tracker-specific richness (projects/cycles/documents)
