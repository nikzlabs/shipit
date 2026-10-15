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
- [x] Network `disconnect`/`destroy` events drive the session-network heal
- [x] Log follower re-arms itself instead of relying on a poll
- [x] `ServiceEventRouter`: project index, event routing, host-wide backstop, resync on stream resume
- [x] Wire the router into the orchestrator lifecycle, disposed on close
- [x] Tests: router, Engine API listing, follow-up timers, event exits; existing poller and manager coverage adapted
- [x] Mutation check — every new test fails without its change
- [x] `npm run test:dev`, `lint:dev`, `typecheck`, orchestrator integration tests
- [x] Update docs/121, docs/128, docs/286-install-gate-liveness-watchdog, which described mechanisms riding the old heartbeat
- [x] Independent review
- [ ] Measure on prod after merge: orchestrator CPU and child-process share
