# Checklist

Spec only so far — nothing implemented. Gate the build on the open questions in `plan.md`.

## Decisions to confirm first
- [ ] Loop-close mechanism: agent turn (`runner.dispatch`) vs. server-side frontmatter edit
- [ ] Auto-seed the issue body from the doc's `description` + first section, or leave a blank draft
- [ ] Confirm Linear-only (no GitHub-issue creation for design docs in v1)

## Server
- [ ] Add `createIssue` to the `Tracker` interface (`trackers/tracker.ts`)
- [ ] Linear adapter `issueCreate` mutation against the bound team (`trackers/linear/adapter.ts`)
- [ ] GitHub adapter `createIssue` → not-supported
- [ ] `createTrackingIssueForTracker()` service (`services/issues.ts`)
- [ ] `propose_tracking_issue` WS handler (emit consent card, refuse if Linear unconfigured)
- [ ] `submit_tracking_issue` WS handler (create + loop-close `runner.dispatch`)
- [ ] WS message types (`tracking_issue_card`, `tracking_issue_created`, `tracking_issue_failed`, `submit_/propose_`)

## Persistence
- [ ] `PersistedMessage.trackingIssue` field + `toRow`/`fromRow`
- [ ] `database.ts` migration (new column)
- [ ] `updateTrackingIssueCard` in-place patch for `created`/`failed`
- [ ] `loadSessionHistory` seeds the client store; idempotent-by-id append/upsert

## Client
- [ ] `TrackingIssueCard.tsx` consent card (editable title/body, team display, attribution note)
- [ ] Store wiring + rehydration

## Prompt / docs
- [ ] `agent-instructions.ts` — teach `propose_tracking_issue` for a no-issue doc
- [ ] Update the `CLAUDE.md` Docs-structure no-issue branch from manual round-trip to the card flow

## Tests
- [ ] Integration: propose → card persisted
- [ ] Integration: create only after explicit confirm
- [ ] Integration: loop-close dispatches a cross-link turn
- [ ] Integration: Linear-unconfigured → propose refused, no card
- [ ] History round-trip + no-duplicate-on-replay for the new card field
