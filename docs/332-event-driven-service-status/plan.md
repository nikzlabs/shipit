---
issue: planning#697
title: "Event-driven service status: design"
description: One host-wide Docker event subscription drives per-project refreshes; no per-session timer.
---

# Design: event-driven Compose service status

Implements [requirements.md](requirements.md). The measured cause and the behaviour inventory this design must preserve are in [investigation.md](investigation.md).

## Shape

Today each `ServiceManager` owns a 5-second timer that spawns `docker compose ps` plus one `docker inspect` per container. The timer is the only thing that moves service state forward, so it must run even for a session nobody is watching (req 1 is violated by construction).

This design keeps `ServicePoller` as the thing that *reconciles one project*, and removes its timer. Three callers drive it instead:

1. **Docker events**, routed per project (the normal case).
2. **One host-wide backstop**, every 5 minutes, for all sessions in one Engine API call (req 5).
3. **A resync** whenever the event stream reconnects, because events are lost across a disconnect.

Everything is in-process Engine API through dockerode (`service-manager.ts` already receives a client via `containerManager.getDockerClient()`); no step spawns a process.

## The event source is the existing stream

`container-health.ts` already holds one process-lived `docker.getEvents()` subscription with a 5-second reconnect and a `health_monitor_resumed` signal, and it already decodes Compose service exits into `service_exited` (verified at `container-health.ts:startHealthMonitor`). This design extends that stream rather than opening a second one:

- add `network` to the subscribed types, for the network heal trigger;
- emit `compose_container_changed` for a service container's `start` / `destroy`;
- emit `session_network_changed` for `disconnect` / `destroy` on a `shipit-session-*` network;
- keep `service_exited` as the authoritative crash signal, and **fix it**: it fired on `oom` *and* on the following `die`, describing one kill twice — once as an exit-1 crash with the OOM flag, once as a non-OOM SIGKILL with the real code. Harmless while it only drove a log line; it would have sent the OOM retry decision the wrong way. It now correlates the two as the agent-container path already did, within a 60 s window.

That correlation trades one thing deliberately: an `oom` with no `die` after it — the kernel killed a *child* and the container survived — now reports nothing, where before it raised a `service_oom` card. The card said the service was OOM-killed, which for a container that is still running was wrong, so the signal lost was a false one.

## Routing: project label, not the parent label

A new process-lived `service-event-router.ts` holds the `serviceManagers` map and builds a `com.docker.compose.project` → `sessionId` index from it (`composeProjectName(sessionId)`). Events and backstop rows are routed by that label. The project label is what every container of the stack carries, whether it came from the project file or from a plugin, so routing never depends on `shipit-parent-session` being present.

The router owns the 5-minute backstop: one `GET /containers/json?all=1&filters=label=com.docker.compose.project` (plus the stack filter, so two ShipIt stacks on one host do not cross-talk), sliced per project and handed to each manager. One timer for the process, cost independent of the session count.

## Two entry points on the manager, because there are two different jobs

- **`applyServiceExit(serviceName, containerId, exitCode, oom)`** — the crash path. The exit code and the OOM flag come from the event, which is race-free: a container with a restart policy can be replaced before any listing could observe its exit. It feeds the same `onLeftRunning` / `onExitedCleanly` / `onExitedWithError` callbacks the reconcile path uses, so install-time retry, OOM retry and post-gate retry are unchanged.
- **`refreshServices()`** — the reconcile path. One project listing → status transitions, container addresses, the missing-container rule, the Docker-unreachable rule, the install-gate check.

Both already exist inside today's `pollOnce`; the exit branch is factored out so an event can reach it directly.

## One listing, no per-container inspect

`pollOnce` consumes a normalized `PollerContainer[]` from an injected `listContainers`. Two implementations, one consumer:

- **Engine API** (production): `/containers/json?all=1&filters=label=…` carries `State`, `Labels` and `NetworkSettings.Networks[*].IPAddress`, so a running container needs **no** `inspect` at all — this is where most of the measured CPU goes.
- **`docker compose ps --format json -a`** (tests): the existing parse, kept so tests that inject `composeQuery` keep working.

`inspect` survives for the two things a listing cannot answer, and only then: the exit code / `OOMKilled` of an exited container whose exit no event reported (a resync after a missed event), and the re-read after a repair `network connect` for a running container that shows no session network.

## Pending conditions get a one-shot timer, not a cadence

Three of the poller's rules need a *second* observation after a delay: the missing-container grace (30 s), the Docker-unreachable grace (30 s), and the install-gate watchdog. With a cadence they came for free; with events they would never fire, because no further event arrives for a container that is simply absent.

So a refresh that leaves a pending condition arms **one** follow-up at that condition's deadline, and a refresh that leaves none arms nothing. An idle, healthy session therefore holds no timer, which is req 1; a session mid-install or mid-outage holds one, which is not idle.

The log follower is the fourth such case: today every `running` poll calls `ensureLogFollower`, to catch a follower that exited while its container kept running. It re-arms itself from its own `close` handler instead, guarded on the service still being `running`, so the 5-minute backstop is not the recovery path for missing logs.

## Out of scope

Container health (req 6): the poller never read it and this design does not subscribe to `health_status`.

## Key files

- `src/server/orchestrator/service-poller.ts` — reconcile one project; normalized container shape; no timer.
- `src/server/orchestrator/service-event-router.ts` — new: project index, event routing, host-wide backstop, resync.
- `src/server/orchestrator/container-health.ts` — the one subscription; network events and the new emissions.
- `src/server/orchestrator/service-manager.ts` — `refreshServices()` / `applyServiceExit()`; Engine API listing; on-demand network heal.
