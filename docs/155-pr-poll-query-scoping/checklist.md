# Checklist — PR poll query scoping

## Phase 0 — measure GraphQL cost ✅ DONE

- [x] Write `scripts/measure-pr-poll-cost.ts` and wire it as `npm run measure-pr-poll-cost`.
- [x] Run against `nicolasalt/shipit` and capture results in `cost-measurements.md`.
- [x] Analyze and decide. **Outcome: bulk wins.** Phase 2/3 rejected; Phase 1 ships as the production fix.

## Phase 1 — Bulk query shrink (THE SHIPPING FIX)

### Phase 1a — Cap `first: N` to active session count

- [ ] Change `buildPrStatusQuery()` in `pr-status-parser.ts:78` to take `first` as a parameter (drop the hardcoded 30).
- [ ] In `pollRepo()` (`pr-status-poller.ts:680`), compute `first = Math.min(30, Math.max(trackedSessionCount, DISCOVERY_FLOOR))` where `DISCOVERY_FLOOR = 5`.
- [ ] Helper to count non-merged tracked sessions per repo (or read off `sessionRepos`).
- [ ] Update `pr-status-poller.test.ts` to assert the passed `first:` matches the tracked-session count + floor.

### Phase 1b — Scope conversation fields to focused session only

- [ ] Update `buildPrStatusQuery()` to accept `focusedPrNumbers: number[]` and emit top-level `focused0: pullRequest(number: $n) { ...PrLightFields ...PrConversationFields }` aliases for each.
- [ ] Drop conversation fields from the bulk `pullRequests(first: N)` node selection — it's always light.
- [ ] Build `focusedPrNumbers` in `pollRepo()` from `prTabActiveSessions ∩ sessions-tracked-on-repo`, skipping sessions without a cached `prNumber`.
- [ ] Extend the response handler to walk `focused*` aliases after the bulk loop and patch `issueComments` / `reviewThreads` onto the matching session's `summary`.
- [ ] Preserve the existing carry-forward logic (`pr-status-poller.ts:809`) for sessions whose PR tab lost focus mid-poll.
- [ ] Remove `repoHasActiveTab()` and the dual `PR_STATUS_QUERY` / `PR_STATUS_QUERY_WITH_CONVERSATION` constants — they collapse into one parameterized builder.

### Phase 1c — Tests

- [ ] `pr-status-parser.test.ts`: assert `buildPrStatusQuery({ first: 5, focusedPrNumbers: [42] })` produces a query with `pullRequests(first: 5)` light + one `focused0: pullRequest(number: 42)` heavy alias.
- [ ] `pr-status-parser.test.ts`: snapshot the light-only query (no focused PRs) to lock the shape.
- [ ] `pr-status-poller.test.ts`: a session with PR tab active gets conversation data on the next poll; a session without it doesn't.
- [ ] `pr-status-poller.test.ts`: a focused session whose PR tab closes mid-poll still has its previous conversation data preserved (no flicker).
- [ ] `pr-status-poller.test.ts`: bulk-view discovery still works (a PR opened out-of-band on a tracked branch is picked up within the `DISCOVERY_FLOOR`).

### Phase 1d — Verification

- [ ] Re-run `npm run measure-pr-poll-cost` after landing, confirm cost dropped to expected 1–2 pts on the heavy path.
- [ ] Run `npm run lint` + `npm run typecheck` + `npm run test:dev` (poller-related files) before opening for review.

## Phase 2 — Aliased per-PR query ❌ REJECTED (Phase 0 outcome)

Not implemented. No measured cost advantage over Phase 1. Plan section retained for historical context only.

## Phase 3 — Discover PR action ❌ REJECTED (no longer needed)

Not implemented. Phase 1 keeps the bulk view (with `first: N` capped + `DISCOVERY_FLOOR`), so implicit cross-branch discovery remains intact. No user-facing escape hatch is needed.

## Phase 4 — docs & cleanup

- [ ] Cross-link this plan from `docs/064-pr-lifecycle-flow/plan.md` under "Polling budget".
- [ ] Set `status: done` in `plan.md` frontmatter once Phase 1 lands and verification confirms the cost reduction.
