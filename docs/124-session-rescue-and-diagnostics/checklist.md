# Session rescue & diagnostics — checklist

## Phase 1 — Surface the silent signals

### 1.1 `stack_error` event subscriber
- [ ] Subscribe to `stack_error` in `ContainerSessionRunner.setServiceManager()` (`container-session-runner.ts:383-386`).
- [ ] Route to `runner.emitMessage({ type: "stack_error", error })`.
- [ ] Route to `ctx.broadcastLog({ level: "error", source: "compose", … })`.
- [ ] Add `stack_error` to `ws-server-messages.ts`.
- [ ] Client: render `stack_error` in Logs panel + ServicesPanel banner.

### 1.2 Compose-child OOM detection
- [ ] Widen Docker event label filter in `container-health.ts:84-89` to include `shipit-parent-session`.
- [ ] On `die`/`oom` for a compose-child, look up session via `shipit-parent-session` label.
- [ ] Emit `service_oom` runner event with service name + container id.
- [ ] Annotate `pollStatus` exit messages with "OOMKilled" reading from `docker inspect` State.OOMKilled.
- [ ] Add `service_oom` to `ws-server-messages.ts`.
- [ ] Client: surface OOM badge on ServicesPanel service row.

### 1.3 Default `workerPost`/`workerGet` timeout
- [ ] Set default `timeoutMs: 10_000` in `worker-http.ts:21-74`.
- [ ] Define `WorkerTimeoutError` and throw on timeout.
- [ ] Audit call sites that need to opt out (streaming endpoints, long agent operations) and pass an explicit override.
- [ ] Update agent control handlers (`/agent/start`, `/agent/stdin`, `/agent/interrupt`) to surface `WorkerTimeoutError` as a chat-visible error.

### 1.4 Stop swallowing `ProxyAgentProcess.kill()` errors
- [ ] Change the `.catch(() => {})` in `proxy-agent-process.ts:75-77` to log + emit.
- [ ] On error, emit a `log_entry` ("Interrupt failed: worker unreachable") and update `session_status.lastInterruptError`.
- [ ] Client: when interrupt fails, surface a non-blocking toast.

### 1.5 Preview-proxy 502 server-side surfacing
- [ ] In `preview-proxy.ts:134-139`, on connection error emit `runner.emitMessage({ type: "preview_error", port, error })`.
- [ ] In `proxy-error.ts:182-184` (HMR upgrade failure), do the same.
- [ ] Add `preview_error` to `ws-server-messages.ts`.
- [ ] Client `PreviewFrame.tsx`: render an inline overlay on `preview_error` with a "Rescue session" CTA.

### 1.6 Idle-disposal user-visible notice
- [ ] In `app-lifecycle.ts:441`, after the `console.log`, emit `session_status` with `reason: "idle-disposed"` and elapsed-idle ms.
- [ ] Client: render a non-blocking inline notice "Session paused after N minutes idle. Send a message to resume."

## Phase 2 — Diagnostics endpoint + panel

### 2.1 Server: `services/diagnostics.ts`
- [ ] Compose payload from `getContainerHealth`, ServiceManager service map + log tails, runner state, broadcastLog ring.
- [ ] Add `getServiceDiagnostics(deps, sessionId)` walking `ServiceManager` services + log buffer tails.
- [ ] Add `getRunnerDiagnostics(deps, sessionId)` returning `running`, viewer count, queue length, last SSE event, capturedSessionId mismatches.
- [ ] Expose a getter on the orchestrator's broadcastLog ring for recent entries.

### 2.2 Endpoint
- [ ] `GET /api/sessions/:id/diagnostics` in `api-routes-container.ts`.
- [ ] Read-only; safe to call repeatedly.

### 2.3 Client: `SessionDiagnosticsPanel.tsx`
- [ ] New modal/panel reachable from `SessionHealthStrip`'s "Details" affordance.
- [ ] Sections: Container, Worker, SSE, Compose stack (with per-service expandable stderr tail), Recent logs, Runner.
- [ ] Polls `/diagnostics` at 2 s while open.
- [ ] "Copy diagnostics" button copies full payload as JSON.

## Phase 3 — Rescue session (deep restart)

### 3.1 Stop compose stack before dispose
- [ ] In `services/recovery.ts:144-247`, resolve runner, call `runner.serviceManager?.stop()` before `runnerRegistry.dispose()`.
- [ ] After `containerManager.destroy()`, run a one-shot orphan reaper for `shipit-parent-session={sid}` survivors.
- [ ] Reuse logic from `cleanupSessionDockerResources` (already exists for orphan reaping at startup — `091-compose-stack-cleanup`).

### 3.2 Phased progress
- [ ] Refine `container_restarting` WS payload to carry `phase`: `stopping_stack | destroying_container | creating_container | starting_stack | ready | failed:<reason>`.
- [ ] Emit each phase as it begins.
- [ ] Per-phase max duration; on timeout, transition to a `failed:<phase>` state with diagnostics deep-link.

### 3.3 Periodic `verifyRunningState` reconciler
- [ ] Add a 30 s interval inside `ContainerSessionRunner` (only while viewer attached and `running === true`).
- [ ] Compare against `/agent/status`; on 2 consecutive divergences, correct `runner.running` and emit a `session_status` notice.

### 3.4 UI rename
- [ ] `SessionHealthStrip.tsx`: rename "Restart container" button to "Rescue session".
- [ ] Render phased progress overlay tied to the new payload.
- [ ] On `failed:<phase>`, deep-link to the diagnostics panel.

## Phase 4 — Copy diagnostics
- [ ] "Copy diagnostics" button in `SessionDiagnosticsPanel`.
- [ ] Includes full diagnostics payload + session ID + client timestamp, JSON-formatted.
- [ ] Brief "Copied" affordance.

## Quality
- [ ] `npm run lint` passes.
- [ ] `npm run typecheck` passes.
- [ ] `npm run test:dev` passes (server + client tests for new/touched files).
- [ ] Integration test: `stack_error` propagates to broadcast log + emitMessage.
- [ ] Integration test: preview-proxy 502 emits `preview_error`.
- [ ] Integration test: Rescue session full path (stop stack → destroy → recreate → start stack).
- [ ] Integration test: diagnostics endpoint returns expected shape with services, runner, recent logs.

## Docs
- [x] `plan.md` written.
- [x] `checklist.md` written.
- [ ] Update `plan.md` if implementation diverges (esp. phase names or endpoint shape).
- [ ] Mark `status: in-progress` when Phase 1 starts.
- [ ] Mark `status: done` when all phases are complete.
