# Checklist — proactive git pre-fetch

## Gate (cleared 2026-05-22)

- [x] From 144's `[timing]` logs: git fetch #1 (`refreshCloneToLatestMain`) is
      ~620–700ms and ~95–98% of claim latency on every path after 144 fix #1.
      Also found: a no-op fetch still pays the full RTT, so the cache-warm
      approach must be paired with *skipping* the synchronous claim fetch.

## Design

- [ ] Decide periodic interval N (fixed vs adaptive)
- [ ] Decide on-change trigger source (webhook vs `pr-status-poller.ts`)
- [ ] Define per-repo fetch concurrency / GitHub rate-limit budget
- [ ] Confirm interaction with `disk-janitor` cache cleanup (don't fetch caches
      for repos no session will use)

## Implementation

- [ ] Periodic background fetch per `ready` repo, coalesced via the 60s TTL guard
- [ ] On-change fetch hook (PR merge / push / post-auto-push)
- [ ] **Skip/defer the claim-time `refreshCloneToLatestMain`** — this is the part
      that removes the ~650ms; a fresh cache alone does not (a no-op fetch still
      pays the RTT). Either skip when a recent background refresh covered the
      repo, or run it fire-and-forget so the claim returns immediately.
- [ ] Verify the warm-hit claim does zero blocking git work (re-measure `fetch`)

## Guardrails (must hold)

- [ ] Resource limits never derived from a stale `shipit.yaml`
      (re-provision standby on HEAD change as today)
- [ ] Session clone HEAD is never fast-forwarded after branch cut
- [ ] W2 stale-clone visibility breadcrumb preserved when starting against a
      knowingly-stale snapshot

## Verification

- [ ] Re-measure `[timing] claim-session ... fetch=<ms>` — confirm the fetch
      portion drops to ~0 in the common case
- [ ] Test: claim immediately after a push lands → session is fresh or
      gracefully bounded-stale, never broken
