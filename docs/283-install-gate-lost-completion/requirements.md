---
title: Install gate must not wedge on a lost completion event
description: A mid-session reinstall must always reopen the service gate — whether the install's completion event is lost or its teardown never reports back.
---

# Install gate must not wedge on a lost completion event

1. When ShipIt stops a session's `preview: auto` services to re-run
   `agent.install`, it must start them again — including when ShipIt is never
   told the install finished, and including when the teardown that stopped them
   never reports back.
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
6. A gate must only ever be opened by the teardown cycle that closed it. One
   reinstall's teardown must never start services that a later reinstall's
   teardown is in the middle of stopping.

## Open questions

- None.

## Resolved questions

- 2026-08-26 — Should the completion wait fail after a deadline? No. A slow
  `npm install` is not a fault, so the wait probes the worker for the real
  answer instead of assuming one (req 3).
- 2026-08-26 — Should req 1 cover a hung `docker compose stop` too? No, not
  in the first change. Review raised it as a second, independent way the gate
  can stay shut, but the production evidence ruled it out for this incident and
  bounding a compose child process is a different mechanism in a different
  subsystem. Req 1 was worded "once the install has finished" so it did not
  silently claim that hole was closed. **Superseded 2026-08-26 (below).**
- 2026-08-26 — Nik asked for the deferred hole to be closed after all, in the
  same breath as asking for an end-to-end regression test. So req 1 now covers
  a teardown that never reports back, and req 6 records the ordering hazard
  review found alongside it. Both are implemented; see
  [plan.md](./plan.md) → "Bounding the teardown".
