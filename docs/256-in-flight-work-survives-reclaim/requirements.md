---
title: In-flight work survives reclamation
description: A session that still has work running must not have its container destroyed by automatic resource reclamation.
---

# 256 — In-flight work survives reclamation

Human-owned requirements. Numbered statements are what the feature must do,
in plain language and at the UX level. Mechanism lives in [`plan.md`](plan.md).

Current behavior this is measured against is recorded separately in
[`investigation.md`](investigation.md) — verified at the source, not assumed.

## Requirements

1. **Work a session has in flight is not destroyed by automatic resource
   reclamation.** When a session has started work that is still running,
   ShipIt does not stop or remove its container in order to reclaim host
   resources.

2. **"In flight" includes work that outlives the turn that started it.** A
   paced background job the agent kicked off and left running counts, not only
   a turn that is currently streaming. The motivating case is a ~2-hour
   migration job started in one turn and expected to keep running across many
   turns with no user present.

3. **Protection does not depend on anyone watching.** Closing the tab,
   switching to another session, or leaving ShipIt entirely does not shorten
   the life of in-flight work.

4. **When in-flight work is destroyed anyway, the session says so.** The user
   — and the agent on its next turn — can tell that work was killed by
   reclamation. The failure Nik reported is that it "silently dies": the job
   stops part-way, and nothing anywhere records that ShipIt was the one that
   stopped it.

5. **Every protection ShipIt offers covers a coherent, stated scope, and no
   surface implies more than it delivers.** A user should never be protected
   from one form of automatic cleanup and eligible for another without being
   able to say which. Where the product currently suggests a protection it
   does not provide, the wording changes.

6. **Protection is something the agent declares.** When the agent starts work
   that is meant to outlive the turn, it says so explicitly. ShipIt does not
   guess by watching the container, and the user does not have to be present
   to flip a switch.

7. **A declared protection lapses unless it keeps being re-asserted.** Work
   that has finished, crashed, or was never really running must not keep a
   container alive indefinitely.

8. **Host memory pressure does not override a declared protection.** If the
   host genuinely runs out of memory, the OOM backstop is the correct failure
   — not quietly killing work that was declared and is still running.

9. **Pinning a session remains sidebar-and-disk persistence only.** It is not
   a claim about the container, and container protection is not folded into
   it.

## Open questions

_None._

## Resolved questions

- **2026-08-07 — What establishes that a session has work in flight?**
  Nik: **the agent declares a lease** — it takes a keep-alive when it starts
  long work and releases it when done. Rejected: inferring it from the
  container's process table (can't distinguish real work from a leaked stray,
  so containers would stay up for reasons nobody chose); a user-only toggle
  (the work dies exactly when the user isn't there, which is the reported
  bug); auto-covering only the jobs ShipIt can already see (leaves a detached
  `nohup` — the case as actually written — uncovered). → requirement 6.

- **2026-08-07 — What stops a protection from making a container permanent?**
  Nik: **a heartbeat the holder must renew.** Explicitly chosen over a hard
  maximum duration and over an unbounded explicit-release-only lease, so a
  long job is never killed for being long, and a lease whose owner is gone
  lapses on its own. Fails toward reclaimable, matching the direction the
  existing background-task decay already chose. → requirement 7.

- **2026-08-07 — Can host memory pressure override the protection?**
  Nik: **no — protection wins.** Consistent with the two precedents this repo
  already set: docs/241 made an always-on preview immune to pressure eviction,
  and docs/235 refused to let pressure override `agentBusy`. → requirement 8.

- **2026-08-07 — Should a pin keep the container alive, as assumed?**
  Nik: **no — put the protection elsewhere.** Pins are unlimited and free
  while a container reservation consumes RAM continuously, so making pins
  runtime would let a user pin the host to death. The consistency concern in
  requirement 5 is met by the new mechanism plus correcting any wording that
  overstates what a pin does. → requirement 9, and requirement 5 reworded from
  "protected from every path" to "a coherent, stated scope".
