---
issue: planning#697
title: "Event-driven service status: checklist"
---

# Checklist

- [x] Investigate what keeps service status current today, with `file.ts:fn` citations — `investigation.md`
- [x] Requirements, with the three open questions answered and receipted
- [x] Design — `plan.md`
- [x] Normalize the poller onto one container shape (`PollerContainer`), with the `compose ps` parse kept as the test source
- [x] Engine API source for listings — `compose-container-listing.ts`
- [x] Remove the per-session 5-second timer (`pollIntervalMs` defaults to 0)
- [x] One follow-up per pending condition, replacing the cadence the 30 s rules and the gate watchdog relied on
- [x] Event entry point for exits (`applyServiceExit`), with the stale-container guard
- [x] Correlate `oom` with the following `die` for Compose services, so one kill is one verdict
- [x] Network `connect`/`disconnect`/`destroy` events drive the session-network heal and re-resolve service addresses
- [x] Log follower re-arms itself instead of relying on a poll
- [x] `ServiceEventRouter`: project index, event routing, host-wide backstop, resync on stream resume
- [x] Wire the router into the orchestrator lifecycle, disposed on close
- [x] Tests: router, Engine API listing, follow-up timers, event exits; existing poller and manager coverage adapted
- [x] Mutation check — every new test fails without its change
- [x] `npm run test:dev`, `lint:dev`, `typecheck`, orchestrator integration tests
- [x] Update docs/121, docs/128, docs/286-install-gate-liveness-watchdog, which described mechanisms riding the old heartbeat
- [x] Independent review (ShipIt's configured reviewer, Codex)
- [x] Act on the review: the listing/exit ordering race, the per-container exit cache, the 250 ms
      outage spin, the dropped shared-listing failure, the per-session network inspect on every
      backstop, the never-ending refresh on a failed install gate, the consumed gate follow-up,
      the `runningRef` guard that dropped real exits, the stale OOM attribution across a restart,
      service addresses on a network event, and the follower spawn-error path
- [x] Second mutation pass over the review fixes (12 mutations, all caught)
- [x] Three more found while checking the fixes: a second Docker outage never swept (the first
      one's flag disarmed it), a burst of events costing one full listing per event, and the
      follower budget not resetting on a deliberate restart
- [x] Second review round, and its 8 findings: the shared-slice age guard, the unbounded network
      repair, the outage spin reached via a stale missing-container clock, stderr refilling the
      follower budget, the lost recovery for a missed network event, the serial relisting fan-out,
      every backstop inspecting every stopped container, and the coalescer's corrupted in-flight set
- [x] Third mutation pass (12 mutations, all caught), plus the two test gaps it exposed
- [x] `install-gate.test.ts` runs with `pollIntervalMs: 0`, so the watchdog is exercised under the
      shipped scheduling rather than a test-only poll interval
- [x] Third review round, and its 8 findings. The decisive one: every round had found a new defect
      in the same optimization (remembering an exited container's verdict), so it was **deleted**
      rather than hardened a fourth time — it saved one socket request per exited container per
      five minutes against a baseline of 18 process spawns per second
- [x] Monotonic ordering: `performance.now()` for slice age, seeded at construction, advanced on
      every publication, plus a per-listing sequence so two overlapping refreshes cannot apply out
      of order (follow-ups and post-`up` refreshes call in directly, bypassing the coalescer)
- [x] Sweep bounded and concurrent; a resync requested during one is queued, not dropped
- [x] Heal bounded and one at a time per session; follower budget covers a reconcile's attempt too
- [x] Fourth mutation pass (9 mutations, all caught), plus the two test gaps it exposed
- [ ] Measure on prod after merge: orchestrator CPU and child-process share
