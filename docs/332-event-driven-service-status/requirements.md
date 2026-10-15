---
issue: planning#697
title: Event-driven Compose service status
description: Idle sessions stop costing orchestrator CPU for service status; status, crash recovery and previews keep working.
---

# Event-driven Compose service status

Measured cause and the behaviour inventory: [investigation.md](investigation.md).

1. An idle session costs the orchestrator no CPU to keep its service status current.
2. The service status a client sees stays correct, on a live connection and after attach, reconnect, page reload or session switch.
3. Crash recovery keeps working: a service that crashes, is OOM-killed, or exits while an install runs is detected and handled as it is today.
4. Previews keep working: the preview routes to a service's current container, including after that container is recreated with a new address.
5. The periodic work left for service status is one host-wide check for all sessions together, every 5 minutes, and it spawns no process. Per-session periodic work is not acceptable.
6. Container health does not change a service's status. The feature adds no health behaviour.

## Open questions

## Resolved questions

- 2026-10-15 — Does requirement 1's "no CPU" allow a slow backstop? The user chose one host-wide Engine API check every 5 minutes for all sessions together, with no process spawn, over a per-session backstop or no backstop at all. Recorded as req 5: the cost must not grow with the session count.
- 2026-10-15 — Should health events start changing service status? The user chose to keep it out of scope, so the feature does not subscribe to `health_status`. Recorded as req 6.
- 2026-10-15 — What keeps status current where no Docker event stream exists? The user asked whether local mode has containers at all. It does not: `setupServiceManager` is skipped for `runtimeMode === "local"` (verified at `runner-registry-factory.ts:620`) and that mode builds no container manager (verified at `app-lifecycle.ts:164`), so there is no Compose stack to keep current. The question is therefore moot for local mode, and the only stream-less caller left is test mode, which constructs a `ServiceManager` directly with an injected `composeQuery`. No production fallback is needed; `pollOnce()` stays as an explicitly-called refresh so tests keep driving it.
