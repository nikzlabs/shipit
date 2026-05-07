# Session rescue & diagnostics — checklist

## Phase 1 — Surface the silent signals

### 1.1 `stack_error` event subscriber
- [x] Compose stack startup failure surfaced as `compose_error` WS message (existing, app-lifecycle.ts catch on `mgr.start()`).
- [x] Per-session log ring entry added on stack startup failure so the Logs panel and the future diagnostics endpoint see the failure.
- [ ] (Deferred) Distinct `stack_error` WS type if non-startup `stack_error` emit sites are added later. The current `compose_error` channel covers all paths that throw.

### 1.2 Compose-child OOM detection
- [x] Widen Docker event label filter in `container-health.ts` to dispatch by label inside the handler (Path 1: `shipit-session`, Path 2: `shipit-parent-session`).
- [x] On `die`/`oom` for a compose-child, look up session via `shipit-parent-session` label and emit `service_exited` with `oom`.
- [x] Emit `service_oom` runner event with service name + container id (`app-lifecycle.ts` `service_exited` handler).
- [x] Add `service_oom` to `ws-server-messages.ts`.
- [x] Per-session log ring + `log_entry` runner message with OOM-vs-exit guidance text.
- [x] Annotate `pollStatus` exit messages with "OOMKilled" — heuristic: exit code 137 → "Exited with code 137 (likely OOMKilled)". The Docker event subscriber in container-health.ts is the authoritative path; this is the fallback when that event was missed.
- [x] Client: surface OOM badge on ServicesPanel service row (red OOM pill in `ServiceList` when `svc.error` matches /oom/i).

### 1.3 Default `workerPost`/`workerGet` timeout
- [x] `DEFAULT_WORKER_TIMEOUT_MS = 10_000` in `worker-http.ts`, with `timeoutMs: 0` opt-out.
- [x] `WorkerTimeoutError` defined with `path` and `timeoutMs`; thrown on timeout.
- [x] Audited all call sites: every endpoint behind `workerPost`/`workerGet`/`workerPut` returns immediately (acks; long work streams via SSE), so the 10s default is correct everywhere. No opt-outs needed.
- [x] `ProxyAgentProcess.run/writeStdin/interrupt` translate `WorkerTimeoutError` into action-oriented chat errors (`"agent container is not responding. Try Rescue session…"` etc.) instead of the raw `Worker request timed out after 10000ms: /agent/start` message.

### 1.4 Stop swallowing `ProxyAgentProcess.kill()` errors
- [x] Replace `.catch(() => {})` in `proxy-agent-process.ts` with `log` event emission ("Failed to kill agent on worker: …") so failures land in the Logs panel.
- [ ] (Deferred) `session_status.lastInterruptError` field + non-blocking toast — incremental polish; the Logs entry already covers the visibility gap.

### 1.5 Preview-proxy 502 server-side surfacing
- [x] In `preview-proxy.ts`, on connection error emit `runner.emitMessage({ type: "preview_error", port, message })` (with HMR-upgrade variant) + a `log_entry` with `source: "preview"`.
- [x] Add `preview_error` to `ws-server-messages.ts`.
- [x] Throttle errors per `(session, port)` to avoid log spam (5s window).
- [x] Client `PreviewFrame.tsx`: render an inline banner on `preview_error` for the active port with Retry / Dismiss buttons. Sits above the iframe.

### 1.6 Idle-disposal user-visible notice
- [x] Idle enforcer broadcasts `session_status` SSE with `reason: "idle-disposed"` (or `"memory-pressure"`) and `idleMs`.
- [x] Per-session log ring entry "Session container paused after N s. Send a message to resume." so a returning viewer sees the explanation in the Logs panel.
- [ ] Dedicated inline notice surface (as opposed to log entry) — incremental polish.

## Phase 2 — Diagnostics endpoint + panel

### 2.1 Server: `services/diagnostics.ts`
- [x] Compose payload from `getContainerHealth`, ServiceManager service map + log tails (last 20 lines/service), runner state, log ring (last 50 entries).
- [x] Walks `ServiceManager` services for status, port, IP, error, and log tail.
- [x] Reads runner state: `running`, viewer count, queue length, last SSE event, turn buffer size, disposed.
- [x] Reuses the existing per-session `getLogBuffer` (no new ring needed — the per-session ring already covers everything).

