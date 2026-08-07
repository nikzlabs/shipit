---
title: In-flight work survives reclamation
description: A session that still has work running must not have its container destroyed by automatic resource reclamation.
---

# 256 — In-flight work survives reclamation

Human-owned requirements. Numbered statements are what the feature must do,
in plain language and at the UX level. Mechanism lives in `plan.md`, which is
not written until every `## Open questions` bullet is resolved.

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

5. **A protection the user has already been offered means what it appears to
   mean.** A session the user has marked as protected is protected from every
   automatic reclamation path, not from one and eligible for another. Today a
   pinned session and a keep-preview session are each immune to a different
   half of the machinery, and neither user could describe which half.

## Open questions

Blocking. No implementation of the numbered requirements above while any of
these is open. (The reaper-asymmetry bug fix landed with this doc is a
self-contained defect, not an implementation of these requirements — see
`checklist.md`.)

- **How is protection established?** Declared by the agent (it takes a
  keep-alive when it starts long work and releases it when done), inferred by
  the orchestrator (it notices the container is running work of its own),
  controlled by the user (extend the existing always-on toggle, or make a pin
  mean this too), or covered automatically for the subset of jobs ShipIt can
  already see.

- **What bounds a protection so a container cannot become permanent?** A
  heartbeat the holder must renew, a fixed expiry, a hard maximum duration, or
  nothing but an explicit release. A protection that outlives its owner is a
  container that never dies, and requirement 1 gives no guidance on where that
  stops.

- **Can host memory pressure override the protection?** Today pressure
  overrides the disconnect grace period but does not override an always-on
  preview reservation (`idle-enforcer.ts:113`, ahead of the pressure branch)
  — so there is precedent for "never," and it is a deliberate one from
  docs/241. Whether that precedent should extend to this is Nik's call.

- **Does a pin mean the container stays alive?** Nik assumed a pinned session
  was already exempt. It is not: `pinnedAt` is documented and implemented as
  sidebar-and-disk persistence only (`session.ts:152-162`,
  `tier-escalation.ts:137`). Requirement 5 is satisfiable either by widening
  what a pin means or by leaving pins alone and putting the protection
  somewhere else — that is a product decision about what the pin icon
  promises, not a bug.

## Resolved questions

_None yet._
