---
issue: https://linear.app/shipit-ai/issue/SHI-76
title: Git fetch overhead before session creation
description: Benchmark of the latency cost of running git fetch before every new session, with a freshness-strategy recommendation.
---

# Git fetch overhead before session creation (SHI-76)

## Question

Newly created sessions sometimes miss the latest commits. One proposed fix is to run
`git fetch` **before every new session** so the clone is guaranteed fresh. Before
changing behavior, measure what that fetch costs.

## How ShipIt's git topology works (what we're actually adding)

Session creation does **not** clone from the remote on the critical path. Instead
(`repo-git.ts`, `claim-session.ts`):

1. A **bare cache** per remote lives at `repo-cache/<hash>`. It is kept fresh by a
   background prefetcher (`repo-prefetch.ts`, 3-min sweep + on-PR-change trigger) running
   `git fetch --all --force --prune`.
2. Each session is cut from that cache with `git clone --local` (hardlinked, no network).
3. The claim path *may* then run `git fetch origin` in the workspace clone
   (`fetchAndResolveDefaultBranch` in `git-utils.ts`). The **docs/145 optimization
   already skips this** when the bare cache was pre-fetched recently *and* the clone is
   in sync — precisely to avoid the cost measured below.

So "fetch before every session" means making that network `git fetch` **unconditional** on
the synchronous claim path. The benchmark measures the marginal cost of that fetch.

## Method

`docs/200-git-fetch-overhead/run_bench.sh` + `run_d.sh` reproduce ShipIt's topology
against the real remote (`github.com/nicolasalt/shipit.git`, 209 MB `.git`, 1667 commits):

- Build a bare cache the way ShipIt does (`git clone --bare`, `remote.origin.fetch =
  +refs/heads/*:refs/heads/*`, warm it once).
- **A. clone_local** — `git clone --local` from cache: the per-session git baseline, no fetch.
- **B. fetch_all_noop** — `git fetch --all --force --prune` on a warm cache (nothing new).
- **C. fetch_origin_noop** — `git fetch origin` in a session clone (warm, the claim-path fetch).
- **D. fetch_behind_{1,10,50}** — rewind a fresh cache N commits, gc away the newer objects,
  then time the fetch that genuinely re-downloads them from GitHub.

25 samples for the no-op cases, 12 for clone, 3 per "behind" size. Run from the session
container (datacenter network to github.com). Raw data: `raw-results.csv`.

## Results (milliseconds)

| scenario                         |  n |  min |  p50 |  p95 |  max | mean |
|----------------------------------|---:|-----:|-----:|-----:|-----:|-----:|
| clone_local (baseline, no fetch) | 12 |  139 |  147 |  169 |  170 |  151 |
| **fetch_all_noop** (warm cache)  | 25 |  920 | **1002** | **1128** | 1143 | 1008 |
| **fetch_origin_noop** (warm)     | 25 |  958 |  **991** | **1119** | 1177 | 1019 |
| fetch_behind_1                   |  3 | 1308 | 1435 | 1479 | 1483 | 1409 |
| fetch_behind_10                  |  3 | 1592 | 1610 | 1632 | 1635 | 1612 |
| fetch_behind_50                  |  3 | 1767 | 1841 | 1959 | 1972 | 1860 |

### Marginal overhead a pre-session fetch adds

| case                        | added latency (vs clone-only) |
|-----------------------------|-------------------------------|
| **No-op fetch (warm)**      | **p50 ≈ +850 ms, p95 ≈ +960 ms** |
| 1 commit behind             | ≈ +1.29 s                     |
| 10 commits behind           | ≈ +1.46 s                     |
| 50 commits behind           | ≈ +1.69 s                     |

## Reading the numbers

- **The no-op case dominates and still costs ~1 s.** Even when there's nothing to fetch,
  a warm fetch is **~1.0 s p50 / ~1.1 s p95**. Nothing is transferred — this is pure
  network round-trip: TLS handshake + git smart-HTTP ref advertisement to github.com.
  Because it's round-trip-bound, repo size barely matters for the warm case; **network
  latency to the remote is the floor**, and it rises on slower links.
- **With updates it scales with object count**, not dramatically: +1.3 s (1 commit) to
  +1.7 s (50 commits). The incremental pack transfer is cheap; the round-trip is the bulk.
- **This ~1 s would be paid on ~100% of session creations**, against a clone-from-cache
  step that is only ~150 ms today — a ~7× inflation of the git portion of a claim — to fix
  a freshness gap that only manifests in a narrow window (a push that lands between
  prefetch sweeps, or a skip-fetch that trusted a stale cache).
- A "check first, then fetch" variant does **not** help latency: a `git ls-remote` staleness
  probe is itself a network round-trip of the same order (~0.7–1 s), so it costs roughly
  what the no-op fetch it's trying to avoid costs.

## Is the added latency acceptable?

**No, not as an unconditional synchronous fetch.** ~1 s p50 / ~1.1 s p95 on every
session create is a large, user-visible regression for the warm/claim path — and it
directly undoes the docs/145 skip-fetch optimization that exists specifically to keep
claims feeling instant. The cost is also worst exactly where it's least justified: the
common case is the cache is *already* current (the prefetcher saw to it), so the fetch
transfers nothing yet still burns a full round-trip.

## Recommendation: fetch **conditionally / asynchronously**, do **not** always fetch

The freshness bug is "the bare cache was stale at claim time," not "we never fetch." Fix
the staleness window without putting a round-trip on the critical path:

1. **Keep the fetch off the synchronous path — strengthen the background prefetcher.**
   `repo-prefetch.ts` already sweeps every 3 min and on PR-poller "main moved." Tightening
   this to an **event-driven trigger on push / merge** (webhook → immediate
   `fetchCache()`) collapses the staleness window to near-zero with **zero** per-session
   latency, since the cache is refreshed before the next claim asks for it.
2. **Gate any claim-time fetch on a real staleness signal, not "always."** Keep the
   docs/145 skip logic; only fetch when the bare-cache freshness timestamp is older than a
   threshold or a push event marked it dirty. This pays the ~1 s on the rare stale claim,
   not on every create.
3. **If a hard freshness guarantee is ever required, fetch lazily at the point of need**
   (e.g. when branching for the user's first commit/PR), not eagerly on session create — so
   the cost lands on an action the user is already waiting on, not on every session open.

Always-fetch is the one option to avoid: it's the most expensive (~1 s on 100% of
creates) and strictly dominated by the event-driven prefetch above, which closes the same
gap for free.

## Reproduce

```bash
bash docs/200-git-fetch-overhead/run_bench.sh   # scenarios A–C
bash docs/200-git-fetch-overhead/run_d.sh        # scenario D (with-updates)
```

Numbers are network-dependent; rerun from the target environment (the prod VPS) to get its
own floor. The *shape* of the conclusion — no-op fetch is round-trip-bound at ~1 s and
always-fetch is strictly worse than event-driven prefetch — holds regardless of the exact
floor.