### 2.2 Endpoint
- [x] `GET /api/sessions/:id/diagnostics` in `api-routes-container.ts`.
- [x] Read-only; safe to call repeatedly.

### 2.3 Client: `SessionDiagnosticsPanel.tsx`
- [x] New modal reachable from a "Diagnostics" button in `SessionHealthStrip`.
- [x] Sections: Container & worker (incl. SSE freshness + create errors), Compose stack (with per-service expandable log tail), Runner, Recent logs, Meta.
- [x] Polls `/diagnostics` at 2 s while open; cleans up on close.
- [x] "Copy" button copies full payload as JSON (with a `clientCopiedAt` field).

## Phase 3 — Rescue session (deep restart)

### 3.1 Stop compose stack before dispose
- [x] In `services/recovery.ts`, call `runner.serviceManager?.stop()` (with a 10s timeout) before `runnerRegistry.dispose()`.
- [x] After `containerManager.destroy()`, run a one-shot orphan reaper via the new `containerManager.reapOrphans(sessionId)` for `shipit-parent-session={sid}` survivors.
- [x] Reuses `cleanupSessionDockerResources` (already exists for orphan reaping at startup — `091-compose-stack-cleanup`).

### 3.2 Phased progress
- [x] Refined `container_restarting` WS payload — added optional `phase`, `reason`, `message` fields. `RescuePhase` type covers `stopping_stack | destroying_container | creating_container | starting_stack | ready | failed`.
- [x] Each phase is emitted as it begins. Phases after `dispose()` re-resolve the new runner so `emitMessage` reaches reconnecting viewers via the turn-event buffer.
- [x] Per-phase max duration via `withTimeout()` helper. On timeout we log and continue (the orphan reaper covers the safety case); on creation failure we emit `failed` with `reason: "create_failed"` so the UI deep-links to diagnostics.

### 3.3 Periodic `verifyRunningState` reconciler
- [x] 30s `setInterval` inside `ContainerSessionRunner`, started in `attachViewer`, stopped on last detach + on dispose.
- [x] Compares `runner._isRunning` against `/agent/status`. On 2 consecutive divergences (`RECONCILE_MAX_DIVERGENCES`), runs `verifyRunningState()` which already emits the `session_status` notice and resets the flag.
- [x] Worker-unreachable polls don't count toward divergences (transient SSE blips don't trigger false resets).

### 3.4 UI rename
- [x] `SessionHealthStrip.tsx`: button label is now **Rescue session** with a deeper tooltip ("Stop the compose stack, destroy the agent container, then recreate everything from scratch").
- [x] Phase-aware overlay label (e.g. "Stopping services…" → "Recreating container…" → "Rescue complete") driven by `rescueState` in `session-store`, populated from `container_restarting` WS messages.
- [x] On `failed`, an inline error row renders with reason + message and an **Open diagnostics** button that opens `SessionDiagnosticsPanel` directly.

## Phase 4 — Copy diagnostics
- [x] "Copy" button in `SessionDiagnosticsPanel`.
- [x] Includes full diagnostics payload + session ID + `clientCopiedAt`, JSON-formatted.
- [x] Brief "Copied" affordance (2s).

## Quality
- [x] `npm run lint` passes.
- [x] `npm run typecheck` passes.
- [x] `npm run test:dev` passes (server + client tests for new/touched files).
- [ ] (Deferred) Integration test: `stack_error` propagates to broadcast log + emitMessage.
- [ ] (Deferred) Integration test: preview-proxy 502 emits `preview_error`.
- [ ] (Deferred) Integration test: Rescue session full path (stop stack → destroy → recreate → start stack).
- [ ] (Deferred) Integration test: diagnostics endpoint returns expected shape with services, runner, recent logs.

The deferred integration tests cover happy-path wiring whose component pieces already have unit coverage (proxy-agent-process, diagnostics service, SessionDiagnosticsPanel). They're not blocking the feature; track separately if regressions show up.

## Docs
- [x] `plan.md` written.
- [x] `checklist.md` written.
- [x] Update `plan.md` if implementation diverges (esp. phase names or endpoint shape) — phase set matches plan; `failed` carries `reason` instead of `failed:<reason>` (cleaner discriminated union).
- [x] Marked `status: in-progress` when Phase 1 started.
- [x] Marked `status: done` once all phases shipped.
