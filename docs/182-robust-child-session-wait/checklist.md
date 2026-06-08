# Checklist — Robust child-session orchestration

## Server: durable, level-triggered readiness
- [ ] `waitForChildIdle` accepts a bounded `segmentMs` and returns a `pending` result when the segment elapses with the child still running
- [ ] Readiness derives from session existence + `userArchived` + a live worker `/agent/status` probe (there is NO persisted run-status field — `SessionInfo` only persists existence + `userArchived`); in-memory `idle` event is a fast-wakeup only
- [ ] Wait result distinguishes `idle` / `error` / `archived`(disposed) / `pending` / `timed-out`

## Server: `error` outcome (new state, does not exist today)
- [ ] Record a turn-error flag when the child's `agent_result` reports failure / `agent_error` fires — on the runner and persisted on `SessionInfo` (migration) so it survives a restart
- [ ] Expose the flag on the child view / readiness check; `waitForChildIdle` resolves with the `error` outcome when set
- [ ] (Or: drop the `error` row and rely on `latestAssistantMessage`/PR state — decide explicitly)

## Server: headless reconcile (vector #5)
- [ ] On each segment, when the runner reports running, call `verifyRunningState()` from the readiness check (this alone fixes vector #5 for viewerless children; `runReconcileCheck`'s viewer gate is left untouched)
- [ ] Regression test: stuck `running=true` + worker idle + zero viewers is corrected by the segment probe and the wait resolves

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
