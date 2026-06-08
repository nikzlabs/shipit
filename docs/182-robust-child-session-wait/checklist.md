# Checklist — Robust child-session orchestration

## Server: durable, level-triggered readiness
- [x] `waitForChildIdle` accepts a bounded `segmentMs` and returns a `pending` result when the segment elapses with the child still running
- [x] Readiness derives from session existence + `userArchived` + a live worker `/agent/status` probe (there is NO persisted run-status field — `SessionInfo` only persists existence + `userArchived`); in-memory `idle` event is a fast-wakeup only
- [x] Wait result distinguishes `idle` / `error` / `archived`(disposed) / `pending` / `timed-out`

## Server: `error` outcome (new state, does not exist today)
- [x] Record a turn-error flag when the child's `agent_result` reports failure / `agent_error` fires — on the runner and persisted on `SessionInfo` (migration) so it survives a restart
- [x] Expose the flag on the child view / readiness check; `waitForChildIdle` resolves with the `error` outcome when set
- [x] **Decision: built the `error` outcome.** New durable state added (`SessionInfo.lastTurnErrored` + `last_turn_errored` column, runner `lastTurnErrored` flag set in `agent-listeners`), so the parent can mechanically branch on exit code 3.

## Server: headless reconcile (vector #5)
- [x] On each segment, when the runner reports running, call `verifyRunningState()` from the readiness check (this alone fixes vector #5 for viewerless children; `runReconcileCheck`'s viewer gate is left untouched)
- [x] Regression test: stuck `running=true` + worker idle + zero viewers is corrected by the segment probe and the wait resolves (`child-sessions-wait.test.ts` → "reconciles a stuck running=true on a viewerless child")

## Route + relay plumbing
- [x] `api-routes-session.ts` children wait route emits the segmented `pending`/terminal response shape; legacy `wait=true&timeout=N` still works
- [x] `agent-ops-routes.ts` passes `segment` through (and bounds the worker→orchestrator leg)
- [x] `OrchestratorClient.request` gains an AbortController per-request timeout and classifies transient failures (status 0 surfaces, shim retries)

## Shim
- [x] `handleSessionWait` loops over segments until idle/terminal or overall `--timeout`
- [x] Transient transport errors retried with capped exponential backoff, never surfaced as terminal
- [x] Distinct exit codes (0 idle/archived, 1 timed-out, 3 child error) + `--json` fields incl. `lastTransportError`
- [x] `callBroker` per-request timeout
- [x] Multi-id `wait <id...> [--any|--all]` fan-out over the resilient single-wait

## Docs + tests
- [x] Update `shipit-docs/sessions.md`: new wait semantics, exit codes, multi-id, resilience guarantees
- [x] Segment-loop / resume tests, transient-retry tests, outcome-mapping tests, multi-child tests (`shipit.test.ts`, `child-sessions-wait.test.ts`, `agent-spawned-session.test.ts`)
- [x] Serialization round-trip for the new `lastTurnErrored` field (`sessions.test.ts`)

## Future (not blocking)
- [ ] (G) push-based `child_session_idle` event into the parent runner, persisted as a transcript card
