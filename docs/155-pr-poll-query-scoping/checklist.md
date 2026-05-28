# Checklist — PR poll query scoping

## Phase 0 — measure GraphQL cost ✅ DONE

- [x] Write `scripts/measure-pr-poll-cost.ts` and wire it as `npm run measure-pr-poll-cost`.
- [x] Run against `nicolasalt/shipit` and capture results in `cost-measurements.md`.
- [x] Analyze and decide. **Outcome: bulk wins.** Phase 2/3 rejected; Phase 1 ships as the production fix.

## Phase 1 — Bulk query shrink (THE SHIPPING FIX)

### Phase 1a — Cap `first: N` to active session count

- [x] Change `buildPrStatusQuery()` in `pr-status-parser.ts` to take `first` as a parameter (drop the hardcoded 30).
- [x] In `pollRepo()`, compute `first = Math.min(30, Math.max(trackedSessionCount, DISCOVERY_FLOOR))` where `DISCOVERY_FLOOR = 5` (`computeBulkFirst` helper).
- [x] Helper to count non-merged tracked sessions per repo (inlined in `computeBulkFirst`).
- [x] Update `pr-status-poller.test.ts` to assert the passed `first:` matches the tracked-session count + floor (three tests covering floor / scale / cap).

### Phase 1b — Scope conversation fields to focused session only

- [x] Update `buildPrStatusQuery()` to accept `focusedPrNumbers: number[]` and emit top-level `focused${i}: pullRequest(number: N) { ...PR_LIGHT_FIELDS ...CONVERSATION_FIELDS }` aliases for each.
- [x] Drop conversation fields from the bulk `pullRequests(first: N)` node selection — it's always light.
- [x] Build `focusedPrNumbers` in `pollRepo()` from `prTabActiveSessions ∩ sessions-tracked-on-repo`, skipping sessions without a cached `prNumber` (`collectFocusedPrNumbers` helper).
- [x] Extend the response handler to walk `focused*` aliases after the bulk loop and patch conversation onto the matching session's `summary` (via `extractFocusedPrNodes` + per-session `focusedByPrNumber.get(bulkNode.number) ?? bulkNode`).
- [x] Preserve carry-forward logic for sessions whose PR tab lost focus mid-poll (the outer `if (!includeConversation)` gate is gone; the inner check applies on every poll).
- [x] Remove `repoHasActiveTab()` and the dual `PR_STATUS_QUERY` / `PR_STATUS_QUERY_WITH_CONVERSATION` constants.

### Phase 1c — Tests

- [x] `buildPrStatusQuery` test: bulk light without focused aliases; focused aliases append per PR number.
- [x] `extractFocusedPrNodes` test: maps aliases by PR number, ignores malformed values.
- [x] Poller test: focused alias emitted only when PR tab is active on a session with a cached `prNumber`.
- [x] Poller test: PR tab loses focus mid-cycle → cached `issueComments` / `reviewThreads` preserved on the next light poll.
- [x] Poller tests: `first: N` honors floor (5), scales with tracked count, caps at 30.

### Phase 1d — Verification

- [x] `npm run lint` clean, `npm run typecheck` clean, `npx vitest run pr-status-poller.test.ts` → 87/87 pass, `npm run test:dev` → 195/195 pass.
- [x] ~~Re-run `npm run measure-pr-poll-cost` post-merge~~ — redundant. The script issues GraphQL shapes directly against GitHub independent of the poller; the 2026-05-27 measurement already proved bulk light + focused-conversation alias = 1 pt. The production code path is verified to emit that exact shape by the Phase 1c unit tests above.

## Phase 2 — Aliased per-PR query ❌ REJECTED (Phase 0 outcome)

Not implemented. No measured cost advantage over Phase 1. Plan section retained for historical context only.

## Phase 3 — Discover PR action ❌ REJECTED (no longer needed)

Not implemented. Phase 1 keeps the bulk view (with `first: N` capped + `DISCOVERY_FLOOR`), so implicit cross-branch discovery remains intact. No user-facing escape hatch is needed.

## Phase 4 — docs & cleanup

- [x] Cross-link this plan from `docs/064-pr-lifecycle-flow/plan.md` under "Polling budget".
- [x] Set `status: done` in `plan.md` frontmatter once Phase 1 lands and verification confirms the cost reduction.
