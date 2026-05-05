# Container resilience — checklist

## A. SSE idle timeout + activity tracking

- [x] Add `ConnectSSEOpts` (`idleTimeoutMs`, `onActivity`) to `connectSSE` in `sse-client.ts`.
- [x] Arm/reset an idle timer on every chunk received from the server (including keepalive comments).
- [x] On idle expiry, destroy the request and call `onError("SSE stream stale (no activity within idle timeout)")`.
- [x] Pass `idleTimeoutMs: 45_000` from `ContainerSessionRunner._connectEventStreamNow()`.
- [x] Pass `onActivity: () => { this._lastSseEventAt = Date.now(); }` so keepalives advance the gauge.
- [x] Add unit tests in `sse-client.test.ts`:
  - normal event parsing still works
  - idle timeout fires `onError` when no bytes arrive
  - any byte (including keepalive comment) resets the idle timer
  - `onActivity` fires for every chunk
  - explicit `close()` clears the timer
- [x] Verify the existing `handleSSEDisconnect` → `scheduleReconnect` path is reached on stale-error (relies on existing reconnect machinery; no new wiring needed — the `onError` callback in `_connectEventStreamNow` already calls `handleSSEDisconnect`).

## B. Docker event stream auto-restart

- [x] Add `stopped` flag to `HealthMonitorState` in `container-health.ts`.
- [x] In `startHealthMonitor`, set `stopped = false` and capture a `restartTimer` handle on state.
- [x] On `eventStream.on("error")` and stream `end`, schedule a restart with 5s debounce; do nothing if `stopped` is true.
- [x] In `stopHealthMonitor`, set `stopped = true` and clear `restartTimer`.
- [x] Extend `session-container.test.ts` with a test that simulates a stream error and verifies the monitor reconnects (and that subsequent `die` events still fire).

## Quality

- [x] `npm run lint` passes.
- [x] `npm run typecheck` passes.
- [x] `npm run test:dev` passes (covers touched files: 132/132).
- [ ] Smoke-test by manually killing a worker mid-session — agent and terminal should recover within ~45s without reload.

## Docs

- [x] `plan.md` written.
- [x] `checklist.md` written.
- [ ] Mark `status: done` in `plan.md` once all checklist items above are checked.
