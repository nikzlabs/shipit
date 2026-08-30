---
title: Install gate — liveness watchdog
description: A gate that holds preview services with nothing able to open it must reopen itself, and every branch that declines to open it must say so.
---

# Install gate — liveness watchdog

Reported from production on 2026-08-30 as "my preview crashed and ShipIt did
not recover it". It was not a crash — it was ShipIt's own install-gate
teardown, never undone. See [plan.md](./plan.md) for the incident record.

1. A `preview: auto` service that ShipIt stopped for a mid-session re-install
   must never be left stopped indefinitely. If the gate holding it is never
   reopened, ShipIt reopens it itself.
2. ShipIt must not mistake a re-install that is legitimately still in progress
   for a stuck one. A gate that is mid-bracket is left alone.
3. A service the user stopped stays stopped. Recovering a stuck gate is an
   automatic lifecycle event, not a newer instruction from the user.
4. When ShipIt declines to open the gate, the reason is in the orchestrator log.
   An operator reading the log must be able to tell a lost release from a
   deliberate one without reading the source.
5. The recovery must not depend on knowing which code path lost the release.
   Two such paths were already fixed (docs/283) and the incident happened on a
   build carrying that fix, with the responsible branch never identified.

## Open questions

None.

## Resolved questions

- 2026-08-30 — *What should ShipIt do when a preview stays dead after a
  re-install?* Nik chose a **targeted gate watchdog** and explicitly rejected
  both a blanket restart-on-any-exit and any change that would stop honouring a
  user's Stop. Carried by req 1 and req 3.
- 2026-08-30 — *Should the fix name the branch that lost the release?* No. The
  branch is deliberately not known — the diagnosis narrowed it to one of five
  silent early returns and stopped there. The watchdog is designed to fix the
  class regardless (req 5), and the missing logs (req 4) are what make the next
  occurrence identifiable.
