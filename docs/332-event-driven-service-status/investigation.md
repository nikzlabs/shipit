---
issue: planning#697
title: "Event-driven service status: investigation"
description: What keeps Compose service status current today, who reads it, and what only the 5 s poller catches.
---

# Investigation: what the service poller does today

Requirements: [requirements.md](requirements.md). Findings recorded 2026-10-15 against `main` at `371ac739`.

## Cost

`ServiceManager` builds one `ServicePoller` per session with `pollIntervalMs: 5_000` (verified at `service-manager.ts:constructor`, `opts.pollIntervalMs ?? 5_000`). `start()` arms it in its `finally` (verified at `service-manager.ts:start`), and nothing pauses it for an idle session: only `stop()` and `reconcile()` stop it. Each tick (verified at `service-poller.ts:pollOnce`):

- spawns `docker compose -p shipit-<id12> ps --format json -a` (`compose-cli.ts:defaultComposeQuery` is a `spawn("docker", …)`);
- spawns one `docker inspect <id>` for **every** listed container, exited ones too (`service-poller.ts:resolveContainerIps`);
- runs `afterPoll`: the install-gate watchdog and a network heal, which is one in-process Engine API `GET /networks/<name>` per session (verified at `session-container.ts:ensureConnectedToSessionNetwork`, dockerode, no spawn).

A session with no project compose file and no plugin services never arms the poller (verified at `service-manager.ts:start`, early return). A stack whose services are all manual and stopped still polls: `ps` returns nothing, but the three processes are spawned.

## Is status persisted, and how does a client get it?

- **In memory only.** `ManagedService.status` / `containerIp` live in `ServiceManager.services`; no DB column or chat-history field holds them (grep of `database.ts`, `chat-history*.ts`: none).
- **Push path.** `updateServiceStatus` emits `service_status` once `_startupComplete` (verified at `service-manager.ts:updateServiceStatus`). The runner forwards it as WS `service_status` plus a rebuilt `preview_status` via `runner.emitMessage` (verified at `container-session-runner.ts:setServiceManager`, `onStatus`). `stack_ready` / `stack_error` send a full `service_list`.
- **Attach / reconnect / reload / switch.** The WS attach sends a snapshot built from the manager's in-memory state: `buildComposeAttachReplay` → `service_list`, `compose_error`, `secrets_status` (verified at `route-registry.ts:attachToRunner` → `compose-attach-replay.ts:buildComposeAttachReplay`). `GET /api/sessions/:id/services` also reads `mgr.getServices()` (verified at `api-routes-preview.ts`).

**Consequence:** no client path waits for the next poll. A client always gets whatever the in-memory state is. The poller's job is to keep that state true; if it stops for an idle session, a client sees the last state the manager recorded — correct until something changes in Docker that nobody observes. So the design does **not** need a refresh on viewer attach, as long as events keep the in-memory state true.

## Who reads poll-maintained state

| Consumer | Reads | Verified at |
|---|---|---|
| Preview proxy | `resolvePreviewTarget(port)` → `svc.containerIp` (falls back to the agent container IP) | `preview-proxy.ts:resolveTarget`, `service-manager.ts:resolvePreviewTarget` |
| Preview status / detected ports | `getServices()` filtered to `running` | `container-session-runner.ts:buildDetectedPortsFromServices` |
| `shipit service` CLI, services API, diagnostics | `getServices()` (status, `url` from `containerIp`) | `container-session-runner.ts` (service command handler), `api-routes-preview.ts`, `services/diagnostics.ts` |
| Log follower | `onRunning` → `ensureLogFollower`, **every** poll | `service-manager.ts:constructor` (poller `onRunning`) |
| Retry / OOM budgets | `onRunning` clears install retries and arms the 60 s stable timers; `onLeftRunning` cancels them | `service-retry-manager.ts:armOomStableResetIfNeeded`, `armPostGateStableClear` |
| Plugin port probe | `onRunning` arms, `onLeftRunning` cancels | `service-manager.ts:armPluginPortProbe` |
| Starting watchdog | any non-`starting` status clears it | `service-manager.ts:updateServiceStatus` |

