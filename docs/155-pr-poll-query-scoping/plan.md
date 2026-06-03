---
description: Shrink the PR status poll's GraphQL query so per-session cadence actually reduces GitHub API usage. Phase 0 cost measurement (2026-05-27) ruled out the aliased-per-PR rewrite — bulk shape with capped `first: N` and per-session conversation scoping gets the full win.
---

# PR poll query scoping

> **Status update (2026-05-27):** Phase 0 measurement is complete. The aliased-per-PR restructure (Phase 2) and the Discover PR escape hatch (Phase 3) are rejected — they don't measurably outperform the bulk shape once Phase 1's two quick wins are in place. Phase 1 ships as the production fix. See [`cost-measurements.md`](./cost-measurements.md) for the data and analysis.

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

**Outcome (measured 2026-05-27): "Bulk is cheaper across the board" branch selected.** The bulk wrapper costs 0 extra points for light polls (flat cost = 1 from N=1 to N=30) and heavy cost scales with the requested `first: N` rather than actual returned count. Phase 2's aliased K=1 heavy and the combination of Phase 1's two quick wins both bottom out at 1 point per call — no measurable advantage to restructuring. Phase 1 ships; Phase 2 and Phase 3 are rejected. See [`cost-measurements.md`](./cost-measurements.md) "Analysis" section for the table and rate-limit math.

### Phase 1 — Bulk query shrink (THE SHIPPING FIX)

After Phase 0 measurement, this is the entire production fix. Two small changes inside the existing bulk query shape get per-call cost from **11 → 1 point** on the worst-case PR-tab-active call.

#### Phase 1a — Cap `first: N` to active session count

`pr-status-poller.ts:713` issues `pullRequests(first: 30, ...)` unconditionally. Replace 30 with the count of tracked, non-merged sessions on the repo, plus a small discovery floor for branches whose PR was opened out-of-band:

```ts
const trackedCount = this.countTrackedSessions(repoKey); // already derivable from sessionRepos
const DISCOVERY_FLOOR = 5; // see below
const first = Math.min(30, Math.max(trackedCount, DISCOVERY_FLOOR));
```

The hard cap of 30 stays — the existing `verifyMissingPr` REST fallback still handles sessions past the pagination cap, so the upper bound is purely cost-control.

The `DISCOVERY_FLOOR` covers two cases the bulk view legitimately needs to see beyond tracked sessions: (i) a PR opened out-of-band on a tracked branch (e.g. user ran `gh pr create` in the terminal) before that session's first poll, and (ii) ShipIt restart where `lastKnown` is empty and we want the bulk view to repopulate every tracked session's PR in the first call. 5 is a guess — tune after observing real workloads.

`buildPrStatusQuery()` (`pr-status-parser.ts:78`) takes `first` as a parameter instead of hardcoding it. The two cached query constants (`PR_STATUS_QUERY`, `PR_STATUS_QUERY_WITH_CONVERSATION`) become builder functions or get cached by `first` value.

Expected savings on heavy polls: bulk N=30 (11 pts) → bulk N=5 (2 pts). **5.5× reduction.**

#### Phase 1b — Scope conversation fields to focused session only

Today, `repoHasActiveTab(repoKey)` (`pr-status-poller.ts:712`) returns true if **any** tracked session on the repo has its PR tab active, and the heavy `PR_STATUS_QUERY_WITH_CONVERSATION` is then sent for **every** PR in the bulk view. That over-fetches conversation data for every other PR on the repo.

The cost-measurement script's "mixed" variant proves the fix is cheap: aliased K=5 with one heavy + four light costs the same as K=5 all-light (1 point), saving 1 point vs. K=5 all-heavy (2 points). The same shape works inside the bulk query — GraphQL allows per-node `... on PullRequest` selections, but a simpler approach is to keep two top-level fields in the same query:

```graphql
query($owner: String!, $name: String!) {
  repository(owner: $owner, name: $name) {
    # Light fields for the full visible window
    pullRequests(first: ${first}, states: [OPEN]) {
      nodes { ...PrLightFields }
    }
    # Heavy fields for the focused PR(s) only, by number
    focused0: pullRequest(number: $focused0) { ...PrLightFields ...PrConversationFields }
    # repeat for each session whose PR tab is currently active
  }
}
```

The poller already maintains `prTabActiveSessions` (`pr-status-poller.ts:108`) and `lastKnown` carries the focused session's `prNumber`. Build the focused-PR alias list from `prTabActiveSessions ∩ sessions-tracked-on-this-repo`. Skip the alias when a session in that set doesn't have a cached `prNumber` yet — the next poll picks it up via the bulk view, then subsequent polls upgrade to conversation.

