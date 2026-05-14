# Session rescue & diagnostics — checklist

## Phase 1 — Surface the silent signals

### 1.1 `stack_error` event subscriber
- [x] Compose stack startup failure surfaced as `compose_error` WS message (existing, app-lifecycle.ts catch on `mgr.start()`).
- [x] Per-session log ring entry added on stack startup failure so the Logs panel and the future diagnostics endpoint see the failure.
- [x] Distinct `stack_error` WS type added. `compose_error` (catch path) stays as the user-facing PreviewFrame banner; `stack_error` (subscriber path) is the typed channel for the manager's emit, ready for non-startup emit sites without re-wiring.

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
- [x] `session_status.lastInterruptError` field added; emitted from the recovery flow when the best-effort `killAgentOnWorker` call fails. Client renders an auto-dismissing inline toast in `SessionHealthStrip` (8s timeout, dismissable).

### 1.5 Preview-proxy 502 server-side surfacing
- [x] In `preview-proxy.ts`, on connection error emit `runner.emitMessage({ type: "preview_error", port, message })` (with HMR-upgrade variant) + a `log_entry` with `source: "preview"`.
- [x] Add `preview_error` to `ws-server-messages.ts`.
- [x] Throttle errors per `(session, port)` to avoid log spam (5s window).
- [x] Client `PreviewFrame.tsx`: render an inline banner on `preview_error` for the active port with Retry / Dismiss buttons. Sits above the iframe.

### 1.6 Idle-disposal user-visible notice
- [x] Idle enforcer broadcasts `session_status` SSE with `reason: "idle-disposed"` (or `"memory-pressure"`) and `idleMs`.
- [x] Per-session log ring entry "Session container paused after N s. Send a message to resume." so a returning viewer sees the explanation in the Logs panel.
- [x] Dedicated inline notice surface — `pauseNotice` field in session-store, populated from `session_status` `idle-disposed` / `memory-pressure` reasons, rendered as a banner in `SessionHealthStrip` with auto-clear when the container is running again.

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
- [x] Integration test: `stack_error` propagates to broadcast log + emitMessage (`integration_tests/stack-error.test.ts`).
- [x] Integration test: preview-proxy 502 emits `preview_error` with throttling (`integration_tests/preview-error.test.ts`).
- [x] Integration test: Rescue session full path — phased emits, stop-stack-before-dispose, reapOrphans, getOrCreate, failed-create reason, lastInterruptError, noContainer (`services/recovery.test.ts`).
- [x] Integration test: diagnostics endpoint returns expected shape (`integration_tests/diagnostics-endpoint.test.ts`).

The wiring helpers `handleStackError` and `createPreviewErrorReporter` were extracted from inline closures so the tests can hit the wiring directly without spinning up Docker.

## Docs
- [x] `plan.md` written.
- [x] `checklist.md` written.
- [x] Update `plan.md` if implementation diverges (esp. phase names or endpoint shape) — phase set matches plan; `failed` carries `reason` instead of `failed:<reason>` (cleaner discriminated union).
- [x] Marked `status: in-progress` when Phase 1 started.
- [x] Marked `status: done` once all phases shipped.

## Follow-up — Silent container death (post-ship)

Field report from a production user (2026-05-11) showed a session
diagnostic with `containerState: missing`, `runner: null`, and only the
single "Agent process started" entry in `recentLogs` 70 minutes after
the session started. Two gaps that Phase 1 missed:

