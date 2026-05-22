# Checklist — proactive git pre-fetch

## Gate (cleared 2026-05-22)

- [x] From 144's `[timing]` logs: git fetch #1 (`refreshCloneToLatestMain`) is
      ~620–700ms and ~95–98% of claim latency on every path after 144 fix #1.
      Also found: a no-op fetch still pays the full RTT, so the cache-warm
      approach must be paired with *skipping* the synchronous claim fetch.

## Design

- [x] Periodic interval N — fixed `PREFETCH_INTERVAL_MS = 3 min`; skip window
      `CLAIM_SKIP_WINDOW_MS = 2 × interval` so one missed cycle doesn't force
      every claim back onto the slow fetch.
- [x] On-change trigger source — ride the existing `pr-status-poller.ts` merge
      detection (`onMergeDetectedCb` → `onRepoMainAdvanced`). Webhooks deferred:
      a merge is the precise moment `main` moves and the poller already sees it.
- [x] Per-repo fetch concurrency — a per-repo `inFlight` set in the prefetcher
      plus `fetchCache`'s 60s TTL coalesce overlapping triggers; the periodic
      sweep is low-frequency (3 min). No extra rate-limit budget needed.
- [x] Interaction with `disk-janitor` — the sweep only fetches `status:"ready"`
      repos in the `RepoStore`; janitor-pruned caches drop their repo entry, so
      they're never fetched.

## Implementation

- [x] Periodic background fetch per `ready` repo, coalesced via the 60s TTL guard
      — `repo-prefetch.ts` `createRepoPrefetcher().start()`.
- [x] On-change fetch hook (PR merge) — `onRepoMainAdvanced` wired from the PR
      poller's post-merge callback to `prefetchRepo()`. (Post-auto-push pushes a
      *feature* branch, which doesn't move `main`, so it's intentionally not a
      trigger.)
- [x] **Skip/defer the claim-time `refreshCloneToLatestMain`** — claim handler
      skips the synchronous fetch when `shouldSkipClaimFetch(url)` (i.e.
      `coveredRecently`) is true; warm/reuse/waiting return `fetch=0`, the
      slow-clone path passes `skipFetch` to `fetchAndResolveDefaultBranch` and
      resolves from local refs. Chose **skip**, not fire-and-forget: the latter
      ends in a hard reset that would race the agent's first edits.
- [x] Verify the warm-hit claim does zero blocking git work — re-measured live
      (2026-05-22): `path=warm total=1–2ms fetch=0ms`, `path=reuse total=1ms
      fetch=0ms`. Down from ~650ms total / ~620–700ms fetch before 145.

## Guardrails (must hold)

- [x] Resource limits never derived from a stale `shipit.yaml` — skipping the
      fetch leaves HEAD untouched, so the standby's booted limits stay
      consistent with the clone (no HEAD move ⇒ no re-provision needed). The
      slow-path's `reprovisionStandbyIfLimitsChanged` still fires if a real
      fetch ever does move HEAD.
- [x] Session clone HEAD is never fast-forwarded after branch cut — the
      pre-fetcher touches the **bare cache only**, never a live session clone;
      and the claim skip avoids the post-cut reset entirely.
- [x] W2 stale-clone visibility breadcrumb — preserved for genuine fetch
      *failures* (slow path). A deliberate `skipFetch` is bounded-stale by
      design and does not trip the breadcrumb (would be noise on every claim).

## Verification

- [x] Unit: `repo-prefetch.test.ts` (coveredRecently freshness window, ready
      gating, fire-and-forget fetch, start/stop idempotence) +
      `git-utils.test.ts` skipFetch case (resolves from local refs, no network,
      `authError:false`).
- [x] Re-measure `[timing] claim-session ... fetch=<ms>` live — confirmed: the
      fetch portion is `0ms` and total is `1–2ms` on warm/reuse claims
      (2026-05-22 dogfood run).
- [ ] Manual: claim immediately after a push lands → session is fresh or
      gracefully bounded-stale, never broken. (Bounded-stale by design — the
      merge→`prefetchRepo` hook refreshes the cache; not separately exercised.)

## Follow-up (2026-05-22): long-idle-pool regression

- [x] Repro: live claim cut a branch at a commit ~2 months behind `origin/main`.
      Root cause: `coveredRecently` proves the **bare cache** is fresh but says
      nothing about a warm clone whose `origin/HEAD` was frozen at warm time.
- [x] Fix: add second gate `isWorkspaceCloneInSyncWithCache(workspaceDir,
      cacheDir)` to `refreshClaimedSession` — two local `rev-parse`s, no
      network. Both gates must hold for the claim to skip the fetch.
- [x] Unit: `git-utils.test.ts` — in-sync, drifted (long-idle regression),
      missing cache, fallback to `origin/main`.