Response handling: `parsePrNode()` already accepts a single PR node. The poller iterates the bulk `nodes[]` first (light data for all visible PRs), then walks the `focused*` aliases and patches the conversation fields onto the matching session's summary.

Expected savings on heavy polls (when at least one PR tab is active): bulk N=5 all-heavy (2 pts) → bulk N=5 light + 1 focused alias (1 pt). **2× reduction on top of Phase 1a.** Combined with Phase 1a: **11× reduction from today.**

#### Phase 1c — Test coverage

- `pr-status-poller.test.ts`: assert that `pollRepo()` issues `first: N` matching the tracked-session count (within the floor + cap).
- `pr-status-poller.test.ts`: assert that conversation fields are pulled only for sessions in `prTabActiveSessions`, not the whole bulk view.
- `pr-status-parser.test.ts`: assert `buildPrStatusQuery({ first, focusedPrNumbers })` emits the correct shape.

#### Phase 1d — Discovery correctness fix (steady-state "no PR" regression)

**Status update (2026-06-03):** Phase 1 shipped a latent discovery bug. The plan's premise — *"If a session's PR is past the `first: N` cap it gets a per-session REST verify instead (see `verifyMissingPr`)"* — was false in the deployed code. `verifyMissingPr`'s `open` branch only recovers a stuck `merged`/`closed` `lastKnown`; when `lastKnown` is `undefined` it returns without building a summary, and the `verifiedAbsent` debounce then suppresses re-verification. So a tracked session's open PR that fell outside the bulk window showed **"no PR" persistently**, and re-activation (`forceRefreshSession`) re-ran the same capped query + the same no-op verify.

Two composing facts made the window miss tracked PRs on a busy repo:

1. **The bulk connection lost its `orderBy`.** The pre-Phase-1 query ordered `pullRequests` by `UPDATED_AT DESC` (see the historical Phase 2 snippet below). The Phase 1 rewrite of `buildPrStatusQuery` dropped it, so the `first: N` window fell back to GitHub's default (roughly oldest-open-first) — exactly the PRs a user is *not* working on.
2. **The window collapsed toward the floor.** `computeBulkFirst` sizes `first` to `max(trackedCount, DISCOVERY_FLOOR)`. As sessions merge, `trackedCount` drops toward 5 while the repo still has 30+ open PRs — window smaller than the open-PR set, holding the wrong PRs.

**Fix — keep tracked PRs IN the bulk view, in discovery (not in `verifyMissingPr`):**

- **Restore `orderBy: { field: UPDATED_AT, direction: DESC }`** on the bulk `pullRequests` connection in `buildPrStatusQuery`. Biases the `first: N` window toward recently-active PRs (the session PRs). Zero points cost.
- **Light coverage aliases.** `collectCoveragePrNumbers(repoKey)` returns the last-known PR number for every tracked, non-merged session; `buildPrStatusQuery` emits a `coverage${i}: pullRequest(number: N)` alias (light fields only) for each, deduped against the conversation-carrying `focused${i}` aliases. `pollRepo` folds these alias nodes into the branch-match map so a known PR can never be windowed out. **Cost-respecting:** the cost-measurements show light aliased lookups stay at ~1 point regardless of K (only the heavy conversation fields scale), so coverage is effectively free; conversation stays scoped to the focused PR.
- **Merged/closed detection preserved.** Coverage aliases fetch by number regardless of state, but `parsePrNode` always reports `prState: "open"`. So `pollRepo` only folds an alias node into the branch map when `node.state === "OPEN"`; a known PR that has since merged/closed is left absent from the map and routes through `verifyMissingPr`, which still owns terminal-state promotion.

This is complementary to PR #1007 (`shipit/refresh-pr-status-on-session-40kxk4`), which addresses the ~1–2 min GitHub creation-lag case by surfacing open PRs from the REST verify path. #1007 = creation-lag verify surfacing; this = steady-state bulk discovery. They touch different paths (REST `verifyMissingPr` vs. the GraphQL discovery query) and do not conflict.

### ~~Phase 2 — Aliased per-PR query~~ [REJECTED — see Phase 0 outcome]

The remaining subsections (PR-number caching, per-session `lastPolledAt`, dynamic aliased queries, discovery aliases) are preserved below as historical context but are NOT implemented. They produce identical points cost to Phase 1 while requiring substantial structural changes (parser refactor, response-shape changes, per-session due-time tracking). Phase 1 is the fix.

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

