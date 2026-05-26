---
status: planned
priority: high
description: Scope the PR status poll's GraphQL query to only sessions whose interval is due, so per-session cadence actually reduces GitHub API usage instead of just spacing identical 30-PR bulk queries.
---

# PR poll query scoping

## Problem

The per-session interval logic in `PrStatusPoller.perSessionInterval()` is a paper optimization. `repoInterval()` takes the **minimum** across all tracked sessions on a repo, and the GraphQL call fetches `repository.pullRequests(first: 30)` regardless of how many sessions are actually due. So on a repo with one CI-pending session and nineteen settled PRs, every 15 s tick still pulls all twenty PR nodes — same payload, same GraphQL points cost, same secondary-rate-limit pressure.

In production this manifests as GitHub rate-limiting ShipIt by the end of each hour (`shipit/github-update-strategy-gnl9-q` was opened to address this).

The cadence buckets (`PR_STATUS_POLL_INTERVAL_MS = 15_000`, `PR_STATUS_SLOW_INTERVAL_MS = 120_000`) and the rules that decide them (`perSessionInterval()` at `pr-status-poller.ts:245`) are correct. The query that consumes them is wrong.

## Goal

Make the GraphQL query payload proportional to the **number of sessions whose interval has elapsed this tick**, not the total open-PR count on the repo. One query per repo is still fine — but its body should alias in only the PRs we actually need to refresh now.

## Approach

### Phase 0 — Measure GraphQL cost before committing

**This phase gates Phases 2 and 3.** The aliased-per-PR rewrite is intuitive but unverified — GitHub's points model bills by node count plus connection multipliers, and `pullRequests(first: N)` may amortize its overhead in a way that beats N individual `pullRequest(number)` lookups, especially when the heavy nested fields (`statusCheckRollup.contexts(first: 100)`, `reviewThreads(first: 50)`, `commits(last: 1) { commit { ... } }`) dominate the per-PR cost. Those nested costs are paid per PR regardless of how the PR was selected, so the savings from "fewer top-level PRs" might be smaller than expected — or the bulk form might actually be cheaper per PR.

Measure before restructuring.

**Methodology:**

- GitHub exposes `rateLimit { cost limit remaining resetAt }` on every GraphQL query. The `cost` field is the authoritative per-call points charge. Include it in both query shapes.
- Run both shapes against the same repo state, back-to-back, to neutralize CI-state variance:
  1. **Bulk baseline (current):** `pullRequests(first: N)` with `PR_STATUS_QUERY` and `PR_STATUS_QUERY_WITH_CONVERSATION`, for N ∈ {1, 5, 10, 20, 30}.
  2. **Aliased candidate:** `pullRequest(number: $n)` aliased K ways, for K ∈ {1, 5, 10, 20, 30}, light and conversation variants.
  3. **Mixed:** aliased K=1 of conversation + K-1 of light in the same query (Phase 1 "scope conversation fields to focused session only" preview).
- Use the ShipIt repo itself or a real busy repo with ≥20 open PRs as the test target. A near-empty repo won't surface the divergence point.
- Capture results in `docs/155-pr-poll-query-scoping/cost-measurements.md` — keep the raw numbers in-repo so future tuning has a baseline.

**Tooling:** `scripts/measure-pr-poll-cost.ts` (wired as `npm run measure-pr-poll-cost`) issues each query shape against the GitHub GraphQL API and logs the authoritative `rateLimit.cost` value. Standalone — talks directly to `api.github.com/graphql` with a PAT, no orchestrator boot needed. Run:

```bash
GITHUB_TOKEN=ghp_xxx npm run measure-pr-poll-cost -- \
  --owner nicolasalt --repo shipit \
  --out docs/155-pr-poll-query-scoping/cost-measurements.md
```

The script fetches the first 30 open PR numbers from the target repo, then issues:

- Bulk `pullRequests(first: N)` for N ∈ {1, 5, 10, 20, 30}, light + heavy variants.
- Aliased `pullRequest(number: $n)` for K ∈ {1, 5, 10, 20, 30}, light + heavy + mixed (heavy on one alias, light on the rest — Phase 1's "scoped conversation fields" preview).

It writes the full results table to the `--out` path so the numbers stay in-repo as the baseline for future tuning. Doesn't need to be wired into CI — it's a measurement, not a regression test.

**Decision branches:**

- **Aliased is cheaper (expected case for K << N):** proceed with Phase 2/3 as designed.
- **Aliased and bulk are within ~10% per call:** Phase 2 still wins on tail behavior (a repo with 30 PRs but only 1 due polls cheaply at 15 s), but the per-call savings don't dominate. The motivation shifts from "lower steady-state cost" to "lower fast-tick burst cost." Phase 1 quick wins likely close most of the gap; reconsider whether Phase 2 is worth the structural change.
- **Bulk is cheaper across the board:** abandon Phase 2. The optimization is then "shrink the bulk query, don't restructure it" — keep `pullRequests(first: N)` but (a) tighten `first: N` to the tracked-session count, (b) scope conversation fields to the focused session via inline conditional selections or a fragment swap, (c) reduce the fast-cadence cohort by tightening `perSessionInterval()`'s rules (e.g., shorter `POST_PUSH_FAST_WINDOW_MS`, or back off to slow once a PR's checks resolve to pass/fail). Phase 3 (Discover PR) also drops — implicit discovery via the bulk view stays.

### 1. Cache PR number per session

`parsePrNode()` already extracts `prNumber` and we persist `PrStatusSummary` per session. Add a `sessionId → prNumber` map in the poller (or read from `lastKnown.get(sessionId)?.prNumber`) and rely on it for subsequent polls. First-ever observation still needs a branch lookup.

### 2. Replace the bulk query with an aliased per-PR query

Today (`pr-status-poller.ts:713`):

```graphql
repository(owner: $owner, name: $name) {
  pullRequests(states: [OPEN], first: 30, orderBy: { field: UPDATED_AT, direction: DESC }) {
    nodes { ...PrStatusFields }
  }
}
```

Becomes (built dynamically per tick):

```graphql
repository(owner: $owner, name: $name) {
  pr1: pullRequest(number: 42) { ...PrStatusFields }
  pr2: pullRequest(number: 99) { ...PrStatusFields }
  # … only sessions whose interval elapsed this tick
}
```

`PR_STATUS_QUERY` / `PR_STATUS_QUERY_WITH_CONVERSATION` (`pr-status-parser.ts`) become fragments composed into a dynamic query string.

### 3. Per-session due-time tracking in the supervisor

`lastPolledAt` is currently per-repo. Replace with per-session `lastPolledAt` (`sessionId → ts`). On each supervisor tick:

1. For each repo, gather sessions whose `now - lastPolledAt(sessionId) >= perSessionInterval(sessionId)`.
2. If the set is empty, skip the repo entirely (no GraphQL call).
3. Otherwise build the aliased query for that set and issue one call per repo.

The supervisor still ticks at the fast interval (15 s); the cadence per session controls inclusion in the query body, not the cadence of GraphQL calls per se.

### 4. First-time PR discovery for a session

When a session has no cached `prNumber` (newly tracked, or `lastKnown` was wiped), we need a one-shot branch → PR lookup before the aliased query can include it. Two options:

- **Cheap branch lookup** via `repository.pullRequests(headRefName: $b, first: 1)` aliased in alongside the per-number selections. One extra small alias per "unknown" session per tick.
- **REST fallback** via the existing `findPullRequestAnyState` used by `verifyMissingPr`.

Prefer the first; it stays inside the single GraphQL request and the alias drops away once `prNumber` is cached.

### 5. Replace implicit out-of-band discovery with an explicit "Discover PR" action