The stable timers and the port probe are self-contained `setTimeout`s: they need **one** observation that the service is running and **one** that it left. They do not need repeated ticks.

## What only the poller catches

1. **Crash / exit.** A non-zero exit reaches `handleNonZeroExit` only through the poller (`onExitedWithError`), which routes to install-time retry, OOM retry (only when `inspect` says `State.OOMKilled`), post-gate retry, or `error` (verified at `service-manager.ts:handleNonZeroExit`). A clean exit → `stopped` and budgets cleared.
2. **Restart policy.** State `restarting` → `starting`.
3. **Container recreated with a new IP**, and a running container with no networks (the poller runs `docker network connect` and re-inspects) (verified at `service-poller.ts:resolveContainerIps`).
4. **Container gone.** Missing for 30 s continuously, not gated, no `up` in flight → `stopped` (verified at `service-poller.ts:reconcileMissingServices`). This needs **two** observations 30 s apart.
5. **Docker unreachable.** `ps` failing for 30 s → every `running` service to `error` with `DOCKER_UNREACHABLE_MESSAGE` (verified at `service-poller.ts:expireUnconfirmedStatuses`). Also two observations 30 s apart.
6. **Lost install-gate release.** Gated services held with no install running, no failed install, no release in flight, for `GATE_WATCHDOG_SETTLE_MS` → reopen (verified at `service-manager.ts:checkInstallGateLiveness`). Needs repeated ticks while that condition holds.
7. **Agent container detached from the session network** (proxy / network recreate) → reconnect (verified at `session-container.ts:ensureConnectedToSessionNetwork`).
8. **A log follower that exited while the container keeps running** → restarted on the next `running` poll (comment at the poller `onRunning`).

Items 4, 5, 6 and 8 are *pending conditions*: they need a timer only while the condition holds. An idle, healthy session has none of them.

## The explicit `pollOnce()` calls

After every `up` the manager calls `pollOnce()` directly: `start`, `startService`, `restartService`, `refreshSecrets`, `runRetryNow`, `startGatedBatch` (verified at `service-manager.ts`, each method). These are not idle cost, but they spawn the same processes; the targeted refresh should replace them so one code path exists.

**In-flight `up`:** nothing in the poller needs the 5 s cadence during an `up`. Containers created by `up` emit `start`; the starting watchdog is its own timer (verified at `service-manager.ts:onStartingWatchdogFired`); `isStartInFlight` only suppresses the missing-container rule. So no fast path is needed there.

## An events stream already exists

`container-health.ts:startHealthMonitor` already holds one process-lived `docker.getEvents()` stream (type `container`, events `die`, `oom`, `start`, `destroy`), reconnects after 5 s on `error`/`end`, and emits `health_monitor_resumed` with the gap. For compose services it already emits `service_exited` with `serviceName`, `exitCode`, `oom` (one-offs and egress sidecars excluded) — today used only for a log line and a `service_oom` card (verified at `startup-tasks.ts`, `containerManager.on("service_exited")`). Routing uses the `shipit-parent-session` label, which the generated override sets on every service (verified at `compose-generator.ts`), checked against `com.docker.compose.project` = `composeProjectName(sessionId)` (verified at `compose-stack-reaper.ts:reapSurvivingComposeStacks`).

So "one host-wide subscription" means extending this stream (add `network` events, add a session-keyed router), not opening a second one.

## Engine API replacements for the spawned commands

- `docker compose ps -a` → `GET /containers/json?all=1&filters={"label":["com.docker.compose.project=shipit-<id12>"]}`. It returns `State`, `Labels` (service, one-off) and `NetworkSettings.Networks[*].IPAddress`, so a running container needs no `inspect`.
- It does not return the exit code. The `die` event carries `exitCode`; a resync without an event needs `GET /containers/<id>/json` for an exited container whose state is new to the manager — that also gives `State.OOMKilled`.
- `health_status` events: the poller never reads health, so nothing to preserve (see the open question in requirements).