### 5. ~~Replace implicit out-of-band discovery with an explicit "Discover PR" action~~ [REJECTED — see Phase 0 outcome]

Phase 1 keeps the bulk view (with `first: N` capped to tracked-session count plus a `DISCOVERY_FLOOR` of 5), so implicit cross-branch discovery remains intact. No user-facing escape hatch is needed. The original design is preserved below for historical context.

The current `pullRequests(first: 30)` bulk view implicitly catches PRs opened outside ShipIt for a tracked session's branch (e.g. user ran `gh pr create` from the terminal, or restored a session whose `lastKnown` was wiped without a known PR number). Scoping the query removes this implicit sweep.

In its place: add an explicit **Discover PR** entry to the auto-merge overflow menu (`OverflowMenu` in `PrLifecycleCard.tsx:363` / `:451`). Clicking it runs a branch lookup (`pullRequests(headRefName: $b, first: 1)` or REST equivalent) for that session and seeds the poller with the discovered PR number.

Surface rules:

- Visible only when the session has a tracked branch AND no `lastKnown` PR for it (i.e. no PR card is rendered yet for that session, **or** the card is in a state where re-discovery would be useful — TBD during implementation; the common case is "branch pushed, no PR card").
- For sessions with an active PR card this is a no-op and the menu entry is hidden.
- On success, broadcast a `pr_status` update with the new summary so the card appears immediately.

This keeps the behavior available without paying for it on every poll.

## Out of scope

- Webhooks. ShipIt remains polling-only by design (see `docs/064-pr-lifecycle-flow/plan.md`).
- Reducing the supervisor tick rate below 15 s. The fast cadence is correct; the query body is what needs to shrink.
- Changing `verifyMissingPr` REST verification. It already only runs per session, on absence, and is debounced via `verifiedAbsent`.

## Key files (Phase 1)

- `src/server/orchestrator/pr-status-poller.ts` — `pollRepo()` at line 680; passes `first: N` and the focused-session list into the query builder.
- `src/server/orchestrator/pr-status-parser.ts` — `buildPrStatusQuery()` at line 78 takes `first` + `focusedPrNumbers[]`; response parsing walks both the bulk `nodes[]` and the `focused*` aliases.
- `src/server/orchestrator/pr-status-poller.test.ts` and `pr-status-parser.test.ts` — coverage for the two new behaviors.
- `docs/064-pr-lifecycle-flow/plan.md` — cross-link once this lands.

## Risks / open questions (Phase 1)

- **`DISCOVERY_FLOOR` tuning.** 5 is a guess based on the worst case "a few tracked sessions + a few out-of-band PRs on the same repo." On a busy repo with many simultaneous PRs not tracked by ShipIt, a smaller floor over-relies on the `verifyMissingPr` REST fallback (cheap per-PR but more requests). Worth re-checking after a week in production.
- **Secondary rate limits.** Phase 1 brings primary-budget cost from 7,920 → 720 pts/hr in the modeled scenario, comfortably under 5,000. If users still see rate-limiting after Phase 1 ships, the cause is the secondary limits (concurrent requests, points-per-minute), and the fix is request frequency, not request shape. Instrument the GitHub response headers (`x-ratelimit-*` and `retry-after`) and revisit then.
- **Heavy-fields response shape.** Phase 1b moves conversation data from the bulk `nodes[]` to top-level `focused*` aliases. The parser merge step needs to preserve the existing `lastKnown.issueComments` / `lastKnown.reviewThreads` carry-forward logic for sessions whose PR tab loses focus mid-poll (today's behavior at `pr-status-poller.ts:809`). Easy to get wrong; cover with an explicit test.

### Historical risks (Phase 2 — rejected)

Preserved for context; not relevant to the shipping path.

- **Behavior delta on session restart.** Today, after a process restart, `lastKnown` is empty for every session and the bulk poll re-discovers all PRs. With per-session `prNumber` we either persist the mapping (extend session metadata) or eat one branch-lookup alias per session on first tick. The latter is simpler.
- **PR closed → reopened.** If a closed PR for the same branch is reopened, the cached `prNumber` is still valid. Verify this matches GitHub's semantics (a reopened PR retains its number).
- **Stale PR number.** If a session's branch was force-pushed and a new PR was opened against the same branch, the old PR number could be stale. Rare, but the Discover PR button covers the recovery path.
