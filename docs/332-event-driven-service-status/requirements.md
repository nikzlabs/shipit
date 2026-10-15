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

## Open questions

- Requirement 1 says "no CPU". Is a slow backstop acceptable — one host-wide Engine API container list every few minutes for all sessions together, no process spawn — or must an idle session cause no periodic work at all? (Agent recommendation: allow the host-wide backstop, 5 minutes.)
- The poller does not read container health today; a health check changes no status. Should health events now change status (for example "starting" until healthy), or stay out of scope? (Agent recommendation: out of scope; do not subscribe to `health_status`.)
- With no Docker events stream (the dogfood inner instance, `RUNTIME_MODE=local`, and tests without a container manager), should the status keep the old 5-second poll there? (Agent recommendation: yes, keep the poll as the fallback when no stream exists.)

## Resolved questions
