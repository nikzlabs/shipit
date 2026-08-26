---
title: Install gate must not wedge on a lost completion event
description: A mid-session reinstall whose install_done never arrives must still reopen the service gate, so preview services are started again.
---

# Install gate must not wedge on a lost completion event

1. When ShipIt stops a session's `preview: auto` services to re-run
   `agent.install`, it must start them again, whatever happens to the install.
2. A completion event that never arrives must not hold the services stopped
   indefinitely. Recovery must not depend on the user reconnecting, switching
   sessions, or reloading the page.
3. A genuinely slow install must not be cut short, and must never be reported
   as failed because it took a long time.
4. The behaviour that stops ShipIt's own teardown from being reported to the
   user as a service crash (docs/239) must be unchanged: the gate still waits
   for the teardown before it reopens, and held services stay exempt from
   crash reporting while it is in progress.

## Open questions

- None.

## Resolved questions

- 2026-08-26 — Should the completion wait fail after a deadline? No. A slow
  `npm install` is not a fault, so the wait probes the worker for the real
  answer instead of assuming one (req 3).
