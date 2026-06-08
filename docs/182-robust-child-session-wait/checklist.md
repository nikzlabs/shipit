# Checklist — Robust child-session orchestration

## Server: durable, level-triggered readiness
- [ ] `waitForChildIdle` accepts a bounded `segmentMs` and returns a `pending` result when the segment elapses with the child still running
- [ ] Readiness derives from persisted session status + worker `/agent/status`, with the in-memory `idle` event as a fast-wakeup only
- [ ] Wait result distinguishes `idle` / `error` / `archived`(disposed) / `pending` / `timed-out`
- [ ] On each segment, probe `verifyRunningState()` when the runner still reports running

## Server: headless reconcile (vector #5)
- [ ] `runReconcileCheck` runs for viewerless runners that have a parent linkage
- [ ] Regression test: stuck `running=true` + worker idle + zero viewers gets reconciled

## Route + relay plumbing
- [ ] `api-routes-session.ts` children wait route emits the segmented `pending`/terminal response shape; legacy `wait=true&timeout=N` still works
- [ ] `agent-ops-routes.ts` passes `segment` through
- [ ] `OrchestratorClient.request` gains an AbortController per-request timeout and classifies transient failures

## Shim
- [ ] `handleSessionWait` loops over segments until idle/terminal or overall `--timeout`
- [ ] Transient transport errors retried with capped exponential backoff, never surfaced as terminal
- [ ] Distinct exit codes (0 idle/archived, 1 timed-out, 3 child error) + `--json` fields incl. `lastTransportError`
- [ ] `callBroker` per-request timeout
- [ ] Multi-id `wait <id...> [--any|--all]` fan-out over the resilient single-wait

## Docs + tests
- [ ] Update `shipit-docs/sessions.md`: new wait semantics, exit codes, multi-id, resilience guarantees
- [ ] Segment-loop / resume tests, transient-retry tests, outcome-mapping tests, multi-child tests
- [ ] Serialization round-trip for any new `pending`/outcome fields

## Future (not blocking)
- [ ] (G) push-based `child_session_idle` event into the parent runner, persisted as a transcript card