- [x] **`container_exited` handler didn't write to the per-session log
      ring.** It emitted `session_status` via `runner.emitMessage` (which
      goes into the turn buffer that's discarded on dispose) and
      `console.error` (which doesn't surface in diagnostics), then
      force-disposed. Net result: a container that OOMs or crashes leaves
      zero trace in the diagnostic snapshot. Fixed by extracting the
      inline handler into `handleContainerExited` and calling
      `broadcastLog` before disposing. Exit 137 is annotated as "likely
      OOMKilled" for the human-readable log line.
- [x] **Runners whose container vanished without a `die` event were
      undetectable.** The Docker event subscriber has a 5s reconnect
      window during which die events are lost; daemon restarts and
      external `docker rm` also bypass the event path. The 30s reconciler
      from §3.3 only checks `/agent/status` (worker-level), not container
      existence — so a missing container would never be detected. Fixed
      by adding `createMissingContainerReconciler` in `app-lifecycle.ts`,
      scheduled on the existing idle-enforcement timer in `index.ts`. It
      walks `runnerRegistry.ids()`, force-disposes runners with no
      corresponding container (skipping standbys), and writes a
      "container vanished" log entry to the per-session ring.
- [x] Tests in `integration_tests/container-exit-logging.test.ts` cover
      both paths (OOM annotation, orphan detection, multi-runner mix,
      standby skip, no-container-manager local-mode).

## Follow-up — Rescue create/phantom-exit loop (OOM cascade, post-ship)

Field report (session 90afd431, 2026-05-14): clicking **Rescue session**
created a healthy container, but a stale Docker `die` event for the
*previous* container — same `agent-<shortId>` name and `shipit-session-id`
label — was attributed to the *new* one, deleting its manager-map entry
and emitting a phantom `container_exited`. Every WS attach then created
another container; after 3 in 300s the loop detector force-tripped the
breaker. Result: `oomBreaker.tripped`, `containerState: missing`, and a
healthy untracked container left running.

- [x] **Stale-incarnation guard in `container-health.ts`.** The `die`/`oom`
      handler now reads the real container ID from `event.Actor.ID`
      (`attrs.id` was never populated — always `""`) and skips the event
      when `containerId !== sc.id`. An empty `sc.id` (new container
      mid-create) still skips a non-empty stale ID. Path 2 (`service_exited`)
      now also carries the real container ID — latent-bug fix for compose.
- [x] **`sc.id` assigned before `start()` in `container-lifecycle.ts`.**
      Moved `sc.id = container.id` to immediately after `createContainer()`
      returns, so the health-monitor ID guard is armed before the new
      container can emit any event.
- [x] **Loop detector hoisted + reset on recovery (Bug B).** The
      `SessionLoopDetector` was a hidden default-parameter singleton inside
      `setupContainerHealthMonitoring` with no DI handle. Hoisted to
      `index.ts` next to the OOM breaker, plumbed through `ApiDeps` →
      `RecoveryDeps`. `restartContainer`/`restartAgent` now call
      `loopDetector.forget(sessionId)` alongside `oomBreaker.reset(...)` —
      both gate the same runner factory, so resetting one without the
      other left the trip sticky.
- [x] **Inverse-leak backstop (C3).** `adoptRunningContainer` added to
      `container-discovery.ts` + `SessionContainerManager`; the
      missing-container reconciler now tries to re-adopt a live-but-untracked
      container (via an optional `sessionInfoResolver`) before
      force-disposing the runner. The reconciler is now async; `index.ts`
      fire-and-forgets it with a `.catch`.
- [x] Tests: `container-health.test.ts` (new — stale-ID drop, matching-ID
      process, no-ID fallthrough, mid-create empty `sc.id`) and
      `services/recovery.test.ts` (both recovery paths clear breaker +
      loop detector).

## Follow-up — Warm-pool provisioned containers from stale config (same incident)

Root cause behind the *original* OOM in session 90afd431: the bare cache
`repo-cache/<hash>` was 270 commits stale (its `fetchCache` had been
failing silently for a long time). The warm pool clones from that cache
with `git clone --local` — a snapshot — and resolved `origin/main` inside
that snapshot, so the session container's memory limit was derived from a
frozen `shipit.yaml`. The claim-time refresh then jumped the workspace 270
commits to a heavier `agent.memory: 3072` config, but the already-booted
1 GiB container kept its (immutable) limit → `npm install` OOM.

- [x] **W1 — `fetchCache` visibility.** `repo-git.ts` `fetchCache` now logs
      HEAD before/after (`advanced`/`unchanged`) so a fetch that "succeeds"
      without moving the cache is visible in journalctl; added `readHead()`.
      Warm path + claim slow-path surface a `fetchCache` failure via an SSE
      `error` event instead of only `console.warn`.
- [x] **W2 — land on the actual latest commit.** New shared helper
      `fetchAndResolveDefaultBranch` (`git-utils.ts`) fetches the *real
      remote* in the workspace clone and resolves `origin/HEAD` →
      `origin/main` → `origin/master`. The warm pool, the claim slow-path,
      and `refreshCloneToLatestMain` all use it, so none can branch from a
      stale `--local` snapshot. Best-effort: a failed fetch falls back to
      local refs (offline / unreachable remote) rather than aborting.
      Credentials are configured before the fetch on both paths.
- [x] **W3 — re-provision the standby on a claim-time HEAD jump.**
      `SessionContainer.bootedLimits` always records what the agent
      container was created with (`container-lifecycle.ts`). The claim
      handler's `reprovisionStandbyIfLimitsChanged` compares it against
      `resolveAgentDockerLimits()` of the refreshed workspace when
      `headChanged`, and `destroy()`s the standby on mismatch — the runner
      factory rebuilds it with correct limits on first attach.
- [x] **W4a — loud `readAgentConfig` fallback.** The catch in
      `readAgentConfig` no longer swallows silently — it logs the workspace
      dir + the underlying error before falling back to `AGENT_DEFAULTS`,
      so a broken `shipit.yaml` can't quietly produce a 1 GiB container.
      (The old-format hard-fail gate considered here was dropped — W2/W3
      already remove the staleness, and `resolveShipitConfig` keeps
      emitting old-format parse warnings for diagnostics.)
- [x] **W4b — booted-vs-parsed in diagnostics.** `ContainerHealth` carries
      `bootedLimits`; `SessionDiagnosticsPanel` renders "booted memory/cpu/
      pids" alongside the parsed `effectiveAgent` values and highlights a
      mismatch — the warm→claim divergence is now visible at a glance.
- [x] Tests: `git-utils.test.ts` (new — W2 helper resolves to latest after
      fetch + offline fallback), `session-container.test.ts` (`bootedLimits`
      population, W4a loud-fallback), `services/diagnostics.test.ts` (W4b
      booted-vs-parsed surfacing), `integration_tests/warm-pool-staleness.test.ts`
      (new — W2 warm standby boots at the remote's latest `agent.memory`;
      W3 claim destroys a stale-limit standby on `headChanged`).
