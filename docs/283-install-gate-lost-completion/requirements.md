---
title: Install gate must not wedge on a lost completion event
description: A mid-session reinstall whose install_done never arrives must still reopen the service gate, so preview services are started again.
---

# Install gate must not wedge on a lost completion event

1. When ShipIt stops a session's `preview: auto` services to re-run
   `agent.install`, it must start them again once the install has finished —
   including when ShipIt is never told that it finished.
2. A completion event that never arrives must not hold the services stopped
   indefinitely. Recovery must not depend on the user reconnecting, switching
   sessions, or reloading the page.
3. A genuinely slow install must not be cut short, and must never be reported
   as failed because it took a long time.
4. The behaviour that stops ShipIt's own teardown from being reported to the
   user as a service crash (docs/239) must be unchanged: the gate still waits
   for the teardown before it reopens, and held services stay exempt from
   crash reporting while it is in progress.
5. Recovering a lost completion must not open a gate early. An install that is
   still running must keep its services held, whatever ShipIt learns about any
   *other* install.

## Open questions

- None.

## Resolved questions

- 2026-08-26 — Should the completion wait fail after a deadline? No. A slow
  `npm install` is not a fault, so the wait probes the worker for the real
  answer instead of assuming one (req 3).
- 2026-08-26 — Should req 1 cover a hung `docker compose stop` too? No, not
  here. Review raised it as a second, independent way the gate can stay shut
  (see "Known separate hole" in [plan.md](./plan.md)), but the production
  evidence rules it out for this incident, and bounding a compose child process
  is a different mechanism in a different subsystem. Req 1 says "once the
  install has finished" rather than "whatever happens" so it does not silently
  claim that hole is closed.
