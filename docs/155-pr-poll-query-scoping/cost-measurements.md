# PR poll cost measurements

Measured against `nicolasalt/shipit` on 2026-05-27T11:40:21.166Z. Source repo had 5 open PRs at measurement time (the aliased K range tops out here if smaller than 30).

The `cost` column is GitHub's authoritative `rateLimit.cost` value — the same number that's deducted from the 5,000-points/hour primary budget. `nodeCount` is GitHub's count of objects loaded; useful for sanity-checking that bulk vs. aliased are walking comparable amounts of data.

| Shape | N (PRs in query) | Variant | Cost | nodeCount | PRs returned | Notes |
|---|---:|---|---:|---:|---:|---|
| bulk | 1 | light | 1 | 115 | 1 |  |
| bulk | 1 | heavy | 1 | 1675 | 1 |  |
| bulk | 5 | light | 1 | 575 | 5 |  |
| bulk | 5 | heavy | 2 | 8375 | 5 |  |
| bulk | 10 | light | 1 | 1150 | 5 |  |
| bulk | 10 | heavy | 4 | 16750 | 5 |  |
| bulk | 20 | light | 1 | 2300 | 5 |  |
| bulk | 20 | heavy | 7 | 33500 | 5 |  |
| bulk | 30 | light | 1 | 3450 | 5 |  |
| bulk | 30 | heavy | 11 | 50250 | 5 |  |
| aliased | 1 | light | 1 | 114 |  |  |
| aliased | 1 | heavy | 1 | 1674 |  |  |
| aliased | 5 | light | 1 | 570 |  |  |
| aliased | 5 | heavy | 2 | 8370 |  |  |
| aliased | 5 | mixed | 1 | 2130 |  |  |

## Analysis

Three findings that flip the recommended path:

**1. The bulk wrapper is free for light polls.** `pullRequests(first: N)` light cost is flat at 1 for every N ∈ {1, 5, 10, 20, 30}. GitHub does not charge incrementally for the connection wrapper when no nested heavy connections are pulled. The aliased rewrite at K=5 light also costs 1 — identical to bulk. **Phase 2's aliased restructure saves nothing on light polls.**

**2. Heavy cost scales with the requested `first: N`, not actual returned count.** Bulk heavy at N=30 with only 5 PRs actually present still costs 11 points — the same as it would on a real 30-PR repo. The cost growth (1, 2, 4, 7, 11 for N = 1, 5, 10, 20, 30) is driven by the conversation-field multipliers (`comments(last: 30)`, `reviewThreads(first: 30)`, nested `comments(first: 50)`) being amortized over the connection limit, not over actual node count. **This is exactly where today's rate-limit pain comes from**, and it's fixable inside the bulk shape.

**3. Aliased K=1 heavy = 1 point. Bulk N=5 heavy + mixed conversation = 1 point.** The Phase 2 aliased rewrite gets the per-call cost to its minimum, but so does combining the two Phase 1 quick wins. There is no headroom below 1 point per call. **Phase 2's structural complexity buys nothing the bulk shape can't already match.**

### Cost reduction path (today → target)

| Scenario | Cost | Reduction from today |
|---|---:|---|
| Today's worst call: bulk N=30 heavy (any session on the repo has the PR tab active) | 11 | — |
| Phase 1a — cap `first: N` to active-session count (~5): bulk N=5 heavy | 2 | 5.5× |
| Phase 1a + 1b — also scope conversation to focused session: bulk N=5 mixed | 1 | 11× |
| Phase 2 hypothetical — aliased K=1 heavy (no Phase 1) | 1 | 11× |

Phase 1a alone is achievable with a one-line change (pass `tracked-session count` into the query builder instead of hardcoded 30). Phase 1b is a small fragment-swap in `pr-status-parser.ts` so only the focused session's PR node gets the conversation block.

### Rate-limit math against the 5,000 pts/hr primary budget

Assume a user with 3 active repos, each with the PR tab open on one session, 15 s fast cadence (worst case — all repos held at fast by post-push or auto-fix).

- **Today (cost 11/call):** 3 repos × 240 calls/hr × 11 = **7,920 pts/hr** — over budget. Matches the observed "rate-limited by end of hour" pain.
- **After Phase 1a + 1b (cost 1/call):** 3 repos × 240 calls/hr × 1 = **720 pts/hr** — 14% of budget. Comfortable.

### Recommended decision

**Bulk wins.** Per the plan's Phase 0 decision branches, this maps to "Bulk is cheaper across the board → abandon Phase 2, shrink the bulk query instead."

- **Phase 1 ships as the production fix.** Both quick wins are needed (cap N, scope conversation); each alone is a partial improvement.
- **Phase 2 (aliased rewrite) — rejected.** No measured points win over Phase 1, and the structural cost is high (parser refactor, per-session `lastPolledAt`, dynamic query builder, response-shape changes throughout the parser).
- **Phase 3 (Discover PR menu) — deferred / no longer needed.** The bulk view's implicit cross-branch discovery stays intact under Phase 1, so the user-facing escape hatch isn't needed yet. If a future change does narrow the bulk view past `headRefName` discovery, revisit then.

### Caveats

- Measurement was on a 5-PR repo; bulk-heavy cost is driven by the `first: N` multiplier (not actual returned PR count), so the conclusion generalizes. If a future repo legitimately has 30+ PRs that ShipIt actively polls, Phase 1a's session-count cap automatically scales the saving with it.
- We did not measure secondary rate limits (concurrent requests, points-per-minute). The hourly 5,000-pt budget analysis above is the most likely binding constraint given the observed "end of hour" failure pattern, but if Phase 1 ships and rate-limiting persists, instrument the secondary limit headers and revisit.