The current `pullRequests(first: 30)` bulk view implicitly catches PRs opened outside ShipIt for a tracked session's branch (e.g. user ran `gh pr create` from the terminal, or restored a session whose `lastKnown` was wiped without a known PR number). Scoping the query removes this implicit sweep.

In its place: add an explicit **Discover PR** entry to the auto-merge overflow menu (`OverflowMenu` in `PrLifecycleCard.tsx:363` / `:451`). Clicking it runs a branch lookup (`pullRequests(headRefName: $b, first: 1)` or REST equivalent) for that session and seeds the poller with the discovered PR number.

Surface rules:

- Visible only when the session has a tracked branch AND no `lastKnown` PR for it (i.e. no PR card is rendered yet for that session, **or** the card is in a state where re-discovery would be useful — TBD during implementation; the common case is "branch pushed, no PR card").
- For sessions with an active PR card this is a no-op and the menu entry is hidden.
- On success, broadcast a `pr_status` update with the new summary so the card appears immediately.

This keeps the behavior available without paying for it on every poll.

## Quick wins (optional, lower priority)

Cheap mitigations available **without** the restructure above. Useful if the full rewrite slips:

- **Cap `first: N` to actual tracked-session count.** Today it's hardcoded to `first: 30`. We know `sessionRepos` size per repo; pass `Math.max(N, minimumDiscoveryFloor)`. Bounds the worst case but doesn't eliminate the "1 active, 19 settled" payload.
- **Scope conversation fields to the focused session only.** `PR_STATUS_QUERY_WITH_CONVERSATION` (`pr-status-poller.ts:712`) currently pulls review threads + issue comments for **every** PR in the bulk view whenever **any** tracked session on the repo has its PR tab active. Restrict to the actually-focused `prTabActiveSessions` set; everyone else gets the light query fragment in the same call.

These can ship before the larger restructure and partially relieve the rate-limit pressure on multi-PR repos.

## Out of scope

- Webhooks. ShipIt remains polling-only by design (see `docs/064-pr-lifecycle-flow/plan.md`).
- Reducing the supervisor tick rate below 15 s. The fast cadence is correct; the query body is what needs to shrink.
- Changing `verifyMissingPr` REST verification. It already only runs per session, on absence, and is debounced via `verifiedAbsent`.

## Key files

- `src/server/orchestrator/pr-status-poller.ts` — supervisor loop, cadence, `pollRepo()`
- `src/server/orchestrator/pr-status-parser.ts` — GraphQL query strings + node parser; needs to expose fragments instead of full queries
- `src/server/orchestrator/api-routes-github.ts` — add the Discover PR HTTP endpoint (or a WS message)
- `src/client/components/PrLifecycleCard.tsx` — add Discover PR entry to the auto-merge `OverflowMenu` (lines 363, 451)
- `src/server/orchestrator/integration_tests/` — extend existing PR-poller tests for the scoped-query path
- `docs/064-pr-lifecycle-flow/plan.md` — cross-link once this lands

## Risks / open questions

- **GraphQL points cost is unverified.** See Phase 0 — the central assumption that aliased queries are cheaper than the bulk form needs measurement before Phase 2 is worth doing. Nested field cost (`statusCheckRollup.contexts`, `reviewThreads`) likely dominates per-PR and is paid identically in both shapes, so the savings may come entirely from "fetch fewer PRs" rather than "skip the bulk wrapper."
- **Behavior delta on session restart.** Today, after a process restart, `lastKnown` is empty for every session and the bulk poll re-discovers all PRs. With per-session `prNumber` we either persist the mapping (extend session metadata) or eat one branch-lookup alias per session on first tick. The latter is simpler.
- **PR closed → reopened.** If a closed PR for the same branch is reopened, the cached `prNumber` is still valid. Verify this matches GitHub's semantics (a reopened PR retains its number).
- **Stale PR number.** If a session's branch was force-pushed and a new PR was opened against the same branch, the old PR number could be stale. Rare, but the Discover PR button covers the recovery path.
