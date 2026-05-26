# Checklist — PR poll query scoping

## Phase 1 — quick wins (optional)

- [ ] Cap `pullRequests(first: N)` to `Math.max(trackedSessionCount, discoveryFloor)` in `pollRepo()`.
- [ ] Restrict conversation fields (review threads, issue comments) in `PR_STATUS_QUERY_WITH_CONVERSATION` to sessions in `prTabActiveSessions` only — other PRs in the same call use the light fragment.

## Phase 2 — scoped query

- [ ] Refactor `pr-status-parser.ts` to expose `PR_STATUS_FRAGMENT` / `PR_STATUS_FRAGMENT_WITH_CONVERSATION` instead of full queries.
- [ ] Add `sessionId → prNumber` cache (derive from `lastKnown` or persist on the session — pick one).
- [ ] Replace per-repo `lastPolledAt` with per-session `lastPolledAt`.
- [ ] Rewrite `supervisorTick()` to gather due sessions per repo and skip repos with an empty due-set.
- [ ] Rewrite `pollRepo()` to build a dynamic aliased query body for the supplied session set, including a branch-lookup alias for sessions without a cached PR number.
- [ ] Update `parsePrNode()` callsite to walk aliased response keys instead of `nodes[]`.
- [ ] Update PR-poller integration tests to assert query scoping (only due sessions appear in the call, settled sessions are skipped, brand-new sessions get a discovery alias on first tick).

## Phase 3 — Discover PR action

- [ ] Add server endpoint (HTTP) `POST /api/sessions/:id/pr/discover` that runs a branch → PR lookup, seeds the poller, and broadcasts `pr_status` if found.
- [ ] Add client hook + button binding.
- [ ] Add **Discover PR** menu entry to `OverflowMenu` in `PrLifecycleCard.tsx` (both `ReadyPhase` and `OpenPhase` instances). Show only when no PR is tracked for the session yet.
- [ ] Tests: integration test for the discover endpoint; component test for the menu visibility rule.

## Phase 4 — docs & cleanup

- [ ] Cross-link this plan from `docs/064-pr-lifecycle-flow/plan.md` under "Polling budget".
- [ ] Remove the `pullRequests(first: 30)` bulk-view code path from `pr-status-poller.ts` once the scoped query is in production.
- [ ] Update `src/server/shipit-docs/` if any agent-facing behavior changed (likely none — this is an internal optimization).
